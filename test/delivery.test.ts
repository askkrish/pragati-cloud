// Project delivery and the controls carried over from JAOA: contract, change orders through the
// approval rules, milestones and handover; asset service logs; GST checks on vouchers; permits for
// work that needs the committee's permission; and decisions flagged when they wait too long.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
let roles: any[];
let committeeId: string;
let fm: ReturnType<Harness['client']>, c1: ReturnType<Harness['client']>, c2: ReturnType<Harness['client']>;
let fmPerson: any, c1Person: any;
const ok = (r: { status: number; body: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
async function upload(client: ReturnType<Harness['client']>, purpose: string) {
  const b = '----x';
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="f.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), PDF, Buffer.from(`\r\n--${b}--\r\n`)]);
  return client.call('POST', `/api/files?purpose=${purpose}`, payload, { 'content-type': `multipart/form-data; boundary=${b}` });
}
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

async function member(name: string, phone: string, roleKey: string, seat = false, scopeNodeId: string | null = null) {
  const p = await C.person(name, phone);
  ok(await C.admin.post('/api/members', { personId: p.id, roleId: roles.find(r => r.key === roleKey).id, scopeNodeId }));
  if (seat) ok(await C.admin.post(`/api/committees/${committeeId}/seats`, { personId: p.id }));
  return { person: p, client: h.client(C.host, await h.sessionFor(C.id, phone)) };
}
const approve = async (id: string) => { for (const c of [c1, c2]) { const r = await c.post(`/api/approvals/${id}/vote`, { vote: 'approve' }); if (r.status !== 200 && r.status !== 409) ok(r); } };

before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'dlv');
  roles = (await C.admin.get('/api/roles')).body;
  committeeId = ok(await C.admin.get('/api/committees'))[0].id;
  ({ client: fm, person: fmPerson } = await member('Facility Manager', '+919000800001', 'facility_manager'));
  ({ client: c1, person: c1Person } = await member('Committee One', '+919000800002', 'committee_member', true));
  ({ client: c2 } = await member('Committee Two', '+919000800003', 'committee_member', true));
});
after(() => h.close());

