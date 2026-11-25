import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';
import { parseCsv, parseSegment } from '../server/src/services/import-units.ts';
import { normalisePhone } from '../server/src/auth/crypto.ts';
import { requiredVotes } from '../server/src/services/approvals.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'tree');
});
after(() => h.close());

describe('pure helpers', () => {
  test('CSV parsing handles quotes, commas and blank lines', () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n1,2'), [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
  });
  test('place kinds come from the first word or an explicit prefix', () => {
    assert.deepEqual(parseSegment('Tower Sky'), { kind: 'tower', name: 'Tower Sky' });
    assert.deepEqual(parseSegment('wing:North'), { kind: 'wing', name: 'North' });
    assert.deepEqual(parseSegment('3rd Floor'), { kind: 'floor', name: '3rd Floor' });
    assert.deepEqual(parseSegment('Palm Avenue'), { kind: 'other', name: 'Palm Avenue' });
  });
  test('Indian mobile numbers in everyday formats', () => {
    for (const v of ['98400 12345', '098400-12345', '+91 98400 12345', '919840012345']) assert.equal(normalisePhone(v), '+919840012345');
    assert.equal(normalisePhone('12345'), null);
    assert.equal(normalisePhone('+44 7700 900123'), '+447700900123');
  });
  test('votes needed by mode', () => {
    assert.equal(requiredVotes('unanimous', 7, null), 7);
    assert.equal(requiredVotes('majority', 7, null), 4);
    assert.equal(requiredVotes('majority', 6, null), 4);
    assert.equal(requiredVotes('count', 2, 3), 2);
    assert.equal(requiredVotes('any', 9, null), 1);
    assert.equal(requiredVotes('unanimous', 0, null), Infinity);
  });
});

describe('property tree', () => {
  test('moving a block moves everything inside it', async () => {
    const phase = (await C.admin.post('/api/property/nodes', { parentId: C.root.id, kind: 'phase', name: 'Phase 1' })).body;
    const wing = (await C.admin.post('/api/property/nodes', { parentId: C.blockA.id, kind: 'wing', name: 'North wing' })).body;
    const floor = (await C.admin.post('/api/property/nodes', { parentId: wing.id, kind: 'floor', name: 'Floor 1' })).body;
    assert.equal(floor.depth, 3);
    const moved = await C.admin.patch(`/api/property/nodes/${C.blockA.id}`, { parentId: phase.id });
    assert.equal(moved.status, 200);
    const [f] = await h.asApp(C.id, `select depth, ancestor_ids from app.property_nodes where id = $1`, [floor.id]);
    assert.equal(f.depth, 4);
    assert.deepEqual(f.ancestor_ids, [C.root.id, phase.id, C.blockA.id, wing.id]);
  });

  test('a place cannot be moved inside itself', async () => {
    const wing = (await C.admin.get('/api/property/tree')).body.nodes.find((n: any) => n.name === 'North wing');
    const r = await C.admin.patch(`/api/property/nodes/${C.blockA.id}`, { parentId: wing.id });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /inside one of its own/);
  });

  test('one top level per community, and names are unique among siblings', async () => {
    await assert.rejects(h.asApp(C.id, `insert into app.property_nodes (kind, name) values ('community', 'Second root')`), /duplicate key/);
    const dup = await C.admin.post('/api/property/nodes', { parentId: C.root.id, kind: 'block', name: 'Block B' });
    assert.equal(dup.status, 409);
  });

  test('a shared facility belongs to a place', async () => {
    const golf = await C.admin.post('/api/facilities', { nodeId: C.root.id, name: '9-hole golf course', kind: 'golf_course', bookable: true });
    assert.equal(golf.status, 200);
    const dash = (await C.admin.get('/api/dashboard')).body;
    assert.ok(dash.facilities.some((f: any) => f.name === '9-hole golf course'));
  });
});

