// Brings a database to the current version from nothing, using only what Azure Database for
// PostgreSQL grants its administrator (CREATEROLE, not superuser). Safe to run on every deploy.
//
//   1. as the server administrator: the schema owner role, allowed to create schemas in this database
//   2. as the schema owner: the migrations
//   3. as the schema owner: the two login roles the services use, with their passwords
//
// Env: DATABASE_URL_ADMIN (administrator, connected to the target database),
//      PRAGATI_OWNER_PASSWORD, PRAGATI_WEB_PASSWORD, PRAGATI_OPS_PASSWORD
import pg from 'pg';
import { migrate } from './migrate.ts';

const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"';

export async function bootstrap(opts: { adminUrl: string; ownerPassword: string; webPassword: string; opsPassword: string },
  log: (m: string) => void = console.log) {
  for (const [k, v] of Object.entries(opts)) if (!v) throw new Error(`bootstrap: ${k} is missing`);
  const adminUrl = new URL(opts.adminUrl);
  const db = decodeURIComponent(adminUrl.pathname.slice(1));
  const as = (user: string, password: string) => {
    const u = new URL(opts.adminUrl); u.username = user; u.password = password; return u.toString();
  };

  const admin = new pg.Client({ connectionString: opts.adminUrl });
  await admin.connect();
  try {
    const exists = (await admin.query(`select 1 from pg_roles where rolname = 'pragati_owner'`)).rowCount;
    await admin.query(`${exists ? 'alter' : 'create'} role pragati_owner with login createrole password ${lit(opts.ownerPassword)}`);
    await admin.query(`grant connect, create, temporary on database ${ident(db)} to pragati_owner`);
    log(`schema owner ${exists ? 'checked' : 'created'}`);
  } finally {
    await admin.end();
  }

  await migrate(as('pragati_owner', opts.ownerPassword), log);

  const owner = new pg.Client({ connectionString: as('pragati_owner', opts.ownerPassword) });
  await owner.connect();
  try {
    for (const [login, group, pw] of [['pragati_web', 'pragati_app', opts.webPassword], ['pragati_ops', 'pragati_platform', opts.opsPassword]]) {
      const exists = (await owner.query('select 1 from pg_roles where rolname = $1', [login])).rowCount;
      await owner.query(`${exists ? 'alter' : 'create'} role ${ident(login)} with login password ${lit(pw)}`);
      await owner.query(`grant ${ident(group)} to ${ident(login)} with inherit true`);
    }
    log('service logins ready');
  } finally {
    await owner.end();
  }
}

// Run directly (not when bundled into another entry point).
if (/[\\/]bootstrap\.(ts|js)$/.test(process.argv[1] ?? '')) {
  const e = process.env;
  await bootstrap({ adminUrl: e.DATABASE_URL_ADMIN ?? '', ownerPassword: e.PRAGATI_OWNER_PASSWORD ?? '',
    webPassword: e.PRAGATI_WEB_PASSWORD ?? '', opsPassword: e.PRAGATI_OPS_PASSWORD ?? '' });
  console.log('Database is up to date.');
}
