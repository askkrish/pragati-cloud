// Procurement: quotations, the like-for-like comparison, choosing a vendor through the approval
// rules, and reviews; with JAOA's safeguards (a reason always, a justification for a single
// quotation, revised quotes keep the original).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compare } from '../server/src/routes/procurement.ts';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
let roles: any[];
let committeeId: string;
const ok = (r: { status: number; body: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'proc');
  roles = (await C.admin.get('/api/roles')).body;
  committeeId = ok(await C.admin.get('/api/committees'))[0].id;
});
after(() => h.close());

async function member(name: string, phone: string, roleKey: string, seat = false) {
  const p = await C.person(name, phone);
  ok(await C.admin.post('/api/members', { personId: p.id, roleId: roles.find(r => r.key === roleKey).id, scopeNodeId: null }));
  if (seat) ok(await C.admin.post(`/api/committees/${committeeId}/seats`, { personId: p.id }));
  return { person: p, client: h.client(C.host, await h.sessionFor(C.id, phone)) };
}

test('the comparison shows totals with GST only where known, and asks for missing terms', () => {
  const q = (o: any) => ({ id: o.vendor, vendor: o.vendor, amount_paise: o.amount, tax: o.tax, gst_paise: o.gst ?? null, timeline: o.t ?? '',
    warranty: o.w ?? '', valid_until: o.v ?? null, payment_terms: o.p ?? '', exclusions: o.x ?? '' });
  const full = { t: '3 weeks', w: '5 years', v: '2026-12-31', p: '30% advance', x: 'Scaffolding' };
  let c = compare([q({ vendor: 'A', amount: 100000, tax: 'included', ...full }), q({ vendor: 'B', amount: 80000, tax: 'excluded', gst: 14400, ...full })], '2026-11-01');
  assert.match(c.summary, /range from ₹944 to ₹1,000/);
  assert.equal(c.rows.find(r => r.vendor === 'B')!.lowest, true);
  assert.deepEqual(c.checks, []);
  c = compare([q({ vendor: 'A', amount: 100000, tax: 'unclear' }), q({ vendor: 'B', amount: 80000, tax: 'included', ...full, v: '2026-10-01' })], '2026-11-01');
  assert.match(c.summary, /same GST basis/);
  assert.ok(c.rows.every(r => !r.lowest));
  assert.match(c.checks[0], /^A: confirm the amount with GST, the delivery time, the warranty/);
  assert.match(c.checks[1], /^B: confirm a fresh validity/);
  assert.match(compare([q({ vendor: 'A', amount: 1, tax: 'included' })], '2026-11-01').summary, /Only one quotation/);
});

