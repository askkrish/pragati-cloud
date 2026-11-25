import { buildApp } from './app.ts';
import { config } from './config.ts';
import { createPool } from './db.ts';

const pool = createPool(config.appDatabaseUrl, Number(process.env.PRAGATI_DB_POOL ?? 10), { entra: config.pgEntra });
const app = await buildApp({ pool });
await app.listen({ port: config.port, host: config.host });
console.log(`Pragati Cloud listening on ${config.host}:${config.port} (base domain ${config.baseDomain})`);

// Clears used sign-in codes and long-expired sessions every hour.
setInterval(() => { pool.query('select auth_api.purge_expired()').catch(() => {}); }, 3_600_000).unref();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await app.close(); await pool.end(); process.exit(0); });
}