describe('importing units', () => {
  const csv = [
    'location,unit,type,floor,carpet_sqft,super_sqft,uds_sqft,owner_name,owner_phone,owner_share',
    'Phase 2 > Tower Sky > Wing East > Floor 1,S-101,2BHK,1,1050,1380,412,Ravi K;Meena K,98400 11111;98400 22222,50;50',
    'Phase 2 > Tower Sky > Wing East > Floor 1,S-102,3 BHK,1,1400,1800,520,Ravi K,9840011111,100',
    'Phase 2 > street:Palm Avenue,Villa 7,villa,,2400,,1200,"Iyer, Lakshmi",98400 33333,',
    'Phase 2 > Tower Sky > Wing East > Floor 2,S-201,9BHK,2,,,,,,',
    'Phase 2 > Tower Sky > Wing West,S-101,2bhk,,,,,,,',
  ].join('\n');

  test('a preview runs every row but saves nothing, and names each bad row', async () => {
    const r = (await C.admin.post('/api/units/import', { csv, dryRun: true })).body;
    assert.equal(r.committed, false);
    assert.equal(r.unitsCreated, 3);
    assert.deepEqual(r.errors.map((e: any) => e.row), [5, 6]);
    assert.match(r.errors[0].message, /Unknown unit type "9BHK"/);
    assert.match(r.errors[1].message, /already exists/);
    assert.ok(r.locationsCreated.includes('Phase 2 > Tower Sky > Wing East > Floor 1'));
    assert.ok(!r.locationsCreated.includes('Phase 2 > Tower Sky > Wing East > Floor 2'), 'a failed row creates no places');
    const [n] = await h.asApp(C.id, `select count(*)::int as n from app.units where label like 'S-%'`);
    assert.equal(n.n, 0);
  });

  test('an import with errors saves nothing; a clean one saves everything', async () => {
    assert.equal((await C.admin.post('/api/units/import', { csv, dryRun: false })).status, 400);
    const clean = csv.split('\n').slice(0, 4).join('\n');
    const r = (await C.admin.post('/api/units/import', { csv: clean, dryRun: false })).body;
    assert.equal(r.committed, true);
    assert.equal(r.unitsCreated, 3);
    assert.equal(r.peopleCreated, 3, 'Ravi K is matched by number on the second row');
    const villa = (await C.admin.get('/api/units?q=Villa 7')).body.units[0];
    assert.equal(villa.type, 'Villa');
    assert.equal(villa.owners, 'Iyer, Lakshmi');
    const palm = (await C.admin.get('/api/property/tree')).body.nodes.find((n: any) => n.name === 'Palm Avenue');
    assert.equal(palm.kind, 'street');
  });
});

describe('ownership', () => {
  test('shares cannot exceed 100%', async () => {
    const p1 = await C.person('Owner A', '+919000300001');
    const p2 = await C.person('Owner B', '+919000300002');
    assert.equal((await C.admin.post(`/api/units/${C.unitB.id}/owners`, { personId: p1.id, sharePct: 60 })).status, 200);
    const over = await C.admin.post(`/api/units/${C.unitB.id}/owners`, { personId: p2.id, sharePct: 50 });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /cannot exceed 100/);
  });

  test('a sale ends the sellers and records the buyers together', async () => {
    const r = await C.admin.post(`/api/units/${C.unitB.id}/sale`, { date: '2026-11-20',
      buyers: [{ newPerson: { name: 'Buyer One', phone: '9000300003' }, sharePct: 70 }, { newPerson: { name: 'Buyer Two' }, sharePct: 30 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const u = (await C.admin.get(`/api/units/${C.unitB.id}`)).body;
    const current = u.owners.filter((o: any) => !o.ends_on).map((o: any) => [o.full_name, Number(o.share_pct)]);
    assert.deepEqual(current, [['Buyer One', 70], ['Buyer Two', 30]]);
    assert.ok(u.owners.some((o: any) => o.full_name === 'Owner A' && o.ends_on), 'history is kept');
    const bad = await C.admin.post(`/api/units/${C.unitB.id}/sale`, { date: '2026-11-21', buyers: [{ newPerson: { name: 'X' }, sharePct: 90 }] });
    assert.equal(bad.status, 400);
  });

  test('the audit trail cannot be edited, even by the schema owner', async () => {
    await assert.rejects(h.asOwner(C.id, `update app.audit_events set summary = 'edited'`), /cannot be changed/);
    await assert.rejects(h.asOwner(C.id, `truncate app.audit_events`), /cannot be changed/);
  });
});
