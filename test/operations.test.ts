// Operations: routines and checks, work orders and service requests, and the asset register,
// with the access rules that matter most: block staff stay in their block, staff without full
// view see only their own work, and owners see their own requests without staff-only notes.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { localNow, addDays } from '../server/src/services/schedule.ts';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
let roles: any[];
const role = (key: string) => roles.find(r => r.key === key);
const today = localNow('Asia/Kolkata').day;

before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'ops');
  roles = (await C.admin.get('/api/roles')).body;
});
after(() => h.close());

async function personWithRole(name: string, phone: string, roleKey: string, scopeNodeId: string | null = null) {
  const p = await C.person(name, phone);
  const m = await C.admin.post('/api/members', { personId: p.id, roleId: role(roleKey).id, scopeNodeId });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  return { person: p, client: h.client(C.host, await h.sessionFor(C.id, phone)) };
}
const ok = (r: { status: number; body: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

test('existing administrators gain the new permissions and templates include them', async () => {
  const me = ok(await C.admin.get('/api/me'));
  for (const p of ['operations.view', 'operations.update', 'operations.manage']) assert.ok(me.permissions.includes(p), p);
  assert.deepEqual(role('staff').permissions.filter((p: string) => p.startsWith('operations')), ['operations.update']);
});

test('a routine is set up, recorded, and judged late or missed by its own window', async () => {
  const { person: guard, client: guardClient } = await personWithRole('Guard One', '+919000200001', 'staff');
  const r = ok(await C.admin.post('/api/routines', { title: 'Main gate round', category: 'security', nodeId: C.root.id, assigneeId: guard.id,
    schedule: { frequency: 'daily', startsOn: addDays(today, -3), startTime: '00:00', endTime: '00:01', readingLabel: 'Visitors logged', readingUnit: 'count' } }));
  assert.match(r.ref, /^RT-\d{4}$/);

  // The assigned guard sees it even without operations.view; yesterday's check is missed.
  const day = ok(await guardClient.get(`/api/ops/today?date=${addDays(today, -1)}`));
  assert.equal(day.rows.length, 1);
  assert.equal(day.rows[0].status, 'missed');

  // Done needs the reading; done after the window is late.
  ok(await guardClient.put(`/api/routines/${r.id}/checks/${addDays(today, -1)}`, { status: 'done', performedAt: '09:00' }), 400);
  const rec = ok(await guardClient.put(`/api/routines/${r.id}/checks/${addDays(today, -1)}`, { status: 'done', performedAt: '09:00', reading: '14' }));
  assert.equal(rec.late, true);
  // A skip needs a reason; future days cannot be recorded.
  ok(await guardClient.put(`/api/routines/${r.id}/checks/${addDays(today, -2)}`, { status: 'skipped' }), 400);
  ok(await guardClient.put(`/api/routines/${r.id}/checks/${addDays(today, -2)}`, { status: 'skipped', note: 'Gate closed for road work' }));
  ok(await guardClient.put(`/api/routines/${r.id}/checks/${addDays(today, 1)}`, { status: 'done', performedAt: '09:00', reading: '3' }), 400);

  const detail = ok(await C.admin.get(`/api/routines/${r.id}`));
  const byDay = Object.fromEntries(detail.days.map((d: any) => [d.day, d]));
  assert.equal(byDay[addDays(today, -1)].status, 'done');
  assert.equal(byDay[addDays(today, -1)].late, true);
  assert.equal(byDay[addDays(today, -2)].status, 'skipped');
  assert.equal(byDay[addDays(today, -3)].status, 'missed');
  assert.match(detail.schedule, /^Daily, 00:00 to 00:01$/);
});

test('a schedule change applies from today on and never rewrites past days', async () => {
  const r = ok(await C.admin.post('/api/routines', { title: 'Terrace inspection', nodeId: C.blockA.id,
    schedule: { frequency: 'daily', startsOn: addDays(today, -5) } }));
  ok(await C.admin.patch(`/api/routines/${r.id}`, { schedule: { frequency: 'weekly', weekdays: [9 % 7], startsOn: addDays(today, -5), effectiveFrom: addDays(today, -1) } }), 400);
  ok(await C.admin.patch(`/api/routines/${r.id}`, { schedule: { frequency: 'monthly', monthDays: [31], startsOn: addDays(today, -5), effectiveFrom: addDays(today, 1) } }));
  const d = ok(await C.admin.get(`/api/routines/${r.id}`));
  assert.equal(d.versions.length, 2);
  assert.ok(d.days.filter((x: any) => x.day < today).length >= 5, 'past days still follow the daily schedule');
});

test('block staff and block committees see only their block; blocked checks raise a work order', async () => {
  const { client: mgrA } = await personWithRole('Block A Manager', '+919000200002', 'facility_manager', C.blockA.id);
  const { client: commB } = await personWithRole('Block B Committee', '+919000200003', 'block_committee_member', C.blockB.id);
  const rA = ok(await mgrA.post('/api/routines', { title: 'Block A pump room check', category: 'water', nodeId: C.blockA.id,
    schedule: { frequency: 'daily', startsOn: today } }));
  ok(await mgrA.post('/api/routines', { title: 'Block B pump room check', nodeId: C.blockB.id, schedule: { frequency: 'daily', startsOn: today } }), 403);
  assert.ok(ok(await mgrA.get('/api/routines')).some((x: any) => x.id === rA.id));
  assert.ok(!ok(await commB.get('/api/routines')).some((x: any) => x.id === rA.id));
  ok(await commB.get(`/api/routines/${rA.id}`), 404);

  const blocked = ok(await mgrA.put(`/api/routines/${rA.id}/checks/${today}`, { status: 'blocked', note: 'Pump room flooded', raiseWorkOrder: true }));
  assert.ok(blocked.workOrderId);
  const wo = ok(await mgrA.get(`/api/work/${blocked.workOrderId}`));
  assert.equal(wo.kind, 'maintenance');
  assert.equal(wo.routineId, rA.id);
  ok(await commB.get(`/api/work/${blocked.workOrderId}`), 404);
});

test('an owner raises a request for their own home, sees only what is meant for them, and confirms the fix', async () => {
  const owner = ok(await C.admin.post(`/api/units/${C.unitA.id}/owners`, { newPerson: { name: 'Owner A', phone: '+919000200010' }, sharePct: 100 }));
  assert.ok(owner.id);
  const ownerClient = h.client(C.host, await h.sessionFor(C.id, '+919000200010'));
  const { person: tech, client: techClient } = await personWithRole('Technician', '+919000200011', 'staff');

  // Not for someone else's home.
  ok(await ownerClient.post('/api/work', { kind: 'request', title: 'Leak in the bathroom', unitId: C.unitB.id }), 403);
  ok(await ownerClient.post('/api/work', { kind: 'incident', title: 'Lift stuck', nodeId: C.blockA.id }), 403);
  const req = ok(await ownerClient.post('/api/work', { kind: 'request', title: 'Leak in the bathroom ceiling', unitId: C.unitA.id,
    details: 'Water drips when the flat above uses the shower', priority: 'urgent' }));
  let w = ok(await ownerClient.get(`/api/work/${req.id}`));
  assert.equal(w.status, 'new');
  assert.deepEqual(w.actions.moves.map((m: any) => m.to), ['cancelled']);

  // The technician cannot see it until it is given to them.
  ok(await techClient.get(`/api/work/${req.id}`), 404);
  ok(await C.admin.post(`/api/work/${req.id}/status`, { to: 'open' }));
  ok(await C.admin.patch(`/api/work/${req.id}`, { assigneeId: tech.id, dueOn: addDays(today, 2), estimate: '2,500' }));
  ok(await C.admin.post(`/api/work/${req.id}/updates`, { body: 'Plumber from outside may be needed; ask the treasurer', staffOnly: true }));
  ok(await ownerClient.post(`/api/work/${req.id}/updates`, { body: 'Secret', staffOnly: true }), 403);

  w = ok(await techClient.get(`/api/work/${req.id}`));
  assert.ok(w.actions.moves.some((m: any) => m.to === 'in_progress'));
  ok(await techClient.post(`/api/work/${req.id}/status`, { to: 'in_progress' }));
  ok(await techClient.post(`/api/work/${req.id}/status`, { to: 'done' }), 400);
  ok(await techClient.post(`/api/work/${req.id}/status`, { to: 'done', note: 'Replaced the waste coupling in the flat above' }));
  ok(await techClient.post(`/api/work/${req.id}/status`, { to: 'closed' }), 403);

  // The owner sees the public trail only: no staff notes, no estimate, no names of staff.
  w = ok(await ownerClient.get(`/api/work/${req.id}`));
  assert.equal(w.estimatePaise, null);
  assert.ok(!w.updates.some((u: any) => u.staff_only));
  assert.ok(!JSON.stringify(w.updates).includes('treasurer'));
  assert.ok(!JSON.stringify(w).includes('Technician'));
  assert.deepEqual(w.actions.moves.map((m: any) => m.to).sort(), ['closed', 'in_progress']);
  ok(await ownerClient.post(`/api/work/${req.id}/status`, { to: 'closed' }));
  const mine = ok(await ownerClient.get('/api/work?view=raised'));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'closed');
  // The owner has no operations access otherwise.
  ok(await ownerClient.get('/api/ops/today'), 403);
  ok(await ownerClient.get('/api/assets'), 403);
});

test('spending on a work order goes through the approval rules', async () => {
  const committee = ok(await C.admin.get('/api/committees'))[0];
  const treasurer = await C.person('Treasurer T', '+919000200040');
  ok(await C.admin.post(`/api/committees/${committee.id}/seats`, { personId: treasurer.id, position: 'treasurer' }));
  const p = ok(await C.admin.post('/api/work', { kind: 'project', title: 'Terrace waterproofing', nodeId: C.blockA.id, estimate: 420000 }));
  const a = ok(await C.admin.post(`/api/work/${p.id}/approval`, {}));
  assert.match(a.ref, /^AP-/);
  const approval = ok(await C.admin.get(`/api/approvals/${a.id}`));
  assert.equal(approval.subjectType, 'project');
  assert.equal(approval.amountPaise, '42000000');
  ok(await C.admin.post(`/api/work/${p.id}/approval`, {}), 409);
  const w = ok(await C.admin.get(`/api/work/${p.id}`));
  assert.equal(w.approval.ref, a.ref);
});

test('the asset register tracks renewals, keeps the old record when renewed, and flags what is due', async () => {
  const dg = ok(await C.admin.post('/api/assets', { name: 'DG set 125 kVA', kind: 'generator', nodeId: C.root.id, serviceBy: 'Kaveri Power Systems' }));
  assert.match(dg.ref, /^AS-/);
  const amc = ok(await C.admin.post('/api/renewals', { assetId: dg.id, kind: 'amc', title: 'DG set AMC', startsOn: addDays(today, -340),
    endsOn: addDays(today, 10), amount: '48,000' }));
  const noc = ok(await C.admin.post('/api/renewals', { nodeId: C.root.id, kind: 'licence', title: 'Fire NOC', endsOn: addDays(today, -3) }));
  let due = ok(await C.admin.get('/api/renewals?within=30'));
  assert.deepEqual(due.map((c: any) => [c.ref, c.state]), [[noc.ref, 'overdue'], [amc.ref, 'due']]);
  ok(await C.admin.post(`/api/renewals/${amc.id}/renew`, { endsOn: addDays(today, 5) }), 400);
  const next = ok(await C.admin.post(`/api/renewals/${amc.id}/renew`, { endsOn: addDays(today, 375), amount: 52000 }));
  due = ok(await C.admin.get('/api/renewals?within=30'));
  assert.deepEqual(due.map((c: any) => c.ref), [noc.ref]);
  const asset = ok(await C.admin.get(`/api/assets/${dg.id}`));
  assert.deepEqual(asset.contracts.map((c: any) => [c.ref, c.state]), [[next.ref, 'active'], [amc.ref, 'renewed']]);
  const summary = ok(await C.admin.get('/api/ops/summary'));
  assert.equal(summary.renewals.overdue, 1);
  // Staff without view cannot read the register.
  const { client: staff } = await personWithRole('Housekeeping', '+919000200020', 'staff');
  ok(await staff.get('/api/assets'), 403);
});

test('work photos: owners can add one to their request, and only the right people can download it', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const boundary = '----pragati';
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="leak.png"\r\nContent-Type: image/png\r\n\r\n`),
    png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const owner = h.client(C.host, await h.sessionFor(C.id, '+919000200010'));
  const up = await owner.call('POST', '/api/files?purpose=work_photo', body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const req = ok(await owner.post('/api/work', { kind: 'request', title: 'Balcony drain blocked', unitId: C.unitA.id }));
  ok(await owner.post(`/api/work/${req.id}/updates`, { body: 'Photo of the drain', fileId: up.body.id }));
  assert.equal((await C.admin.get(`/api/files/${up.body.id}`)).status, 200);
  const { client: stranger } = await personWithRole('Stranger', '+919000200030', 'resident');
  assert.equal((await stranger.get(`/api/files/${up.body.id}`)).status, 404);
});