test('a project runs from request for quotation to an accepted handover, with change orders approved under the rules', async () => {
  const wo = ok(await fm.post('/api/work', { kind: 'project', title: 'Boom barrier and pedestrian gate', nodeId: C.root.id, category: 'security' }));
  const v1 = ok(await fm.post('/api/vendors', { name: 'Silvervista Automation', categories: ['security'] }));
  const v2 = ok(await fm.post('/api/vendors', { name: 'Park Smart Systems', categories: ['security'] }));

  // A request for quotation names the scope, the reply date and the vendors asked.
  ok(await fm.post(`/api/work/${wo.id}/rfqs`, { scope: 'short', replyBy: addDays(today, 7) }), 400);
  const rfq = ok(await fm.post(`/api/work/${wo.id}/rfqs`, { scope: 'Boom barrier with RFID tags, pedestrian gate, civil work, 2-year AMC', replyBy: addDays(today, 7), vendorIds: [v1.id, v2.id] }));
  assert.match(rfq.ref, /^RQ-/);
  ok(await c1.post(`/api/work/${wo.id}/rfqs`, { scope: 'Committee members do not send requests for quotation', replyBy: addDays(today, 7) }), 403);

  const q1 = ok(await fm.post(`/api/work/${wo.id}/quotes`, { vendorId: v1.id, amount: 300000, tax: 'excluded', gst: 54000, scope: 'As asked', validUntil: '2099-01-01' }));
  ok(await fm.post(`/api/work/${wo.id}/quotes`, { vendorId: v2.id, amount: 380000, tax: 'included', scope: 'As asked', validUntil: '2099-01-01' }));
  let d = ok(await c1.get(`/api/work/${wo.id}/delivery`));
  assert.deepEqual(d.rfqs[0].vendors.map((v: any) => v.quoted), [true, true]);
  assert.equal(d.actions.contract, false, 'committee members see delivery but do not run it');

  // No contract before a vendor is chosen, except an agreement made before the platform, with a note.
  ok(await fm.post(`/api/work/${wo.id}/contract`, { amount: 354000 }), 409);
  const sel = ok(await fm.post(`/api/work/${wo.id}/select`, { quoteId: q1.id, reason: 'Lower total with GST; RFID tags included' }));
  await approve(sel.approvalId);
  ok(await fm.post(`/api/work/${wo.id}/contract`, { amount: 400000 }), 400);
  const ct = ok(await fm.post(`/api/work/${wo.id}/contract`, { amount: 350000, startsOn: today, finishBy: addDays(today, 30), terms: '30% advance, 60% on installation, 10% after a month' }));
  ok(await fm.post(`/api/work/${wo.id}/contract`, {}), 409);

  // Changes wait for the signed copy, then go through the approval rules.
  ok(await fm.post(`/api/contracts/${ct.id}/changes`, { scope: 'Second boom arm at the exit', reason: 'Exit queue', delta: 60000 }), 409);
  const wrongKind = ok(await upload(fm, 'evidence'));
  ok(await fm.post(`/api/contracts/${ct.id}/sign`, { signedOn: today, reference: 'SV/2026/44', fileId: wrongKind.id }), 400);
  const signed = ok(await upload(fm, 'contract'));
  ok(await fm.post(`/api/contracts/${ct.id}/sign`, { signedOn: today, reference: 'SV/2026/44', fileId: signed.id }));
  const ch = ok(await fm.post(`/api/contracts/${ct.id}/changes`, { scope: 'Second boom arm at the exit', reason: 'Exit queue at peak hours', delta: '60,000', daysDelta: 5 }));
  ok(await fm.post(`/api/contracts/${ct.id}/changes`, { scope: 'Another', reason: 'While one waits', delta: 1000 }), 409);
  const ap = ok(await c1.get(`/api/approvals/${ch.approvalId}`));
  assert.equal(ap.subjectType, 'work_order_change');
  assert.match(ap.details, /₹3,50,000 now; adds ₹60,000, making ₹4,10,000/);
  d = ok(await fm.get(`/api/work/${wo.id}/delivery`));
  assert.equal(d.contract.committed_paise, 35000000, 'a change counts only once approved');
  await approve(ch.approvalId);
  d = ok(await fm.get(`/api/work/${wo.id}/delivery`));
  assert.equal(d.contract.committed_paise, 41000000);
  assert.equal(d.contract.finish_by_now, addDays(today, 35));

  // Milestones.
  const m1 = ok(await fm.post(`/api/work/${wo.id}/milestones`, { title: 'Civil work and cabling', dueOn: addDays(today, 10) }));
  ok(await fm.post(`/api/work/${wo.id}/milestones`, { title: 'Installation and RFID tags', dueOn: addDays(today, 25), amount: 210000 }));
  ok(await fm.patch(`/api/milestones/${m1.id}`, { done: true }), 400);
  ok(await fm.patch(`/api/milestones/${m1.id}`, { done: true, note: 'Foundation cured; conduits laid' }));

  // Contracted work is finished by an accepted handover, not by marking it done.
  ok(await fm.post(`/api/work/${wo.id}/status`, { to: 'in_progress' }));
  ok(await fm.post(`/api/work/${wo.id}/status`, { to: 'done', note: 'Installed' }), 409);
  ok(await fm.post(`/api/work/${wo.id}/handover`, { tests: 'Boom cycles 50 times', defects: 'None', recipientId: fmPerson.id }), 400);
  const { person: staff } = await member('Gate Staff', '+919000800004', 'staff');
  ok(await fm.post(`/api/work/${wo.id}/handover`, { tests: 'Boom cycles 50 times', defects: 'None', recipientId: staff.id }), 400, );
  const evidence = ok(await upload(fm, 'evidence'));
  const ho = ok(await fm.post(`/api/work/${wo.id}/handover`, { tests: 'Boom cycled 50 times; RFID read at 3 m; power-cut manual release works', defects: 'Exit arm paint scratch',
    warranty: '2 years parts and labour', fileId: evidence.id, recipientId: c1Person.id }));
  assert.deepEqual(ho.openMilestones, ['Installation and RFID tags']);
  ok(await fm.post(`/api/work/${wo.id}/handover`, { tests: 'Again', defects: 'None', recipientId: c1Person.id }), 409);
  ok(await fm.post(`/api/handovers/${ho.id}/respond`, { decision: 'accepted', note: 'Fine' }), 404, );

  // The recipient sees the handover and its document, returns it, then accepts the second one.
  assert.equal((await c1.get(`/api/files/${evidence.id}`)).status, 200);
  ok(await c1.post(`/api/handovers/${ho.id}/respond`, { decision: 'returned', note: 'Repaint the exit arm first' }));
  let w = ok(await fm.get(`/api/work/${wo.id}`));
  assert.equal(w.status, 'in_progress');
  const ho2 = ok(await fm.post(`/api/work/${wo.id}/handover`, { tests: 'As before; exit arm repainted', defects: 'None', recipientId: c1Person.id }));
  assert.equal(ok(await c1.get('/api/handovers/mine')).length, 1);
  ok(await c1.post(`/api/handovers/${ho2.id}/respond`, { decision: 'accepted', note: 'Checked at site with the guard' }));
  w = ok(await fm.get(`/api/work/${wo.id}`));
  assert.equal(w.status, 'done');
  d = ok(await fm.get(`/api/work/${wo.id}/delivery`));
  assert.deepEqual(d.handovers.map((x: any) => x.status), ['accepted', 'returned']);
  assert.equal(d.actions.handover, false);
});

