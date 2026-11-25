// Three synthetic sample communities for demos and testing. Every name, number and amount here is
// invented; nothing comes from Jains Ansruta or any real association. Mobile numbers use the
// +91 9x000 range and SMS is printed to the log in development, so no message is ever sent.
//
//   Maple Court      one building, two wings, 50 flats; the JAOA shape, with JAOA's unanimous rule
//   Riverside Greens three named blocks of two wings each, 300 units, block committees under a
//                    managing committee, approval by amount band
//   Palm Meadows     a township federation: towers, villa streets, row houses, a market with shops,
//                    a golf course, 466 units, phase and tower committees under a federation council
//
// Usage: DATABASE_URL_APP=... DATABASE_URL_PLATFORM=... tsx seed/samples.ts
import { Actor } from '../server/src/actor.ts';
import { createPool, many, one, withTenant, type Tx } from '../server/src/db.ts';
import * as engine from '../server/src/services/approvals.ts';
import { writeAudit } from '../server/src/services/audit.ts';
import { importUnits } from '../server/src/services/import-units.ts';
import { seedOperations } from './operations.ts';

const appUrl = process.env.DATABASE_URL_APP ?? 'postgres://pragati_web:pragati-dev-only@localhost:5433/pragati_dev';
const platformUrl = process.env.DATABASE_URL_PLATFORM ?? 'postgres://pragati_ops:pragati-dev-only@localhost:5433/pragati_dev';
const baseDomain = process.env.PRAGATI_BASE_DOMAIN ?? 'localhost';
const pool = createPool(appUrl, 4);
const platform = createPool(platformUrl, 2);

// A small deterministic random generator, so every run produces the same communities.
let seed = 20261125;
const rand = () => {   // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const FIRST = ['Aarav', 'Aditi', 'Anand', 'Anitha', 'Arjun', 'Bhavana', 'Chitra', 'Deepak', 'Divya', 'Ganesh', 'Gayathri', 'Hari',
  'Indira', 'Janani', 'Karthik', 'Kavya', 'Lakshmi', 'Madhavan', 'Meena', 'Mohan', 'Nandini', 'Naveen', 'Padma', 'Prakash',
  'Priya', 'Raghav', 'Rajesh', 'Revathi', 'Sanjay', 'Saranya', 'Shankar', 'Shobha', 'Sridhar', 'Suresh', 'Swathi', 'Uma',
  'Varun', 'Vasanthi', 'Vijay', 'Yamini', 'Farah', 'Imran', 'Joseph', 'Mary', 'Gurpreet', 'Neha', 'Rohit', 'Sneha'];
const LAST = ['Raman', 'Krishnan', 'Subramanian', 'Iyer', 'Natarajan', 'Venkatesh', 'Pillai', 'Menon', 'Reddy', 'Rao', 'Sharma',
  'Gupta', 'Shah', 'Jain', 'Mehta', 'Thomas', 'D\'Souza', 'Khan', 'Singh', 'Bose', 'Chandran', 'Murthy', 'Balaji', 'Sekar'];
const usedNames = new Set<string>();
// Names repeat across communities but not within one; with 1,152 combinations a township of 500
// homes still has room, and the loop gives up rather than spin.
function name() {
  for (let i = 0; i < 5000; i++) { const n = `${pick(FIRST)} ${pick(LAST)}`; if (!usedNames.has(n)) { usedNames.add(n); return n; } }
  throw new Error('Ran out of sample names');
}

type Row = { location: string; unit: string; type: string; floor?: number; carpet?: number; super?: number; uds?: number; plot?: number };

