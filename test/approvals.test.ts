import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
let apex: any, blockCommittee: any;
const members: Record<string, { id: string; c: ReturnType<Harness['client']> }> = {};

before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'votes');
  const roles = (await C.admin.get('/api/roles')).body;
  const roleId = (k: string) => roles.find((r: any) => r.key === k).id;
  apex = (await C.admin.get('/api/committees')).body.find((c: any) => c.kind === 'apex');
  blockCommittee = (await C.admin.post('/api/committees', { name: 'Block A committee', kind: 'block', scopeNodeId: C.blockA.id })).body;
  const add = async (key: string, phone: string, committee: any, position: string, role: string, scope: string | null = null) => {
    const p = await C.person(key, phone);
    await C.admin.post('/api/members', { personId: p.id, roleId: roleId(role), scopeNodeId: scope });
    await C.admin.post(`/api/committees/${committee.id}/seats`, { personId: p.id, position });
    members[key] = { id: p.id, c: h.client(C.host, await h.sessionFor(C.id, phone)) };
  };
  await add('President', '+919000200001', apex, 'president', 'office_bearer');
  await add('Treasurer', '+919000200002', apex, 'treasurer', 'office_bearer');
  await add('Member3', '+919000200003', apex, 'member', 'committee_member');
  await add('BlockLead', '+919000200011', blockCommittee, 'president', 'block_committee_member', C.blockA.id);
  await add('BlockTwo', '+919000200012', blockCommittee, 'member', 'block_committee_member', C.blockA.id);
  await add('BlockThree', '+919000200013', blockCommittee, 'member', 'block_committee_member', C.blockA.id);
});
after(() => h.close());

const raise = (who: string, body: any) => members[who].c.post('/api/approvals', { subjectType: 'expense', ...body });
const vote = (who: string, id: string, v: 'approve' | 'object', note = '') => members[who].c.post(`/api/approvals/${id}/vote`, { vote: v, note });

describe('the default JAOA rule: every committee member must approve', () => {
  test('the proposer counts as approving; the last approval settles it', async () => {
    const r = (await raise('President', { title: 'Repaint the lobby', amount: 45000 })).body;
    assert.equal(r.status, 'pending');
    assert.equal(r.stages[0].approvals, 1);
    assert.equal(r.stages[0].required, 3);
    assert.equal((await vote('Treasurer', r.id, 'approve')).body.status, 'pending');
    assert.equal((await vote('Member3', r.id, 'approve')).body.status, 'approved');
  });

  test('an objection needs a reason, blocks approval, and can be changed', async () => {
    const r = (await raise('President', { title: 'New gym equipment', amount: 120000 })).body;
    assert.equal((await vote('Treasurer', r.id, 'object')).status, 400);
    const o = (await vote('Treasurer', r.id, 'object', 'Get a second quote first')).body;
    assert.equal(o.stages[0].objections, 1);
    assert.equal((await vote('Member3', r.id, 'approve')).body.status, 'pending');
    assert.equal((await vote('Treasurer', r.id, 'approve', 'Second quote received')).body.status, 'approved');
  });

  test('someone who leaves the committee stops counting, so the request settles', async () => {
    const r = (await raise('President', { title: 'Fix the gate motor', amount: 30000 })).body;
    await vote('Treasurer', r.id, 'approve');
    const seat = (await C.admin.get('/api/committees')).body.find((c: any) => c.id === apex.id).seats
      .find((s: any) => s.person_id === members.Member3.id);
    const end = (await C.admin.post(`/api/seats/${seat.id}/end`, { reason: 'Moved out' })).body;
    assert.equal(end.rechecked, 1);
    const after = (await C.admin.get(`/api/approvals/${r.id}`)).body;
    assert.equal(after.status, 'approved');
    assert.equal(after.stages[0].voters.find((v: any) => v.name === 'Member3').active, false);
    await C.admin.post(`/api/committees/${apex.id}/seats`, { personId: members.Member3.id, position: 'member' });
  });

  test('people outside the deciding committee cannot vote', async () => {
    const r = (await raise('President', { title: 'Buy chairs', amount: 9000 })).body;
    assert.equal((await vote('BlockLead', r.id, 'approve')).status, 403);
  });

  test('only one open request per subject', async () => {
    const subjectId = '00000000-0000-4000-8000-000000000001';
    assert.equal((await raise('President', { title: 'Award lift AMC', subjectId, subjectType: 'vendor_selection' })).status, 200);
    const dup = await raise('Treasurer', { title: 'Award lift AMC again', subjectId, subjectType: 'vendor_selection' });
    assert.equal(dup.status, 409);
  });
});

