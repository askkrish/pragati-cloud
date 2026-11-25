// Onboarding and operations for our team. Runs with the platform role, which can create communities
// and read counts, but cannot read any community's records.
//
//   tsx scripts/platform.ts create <slug> "<Brand>" "<Registered name>" <city> community|federation "<Top place name>" "<Admin name>" <admin mobile> [domain...]
//   tsx scripts/platform.ts usage
//   tsx scripts/platform.ts suspend <slug> | reactivate <slug>
import { normalisePhone } from '../server/src/auth/crypto.ts';
import { createPool } from '../server/src/db.ts';

const url = process.env.DATABASE_URL_PLATFORM;
if (!url) throw new Error('Set DATABASE_URL_PLATFORM');
const db = createPool(url, 1);
const base = process.env.PRAGATI_BASE_DOMAIN ?? 'localhost';
const [cmd, ...args] = process.argv.slice(2);

try {
  if (cmd === 'create') {
    const [slug, brand, legal, city, rootKind, rootName, adminName, adminPhone, ...domains] = args;
    if (!adminPhone) throw new Error('Missing arguments; see the usage at the top of this file.');
    const phone = normalisePhone(adminPhone) ?? (() => { throw new Error('The administrator\'s mobile number is not valid.'); })();
    const all = [`${slug}.${base}`, ...domains];
    const r = await db.query(`select platform.create_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9) as id`,
      [slug, brand, legal, city, rootKind, rootName, adminName, phone, all]);
    console.log(`Created ${brand} Pragati (${r.rows[0].id}).`);
    console.log(`Addresses: ${all.join(', ')}. Add each to the installation's community_domains so Front Door issues a certificate.`);
    console.log(`${adminName} can now sign in with ${phone}.`);
  } else if (cmd === 'usage') {
    console.table((await db.query('select * from platform.tenant_usage()')).rows);
  } else if (cmd === 'suspend' || cmd === 'reactivate') {
    const t = await db.query('select id from app.tenants where slug = $1', [args[0]]);
    if (!t.rowCount) throw new Error(`No community with the address name ${args[0]}.`);
    await db.query('select platform.set_tenant_status($1, $2)', [t.rows[0].id, cmd === 'suspend' ? 'suspended' : 'active']);
    console.log(`${args[0]} is now ${cmd === 'suspend' ? 'suspended' : 'active'}.`);
  } else {
    console.log('Commands: create, usage, suspend, reactivate. See the top of scripts/platform.ts.');
  }
} finally {
  await db.end();
}
