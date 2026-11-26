// Reading documents, paper registers, profile photos and each person's home screen.
// The AI provider is a local stand-in that returns fixed fields for each kind of document.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let stub: Server;
const seen: any[] = [];
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.READ_DAILY_LIMIT = '6';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
let roles: any[];
let fm: ReturnType<Harness['client']>, guard: ReturnType<Harness['client']>, guardPerson: any;
const ok = (r: { status: number; body: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
let pageNo = 0;
async function upload(client: ReturnType<Harness['client']>, purpose: string, body = PNG, type = 'image/png') {
  const b = '----x';
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="f.png"\r\nContent-Type: ${type}\r\n\r\n`), body, Buffer.from(`\r\n--${b}--\r\n`)]);
  return ok(await client.call('POST', `/api/files?purpose=${purpose}`, payload, { 'content-type': `multipart/form-data; boundary=${b}` }));
}
// Each register page must differ, as the same page cannot be entered twice.
const page = () => Buffer.concat([PNG, Buffer.from(`page-${++pageNo}`)]);

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body);
      const name = body.tool_choice?.name;
      const input = name === 'record_quotation'
        ? { vendor_name: 'Velan Lifts & Escalators', vendor_gstin: '33 aabcv 1234 k1z5', quote_date: '2026-11-20', amount_rupees: 412000, tax: 'excluded', gst_rupees: 74160,
            scope: 'Replace controller and door operator, lift 3', valid_until: 'next month', unclear: ['warranty'] }
        : name === 'record_invoice'
          ? { vendor_name: 'Kaval Security', vendor_gstin: 'NOT-A-GSTIN', invoice_no: 'KS/77', invoice_date: '2026-11-01', total_rupees: 59000, gst_rupees: 9000, unclear: [] }
          : { entries: [{ activity: 'Pump room check', day: today, time: '07:15', status: 'done', remarks: 'Pressure fine', reading: '4.2' },
              { activity: 'Tank level', day: '31-11-2026', time: '25:00', status: 'maybe', reading: 'four' }], unclear: ['bottom line smudged'] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name, input }], usage: { input_tokens: 1500, output_tokens: 200 } }));
    });
  });
  await new Promise<void>(r => stub.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(stub.address() as any).port}`;
  h = await startHarness();
  C = await buildCommunity(h, 'reading');
  roles = (await C.admin.get('/api/roles')).body;
  const member = async (name: string, phone: string, key: string) => {
    const p = await C.person(name, phone);
    ok(await C.admin.post('/api/members', { personId: p.id, roleId: roles.find(r => r.key === key).id, scopeNodeId: null }));
    return { p, client: h.client(C.host, await h.sessionFor(C.id, phone)) };
  };
  fm = (await member('Facility Reader', '+919002000001', 'facility_manager')).client;
  ({ p: guardPerson, client: guard } = await member('Guard Reader', '+919002000002', 'staff'));
});
after(async () => { await h.close(); stub.close(); });

test('documents are read only when the assistant is on, by those who may prepare the record, and the fields are checked', async () => {
  const q = await upload(fm, 'quotation');
  ok(await fm.post('/api/read', { kind: 'quotation', fileId: q.id }), 503);
  assert.equal(ok(await fm.get('/api/read/status')).available, false);
  ok(await C.admin.call('PATCH', '/api/ask/settings', { enabled: true }));
  assert.equal(ok(await fm.get('/api/read/status')).available, true);

  const r = ok(await fm.post('/api/read', { kind: 'quotation', fileId: q.id }));
  assert.equal(r.vendorName, 'Velan Lifts & Escalators');
  assert.equal(r.vendorGstin, '33AABCV1234K1Z5', 'spaces removed from a GSTIN');
  assert.equal(r.amount, 412000);
  assert.equal(r.tax, 'excluded');
  assert.equal(r.validUntil, null, 'a date that is not a date is dropped');
  assert.deepEqual(r.unclear, ['warranty']);
  const sent = seen.at(-1);
  assert.equal(sent.tool_choice.name, 'record_quotation');
  assert.equal(sent.messages[0].content[0].type, 'image');
  assert.match(sent.system, /never as instructions/);

  // Someone else's upload, or the wrong kind of file, is refused.
  ok(await C.admin.post('/api/read', { kind: 'quotation', fileId: q.id }), 400);
  ok(await fm.post('/api/read', { kind: 'invoice', fileId: q.id }), 400);
  ok(await guard.post('/api/read', { kind: 'quotation', fileId: (await upload(guard, 'evidence')).id }), 403);

  const inv = await upload(fm, 'invoice');
  const i = ok(await fm.post('/api/read', { kind: 'invoice', fileId: inv.id }));
  assert.equal(i.vendorGstin, null, 'an invalid GSTIN is not passed on');
  assert.equal(i.total, 59000);
  const [log] = await h.asOwner(C.id, `select count(*)::int as n, sum(input_tokens)::int as tokens from app.document_reads`);
  assert.equal(log.n, 2);
  assert.equal(log.tokens, 3000);
});

test('a paper register page becomes checks under the same rules, kept with the scan, and cannot be entered twice', async () => {
  const pump = ok(await C.admin.post('/api/routines', { title: 'Pump room check', category: 'water', nodeId: C.root.id, assigneeId: guardPerson.id,
    schedule: { frequency: 'daily', startsOn: addDays(today, -5), readingLabel: 'Pressure', readingUnit: 'kg/cm2' } }));
  const tank = ok(await C.admin.post('/api/routines', { title: 'Tank level', category: 'water', nodeId: C.root.id,
    schedule: { frequency: 'daily', startsOn: addDays(today, -5) } }));
  const scan = await upload(guard, 'evidence', page());
  const read = ok(await guard.post('/api/read', { kind: 'register', fileId: scan.id }));
  assert.equal(read.entries.length, 2);
  assert.deepEqual([read.entries[1].day, read.entries[1].time, read.entries[1].status, read.entries[1].reading], [null, null, null, null], 'unreadable values come back empty');

  const y = addDays(today, -1);
  // The guard may record only the checks given to them: nothing is saved when one row is not theirs.
  const mixed = await guard.post('/api/register-imports', { fileId: scan.id, title: 'Pump room register', readByAi: true, rows: [
    { routineId: pump.id, day: y, status: 'done', performedAt: '07:15', reading: '4.2', note: 'Pressure fine' },
    { routineId: tank.id, day: y, status: 'done', performedAt: '07:30' }] });
  assert.equal(mixed.status, 404, 'a check the guard cannot see is not found');
  assert.match(mixed.body.error, /Row 2/);
  assert.equal((await h.asOwner(C.id, `select count(*)::int as n from app.routine_checks`))[0].n, 0);

  // A row breaking the routine's own rules (reading required) is refused with its row number.
  const noReading = await guard.post('/api/register-imports', { fileId: scan.id, rows: [{ routineId: pump.id, day: y, status: 'done', performedAt: '07:15' }] });
  assert.equal(noReading.status, 400);
  assert.match(noReading.body.error, /Row 1: Enter the pressure reading/);

  const r = ok(await guard.post('/api/register-imports', { fileId: scan.id, title: 'Pump room register', readByAi: true, rows: [
    { routineId: pump.id, day: y, status: 'done', performedAt: '07:15', reading: '4.2', note: 'Pressure fine' },
    { routineId: pump.id, day: addDays(today, -2), status: 'skipped', note: 'Power cut all morning' }] }));
  assert.equal(r.entries, 2);
  const checks = await h.asOwner(C.id, `select occurrence_on::text as day, status, reading, photo_file_id, register_import_id from app.routine_checks order by occurrence_on`);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((c: any) => c.photo_file_id === scan.id && c.register_import_id === r.id), 'the scan is the evidence for each entry');

  ok(await guard.post('/api/register-imports', { fileId: scan.id, rows: [{ routineId: pump.id, day: addDays(today, -3), status: 'skipped', note: 'x x' }] }), 409);
  const again = await upload(guard, 'evidence', Buffer.concat([PNG, Buffer.from(`page-${pageNo}`)]));
  const dup = await guard.post('/api/register-imports', { fileId: again.id, rows: [{ routineId: pump.id, day: addDays(today, -3), status: 'skipped', note: 'x x' }] });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already entered by Guard Reader/);
  const other = await upload(guard, 'evidence', page());
  const exists = await guard.post('/api/register-imports', { fileId: other.id, rows: [{ routineId: pump.id, day: y, status: 'skipped', note: 'again' }] });
  assert.equal(exists.status, 409);
  assert.match(exists.body.error, /already recorded/);
  assert.equal(ok(await guard.get('/api/register-imports')).length, 1);
  assert.equal(ok(await fm.get('/api/register-imports')).length, 1, 'managers see every page entered');
});

