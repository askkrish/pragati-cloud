import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
let roles: any[];
const role = (key: string) => roles.find(r => r.key === key);

before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'perm');
  roles = (await C.admin.get('/api/roles')).body;
});
after(() => h.close());

async function personWithRole(name: string, phone: string, roleKey: string, scopeNodeId: string | null = null) {
  const p = await C.person(name, phone);
  const m = await C.admin.post('/api/members', { personId: p.id, roleId: role(roleKey).id, scopeNodeId });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  return { person: p, client: h.client(C.host, await h.sessionFor(C.id, phone)) };
}

test('a block committee member sees and changes only their block', async () => {
  const { client } = await personWithRole('Block A Member', '+919000100001', 'block_committee_member', C.blockA.id);
  const units = (await client.get('/api/units')).body.units.map((u: any) => u.label);
  assert.deepEqual(units, ['A-101']);
  assert.equal((await client.get(`/api/units/${C.unitA.id}`)).status, 200);
  assert.equal((await client.get(`/api/units/${C.unitB.id}`)).status, 404);
  const tree = (await client.get('/api/property/tree')).body.nodes;
  const names = tree.filter((n: any) => n.in_scope).map((n: any) => n.name);
  assert.ok(names.includes('Block A') && !names.includes('Block B'));
  assert.ok(tree.some((n: any) => !n.in_scope && n.parent_id === null), 'the community name is shown for context');
  // view-only role cannot add units even in its own block
  const add = await client.post('/api/units', { nodeId: C.blockA.id, unitTypeId: C.types[0].id, label: 'A-999' });
  assert.equal(add.status, 403);
});

test('a block-level manager can add units in their block but not in another', async () => {
  const mgr = (await C.admin.post('/api/roles', { key: 'block_manager', name: 'Block manager',
    permissions: ['property.view', 'property.manage', 'units.view', 'units.manage'] })).body;
  roles.push(mgr);
  const { client } = await personWithRole('Block A Manager', '+919000100002', 'block_manager', C.blockA.id);
  assert.equal((await client.post('/api/units', { nodeId: C.blockA.id, unitTypeId: C.types[0].id, label: 'A-201' })).status, 200);
  assert.equal((await client.post('/api/units', { nodeId: C.blockB.id, unitTypeId: C.types[0].id, label: 'B-201' })).status, 403);
  assert.equal((await client.post('/api/property/nodes', { parentId: C.root.id, kind: 'block', name: 'Block Z' })).status, 403);
  assert.equal((await client.post('/api/property/nodes', { parentId: C.blockA.id, kind: 'wing', name: 'Wing 1' })).status, 200);
});

test('nobody can hand out more access than they have', async () => {
  const lead = (await C.admin.post('/api/roles', { key: 'access_lead', name: 'Access lead',
    permissions: ['members.manage', 'people.view', 'people.manage'] })).body;
  roles.push(lead);
  const { client } = await personWithRole('Access Lead', '+919000100003', 'access_lead');
  const target = await C.person('Target', '+919000100004');
  const escalate = await client.post('/api/members', { personId: target.id, roleId: role('administrator').id });
  assert.equal(escalate.status, 403);
  const self = (await client.get('/api/me')).body.person.id;
  assert.equal((await client.post('/api/members', { personId: self, roleId: role('administrator').id })).status, 403);
  assert.equal((await client.post('/api/members', { personId: target.id, roleId: role('resident').id })).status, 200);
  // and cannot create a role with powers it lacks
  assert.equal((await client.post('/api/roles', { key: 'x', name: 'X', permissions: ['settings.manage'] })).status, 403);
});

test('the last administrator cannot be removed', async () => {
  const members = (await C.admin.get('/api/members')).body;
  const adminMembership = members.find((m: any) => m.role === 'Administrator');
  const r = await C.admin.post(`/api/members/${adminMembership.id}/disable`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'last_admin');
  const strip = await C.admin.patch(`/api/roles/${role('administrator').id}`, { permissions: ['people.view'] });
  assert.equal(strip.status, 409);
});

test('the community names its platform; "Pragati" is always added once', async () => {
  const r = await C.admin.patch('/api/settings', { brandName: 'Lakeview' });
  assert.equal(r.body.platform_name, 'Lakeview Pragati');
  assert.equal((await h.client(C.host).get('/api/public/community')).body.platformName, 'Lakeview Pragati');
  assert.equal((await C.admin.patch('/api/settings', { brandName: 'Lakeview Pragati' })).status, 400);
  const audit = (await C.admin.get('/api/audit?entityType=tenant')).body;
  assert.ok(audit.some((a: any) => a.summary === 'Renamed the platform to Lakeview Pragati'));
});

test('owners see their own home without a directory role; others\' homes stay hidden', async () => {
  const { person, client } = await personWithRole('Owner One', '+919000100005', 'owner');
  await C.admin.post(`/api/units/${C.unitA.id}/owners`, { personId: person.id, sharePct: 100 });
  const me = (await client.get('/api/me')).body;
  assert.deepEqual(me.homes.map((x: any) => x.label), ['A-101']);
  assert.equal((await client.get(`/api/units/${C.unitA.id}`)).status, 200);
  assert.equal((await client.get(`/api/units/${C.unitB.id}`)).status, 404);
  assert.equal((await client.get('/api/people')).status, 403);
  assert.equal((await client.get('/api/units')).status, 403);
  // and the owner's view of their unit hides other people's phone numbers
  const unit = (await client.get(`/api/units/${C.unitA.id}`)).body;
  assert.equal(unit.owners[0].phone, null);
});