describe('rules for a larger community', () => {
  before(async () => {
    // Block costs under ₹2 lakh: that block's committee, by majority.
    // ₹2 lakh and over: the block committee by majority, then the managing committee unanimously.
    const ok = async (body: any) => assert.equal((await C.admin.post('/api/approval-rules', body)).status, 200);
    await ok({ name: 'Block costs under ₹2 lakh', subjectType: 'expense', maxAmount: 200000,
      stages: [{ label: 'Block committee', committeeSelector: 'nearest', mode: 'majority' }] });
    await ok({ name: 'Costs of ₹2 lakh and over', subjectType: 'expense', minAmount: 200000, stages: [
      { label: 'Block committee', committeeSelector: 'nearest', mode: 'majority' },
      { label: 'Managing committee', committeeSelector: 'apex', mode: 'unanimous' }] });
    await ok({ name: 'Policies: any two office bearers', subjectType: 'policy', stages: [
      { label: 'Managing committee', committeeSelector: 'fixed', committeeId: apex.id, mode: 'count', requiredCount: 2 }] });
  });

  test('a small Block A cost goes to the Block A committee only', async () => {
    const p = (await members.BlockLead.c.post('/api/approval-rules/preview', { subjectType: 'expense', amount: 50000, scopeNodeId: C.blockA.id })).body;
    assert.equal(p.rule.name, 'Block costs under ₹2 lakh');
    assert.deepEqual(p.stages.map((s: any) => [s.committee.name, s.required]), [['Block A committee', 2]]);
    const r = (await raise('BlockLead', { title: 'Block A corridor lights', amount: 50000, scopeNodeId: C.blockA.id })).body;
    assert.equal(r.stages.length, 1);
    assert.equal((await vote('BlockTwo', r.id, 'approve')).body.status, 'approved');
  });

  test('a large Block A cost escalates from the block committee to the managing committee', async () => {
    const r = (await raise('BlockLead', { title: 'Block A lift modernisation', amount: '6,50,000', scopeNodeId: C.blockA.id })).body;
    assert.deepEqual(r.stages.map((s: any) => s.committee), ['Block A committee', 'Managing committee']);
    assert.equal(r.amountPaise, '65000000');
    assert.equal((await vote('President', r.id, 'approve')).status, 403, 'stage 2 is not open yet');
    const s1 = (await vote('BlockThree', r.id, 'approve')).body;
    assert.equal(s1.currentStage, 2);
    assert.equal(s1.stages[1].status, 'open');
    await vote('President', r.id, 'approve');
    await vote('Treasurer', r.id, 'approve');
    assert.equal((await vote('Member3', r.id, 'approve')).body.status, 'approved');
  });

  test('a community-wide request with both stages on one committee decides once, under the stricter rule', async () => {
    const r = (await raise('President', { title: 'Resurface the internal road', amount: 900000 })).body;
    assert.equal(r.stages.length, 1);
    assert.equal(r.stages[0].mode, 'unanimous');
  });

  test('a fixed count of approvals', async () => {
    const r = (await raise('Member3', { title: 'Pet policy', subjectType: 'policy' })).body;
    assert.equal(r.stages[0].required, 2);
    assert.equal((await vote('Treasurer', r.id, 'approve')).body.status, 'approved');
  });

  test('changing a rule does not change requests already raised', async () => {
    const r = (await raise('BlockLead', { title: 'Block A water tank cleaning', amount: 20000, scopeNodeId: C.blockA.id })).body;
    const rule = (await C.admin.get('/api/approval-rules')).body.find((x: any) => x.name === 'Block costs under ₹2 lakh');
    await C.admin.put(`/api/approval-rules/${rule.id}`, { name: rule.name, subjectType: 'expense', maxAmount: 200000,
      stages: [{ label: 'Block committee', committeeSelector: 'nearest', mode: 'unanimous' }] });
    const v = (await vote('BlockTwo', r.id, 'approve')).body;
    assert.equal(v.status, 'approved', 'majority still applies to the open request');
    assert.equal(v.rule.version, 1);
  });
});