function csvFor(rows: Row[], phonePrefix: string, ownedShare = 0.9) {
  const out = ['location,unit,type,floor,carpet_sqft,super_sqft,uds_sqft,plot_sqft,owner_name,owner_phone,owner_share'];
  let n = 0;
  for (const r of rows) {
    let owners = '', phones = '', shares = '';
    if (rand() < ownedShare) {
      const joint = rand() < 0.3;
      const a = name(), b = name();
      const pa = `${phonePrefix}${String(++n).padStart(5, '0')}`;
      const pb = rand() < 0.6 ? `${phonePrefix}${String(++n).padStart(5, '0')}` : '';
      owners = joint ? `${a};${b}` : a;
      phones = joint ? `${pa};${pb}` : pa;
      shares = joint ? '50;50' : '100';
    }
    const q = (s: string) => (/[,"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    out.push([r.location, r.unit, r.type, r.floor ?? '', r.carpet ?? '', r.super ?? '', r.uds ?? '', r.plot ?? '', q(owners), phones, shares].join(','));
  }
  return out.join('\n');
}

const seeder = (tenantId: string) => new Actor('', '', 'Seed', '', [{ roleKey: 'administrator', roleName: 'Administrator',
  perms: new Set(['approvals.propose', 'approvals.override', 'approvals.view']), scope: null, scopeName: null }]);
const meta = { requestId: 'seed', ip: null };

async function node(tx: Tx, name: string) {
  return (await one(tx, `select id, ancestor_ids, name from app.property_nodes where name = $1`, [name]))!;
}
async function addPerson(tx: Tx, fullName: string, phone: string | null) {
  return (await one(tx, `insert into app.people (full_name, phone_e164) values ($1, $2)
    on conflict (tenant_id, phone_e164) where phone_e164 is not null and archived_at is null do update set full_name = app.people.full_name
    returning id, full_name`, [fullName, phone]))!;
}
async function grant(tx: Tx, personId: string, roleKey: string, scopeName?: string) {
  const role = (await one(tx, `select id from app.roles where key = $1`, [roleKey]))!;
  const scope = scopeName ? (await node(tx, scopeName)).id : null;
  await tx.query(`insert into app.memberships (person_id, role_id, scope_node_id) values ($1, $2, $3) on conflict do nothing`,
    [personId, role.id, scope]);
}
async function committee(tx: Tx, name: string, kind: string, scopeName: string, seats: [string, string, string | null][], role: string) {
  const scope = await node(tx, scopeName);
  const c = await one(tx, `insert into app.committees (name, kind, scope_node_id) values ($1, $2, $3)
    on conflict (tenant_id, name) do update set kind = excluded.kind returning id`, [name, kind, scope.id]);
  const people: Record<string, string> = {};
  for (const [position, fullName, phone] of seats) {
    const p = await addPerson(tx, fullName, phone);
    await tx.query(`insert into app.committee_seats (committee_id, person_id, position, starts_on) values ($1, $2, $3, '2026-04-01')`,
      [c!.id, p.id, position]);
    await giveHome(tx, p.id, scopeName);
    const bearer = ['president', 'secretary', 'treasurer'].includes(position);
    await grant(tx, p.id, role === 'committee_member' && bearer ? 'office_bearer' : role, role === 'block_committee_member' ? scopeName : undefined);
    people[fullName] = p.id;
  }
  return { id: c!.id, people };
}
// Committee members are owners too: give each one a home that has no owner yet, inside the place
// their committee looks after.
async function giveHome(tx: Tx, personId: string, scopeName: string) {
  const has = await one(tx, `select 1 from app.ownerships where person_id = $1 and ends_on is null`, [personId]);
  if (has) return;
  const scope = await node(tx, scopeName);
  const unit = await one(tx, `select u.id from app.units u join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
     join app.unit_types t on t.tenant_id = u.tenant_id and t.id = u.unit_type_id
    where (n.id = $1 or $1 = any (n.ancestor_ids)) and t.category <> 'commercial'
      and not exists (select 1 from app.ownerships o where o.unit_id = u.id and o.ends_on is null)
    order by u.label limit 1`, [scope.id]);
  if (!unit) return;
  await tx.query(`insert into app.ownerships (unit_id, person_id, share_pct, starts_on) values ($1, $2, 100, '2019-06-01')`, [unit.id, personId]);
  await tx.query(`insert into app.occupancies (unit_id, person_id, relation, is_primary_contact, starts_on) values ($1, $2, 'owner', true, '2019-06-01')`, [unit.id, personId]);
  await tx.query(`update app.units set occupancy = 'owner_occupied' where id = $1`, [unit.id]);
}

async function rule(tx: Tx, r: { name: string; subject: string; min?: number; max?: number; scope?: string;
  stages: { label: string; sel: 'fixed' | 'nearest' | 'apex'; committee?: string; mode: string; count?: number }[] }) {
  const scope = r.scope ? (await node(tx, r.scope)).id : null;
  const row = await one(tx, `insert into app.approval_rules (name, subject_type, scope_node_id, min_amount_paise, max_amount_paise)
    values ($1, $2, $3, $4, $5) returning id`, [r.name, r.subject, scope, (r.min ?? 0) * 100, r.max ? r.max * 100 : null]);
  for (const [i, s] of r.stages.entries()) {
    const cid = s.committee ? (await one(tx, `select id from app.committees where name = $1`, [s.committee]))!.id : null;
    await tx.query(`insert into app.approval_rule_stages (rule_id, stage_no, label, committee_selector, committee_id, mode, required_count)
      values ($1, $2, $3, $4, $5, $6, $7)`, [row!.id, i + 1, s.label, s.sel, cid, s.mode, s.count ?? null]);
  }
}
async function request(tx: Tx, proposerId: string, r: { title: string; details: string; amount?: number; scope?: string;
  subject?: string; votes?: [string, 'approve' | 'object', string?][] }, people: Record<string, string>) {
  const actor = seeder(''); actor.personId = proposerId;
  const node_ = r.scope ? (await node(tx, r.scope)).id : null;
  const res = await engine.propose(tx, actor, { subjectType: r.subject ?? 'expense', title: r.title, details: r.details,
    amountPaise: r.amount ? String(r.amount * 100) : null, scopeNodeId: node_ });
  await writeAudit(tx, actor, meta, 'approval.proposed', 'approval_request', res!.id, `${res!.ref} raised: ${r.title}`);
  for (const [who, v, note] of r.votes ?? []) {
    const voter = seeder(''); voter.personId = people[who] ?? fail(`unknown voter ${who}`); voter.name = who;
    await engine.vote(tx, voter, res!.id, v, note ?? '');
    await writeAudit(tx, voter, meta, `approval.${v === 'approve' ? 'approved_by' : 'objected_by'}`, 'approval_request', res!.id,
      `${who} ${v === 'approve' ? 'approved' : 'objected to'} ${res!.ref}`);
  }
}
function fail(m: string): never { throw new Error(m); }

async function createCommunity(slug: string, brand: string, legal: string, rootKind: string, rootName: string,
  adminName: string, adminPhone: string, color: string, languages: string[]) {
  const existing = (await platform.query(`select id from app.tenants where slug = $1`, [slug])).rows[0];
  if (existing) { console.log(`${brand} Pragati already exists; skipping.`); return null; }
  usedNames.clear();
  const id = (await platform.query(`select platform.create_tenant($1,$2,$3,'Chennai',$4,$5,$6,$7,$8) as id`,
    [slug, brand, legal, rootKind, rootName, adminName, adminPhone, [`${slug}.${baseDomain}`]])).rows[0].id as string;
  await withTenant(pool, id, tx => tx.query(`update app.tenants set primary_color = $1, languages = $2`, [color, languages]));
  // Sample communities are demos: made-up data, sign-in code shown on screen, a banner on every page.
  await platform.query(`select platform.set_demo($1, true)`, [id]);
  return id;
}

// ------------------------------------------------------------------------------------------------
async function mapleCourt() {
  const id = await createCommunity('maple-court', 'Maple Court', 'Maple Court Apartment Owners Association', 'community',
    'Maple Court', 'Kavya Raman', '+919000010001', '#2f5d50', ['en', 'ta']);
  if (!id) return;
  await withTenant(pool, id, async tx => {
    const rows: Row[] = [];
    for (const wing of ['A', 'B']) for (let f = 0; f <= 4; f++) for (let k = 1; k <= 5; k++) {
      const three = k === 1 || k === 5;
      rows.push({ location: `wing:${wing} Wing > ${f === 0 ? 'Ground floor' : `Floor ${f}`}`, unit: `${wing}-${f === 0 ? 'G' : f}0${k}`,
        type: three ? '3BHK' : '2BHK', floor: f, carpet: three ? 1450 : 1150, super: three ? 1860 : 1480, uds: three ? 610 : 485 });
    }
    const r = await importUnits(tx, csvFor(rows, '+9191000', 0.92), { dryRun: false, grantOwnerAccess: true });
    const c = await committee(tx, 'Managing committee', 'apex', 'Maple Court', [
      ['president', 'Mohan Krishnan', '+919000010002'], ['secretary', 'Kavya Raman', '+919000010001'],
      ['treasurer', 'Padma Natarajan', '+919000010003'], ['member', 'Imran Khan', '+919000010004'],
      ['member', 'Swathi Iyer', '+919000010005'], ['member', 'Joseph Thomas', '+919000010006'], ['member', 'Uma Sekar', '+919000010007'],
    ], 'committee_member');
    await tx.query(`update app.approval_rules set name = 'All decisions: every committee member approves'`);
    const fm = await addPerson(tx, 'Ravi Shankar (facility manager)', '+919000010010');
    await grant(tx, fm.id, 'facility_manager');
    for (const [n, k] of [['Terrace garden', 'park'], ['Gym', 'gym'], ['Community hall', 'hall']] as const)
      await tx.query(`insert into app.facilities (node_id, name, kind, bookable) values ((select id from app.property_nodes where parent_id is null), $1, $2, $3)`, [n, k, k === 'hall']);
    const P = c.people;
    await request(tx, P['Mohan Krishnan'], { title: 'Replace corridor lights with LED', amount: 38500,
      details: 'Both wings, all floors. Two quotations compared; Vendor B chosen for the longer warranty.',
      votes: [['Kavya Raman', 'approve'], ['Padma Natarajan', 'approve'], ['Imran Khan', 'approve'], ['Swathi Iyer', 'approve'],
        ['Joseph Thomas', 'approve'], ['Uma Sekar', 'approve']] }, P);
    await request(tx, P['Padma Natarajan'], { title: 'Renew the lift AMC with Vendor A', amount: 118000,
      details: 'Comprehensive AMC for both lifts, 12 months, quarterly safety inspection included.',
      votes: [['Mohan Krishnan', 'approve'], ['Imran Khan', 'approve'], ['Swathi Iyer', 'approve']] }, P);
    await request(tx, P['Joseph Thomas'], { title: 'Terrace waterproofing, A Wing', amount: 240000,
      details: 'Seepage reported in A-401 and A-402 after the October rains.',
      votes: [['Mohan Krishnan', 'approve'], ['Uma Sekar', 'object', 'Ask for a 10-year warranty before we commit.']] }, P);
    console.log(`Maple Court Pragati: ${r.unitsCreated} units, ${r.peopleCreated} people`);
  });
}

// ------------------------------------------------------------------------------------------------
async function riversideGreens() {
  const id = await createCommunity('riverside-greens', 'Riverside Greens', 'Riverside Greens Residents Welfare Association',
    'community', 'Riverside Greens', 'Arjun Menon', '+919000020001', '#1f5f8b', ['en', 'ta']);
  if (!id) return;
  await withTenant(pool, id, async tx => {
    const rows: Row[] = [];
    const types = ['3BHK', '2BHK', '2BHK', '1BHK', 'Studio'];
    const size = { '3BHK': [1520, 1950, 640], '2BHK': [1120, 1440, 470], '1BHK': [690, 900, 290], Studio: [420, 560, 180] } as Record<string, number[]>;
    for (const [block, code] of [['Ganga', 'G'], ['Kaveri', 'K'], ['Yamuna', 'Y']]) for (const wing of [1, 2]) for (let f = 1; f <= 10; f++)
      for (let k = 1; k <= 5; k++) {
        const t = types[k - 1];
        rows.push({ location: `block:${block} Block > wing:Wing ${wing} > Floor ${f}`, unit: `${code}${wing}-${f}${String(k).padStart(2, '0')}`,
          type: t, floor: f, carpet: size[t][0], super: size[t][1], uds: size[t][2] });
      }
    const r = await importUnits(tx, csvFor(rows, '+9192000', 0.88), { dryRun: false, grantOwnerAccess: true });
    const apex = await committee(tx, 'Managing committee', 'apex', 'Riverside Greens', [
      ['president', 'Shankar Reddy', '+919000020002'], ['vice_president', 'Neha Gupta', '+919000020003'],
      ['secretary', 'Arjun Menon', '+919000020001'], ['treasurer', 'Lakshmi Subramanian', '+919000020004'],
      ['member', 'Farah Shah', '+919000020005'], ['member', 'Varun Bose', '+919000020006'], ['member', 'Chitra Pillai', '+919000020007'],
    ], 'committee_member');
    const blocks: Record<string, Record<string, string>> = {};
    for (const [b, seats] of [
      ['Ganga Block', [['president', 'Hari Venkatesh', '+919000020011'], ['secretary', 'Divya Rao', '+919000020012'], ['member', 'Rohit Jain', '+919000020013']]],
      ['Kaveri Block', [['president', 'Meena Chandran', '+919000020021'], ['secretary', 'Sanjay Mehta', '+919000020022'], ['member', 'Bhavana Murthy', '+919000020023'], ['member', 'Gurpreet Singh', '+919000020024']]],
      ['Yamuna Block', [['president', 'Prakash Balaji', '+919000020031'], ['secretary', 'Saranya Iyer', '+919000020032'], ['member', 'Mary D\'Souza', '+919000020033']]],
    ] as [string, [string, string, string][]][]) {
      blocks[b] = (await committee(tx, `${b.replace(' Block', '')} block committee`, 'block', b, seats, 'block_committee_member')).people;
    }
    await tx.query(`update app.approval_rules set name = 'Anything else: every managing committee member approves'`);
    await rule(tx, { name: 'Block costs under ₹2 lakh', subject: 'expense', max: 200000,
      stages: [{ label: 'Block committee', sel: 'nearest', mode: 'majority' }] });
    await rule(tx, { name: 'Costs of ₹2 lakh and over', subject: 'expense', min: 200000, stages: [
      { label: 'Block committee', sel: 'nearest', mode: 'majority' }, { label: 'Managing committee', sel: 'apex', mode: 'majority' }] });
    await rule(tx, { name: 'Bye-laws and policies', subject: 'policy',
      stages: [{ label: 'Managing committee', sel: 'apex', mode: 'unanimous' }] });
    for (const [n, k, at, book] of [['Clubhouse', 'clubhouse', 'Riverside Greens', true], ['Swimming pool', 'pool', 'Riverside Greens', false],
      ['Badminton court', 'court', 'Kaveri Block', true], ['Children\'s play area', 'play_area', 'Ganga Block', false]] as const)
      await tx.query(`insert into app.facilities (node_id, name, kind, bookable) values ((select id from app.property_nodes where name = $3), $1, $2, $4)`, [n, k, at, book]);
    const all = { ...apex.people, ...blocks['Ganga Block'], ...blocks['Kaveri Block'], ...blocks['Yamuna Block'] };
    await request(tx, all['Hari Venkatesh'], { title: 'Ganga Block lift rope replacement', amount: 160000, scope: 'Ganga Block',
      details: 'Ropes on lift 2 flagged in the October inspection. Block-only cost, shared by Ganga Block owners.' }, all);
    await request(tx, all['Prakash Balaji'], { title: 'Yamuna Block terrace waterproofing', amount: 320000, scope: 'Yamuna Block',
      details: 'Covers both wings. Over ₹2 lakh, so the managing committee also decides.',
      votes: [['Saranya Iyer', 'approve'], ['Shankar Reddy', 'approve'], ['Neha Gupta', 'approve']] }, all);
    await request(tx, all['Lakshmi Subramanian'], { title: 'Clubhouse air-conditioning replacement', amount: 480000,
      details: 'Three units, 2 tonne each. Shared by all three blocks.', votes: [['Shankar Reddy', 'approve'], ['Farah Shah', 'approve']] }, all);
    await request(tx, all['Arjun Menon'], { title: 'Pet policy for common areas', subject: 'policy',
      details: 'Leashes in lifts and lobbies; pet relief area near the east gate.', votes: [['Neha Gupta', 'approve']] }, all);
    console.log(`Riverside Greens Pragati: ${r.unitsCreated} units, ${r.peopleCreated} people`);
  });
}

// ------------------------------------------------------------------------------------------------
async function palmMeadows() {
  const id = await createCommunity('palm-meadows', 'Palm Meadows', 'Palm Meadows Township Federation of Associations', 'federation',
    'Palm Meadows Township', 'Vasanthi Murthy', '+919000030001', '#6b4f1d', ['en', 'ta', 'hi']);
  if (!id) return;
  await withTenant(pool, id, async tx => {
    const rows: Row[] = [];
    const P1 = 'phase:Phase 1: Sky Towers', P2 = 'phase:Phase 2: Palm Villas', P3 = 'zone:Phase 3: Market Square';
    const tt = ['2BHK', '3BHK', '3BHK', '4BHK'];
    const sz = { '2BHK': [1180, 1530, 410], '3BHK': [1610, 2090, 560], '4BHK': [2240, 2900, 780] } as Record<string, number[]>;
    for (const tower of ['A', 'B', 'C']) {
      for (const wing of ['East', 'West']) for (let f = 1; f <= 15; f++) for (let k = 1; k <= 4; k++) {
        const t = tt[k - 1];
        rows.push({ location: `${P1} > tower:Sky ${tower} > wing:${wing} wing > Floor ${f}`, unit: `S${tower}${wing[0]}-${f}${String(k).padStart(2, '0')}`,
          type: t, floor: f, carpet: sz[t][0], super: sz[t][1], uds: sz[t][2] });
      }
      for (const k of [1, 2]) rows.push({ location: `${P1} > tower:Sky ${tower} > floor:Penthouse level`, unit: `S${tower}-PH${k}`,
        type: 'Penthouse', floor: 16, carpet: 3600, super: 4500, uds: 1350 });
    }
    for (const [street, n] of [['Palm Avenue', 30], ['Coconut Lane', 30]] as const) for (let i = 1; i <= n; i++)
      rows.push({ location: `${P2} > street:${street}`, unit: `${street.split(' ')[0].toUpperCase().slice(0, 4)}-V${String(i).padStart(2, '0')}`,
        type: 'Villa', carpet: i % 3 ? 2600 : 3200, plot: i % 3 ? 2400 : 3000, uds: i % 3 ? 2400 : 3000 });
    for (let i = 1; i <= 20; i++) rows.push({ location: `${P2} > street:Areca Row`, unit: `AREC-R${String(i).padStart(2, '0')}`,
      type: 'Row house', carpet: 1850, plot: 1200, uds: 1200 });
    for (let i = 1; i <= 20; i++) rows.push({ location: `${P3}`, unit: `MKT-${String(i).padStart(2, '0')}`, type: i > 16 ? 'Office' : 'Shop',
      carpet: i > 16 ? 900 : 420, super: i > 16 ? 1100 : 520, uds: i > 16 ? 300 : 150 });
    const r = await importUnits(tx, csvFor(rows, '+9193000', 0.86), { dryRun: false, grantOwnerAccess: true });

    const fed = await committee(tx, 'Federation council', 'federation', 'Palm Meadows Township', [
      ['president', 'Sridhar Natarajan', '+919000030002'], ['secretary', 'Vasanthi Murthy', '+919000030001'],
      ['treasurer', 'Rajesh Sharma', '+919000030003'], ['member', 'Anitha Pillai', '+919000030004'], ['member', 'Karthik Rao', '+919000030005'],
      ['member', 'Nandini Bose', '+919000030006'], ['member', 'Aarav Mehta', '+919000030007'],
    ], 'committee_member');
    const subs: Record<string, string>[] = [];
    for (const [cname, scope, seats] of [
      ['Sky Towers phase committee', 'Phase 1: Sky Towers', [['president', 'Gayathri Chandran', '+919000030011'], ['secretary', 'Naveen Reddy', '+919000030012'], ['member', 'Shobha Iyer', '+919000030013']]],
      ['Palm Villas phase committee', 'Phase 2: Palm Villas', [['president', 'Madhavan Pillai', '+919000030021'], ['secretary', 'Yamini Krishnan', '+919000030022'], ['member', 'Deepak Jain', '+919000030023']]],
      ['Sky A tower committee', 'Sky A', [['president', 'Raghav Subramanian', '+919000030031'], ['member', 'Indira Menon', '+919000030032'], ['member', 'Vijay Singh', '+919000030033']]],
      ['Sky B tower committee', 'Sky B', [['president', 'Revathi Sekar', '+919000030041'], ['member', 'Anand Thomas', '+919000030042'], ['member', 'Sneha Gupta', '+919000030043']]],
      ['Sky C tower committee', 'Sky C', [['president', 'Suresh Balaji', '+919000030051'], ['member', 'Janani Rao', '+919000030052'], ['member', 'Aditi Shah', '+919000030053']]],
    ] as [string, string, [string, string, string][]][]) {
      subs.push((await committee(tx, cname, 'block', scope, seats, 'block_committee_member')).people);
    }
    await tx.query(`update app.approval_rules set name = 'Anything else: the federation council, unanimously'`);
    await rule(tx, { name: 'Tower or street costs under ₹1 lakh', subject: 'expense', max: 100000,
      stages: [{ label: 'Nearest committee', sel: 'nearest', mode: 'count', count: 2 }] });
    await rule(tx, { name: 'Costs from ₹1 lakh to ₹10 lakh', subject: 'expense', min: 100000, max: 1000000, stages: [
      { label: 'Nearest committee', sel: 'nearest', mode: 'majority' }, { label: 'Federation council', sel: 'apex', mode: 'majority' }] });
    await rule(tx, { name: 'Costs of ₹10 lakh and over', subject: 'expense', min: 1000000, stages: [
      { label: 'Nearest committee', sel: 'nearest', mode: 'majority' }, { label: 'Federation council', sel: 'apex', mode: 'unanimous' }] });
    await rule(tx, { name: 'Township policies', subject: 'policy', stages: [{ label: 'Federation council', sel: 'apex', mode: 'unanimous' }] });
    for (const [n, k, at, book, cap] of [
      ['Palm Meadows Golf Course (9 holes)', 'golf_course', 'Palm Meadows Township', true, 40],
      ['Grand Clubhouse', 'clubhouse', 'Palm Meadows Township', true, 250], ['Sky Towers pool', 'pool', 'Phase 1: Sky Towers', false, 60],
      ['Tennis courts', 'court', 'Phase 2: Palm Villas', true, 8], ['Kids\' play area', 'play_area', 'Sky A', false, null],
      ['Market Square parking', 'parking_area', 'Phase 3: Market Square', false, 120]] as const)
      await tx.query(`insert into app.facilities (node_id, name, kind, bookable, capacity) values ((select id from app.property_nodes where name = $3), $1, $2, $4, $5)`,
        [n, k, at, book, cap]);
    const all = Object.assign({}, fed.people, ...subs);
    await request(tx, all['Rajesh Sharma'], { title: 'Golf course irrigation pump replacement', amount: 650000,
      details: 'The 15 HP pump failed in November. Shared by the whole township under the golf course cost-sharing rule.',
      votes: [['Sridhar Natarajan', 'approve'], ['Anitha Pillai', 'approve']] }, all);
    await request(tx, all['Revathi Sekar'], { title: 'Sky B lift modernisation (4 lifts)', amount: 1850000, scope: 'Sky B',
      details: 'Controller and door-operator upgrade for all four lifts. Tower committee first, then the whole council.',
      votes: [['Anand Thomas', 'approve'], ['Sridhar Natarajan', 'approve'], ['Vasanthi Murthy', 'approve'], ['Rajesh Sharma', 'approve']] }, all);
    await request(tx, all['Madhavan Pillai'], { title: 'Palm Avenue streetlight repair', amount: 45000, scope: 'Palm Avenue',
      details: 'Six poles on Palm Avenue. The street has no committee, so the Palm Villas phase committee decides.' }, all);
    await request(tx, all['Vasanthi Murthy'], { title: 'Clubhouse booking policy for weddings', subject: 'policy',
      details: 'Maximum two bookings a month per unit; deposit refundable within 7 days.', votes: [['Karthik Rao', 'approve']] }, all);
    console.log(`Palm Meadows Pragati: ${r.unitsCreated} units, ${r.peopleCreated} people`);
  });
}

await mapleCourt();
await riversideGreens();
await palmMeadows();

// Operations for the demo communities: added once, then topped up with checks on every run so the
// demo always shows recent days.
for (const [slug, n] of [['maple-court', 101], ['riverside-greens', 202], ['palm-meadows', 303]] as const) {
  const t = (await platform.query(`select id from app.tenants where slug = $1 and is_demo`, [slug])).rows[0];
  if (t) await withTenant(pool, t.id, tx => seedOperations(tx, slug, n));
}

// On the pilot, the app's own Azure address shows Palm Meadows until communities have their own domains.
const demoHost = process.env.PRAGATI_DEMO_HOST?.toLowerCase();
if (demoHost) {
  const t = (await platform.query(`select id from app.tenants where slug = 'palm-meadows'`)).rows[0];
  const taken = (await platform.query(`select 1 from app.tenant_domains where domain = $1`, [demoHost])).rowCount;
  if (t && !taken) await platform.query(`select platform.add_domain($1, $2, false)`, [t.id, demoHost]);
  console.log(`${demoHost} shows Palm Meadows Pragati.`);
}
console.log((await platform.query('select platform_name, locations, units, people, active_members, pending_approvals from platform.tenant_usage()')).rows);
await pool.end();
await platform.end();
