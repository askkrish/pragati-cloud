import pg from 'pg';

// Bigint columns (amounts in paise, audit ids) come back as strings; counts are parsed to numbers
// explicitly where needed. Dates come back exactly as stored ('2026-11-25'), never shifted by the
// server's own time zone.
pg.types.setTypeParser(1082, v => v);
export type Tx = pg.PoolClient;

// On Azure the app signs in to PostgreSQL with its managed identity: each new connection gets a
// short-lived Entra ID token as its password, so no database password exists for the app.
let credential: { getToken(scope: string): Promise<{ token: string } | null> } | null = null;
async function entraToken() {
  if (!credential) {
    const { DefaultAzureCredential } = await import('@azure/identity');
    credential = new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID });
  }
  const t = await credential.getToken('https://ossrdbms-aad.database.windows.net/.default');
  if (!t) throw new Error('Could not get a database token for the managed identity');
  return t.token;
}

export function createPool(url: string, max = 10, opts: { entra?: boolean } = {}) {
  return new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
    application_name: 'pragati-cloud', ...(opts.entra ? { password: entraToken } : {}) });
}

// Every request runs in one transaction bound to one community. set_config(..., true) is local to
// the transaction, so a pooled connection never carries a community into the next request.
export async function withTenant<T>(pool: pg.Pool, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.tenant_id', $1, true), set_config('statement_timeout', '15s', true)`, [tenantId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await tx.query(sql, params)).rows[0];
}
export async function many<T = any>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query(sql, params)).rows;
}