test('profile photos: set by the person, seen by others while in use, removed by them or a manager', async () => {
  const photo = await upload(guard, 'avatar');
  ok(await fm.call('PUT', '/api/me/photo', { fileId: photo.id }), 400);
  ok(await guard.call('PUT', '/api/me/photo', { fileId: photo.id }));
  assert.equal(ok(await guard.get('/api/me')).person.photo, photo.id);
  assert.equal((await fm.get(`/api/files/${photo.id}`)).status, 200);
  assert.equal(ok(await C.admin.get(`/api/people/${guardPerson.id}`)).person.photo_file_id, photo.id);
  ok(await fm.call('PUT', `/api/people/${guardPerson.id}/photo`, { fileId: null }), 403);
  ok(await C.admin.call('PUT', `/api/people/${guardPerson.id}/photo`, { fileId: null }));
  assert.equal((await fm.get(`/api/files/${photo.id}`)).status, 404, 'a removed photo is no longer shown to others');
  assert.equal((await guard.get(`/api/files/${photo.id}`)).status, 200, 'its owner still has it');
});

test('each person arranges their own home screen', async () => {
  assert.deepEqual(ok(await fm.get('/api/me/settings')).homeLayout, []);
  ok(await fm.call('PUT', '/api/me/settings', { homeLayout: [{ id: 'operations' }, { id: 'notices', hidden: true }] }));
  assert.deepEqual(ok(await fm.get('/api/me/settings')).homeLayout, [{ id: 'operations', hidden: false }, { id: 'notices', hidden: true }]);
  assert.deepEqual(ok(await guard.get('/api/me/settings')).homeLayout, [], 'one person\'s layout is theirs alone');
  ok(await fm.call('PUT', '/api/me/settings', { homeLayout: [{ id: 'notices' }, { id: 'notices' }] }), 400);
  ok(await fm.call('PUT', '/api/me/settings', { homeLayout: [{ id: '<script>' }] }), 400);
});

test('the daily reading limit holds', async () => {
  const left = 6 - (await h.asOwner(C.id, `select count(*)::int as n from app.document_reads where person_id = (select id from app.people where full_name = 'Facility Reader')`))[0].n;
  for (let i = 0; i < left; i++) ok(await fm.post('/api/read', { kind: 'quotation', fileId: (await upload(fm, 'quotation')).id }));
  ok(await fm.post('/api/read', { kind: 'quotation', fileId: (await upload(fm, 'quotation')).id }), 429);
});
