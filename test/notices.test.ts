// Notices reach the right people, the records library shows each document only to those allowed,
// and the report packs carry only what each reader may see.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
let roles: any[];
let ownerA: ReturnType<Harness['client']>, tenantB: ReturnType<Harness['client']>, block: ReturnType<Harness['client']>;
const ok = (r: { status: number; body: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
async function upload(client: ReturnType<Harness['client']>, purpose: string, body = PDF, name = 'file.pdf', type = 'application/pdf') {
  const b = '----x';
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), body, Buffer.from(`\r\n--${b}--\r\n`)]);
  return client.call('POST', `/api/files?purpose=${purpose}`, payload, { 'content-type': `multipart/form-data; boundary=${b}` });
}

before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'ntc');
  roles = (await C.admin.get('/api/roles')).body;
  ok(await C.admin.post(`/api/units/${C.unitA.id}/owners`, { newPerson: { name: 'Owner A', phone: '+919000600001' }, sharePct: 100 }));
  ownerA = h.client(C.host, await h.sessionFor(C.id, '+919000600001'));
  ok(await C.admin.post(`/api/units/${C.unitB.id}/occupants`, { newPerson: { name: 'Tenant B', phone: '+919000600002' }, relation: 'tenant' }));
  tenantB = h.client(C.host, await h.sessionFor(C.id, '+919000600002'));
  const p = await C.person('Block A Rep', '+919000600003');
  ok(await C.admin.post('/api/members', { personId: p.id, roleId: roles.find(r => r.key === 'block_committee_member').id, scopeNodeId: C.blockA.id }));
  block = h.client(C.host, await h.sessionFor(C.id, '+919000600003'));
});
after(() => h.close());

test('notices reach their audience and place; read receipts are counted for the publisher', async () => {
  const all = ok(await C.admin.post('/api/notices', { title: 'Water supply interruption', body: 'Tank cleaning on Sunday, 9 am to 1 pm.', category: 'maintenance' }));
  const owners = ok(await C.admin.post('/api/notices', { title: 'AGM on 14 December', body: 'Owners only. Agenda attached.', category: 'meeting', audience: 'owners' }));
  const blockB = ok(await C.admin.post('/api/notices', { title: 'Block B lift shutdown', body: 'Lift 2 off on Monday.', category: 'maintenance', scopeNodeId: C.blockB.id }));
  const later = ok(await C.admin.post('/api/notices', { title: 'Diwali event', body: 'Details soon.', category: 'event', publishAt: new Date(Date.now() + 86_400_000).toISOString() }));
  const titles = async (c: any) => ok(await c.get('/api/notices')).map((n: any) => n.title).sort();
  assert.deepEqual(await titles(ownerA), ['AGM on 14 December', 'Water supply interruption']);
  assert.deepEqual(await titles(tenantB), ['Block B lift shutdown', 'Water supply interruption']);
  ok(await tenantB.get(`/api/notices/${owners.id}`), 404);
  ok(await ownerA.get(`/api/notices/${later.id}`), 404);
  // A block representative publishes only for their block.
  ok(await block.post('/api/notices', { title: 'Block A parking', body: 'Repainting on Friday.', category: 'general' }), 403);
  ok(await block.post('/api/notices', { title: 'Block A parking', body: 'Repainting on Friday.', category: 'general', scopeNodeId: C.blockA.id }));
  ok(await ownerA.get(`/api/notices/${all.id}`));
  ok(await tenantB.get(`/api/notices/${all.id}`));
  const seen = ok(await C.admin.get(`/api/notices/${all.id}`));
  assert.equal(seen.reads, 3);
  assert.equal(ok(await ownerA.get(`/api/notices/${all.id}`)).reads, undefined, 'readers do not see read counts');
  assert.ok(ok(await C.admin.get('/api/notices?all=1')).some((n: any) => n.id === later.id && n.scheduled));
  ok(await C.admin.post(`/api/notices/${blockB.id}/withdraw`, { note: 'Shutdown postponed' }));
  assert.deepEqual(await titles(tenantB), ['Water supply interruption']);
});

test('the records library shows each document only to those allowed, keeps versions, and guards the files', async () => {
  const f1 = ok(await upload(C.admin, 'document'));
  const byelaws = ok(await C.admin.post('/api/documents', { title: 'Bye-laws (2019)', category: 'bye_laws', fileId: f1.id, visibility: 'everyone' }));
  const f2 = ok(await upload(C.admin, 'document'));
  const minutes = ok(await C.admin.post('/api/documents', { title: 'Committee minutes, October', category: 'minutes', fileId: f2.id, visibility: 'committee' }));
  const f3 = ok(await upload(C.admin, 'document'));
  const agm = ok(await C.admin.post('/api/documents', { title: 'AGM notice and accounts', category: 'agm', fileId: f3.id, visibility: 'owners', reviewOn: '2020-01-01' }));
  const list = async (c: any) => ok(await c.get('/api/documents')).map((d: any) => d.title).sort();
  assert.deepEqual(await list(ownerA), ['AGM notice and accounts', 'Bye-laws (2019)']);
  assert.deepEqual(await list(tenantB), ['Bye-laws (2019)']);
  assert.equal((await tenantB.get(`/api/files/${f3.id}`)).status, 404);
  assert.equal((await ownerA.get(`/api/files/${f3.id}`)).status, 200);
  assert.equal((await ownerA.get(`/api/files/${f2.id}`)).status, 404);
  assert.ok(ok(await C.admin.get('/api/documents')).find((d: any) => d.id === agm.id).reviewOverdue);
  // A new version replaces the old one in the list and keeps it in the history.
  const f4 = ok(await upload(C.admin, 'document'));
  const v2 = ok(await C.admin.post('/api/documents', { title: 'Bye-laws (2026 amendment)', category: 'bye_laws', fileId: f4.id, visibility: 'everyone', replacesId: byelaws.id }));
  assert.equal(v2.version, 2);
  const d = ok(await tenantB.get(`/api/documents/${v2.id}`));
  assert.deepEqual(d.versions.map((x: any) => x.version), [1]);
  assert.equal((await tenantB.get(`/api/files/${f1.id}`)).status, 200, 'old versions stay readable to the same people');
  ok(await ownerA.post('/api/documents', { title: 'Mine', category: 'other', fileId: f4.id, visibility: 'everyone' }), 403);
  assert.equal((await upload(ownerA, 'document')).status, 403);
  void minutes;
});

test('report packs: the committee pack by permission, the owners\' update in counts only', async () => {
  const pack = ok(await C.admin.get('/api/packs/weekly'));
  for (const k of ['checks', 'work', 'approvals', 'cash', 'dues', 'notices']) assert.ok(k in pack, k);
  ok(await ownerA.get('/api/packs/weekly'), 403);
  const owners = ok(await ownerA.get('/api/packs/owners'));
  assert.ok('checks' in owners && 'work' in owners);
  assert.ok(!JSON.stringify(owners).includes('paise'), 'no amounts in the owners\' update');
});
