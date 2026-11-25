// The end-of-day summary, the annual AGM pack, notice templates, feedback, and importing vouchers.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
let roles: any[];
const ok = (r: { status: number; body: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'packs');
  roles = (await C.admin.get('/api/roles')).body;
});
after(() => h.close());
async function member(name: string, phone: string, roleKey: string) {
  const p = await C.person(name, phone);
  ok(await C.admin.post('/api/members', { personId: p.id, roleId: roles.find(r => r.key === roleKey).id, scopeNodeId: null }));
  return h.client(C.host, await h.sessionFor(C.id, phone));
}

test('the end-of-day summary covers one day; the annual pack carries the accounts only for those who see the books', async () => {
  const inc = ok(await C.admin.post('/api/work', { kind: 'incident', title: 'Water tank overflow', nodeId: C.root.id }));
  const day = ok(await C.admin.get(`/api/packs/weekly?days=1&end=${today}`));
  assert.equal(day.start, today);
  assert.ok(day.incidents.some((x: any) => x.title === 'Water tank overflow'));
  assert.equal(ok(await C.admin.get('/api/packs/weekly')).days, 7);
  void inc;

  const fyNow = Number(today.slice(5, 7)) >= 4 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
  const annual = ok(await C.admin.get(`/api/packs/annual?fy=${fyNow}`));
  assert.equal(annual.complete, false);
  assert.ok(annual.work.some((w: any) => w.kind === 'incident' && w.opened === 1));
  assert.equal(annual.income.title, 'Income and expenditure');
  assert.ok(annual.balance);
  ok(await C.admin.get(`/api/packs/annual?fy=${fyNow + 1}`), 400);

  const cm = await member('Committee Viewer', '+919001000001', 'committee_member');
  assert.ok(ok(await cm.get(`/api/packs/annual?fy=${fyNow}`)).income, 'committee members read the books');
  const staff = await member('Staff Only', '+919001000002', 'staff');
  ok(await staff.get(`/api/packs/annual?fy=${fyNow}`), 403);
});

test('notice templates keep fill-in fields; standard templates are offered too', async () => {
  const list = ok(await C.admin.get('/api/notice-templates'));
  assert.ok(list.some((t: any) => t.id === 'starter-water'));
  ok(await C.admin.post('/api/notice-templates', { title: 'Garden closed on {{day}}', body: 'Broken {{ field', category: 'general' }), 400);
  const t = ok(await C.admin.post('/api/notice-templates', { title: 'Garden closed on {{day}}', body: 'The garden is closed on {{day}} for {{reason}}.' }));
  assert.deepEqual(t.fields, ['day', 'reason']);
  assert.ok(ok(await C.admin.get('/api/notice-templates')).some((x: any) => x.id === t.id && x.own));
  ok(await C.admin.post(`/api/notice-templates/${t.id}/archive`, {}));
  const staff = h.client(C.host, await h.sessionFor(C.id, '+919001000002'));
  ok(await staff.get('/api/notice-templates'), 403);
});

test('feedback reaches the platform team and no one else in the community', async () => {
  ok(await C.admin.post('/api/feedback', { kind: 'idea', body: 'A reminder before the AGM proxy deadline', page: '/notices' }));
  ok(await C.admin.post('/api/feedback', { kind: 'nonsense', body: 'x' }), 400);
  const rows = (await h.platform.query(`select kind, body from app.feedback where tenant_id = $1`, [C.id])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'idea');
});

test('vouchers import from a spreadsheet only when every row passes; each goes through approval', async () => {
  const fm = await member('Facility Imports', '+919001000003', 'facility_manager');
  // With no one on the committee, nothing can be approved, so nothing is saved.
  ok(await fm.post('/api/vendors', { name: 'Seat Check Vendor', categories: ['general'] }));
  const early = await fm.post('/api/finance/vouchers/import', { rows: [{ payee: 'Seat Check Vendor', description: 'Test', amount: 100, account: '5060' }] });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /Nothing was saved/);
  const committee = ok(await C.admin.get('/api/committees'))[0];
  const seat = await C.person('Committee Seat', '+919001000004');
  ok(await C.admin.post('/api/members', { personId: seat.id, roleId: roles.find(r => r.key === 'committee_member').id, scopeNodeId: null }));
  ok(await C.admin.post(`/api/committees/${committee.id}/seats`, { personId: seat.id }));
  ok(await fm.post('/api/vendors', { name: 'Kosu Pest Control', categories: ['pest_control'] }));
  const rows = [
    { payee: 'Kosu Pest Control', description: 'Fogging, October', amount: '6,500', account: '5060', invoiceNo: 'KP/88', invoiceDate: '31/10/2026' },
    { payee: 'Murugan Electricals', description: 'Bulbs and switches', amount: 2400, account: 'no-such-account' },
  ];
  const preview = ok(await fm.post('/api/finance/vouchers/import', { preview: true, rows }));
  assert.equal(preview.errors, 1);
  assert.match(preview.rows[1].error, /no account/);
  const refused = ok(await fm.post('/api/finance/vouchers/import', { rows }));
  assert.equal(refused.saved, false);
  rows[1].account = '5060';
  const dup = [...rows, { ...rows[0] }];
  assert.match(ok(await fm.post('/api/finance/vouchers/import', { preview: true, rows: dup })).rows[2].error, /appears twice/);
  const done = ok(await fm.post('/api/finance/vouchers/import', { rows }));
  assert.equal(done.saved, true);
  assert.equal(done.vouchers.length, 2);
  const v = ok(await C.admin.get(`/api/finance/vouchers/${done.vouchers[0].id}`));
  assert.equal(v.vendor, 'Kosu Pest Control', 'a known vendor is linked by name');
  assert.equal(v.invoice_date, '2026-10-31');
  assert.equal(v.approval_status, 'pending');
  ok(await fm.post('/api/finance/vouchers/import', { rows: [rows[0]] }), 409);
  const staff = h.client(C.host, await h.sessionFor(C.id, '+919001000002'));
  ok(await staff.post('/api/finance/vouchers/import', { rows }), 403);
});
