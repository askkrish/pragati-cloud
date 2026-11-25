// Test harness: a fresh database per test file, the real migrations, the real roles, and the app
// driven through HTTP injection with Host headers, exactly as browsers reach each community.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://pgadmin@localhost:5433/postgres';
const DB = process.env.TEST_DB ?? 'pragati_test';
const PW = 'pragati-dev-only';
const url = (user: string) => { const u = new URL(ADMIN_URL); u.username = user; u.password = PW; u.pathname = '/' + DB; return u.toString(); };

process.env.PRAGATI_DEV_SHOW_OTP = '1';
process.env.DATABASE_URL_APP = url('pragati_web');
process.env.STORAGE_LOCAL_DIR = `var/test-files/${process.pid}`;
process.env.PRAGATI_BASE_DOMAIN = 'test.local';
process.env.PRAGATI_AUTH_RATE = '1000';

export async function freshDatabase() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [DB]);
  await admin.query(`drop database if exists ${DB}`);
  await admin.end();
  execFileSync('npx', ['tsx', 'scripts/db-setup.ts', ADMIN_URL, DB], { stdio: 'pipe', env: { ...process.env, PRAGATI_DB_PASSWORD: PW } });
}

export async function startHarness() {
  await freshDatabase();
  const { buildApp } = await import('../server/src/app.ts');
  const { createPool } = await import('../server/src/db.ts');
  const { tokenHash } = await import('../server/src/auth/crypto.ts');
  const pool = createPool(url('pragati_web'), 5);
  const platform = createPool(url('pragati_ops'), 2);
  const owner = createPool(url('pragati_owner'), 2);
  const app = await buildApp({ pool });

  async function createCommunity(slug: string, opts: { root?: 'community' | 'federation'; adminPhone?: string } = {}) {
    const phone = opts.adminPhone ?? `+9190000${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
    const r = await platform.query(`select platform.create_tenant($1, $2, $3, 'Chennai', $4, $5, 'Admin of ' || $2, $6, $7) as id`,
      [slug, slug.toUpperCase(), `${slug} Owners Association`, opts.root ?? 'community', `${slug} Towers`, phone, [`${slug}.test.local`]]);
    const id = r.rows[0].id as string;
    return { id, host: `${slug}.test.local`, adminPhone: phone };
  }

  // Runs SQL as the application role inside one community, the same way requests do.
  async function asApp<T = any>(tenantId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (tenantId) await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await c.query(sql, params);
      await c.query('commit');
      return r.rows;
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }

  async function asOwner<T = any>(tenantId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    const c = await owner.connect();
    try {
      await c.query('begin');
      if (tenantId) await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await c.query(sql, params);
      await c.query('commit');
      return r.rows;
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }

  // Signs a person in without SMS (the sign-in flow itself is tested separately).
  async function sessionFor(tenantId: string, phone: string) {
    const token = `test-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const [u] = await asOwner(null, `insert into auth_private.users (phone_e164) values ($1)
      on conflict (phone_e164) do update set phone_e164 = excluded.phone_e164 returning id`, [phone]);
    await asOwner(tenantId, `update app.people set user_id = $1 where phone_e164 = $2 and archived_at is null`, [u.id, phone]);
    await asOwner(null, `insert into auth_private.sessions (token_hash, user_id, tenant_id, expires_at)
      values ($1, $2, $3, now() + interval '1 day')`, [tokenHash(token), u.id, tenantId]);
    return token;
  }

  function client(host: string, token?: string) {
    const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const res = await app.inject({ method: method as any, url: path, payload: body === undefined ? undefined : body as any,
        headers: { host, ...(token ? { cookie: `pragati_session=${token}` } : {}),
          ...(method !== 'GET' ? { 'x-pragati': '1' } : {}), ...extra } });
      let json: any = null;
      try { json = res.json(); } catch { /* not json */ }
      return { status: res.statusCode, body: json, raw: res };
    };
    return {
      get: (p: string) => call('GET', p),
      post: (p: string, b: unknown = {}) => call('POST', p, b),
      patch: (p: string, b: unknown) => call('PATCH', p, b),
      put: (p: string, b: unknown) => call('PUT', p, b),
      call,
    };
  }

  async function close() {
    await app.close();
    await Promise.all([pool.end(), platform.end(), owner.end()]);
  }

  return { app, pool, platform, createCommunity, asApp, asOwner, sessionFor, client, close };
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

// Builds a small community through the API: blocks, units, people, committees and access.
export async function buildCommunity(h: Harness, slug: string) {
  const c = await h.createCommunity(slug);
  const adminToken = await h.sessionFor(c.id, c.adminPhone);
  const admin = h.client(c.host, adminToken);
  const tree = (await admin.get('/api/property/tree')).body.nodes;
  const root = tree[0];
  const blockA = (await admin.post('/api/property/nodes', { parentId: root.id, kind: 'block', name: 'Block A' })).body;
  const blockB = (await admin.post('/api/property/nodes', { parentId: root.id, kind: 'block', name: 'Block B' })).body;
  const types = (await admin.get('/api/unit-types')).body;
  const t2 = types.find((t: any) => t.code === '2bhk').id;
  const unitA = (await admin.post('/api/units', { nodeId: blockA.id, unitTypeId: t2, label: 'A-101', carpetSqft: 1000 })).body;
  const unitB = (await admin.post('/api/units', { nodeId: blockB.id, unitTypeId: t2, label: 'B-101', carpetSqft: 1000 })).body;
  const person = async (name: string, phone: string) =>
    (await admin.post('/api/people', { fullName: name, phone })).body;
  return { ...c, admin, adminToken, root, blockA, blockB, unitA, unitB, types, person };
}
