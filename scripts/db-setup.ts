// Local and CI database set-up. Mirrors what the Azure pipeline does with the server administrator:
//   1. create the schema owner and the database (as the administrator)
//   2. run the migrations (as the owner, which is not a superuser)
//   3. create the two login roles the services use (as the owner)
// Usage: tsx scripts/db-setup.ts <admin-url> <database-name>
import pg from 'pg';
import { migrate } from '../db/migrate.ts';

const [adminUrl, dbName = 'pragati'] = process.argv.slice(2);
if (!adminUrl) throw new Error('Usage: tsx scripts/db-setup.ts <admin-url> [database]');
const pw = process.env.PRAGATI_DB_PASSWORD ?? 'pragati-dev-only';
const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"';
const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
if (!(await admin.query("select 1 from pg_roles where rolname = 'pragati_owner'")).rowCount)
  await admin.query(`create role pragati_owner login createrole password ${lit(pw)}`);
if (!(await admin.query('select 1 from pg_database where datname = $1', [dbName])).rowCount)
  await admin.query(`create database ${ident(dbName)} owner pragati_owner`);
await admin.end();

const url = (user: string) => {
  const u = new URL(adminUrl);
  u.username = user; u.password = pw; u.pathname = '/' + dbName;
  return u.toString();
};
await migrate(url('pragati_owner'));

const owner = new pg.Client({ connectionString: url('pragati_owner') });
await owner.connect();
for (const [login, group] of [['pragati_web', 'pragati_app'], ['pragati_ops', 'pragati_platform']]) {
  if (!(await owner.query('select 1 from pg_roles where rolname = $1', [login])).rowCount)
    await owner.query(`create role ${ident(login)} login password ${lit(pw)}`);
  await owner.query(`grant ${ident(group)} to ${ident(login)} with inherit true`);
}
await owner.end();
console.log(`Database ${dbName} is ready.`);
console.log(`DATABASE_URL_APP=${url('pragati_web')}`);
console.log(`DATABASE_URL_PLATFORM=${url('pragati_ops')}`);