describe('closing a request', () => {
  test('approval by signed letter needs an office bearer and the letter', async () => {
    const r = (await raise('Member3', { title: 'Emergency pump replacement', amount: 80000 })).body;
    assert.equal(r.actions.override, false);
    const noFile = await members.President.c.post(`/api/approvals/${r.id}/override`,
      { note: 'Letter of 25 Nov signed by all members', fileId: '00000000-0000-4000-8000-000000000009' });
    assert.equal(noFile.status, 400);
    const pdf = Buffer.from('%PDF-1.4\n% signed letter\n');
    const boundary = 'x-boundary';
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="letter.pdf"\r\n` +
      'Content-Type: application/pdf\r\n\r\n'), pdf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const up = await members.President.c.call('POST', '/api/files?purpose=approval_letter', payload,
      { 'content-type': `multipart/form-data; boundary=${boundary}` });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal((await members.Member3.c.post(`/api/approvals/${r.id}/override`, { note: 'x', fileId: up.body.id })).status, 403);
    const done = (await members.President.c.post(`/api/approvals/${r.id}/override`,
      { note: 'Letter of 25 Nov signed by all members', fileId: up.body.id })).body;
    assert.equal(done.status, 'approved');
    assert.equal(done.override.byName, 'President');
    const dl = await members.Treasurer.c.get(`/api/files/${up.body.id}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.raw.headers['content-disposition'], 'attachment; filename="letter.pdf"');
  });

  test('a disguised file is refused', async () => {
    const boundary = 'y';
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evil.pdf"\r\n` +
      `Content-Type: application/pdf\r\n\r\n<script>alert(1)</script>\r\n--${boundary}--\r\n`);
    const up = await members.President.c.call('POST', '/api/files?purpose=approval_letter', payload,
      { 'content-type': `multipart/form-data; boundary=${boundary}` });
    assert.equal(up.status, 400);
  });

  test('the proposer can withdraw; an office bearer can close as rejected; both are final', async () => {
    const a = (await raise('Member3', { title: 'Paint the compound wall', amount: 60000 })).body;
    assert.equal((await members.Treasurer.c.post(`/api/approvals/${a.id}/withdraw`, { note: '' })).status, 200, 'office bearer');
    const b = (await raise('Member3', { title: 'Install a fountain', amount: 300000 })).body;
    assert.equal((await members.Member3.c.post(`/api/approvals/${b.id}/reject`, { note: 'no' })).status, 403);
    assert.equal((await members.President.c.post(`/api/approvals/${b.id}/reject`, { note: 'Not in this year\'s budget' })).body.status, 'rejected');
    assert.equal((await vote('Treasurer', b.id, 'approve')).status, 409);
  });

  test('every step is in the audit trail', async () => {
    const trail = (await C.admin.get('/api/audit?entityType=approval_request&limit=200')).body.map((a: any) => a.summary);
    assert.ok(trail.some((s: string) => /approved by signed letter/.test(s)));
    assert.ok(trail.some((s: string) => /closed as rejected/.test(s)));
    assert.ok(trail.some((s: string) => /objected to/.test(s)));
  });
});
