// Local and CI database set-up: creates the database if needed, then runs the same bootstrap the
// Azure deployment runs (db/bootstrap.ts). One password for all roles, for development only.
// Usage: tsx scripts/db-setup.ts <admin-url> [database]
import pg from 'pg';
import { bootstrap } from '../db/bootstrap.ts';

const [adminUrl, dbName = 'pragati'] = process.argv.slice(2);
if (!adminUrl) throw new Error('Usage: tsx scripts/db-setup.ts <admin-url> [database]');
const pw = process.env.PRAGATI_DB_PASSWORD ?? 'pragati-dev-only';

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
if (!(await admin.query('select 1 from pg_database where datname = $1', [dbName])).rowCount)
  await admin.query(`create database "${dbName.replace(/"/g, '""')}"`);
await admin.end();

const u = new URL(adminUrl);
u.pathname = '/' + dbName;
await bootstrap({ adminUrl: u.toString(), ownerPassword: pw, webPassword: pw, opsPassword: pw });

const url = (user: string) => { const x = new URL(u); x.username = user; x.password = pw; return x.toString(); };
console.log(`Database ${dbName} is ready.`);
console.log(`DATABASE_URL_APP=${url('pragati_web')}`);
console.log(`DATABASE_URL_PLATFORM=${url('pragati_ops')}`);
