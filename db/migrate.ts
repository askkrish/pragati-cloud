// Applies db/migrations/*.sql in order, once each, as the schema owner.
// Each file runs in its own transaction and is recorded with a checksum, so an edited
// migration that already ran is refused instead of silently skipped.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export async function migrate(ownerUrl: string, log: (m: string) => void = console.log) {
  const dir = process.env.PRAGATI_MIGRATIONS_DIR ?? join(import.meta.dirname, 'migrations');
  const files = (await readdir(dir)).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('create schema if not exists platform');
    await client.query(`create table if not exists platform.schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    const done = new Map((await client.query('select name, checksum from platform.schema_migrations')).rows
      .map(r => [r.name as string, r.checksum as string]));
    for (const name of files) {
      const sql = await readFile(join(dir, name), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (done.has(name)) {
        if (done.get(name) !== sum) throw new Error(`Migration ${name} changed after it was applied. Add a new migration instead.`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into platform.schema_migrations (name, checksum) values ($1, $2)', [name, sum]);
        await client.query('commit');
        log(`applied ${name}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`Migration ${name} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('Set DATABASE_URL_OWNER');
  await migrate(url);
}