test('an agreement made before the platform is recorded with a note', async () => {
  const wo = ok(await fm.post('/api/work', { kind: 'project', title: 'Big lift AMC renewal', nodeId: C.root.id, category: 'lifts' }));
  const v = ok(await fm.post('/api/vendors', { name: 'Velan Lifts', categories: ['lifts'] }));
  ok(await fm.post(`/api/work/${wo.id}/contract`, { amount: 120000, vendorId: v.id }), 409);
  const ct = ok(await fm.post(`/api/work/${wo.id}/contract`, { amount: 120000, vendorId: v.id, earlierNote: 'Signed in October before using the platform' }));
  assert.match(ct.ref, /^CT-/);
});

test('assets keep a service log; a failed check raises a work order and next dues are listed', async () => {
  const asset = ok(await fm.post('/api/assets', { name: 'Fire pump', kind: 'fire_safety', nodeId: C.root.id }));
  ok(await fm.post(`/api/assets/${asset.id}/services`, { servicedOn: addDays(today, 1), provider: 'Agni Fire', outcome: 'passed' }), 400);
  ok(await fm.post(`/api/assets/${asset.id}/services`, { servicedOn: today, provider: 'Agni Fire', outcome: 'follow_up' }), 400);
  const s = ok(await fm.post(`/api/assets/${asset.id}/services`, { servicedOn: today, kind: 'inspection', provider: 'Agni Fire', outcome: 'follow_up',
    notes: 'Jockey pump pressure switch sticking', nextDueOn: addDays(today, 20), raiseWorkOrder: true }));
  assert.match(s.workRef, /^WO-/);
  const a = ok(await fm.get(`/api/assets/${asset.id}`));
  assert.equal(a.services.length, 1);
  assert.equal(a.services[0].work_ref, s.workRef);
  assert.equal(a.nextServiceOn, addDays(today, 20));
  const wo = ok(await fm.get(`/api/work/${s.workId}`));
  assert.equal(wo.priority, 'high');
  assert.equal(wo.category, 'fire_safety');
  assert.ok(ok(await fm.get('/api/assets-due?within=30')).some((x: any) => x.id === asset.id));
  assert.ok(!ok(await fm.get('/api/assets-due?within=10')).some((x: any) => x.id === asset.id));
});