test('quotations are recorded, revised and compared; choosing a vendor goes through the approval rules', async () => {
  const { client: fm } = await member('Facility Manager', '+919000300001', 'facility_manager');
  const { client: c1 } = await member('Committee One', '+919000300002', 'committee_member', true);
  const { client: c2 } = await member('Committee Two', '+919000300003', 'committee_member', true);
  const wo = ok(await fm.post('/api/work', { kind: 'maintenance', title: 'Terrace waterproofing, Block A', nodeId: C.blockA.id, category: 'general' }));

  // Staff without procurement access cannot see quotations.
  const { client: staff } = await member('Staff S', '+919000300004', 'staff');
  ok(await staff.get(`/api/work/${wo.id}/quotes`), 404);

  const q1 = ok(await fm.post(`/api/work/${wo.id}/quotes`, { newVendor: { name: 'Mazhai Shield Waterproofing' }, amount: '2,40,000', tax: 'excluded', gst: '43,200',
    scope: 'Polyurethane coating, 2 coats, 4,200 sq ft', timeline: '3 weeks', warranty: '7 years', validUntil: '2099-01-01', paymentTerms: '40% advance' }));
  const q2 = ok(await fm.post(`/api/work/${wo.id}/quotes`, { newVendor: { name: 'Dakshin Coatings' }, amount: 265000, tax: 'included',
    scope: 'Same scope, acrylic membrane', timeline: '2 weeks' }));
  // Same name again is the same vendor, not a duplicate.
  ok(await fm.post(`/api/work/${wo.id}/quotes`, { newVendor: { name: ' mazhai shield waterproofing ' }, amount: 230000, tax: 'excluded', gst: 41400,
    scope: 'Revised after site visit', replacesId: q1.id, warranty: '7 years', timeline: '3 weeks', validUntil: '2099-01-01', paymentTerms: '30% advance', exclusions: 'Parapet' }));
  const vendors = ok(await fm.get('/api/vendors'));
  assert.equal(vendors.filter((v: any) => /mazhai/i.test(v.name)).length, 1);

  let view = ok(await c1.get(`/api/work/${wo.id}/quotes`));
  assert.equal(view.rows.length, 2, 'the revised quotation replaces the first');
  assert.equal(view.earlier.length, 1);
  assert.equal(view.rows.find((r: any) => r.vendor === 'Mazhai Shield Waterproofing').total_paise, 27140000);
  assert.equal(view.rows.find((r: any) => r.vendor === 'Mazhai Shield Waterproofing').lowest, false, 'no lowest while one total is unclear');
  assert.equal(view.actions.add, false, 'committee members see but do not enter quotations');
  assert.equal(view.actions.select, true);

  // A reason is required; the choice raises a vendor_selection approval carrying the comparison.
  ok(await c1.post(`/api/work/${wo.id}/select`, { quoteId: q2.id, reason: '' }), 400);
  const sel = ok(await c1.post(`/api/work/${wo.id}/select`, { quoteId: view.rows.find((r: any) => r.vendor.startsWith('Mazhai')).id,
    reason: 'Longer warranty; cost is lower once GST is added.' }));
  const approval = ok(await c1.get(`/api/approvals/${sel.approvalId}`));
  assert.equal(approval.subjectType, 'vendor_selection');
  assert.equal(approval.amountPaise, '27140000');
  assert.match(approval.details, /Dakshin Coatings \(QT-\d+\): ₹2,65,000 with GST/);
  ok(await c2.post(`/api/work/${wo.id}/select`, { quoteId: q2.id, reason: 'Cheaper' }), 409);

  // The committee approves; the work is awarded and no more quotations are taken.
  ok(await c2.post(`/api/approvals/${sel.approvalId}/vote`, { vote: 'approve' }));
  view = ok(await c1.get(`/api/work/${wo.id}/quotes`));
  assert.equal(view.award.vendor, 'Mazhai Shield Waterproofing');
  ok(await fm.post(`/api/work/${wo.id}/quotes`, { vendorId: vendors[0].id, amount: 1000, tax: 'included', scope: 'Late quote' }), 409);

  // Reviews: only once the work is done, and low scores need a comment.
  const vendorId = view.award.vendor_id;
  ok(await c1.post(`/api/vendors/${vendorId}/reviews`, { workOrderId: wo.id, quality: 5, timeliness: 4, value: 4, wouldRehire: true }), 400);
  ok(await fm.post(`/api/work/${wo.id}/status`, { to: 'in_progress' }));
  ok(await fm.post(`/api/work/${wo.id}/status`, { to: 'done', note: 'Coating complete; flood test passed' }));
  ok(await c1.post(`/api/vendors/${vendorId}/reviews`, { workOrderId: wo.id, quality: 2, timeliness: 4, value: 4, wouldRehire: true }), 400);
  ok(await c1.post(`/api/vendors/${vendorId}/reviews`, { workOrderId: wo.id, quality: 5, timeliness: 4, value: 4, wouldRehire: true, comment: 'Clean finish' }));
  const v = ok(await c1.get(`/api/vendors/${vendorId}`));
  assert.equal(v.scores.quality, 5);
  assert.equal(v.quotes.length, 2);
  assert.ok(v.quotes.some((q: any) => q.chosen === 'approved'));
});

test('a single quotation needs a justification, lapsed quotes cannot be chosen, blocked vendors cannot quote', async () => {
  const wo = ok(await C.admin.post('/api/work', { kind: 'maintenance', title: 'Replace the borewell pump', nodeId: C.root.id }));
  const q = ok(await C.admin.post(`/api/work/${wo.id}/quotes`, { newVendor: { name: 'Neer Pumps' }, amount: 38000, tax: 'included', scope: '3 HP submersible', validUntil: '2020-01-01' }));
  ok(await C.admin.post(`/api/work/${wo.id}/select`, { quoteId: q.id, reason: 'Only local supplier' }), 400);
  ok(await C.admin.post(`/api/work/${wo.id}/select`, { quoteId: q.id, reason: 'Only local supplier', singleQuoteReason: 'Urgent: no water' }), 400);
  ok(await C.admin.patch(`/api/vendors/${q.vendorId}`, { status: 'blocked' }), 400);
  ok(await C.admin.patch(`/api/vendors/${q.vendorId}`, { status: 'blocked', statusNote: 'Did not honour the last warranty' }));
  ok(await C.admin.post(`/api/work/${wo.id}/quotes`, { vendorId: q.vendorId, amount: 36000, tax: 'included', scope: 'Again' }), 400);
});
