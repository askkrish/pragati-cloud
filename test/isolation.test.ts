// One community can never see or change another's data: checked at the database and through the API.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let A: Awaited<ReturnType<typeof buildCommunity>>;
let B: Awaited<ReturnType<typeof buildCommunity>>;

before(async () => {
  h = await startHarness();
  A = await buildCommunity(h, 'alpha');
  B = await buildCommunity(h, 'beta');
  await A.person('Asha Alpha', '+919000011111');
  await B.person('Bala Beta', '+919000022222');
});
after(() => h.close());

describe('database guarantees', () => {
  test('every table holding community data has row-level security switched on and forced', async () => {
    const rows = await h.asOwner(null, `
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and c.relkind = 'r'
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)`);
    assert.ok(rows.length >= 20, `expected the community tables, found ${rows.length}`);
    // tenant_domains is the one deliberate exception: the owner-run address lookup must find a
    // community before one is selected. The application role is still limited to its own rows.
    const notForced = new Set(['tenant_domains']);
    for (const r of rows) {
      assert.equal(r.relrowsecurity, true, `${r.relname} must have row-level security`);
      if (!notForced.has(r.relname)) assert.equal(r.relforcerowsecurity, true, `${r.relname} must force row-level security`);
    }
  });

  test('with no community selected, the application sees nothing', async () => {
    for (const t of ['people', 'units', 'property_nodes', 'roles', 'memberships', 'audit_events', 'approval_rules', 'tenants']) {
      const [r] = await h.asApp(null, `select count(*)::int as n from app.${t}`);
      assert.equal(r.n, 0, `app.${t} leaked rows without a community`);
    }
  });

  test('inside one community, no row of another community is visible in any table', async () => {
    const tables = await h.asOwner(null, `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id')`);
    for (const { relname } of tables) {
      const [r] = await h.asApp(A.id, `select count(*)::int as n from app.${relname} where tenant_id <> $1`, [A.id]);
      assert.equal(r.n, 0, `app.${relname} showed another community's rows`);
    }
    const [own] = await h.asApp(A.id, `select count(*)::int as n from app.people`);
    assert.ok(own.n >= 2);
  });

  test('rows cannot be written into another community', async () => {
    await assert.rejects(h.asApp(A.id, `insert into app.people (tenant_id, full_name) values ($1, 'Intruder')`, [B.id]),
      /row-level security/);
    const [n] = await h.asApp(A.id, `update app.people set full_name = 'Changed' where tenant_id = $1 returning id`, [B.id]);
    assert.equal(n, undefined);
  });

  test('a row cannot point at another community\'s rows, even with the right id', async () => {
    // Composite foreign keys include tenant_id, so Block B of beta cannot hold a unit of alpha.
    await assert.rejects(h.asApp(A.id, `insert into app.units (node_id, unit_type_id, label)
      values ($1, (select id from app.unit_types limit 1), 'X-1')`, [B.blockA.id]), /foreign key/);
  });

  test('the application cannot read sign-in data, change a community\'s address or erase the audit trail', async () => {
    await assert.rejects(h.asApp(A.id, `select * from auth_private.sessions`), /permission denied/);
    await assert.rejects(h.asApp(A.id, `update app.tenants set slug = 'stolen'`), /permission denied/);
    await assert.rejects(h.asApp(A.id, `delete from app.audit_events`), /permission denied/);
    await assert.rejects(h.asOwner(A.id, `delete from app.audit_events`), /cannot be changed or deleted/);
    await assert.rejects(h.asApp(A.id, `select platform.create_tenant('x','X','X','C','community','X','X','+919000000000')`),
      /permission denied/);
  });
});

describe('API guarantees', () => {
  test('each community gets its own platform name', async () => {
    assert.equal((await h.client(A.host).get('/api/public/community')).body.platformName, 'ALPHA Pragati');
    assert.equal((await h.client(B.host).get('/api/public/community')).body.platformName, 'BETA Pragati');
    assert.equal((await h.client('nowhere.test.local').get('/api/public/community')).status, 404);
  });

  test('a session for one community is refused on another community\'s address', async () => {
    assert.equal((await h.client(A.host, A.adminToken).get('/api/me')).status, 200);
    assert.equal((await h.client(B.host, A.adminToken).get('/api/me')).status, 401);
  });

  test('ids from another community are simply not found', async () => {
    const a = A.admin;
    assert.equal((await a.get(`/api/units/${B.unitA.id}`)).status, 404);
    assert.equal((await a.get(`/api/people/${(await B.admin.get('/api/people')).body.people[0].id}`)).status, 404);
    const r = await a.post('/api/units', { nodeId: B.blockA.id, unitTypeId: A.types[0].id, label: 'Z-1' });
    assert.equal(r.status, 404);
    const m = await a.post('/api/property/nodes', { parentId: B.root.id, kind: 'block', name: 'Sneaky' });
    assert.equal(m.status, 404);
  });

  test('lists only ever show the community\'s own records', async () => {
    const people = (await A.admin.get('/api/people')).body.people.map((p: any) => p.full_name);
    assert.ok(people.includes('Asha Alpha'));
    assert.ok(!people.includes('Bala Beta'));
    const units = (await A.admin.get('/api/units')).body.units.map((u: any) => u.label);
    assert.deepEqual(units.sort(), ['A-101', 'B-101']);
    const exportA = (await A.admin.get('/api/export')).body;
    const ids = new Set(exportA.people.map((p: any) => p.tenant_id));
    assert.deepEqual([...ids], [A.id]);
  });

  test('changes without the page header are blocked', async () => {
    const r = await h.app.inject({ method: 'POST', url: '/api/people', headers: { host: A.host, cookie: `pragati_session=${A.adminToken}` },
      payload: { fullName: 'X' } });
    assert.equal(r.statusCode, 403);
  });
});