test('GST on a voucher: recorded by the preparer, verified by the treasurer, and no payment while pending', async () => {
  const { client: treasurer } = await member('Treasurer T', '+919000800005', 'treasurer');
  const accounts = ok(await C.admin.get('/api/finance/accounts'));
  const bank = ok(await C.admin.post('/api/finance/accounts', { name: 'Operating account', cashKind: 'bank', bankName: 'Sample Bank', last4: '1111', opening: 500000, openedOn: addDays(today, -10) }));
  const vendor = ok(await fm.post('/api/vendors', { name: 'Kaval Security', categories: ['security'] }));
  const v = ok(await fm.post('/api/finance/vouchers', { vendorId: vendor.id, description: 'Guards, October', amount: 50000, accountId: accounts.find((a: any) => a.code === '5060').id,
    nodeId: C.root.id, invoiceNo: 'KS/118' }));
  await approve(v.approvalId);
  ok(await fm.post(`/api/finance/vouchers/${v.id}/gst`, { status: 'pending', gstin: 'BAD' }), 400);
  ok(await fm.post(`/api/finance/vouchers/${v.id}/gst`, { status: 'pending', gstin: '33aabcu9603r1zx' }));
  ok(await fm.post(`/api/finance/vouchers/${v.id}/gst`, { status: 'verified', gstin: '33AABCU9603R1ZX' }), 403);
  ok(await treasurer.post(`/api/finance/vouchers/${v.id}/pay`, { accountId: bank.id, date: today, mode: 'neft', reference: 'N1' }), 409);
  ok(await treasurer.post(`/api/finance/vouchers/${v.id}/gst`, { status: 'verified', gstin: '33AABCU9603R1ZX', note: 'Active on the GST portal' }));
  const d = ok(await treasurer.get(`/api/finance/vouchers/${v.id}`));
  assert.equal(d.gst_status, 'verified');
  assert.equal(d.gst_checked_by_name, 'Treasurer T');
  assert.equal(d.vendor_gstin, '33AABCU9603R1ZX', 'the vendor record picks up the verified GSTIN');
  ok(await treasurer.post(`/api/finance/vouchers/${v.id}/pay`, { accountId: bank.id, date: today, mode: 'neft', reference: 'N1' }));
});

test('requests that need a permit wait for the committee; revoking stops the work', async () => {
  ok(await C.admin.post(`/api/units/${C.unitA.id}/owners`, { newPerson: { name: 'Owner P', phone: '+919000800010' }, sharePct: 100 }));
  const owner = h.client(C.host, await h.sessionFor(C.id, '+919000800010'));
  const r = ok(await owner.post('/api/work', { kind: 'request', title: 'Dish antenna on the terrace', unitId: C.unitA.id, permitKind: 'terrace_work',
    details: 'Cabling through the shaft to A-101' }));
  ok(await fm.post(`/api/work/${r.id}/status`, { to: 'open' }));
  ok(await fm.post(`/api/work/${r.id}/status`, { to: 'in_progress' }), 409);
  ok(await fm.post(`/api/work/${r.id}/permit`, { decision: 'approved', note: 'ok' }), 403);
  const mine = ok(await owner.get(`/api/work/${r.id}`));
  assert.equal(mine.permit.granted, false);
  assert.equal(mine.actions.decidePermit, false);
  ok(await c1.post(`/api/work/${r.id}/permit`, { decision: 'approved', note: 'Approved at the council meeting', conditions: 'No drilling into the waterproofing; work 10 am to 5 pm',
    validUntil: addDays(today, 14) }));
  ok(await c1.post(`/api/work/${r.id}/permit`, { decision: 'declined', note: 'Changed mind' }), 409);
  ok(await fm.post(`/api/work/${r.id}/status`, { to: 'in_progress' }));
  ok(await c2.post(`/api/work/${r.id}/permit`, { decision: 'revoked', note: 'Cable routed over the parapet against the conditions' }));
  const w = ok(await owner.get(`/api/work/${r.id}`));
  assert.equal(w.status, 'on_hold');
  assert.equal(w.permit.latest.status, 'revoked');
  assert.ok(w.updates.some((u: any) => /Permit revoked/.test(u.body)), 'the owner sees the decision');
});

test('decisions waiting longer than the community allows are flagged', async () => {
  const wo = ok(await fm.post('/api/work', { kind: 'maintenance', title: 'Repaint the parking lines', nodeId: C.root.id, estimate: 20000 }));
  const req = ok(await fm.post(`/api/work/${wo.id}/approval`, { title: 'Repaint the parking lines', amount: 20000 }));
  ok(await C.admin.patch('/api/settings', { escalationDays: 2 }));
  await h.asOwner(C.id, `update app.approval_requests set created_at = now() - interval '3 days' where id = $1`, [req.id ?? req.approvalId]);
  const list = ok(await c1.get('/api/approvals'));
  const row = list.find((x: any) => x.id === (req.id ?? req.approvalId));
  assert.equal(row.escalated, true);
  assert.equal(row.waiting_days, 3);
});
