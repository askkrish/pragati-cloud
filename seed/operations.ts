// Sample operations for the three demo communities: staff, the asset register and renewals,
// routines with five weeks of checks, and work orders from owners and staff. Every name, number,
// company and amount is invented. Dates are relative to the day the seed runs, so the demo always
// shows recent history; running it again tops up the checks for the days since.
import { Actor } from '../server/src/actor.ts';
import { many, one, type Tx } from '../server/src/db.ts';
import * as engine from '../server/src/services/approvals.ts';
import { addDays, daysBetween, isLate, localNow, normalise, occursOn, versionOn, zonedInstant } from '../server/src/services/schedule.ts';

type Staff = [name: string, phone: string, role: string, scope?: string];
type Asset = [name: string, kind: string, place: string, serviceBy: string, facility?: string];
type Contract = [asset: string | null, place: string, kind: string, title: string, provider: string, endsInDays: number, rupees: number | null];
type Routine = { title: string; category: string; place: string; who: string; backup?: string; asset?: string; freq: string;
  days?: number[]; start?: string; end?: string; reading?: [string, string, number, number]; remarks?: string; instructions?: string };
type Update = [by: string, kind: 'status' | 'note' | 'staff' | 'assign', text: string, to?: string];
type Work = { kind: string; title: string; details: string; category: string; place: string; priority: string; status: string;
  unitIn?: string; asset?: string; who?: string; raisedBy?: string; ageDays: number; dueIn?: number; estimate?: number; updates: Update[];
  approval?: { by: string; votes: string[] } };
type Plan = { staff: Staff[]; assets: Asset[]; contracts: Contract[]; routines: Routine[]; work: Work[] };

const TZ = 'Asia/Kolkata';

export async function seedOperations(tx: Tx, slug: string, seedNo: number) {
  const plan = PLANS[slug];
  if (!plan) return;
  let s = seedNo;
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const today = localNow(TZ).day;
  const people: Record<string, string> = {};
  const nodeId = async (name: string) => (await one(tx, `select id from app.property_nodes where name = $1`, [name]))?.id ?? fail(`no place ${name}`);
  const admin = (await one(tx, `select p.id, p.full_name from app.people p join app.memberships m on m.tenant_id = p.tenant_id and m.person_id = p.id
    join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id where r.key = 'administrator' order by p.created_at limit 1`))!;

  const already = await one(tx, `select 1 from app.routines limit 1`);
  for (const [name, phone] of plan.staff) {
    const p = await one(tx, `select id from app.people where phone_e164 = $1 and archived_at is null`, [phone]);
    if (p) people[name] = p.id;
  }
  if (already) { await topUpChecks(tx, plan, people, rand, today); return; }

  // ---------- staff ----------
  for (const [name, phone, role, scope] of plan.staff) {
    const p = await one(tx, `insert into app.people (full_name, phone_e164) values ($1, $2)
      on conflict (tenant_id, phone_e164) where phone_e164 is not null and archived_at is null do update set full_name = excluded.full_name returning id`, [name, phone]);
    people[name] = p!.id;
    const r = await one(tx, `select id from app.roles where key = $1`, [role]);
    await tx.query(`insert into app.memberships (person_id, role_id, scope_node_id) values ($1, $2, $3) on conflict do nothing`,
      [p!.id, r!.id, scope ? await nodeId(scope) : null]);
  }
  const who = (n?: string) => n ? (people[n] ?? fail(`no person ${n}`)) : null;

  // ---------- assets and renewals ----------
  const assets: Record<string, string> = {};
  for (const [name, kind, place, serviceBy, facility] of plan.assets) {
    const ref = (await one(tx, `select app.next_ref('asset', 'AS') as ref`))!.ref;
    const fac = facility ? (await one(tx, `select id from app.facilities where name = $1`, [facility]))?.id ?? null : null;
    const a = await one(tx, `insert into app.assets (ref, node_id, facility_id, name, kind, service_by, installed_on)
      values ($1, $2, $3, $4, $5, $6, $7) returning id`, [ref, await nodeId(place), fac, name, kind, serviceBy, addDays(today, -365 * (2 + Math.floor(rand() * 6)))]);
    assets[name] = a!.id;
  }
  for (const [asset, place, kind, title, provider, ends, rupees] of plan.contracts) {
    const ref = (await one(tx, `select app.next_ref('renewal', 'RN') as ref`))!.ref;
    await tx.query(`insert into app.asset_contracts (ref, asset_id, node_id, kind, title, provider, reference, starts_on, ends_on, amount_paise, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [ref, asset ? assets[asset] ?? fail(`no asset ${asset}`) : null, await nodeId(place), kind, title, provider,
        `${kind.toUpperCase()}/${2025 + Math.floor(rand() * 2)}/${String(Math.floor(rand() * 9000) + 1000)}`,
        addDays(today, ends - (kind === 'warranty' ? 1825 : 365)), addDays(today, ends), rupees === null ? null : rupees * 100, admin.id]);
  }

  // ---------- routines ----------
  for (const r of plan.routines) {
    const ref = (await one(tx, `select app.next_ref('routine', 'RT') as ref`))!.ref;
    const row = await one(tx, `insert into app.routines (ref, title, instructions, category, node_id, asset_id, assignee_person_id, backup_person_id, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [ref, r.title, r.instructions ?? '', r.category, await nodeId(r.place), r.asset ? assets[r.asset] : null, who(r.who), who(r.backup), admin.id]);
    const weekly = r.freq === 'weekly', monthly = ['monthly', 'quarterly', 'half_yearly', 'annually'].includes(r.freq);
    const startsOn = addDays(today, r.freq === 'half_yearly' ? -200 : r.freq === 'quarterly' ? -120 : -60);
    await tx.query(`insert into app.routine_schedules (routine_id, effective_from, frequency, weekdays, month_days, starts_on, start_time, end_time,
        remarks, reading_label, reading_unit, created_by) values ($1, $2, $3, $4, $5, $2, $6, $7, $8, $9, $10, $11)`,
      [row!.id, startsOn, r.freq, weekly ? r.days : [], monthly ? r.days : [], r.start ?? null, r.end ?? null, r.remarks ?? 'exception',
        r.reading?.[0] ?? null, r.reading?.[1] ?? null, admin.id]);
  }
  await topUpChecks(tx, plan, people, rand, today);

  // ---------- work orders ----------
  for (const w of plan.work) {
    const ref = (await one(tx, `select app.next_ref('work', 'WO') as ref`))!.ref;
    const node = await nodeId(w.place);
    let unit: any = null, raisedBy = who(w.raisedBy) ?? admin.id;
    if (w.unitIn) {
      unit = await one(tx, `select u.id, u.node_id, o.person_id from app.units u join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
        join app.ownerships o on o.tenant_id = u.tenant_id and o.unit_id = u.id and o.ends_on is null
        join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id and p.phone_e164 is not null
        join app.unit_types t on t.tenant_id = u.tenant_id and t.id = u.unit_type_id and t.category <> 'commercial'
        where ($1 = n.id or $1 = any (n.ancestor_ids)) order by md5(u.label || $2) limit 1`, [await nodeId(w.unitIn), w.title]);
      raisedBy = unit.person_id;
    }
    const created = new Date(Date.now() - w.ageDays * 86_400_000);
    const status = w.status;
    const wo = await one(tx, `insert into app.work_orders (ref, kind, title, details, category, priority, status, node_id, unit_id, asset_id, raised_by,
        assignee_person_id, due_on, estimate_paise, created_at, started_at, completed_at, closed_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        case when $7 in ('in_progress', 'on_hold', 'done', 'closed') then $15::timestamptz + interval '3 hours' end,
        case when $7 in ('done', 'closed') then $15::timestamptz + interval '1 day' end,
        case when $7 in ('closed', 'cancelled') then $15::timestamptz + interval '2 days' end) returning id`,
      [ref, w.kind, w.title, w.details, w.category, w.priority, status, unit?.node_id ?? node, unit?.id ?? null, w.asset ? assets[w.asset] : null,
        raisedBy, who(w.who), w.dueIn === undefined ? null : addDays(today, w.dueIn), w.estimate ? w.estimate * 100 : null, created]);
    let at = created.getTime();
    const log = async (person: string, kind: string, body: string, staffOnly: boolean, from?: string, to?: string) => {
      at += (0.15 + rand() * 0.5) * Math.min(w.ageDays, 1) * 86_400_000 / Math.max(1, w.updates.length);
      await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only, from_status, to_status, at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [wo!.id, person, kind, body, staffOnly, from ?? null, to ?? null, new Date(Math.min(at, Date.now() - 60_000))]);
    };
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, to_status, at) values ($1, $2, 'created', $3, $4, $5)`,
      [wo!.id, raisedBy, w.kind === 'request' ? 'Request raised' : 'Work order raised', w.kind === 'request' ? 'new' : 'open', created]);
    let current = w.kind === 'request' ? 'new' : 'open';
    for (const [by, kind, text, to] of w.updates) {
      const person = by === 'owner' ? raisedBy : who(by)!;
      if (kind === 'status') { await log(person, 'status', text, false, current, to); current = to!; }
      else if (kind === 'assign') { await log(person, 'assigned', `Given to ${text}`, true); await log(person, 'assigned', 'Assigned to staff', false); }
      else await log(person, 'note', text, kind === 'staff');
    }
    if (w.approval) {
      const byName = async (n: string) => (await one(tx, `select id from app.people where full_name = $1 order by created_at limit 1`, [n]))?.id ?? fail(`no person ${n}`);
      const proposerId = await byName(w.approval.by);
      const proposer = new Actor('', proposerId, w.approval.by, '', [{ roleKey: 'administrator', roleName: 'Administrator',
        perms: new Set(['approvals.propose', 'approvals.view']), scope: null, scopeName: null }]);
      const res = await engine.propose(tx, proposer, { subjectType: w.kind === 'project' ? 'project' : 'work_order', subjectId: wo!.id,
        title: `${ref}: ${w.title}`, details: w.details, amountPaise: w.estimate ? String(w.estimate * 100) : null, scopeNodeId: node });
      for (const v of w.approval.votes) {
        const voter = new Actor('', await byName(v), v, '', []);
        await engine.vote(tx, voter, res!.id, 'approve', '');
      }
      await tx.query(`update app.work_orders set approval_request_id = $2 where id = $1`, [wo!.id, res!.id]);
      await log(proposerId, 'approval', `Sent for approval as ${res!.ref}`, true);
    }
  }
  await tx.query(`insert into app.audit_events (action, entity_type, summary) values ('demo.operations', 'tenant', 'Sample operations data added')`);
  console.log(`${slug}: ${plan.routines.length} routines, ${plan.assets.length} assets, ${plan.work.length} work orders`);
}

// Fills in checks for every scheduled day without one, from the routine's start up to now: most done
// within the window, some late, a few skipped or blocked with a reason, and the rest missed.
async function topUpChecks(tx: Tx, _plan: Plan, _people: Record<string, string>, rand: () => number, today: string) {
  const now = localNow(TZ);
  const routines = await many(tx, `select r.*, (select max(occurrence_on) from app.routine_checks c where c.routine_id = r.id) as last_check,
      (select min(occurrence_on) from app.routine_checks c where c.routine_id = r.id) as first_check
    from app.routines r where r.archived_at is null and r.assignee_person_id is not null`);
  const versions = (await many(tx, `select * from app.routine_schedules`)).map(normalise);
  let added = 0;
  for (const r of routines) {
    const vs = versions.filter(v => (v as any).routine_id === r.id);
    const began = vs.map(v => v.effective_from).sort()[0] ?? addDays(today, -35);
    // History runs from the day the routine began. A long stretch before the first check (an older
    // demo that kept only 35 days) is filled once; after that only the days since the last check are.
    const ranges: [string, string][] = [];
    if (r.first_check && daysBetween(began, String(r.first_check)) > 7) ranges.push([began, addDays(String(r.first_check), -1)]);
    ranges.push([r.last_check ? addDays(String(r.last_check), 1) : began, today]);
    for (const [from, to] of ranges) for (let day = from; day <= to; day = addDays(day, 1)) {
      const s = versionOn(vs, day);
      if (!s || !occursOn(s, day)) continue;
      if (day === today && (!s.end_time || s.end_time > now.minute)) {
        // Today: windows already past are mostly done; the rest stay due for the demo.
        if (!s.start_time || s.start_time > now.minute || rand() < 0.5) continue;
      }
      const roll = rand();
      if (roll < 0.06) continue;   // missed
      const status = roll < 0.09 ? 'skipped' : roll < 0.105 ? 'blocked' : 'done';
      const start = s.start_time ?? '09:00', end = s.end_time ?? '18:00';
      const span = Math.max(5, (Number(end.slice(0, 2)) * 60 + Number(end.slice(3))) - (Number(start.slice(0, 2)) * 60 + Number(start.slice(3))));
      const lateBy = rand() < 0.08 ? 20 + Math.floor(rand() * 90) : 0;
      let mins = Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + Math.floor(rand() * span * 0.8) + (lateBy ? span + lateBy : 0);
      mins = Math.min(mins, 23 * 60 + 58);
      const minute = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      if (day === today && minute > now.minute) continue;
      const note = status === 'skipped' ? pick(rand, ['Rain all morning; rescheduled', 'Area closed for a resident function', 'Staff on leave; backup covering another block'])
        : status === 'blocked' ? pick(rand, ['Room locked; key with the supervisor', 'Spare part not available', 'Power cut during the window'])
        : lateBy ? pick(rand, ['Started late after the night shift handover', 'Waited for the vendor', '']) : '';
      const reading = status === 'done' && s.reading_label ? readingFor(s.reading_label, rand) : null;
      await tx.query(`insert into app.routine_checks (routine_id, occurrence_on, status, performed_at, note, reading, late, recorded_by, recorded_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $4) on conflict do nothing`,
        [r.id, day, status, zonedInstant(day, minute, TZ), note, reading, status === 'done' && isLate(s, day, { day, minute }),
          rand() < 0.85 || !r.backup_person_id ? r.assignee_person_id : r.backup_person_id]);
      added++;
    }
  }
  if (added) console.log(`  ${added} checks recorded up to ${today}`);
}

const pick = <T>(rand: () => number, xs: T[]) => xs[Math.floor(rand() * xs.length)];
function readingFor(label: string, rand: () => number) {
  const ranges: Record<string, [number, number, number]> = { 'Treated water': [280, 420, 0], Hardness: [90, 160, 0], 'Free chlorine': [1, 3, 1],
    'Running hours': [1500, 1600, 1], 'Tank level': [55, 95, 0], 'Visitors logged': [20, 140, 0], 'Meter reading': [40000, 41000, 0] };
  const [lo, hi, dp] = ranges[label] ?? [1, 100, 0];
  return (lo + rand() * (hi - lo)).toFixed(dp);
}
function fail(m: string): never { throw new Error(m); }

// ------------------------------------------------------------------------------------------------
const PLANS: Record<string, Plan> = {
  'palm-meadows': {
    staff: [
      ['Prakash Menon', '+919000030101', 'facility_manager'],
      ['Joseph D\'Souza', '+919000030102', 'facility_manager', 'Phase 1: Sky Towers'],
      ['Murugan Selvam', '+919000030103', 'staff'], ['Lakshmi Devi', '+919000030104', 'staff'], ['Ravi Shankar', '+919000030105', 'staff'],
      ['Basheer Ahmed', '+919000030106', 'staff'], ['Kumaravel Pandian', '+919000030107', 'staff'], ['Saravanan Muthu', '+919000030108', 'staff'],
    ],
    assets: [
      ['Sky A lifts (4)', 'lift', 'Sky A', 'Velan Lifts & Escalators'], ['Sky B lifts (4)', 'lift', 'Sky B', 'Velan Lifts & Escalators'],
      ['Sky C lifts (4)', 'lift', 'Sky C', 'Velan Lifts & Escalators'],
      ['DG set 1 (750 kVA)', 'generator', 'Phase 1: Sky Towers', 'Kaveri Power Systems'],
      ['DG set 2 (320 kVA)', 'generator', 'Phase 2: Palm Villas', 'Kaveri Power Systems'],
      ['Sewage treatment plant (450 KLD)', 'sewage_treatment', 'Palm Meadows Township', 'Neervalam Water Engineers'],
      ['Water treatment plant', 'water_treatment', 'Palm Meadows Township', 'Neervalam Water Engineers'],
      ['Fire pump set (main and jockey)', 'fire_safety', 'Phase 1: Sky Towers', 'Agni Suraksha Services'],
      ['Golf course irrigation pump (15 HP)', 'pump', 'Palm Meadows Township', 'Green Fairway Turf Care', 'Palm Meadows Golf Course (9 holes)'],
      ['Pool filtration system', 'pool', 'Phase 1: Sky Towers', 'BlueWave Pools', 'Sky Towers pool'],
      ['CCTV system (126 cameras)', 'cctv', 'Palm Meadows Township', 'Netra Secure Systems'],
      ['Boom barriers and access control', 'access_control', 'Palm Meadows Township', 'Netra Secure Systems'],
      ['11 kV transformer', 'transformer', 'Palm Meadows Township', 'Kaveri Power Systems'],
      ['Solar rooftop (120 kWp)', 'solar', 'Phase 1: Sky Towers', 'Suryan Energy'],
      ['Clubhouse gym equipment', 'gym', 'Palm Meadows Township', 'FitServe Equipment', 'Grand Clubhouse'],
    ],
    contracts: [
      ['Sky A lifts (4)', 'Sky A', 'amc', 'Sky A lifts AMC', 'Velan Lifts & Escalators', 18, 360000],
      ['Sky B lifts (4)', 'Sky B', 'amc', 'Sky B lifts AMC', 'Velan Lifts & Escalators', 200, 360000],
      ['Sky C lifts (4)', 'Sky C', 'amc', 'Sky C lifts AMC', 'Velan Lifts & Escalators', 200, 360000],
      ['Sky A lifts (4)', 'Sky A', 'licence', 'Sky A lift operating licences', 'Lift inspectorate', -5, 4500],
      ['Sky B lifts (4)', 'Sky B', 'licence', 'Sky B lift operating licences', 'Lift inspectorate', 40, 4500],
      ['Sky C lifts (4)', 'Sky C', 'licence', 'Sky C lift operating licences', 'Lift inspectorate', 40, 4500],
      ['DG set 1 (750 kVA)', 'Phase 1: Sky Towers', 'amc', 'DG set 1 AMC', 'Kaveri Power Systems', 95, 120000],
      ['DG set 2 (320 kVA)', 'Phase 2: Palm Villas', 'amc', 'DG set 2 AMC', 'Kaveri Power Systems', 95, 64000],
      ['Sewage treatment plant (450 KLD)', 'Palm Meadows Township', 'amc', 'STP operation and maintenance', 'Neervalam Water Engineers', 150, 780000],
      ['Sewage treatment plant (450 KLD)', 'Palm Meadows Township', 'licence', 'Consent to operate the STP', 'State pollution control board', 25, 15000],
      [null, 'Palm Meadows Township', 'licence', 'Fire safety certificate (NOC)', 'Fire and rescue services', 60, null],
      ['Fire pump set (main and jockey)', 'Phase 1: Sky Towers', 'amc', 'Fire system AMC', 'Agni Suraksha Services', 130, 95000],
      ['Pool filtration system', 'Phase 1: Sky Towers', 'amc', 'Pool equipment AMC', 'BlueWave Pools', 12, 72000],
      ['CCTV system (126 cameras)', 'Palm Meadows Township', 'amc', 'CCTV and access control AMC', 'Netra Secure Systems', 240, 145000],
      [null, 'Palm Meadows Township', 'insurance', 'Common property insurance', 'Sahyadri General Insurance (sample)', 75, 485000],
      ['Solar rooftop (120 kWp)', 'Phase 1: Sky Towers', 'warranty', 'Solar panel performance warranty', 'Suryan Energy', 1500, null],
      ['Clubhouse gym equipment', 'Palm Meadows Township', 'amc', 'Gym equipment AMC', 'FitServe Equipment', -20, 38000],
      ['Golf course irrigation pump (15 HP)', 'Palm Meadows Township', 'warranty', 'Irrigation pump warranty', 'Green Fairway Turf Care', 330, null],
    ],
    routines: [
      { title: 'Main gate and perimeter round', category: 'security', place: 'Palm Meadows Township', who: 'Basheer Ahmed', freq: 'daily', start: '06:00', end: '07:00',
        instructions: 'Walk the full perimeter. Check the boom barriers, visitor register and all four gates. Note anything unusual.' },
      { title: 'Night patrol log', category: 'security', place: 'Palm Meadows Township', who: 'Basheer Ahmed', freq: 'daily', start: '23:00', end: '23:59', reading: ['Visitors logged', 'count', 0, 0] },
      { title: 'Sky A lift inspection', category: 'lifts', place: 'Sky A', who: 'Murugan Selvam', backup: 'Ravi Shankar', asset: 'Sky A lifts (4)', freq: 'weekly', days: [1], start: '10:00', end: '12:00' },
      { title: 'Sky B lift inspection', category: 'lifts', place: 'Sky B', who: 'Murugan Selvam', backup: 'Ravi Shankar', asset: 'Sky B lifts (4)', freq: 'weekly', days: [2], start: '10:00', end: '12:00' },
      { title: 'Sky C lift inspection', category: 'lifts', place: 'Sky C', who: 'Murugan Selvam', backup: 'Ravi Shankar', asset: 'Sky C lifts (4)', freq: 'weekly', days: [3], start: '10:00', end: '12:00' },
      { title: 'DG set 1 test run', category: 'electrical', place: 'Phase 1: Sky Towers', who: 'Murugan Selvam', asset: 'DG set 1 (750 kVA)', freq: 'weekly', days: [5], start: '11:00', end: '12:00',
        reading: ['Running hours', 'hrs', 0, 0], instructions: 'Run on load for 15 minutes. Record the hour meter, fuel level and any alarms.' },
      { title: 'STP readings and log', category: 'water', place: 'Palm Meadows Township', who: 'Saravanan Muthu', asset: 'Sewage treatment plant (450 KLD)', freq: 'daily', start: '08:00', end: '09:00', reading: ['Treated water', 'KL', 0, 0] },
      { title: 'WTP hardness check', category: 'water', place: 'Palm Meadows Township', who: 'Saravanan Muthu', asset: 'Water treatment plant', freq: 'daily', start: '07:00', end: '08:00', reading: ['Hardness', 'ppm', 0, 0] },
      { title: 'Pool chlorine and pH check', category: 'pool', place: 'Phase 1: Sky Towers', who: 'Saravanan Muthu', asset: 'Pool filtration system', freq: 'daily', start: '06:30', end: '07:30', reading: ['Free chlorine', 'ppm', 0, 0] },
      { title: 'Sky Towers common area housekeeping', category: 'housekeeping', place: 'Phase 1: Sky Towers', who: 'Lakshmi Devi', freq: 'daily', start: '09:00', end: '11:00' },
      { title: 'Garbage collection: towers', category: 'waste', place: 'Phase 1: Sky Towers', who: 'Lakshmi Devi', freq: 'daily', start: '07:30', end: '09:00' },
      { title: 'Garbage collection: villas and row houses', category: 'waste', place: 'Phase 2: Palm Villas', who: 'Lakshmi Devi', freq: 'daily', start: '07:00', end: '08:30' },
      { title: 'Golf course mowing and irrigation', category: 'garden', place: 'Palm Meadows Township', who: 'Kumaravel Pandian', asset: 'Golf course irrigation pump (15 HP)', freq: 'weekly', days: [2, 5], start: '06:00', end: '10:00' },
      { title: 'Landscape watering: Palm Avenue and Coconut Lane', category: 'garden', place: 'Phase 2: Palm Villas', who: 'Kumaravel Pandian', freq: 'daily', start: '17:00', end: '18:30' },
      { title: 'Clubhouse opening check', category: 'general', place: 'Palm Meadows Township', who: 'Lakshmi Devi', freq: 'daily', start: '06:00', end: '06:30' },
      { title: 'Fire extinguisher pressure check', category: 'fire_safety', place: 'Palm Meadows Township', who: 'Murugan Selvam', freq: 'monthly', days: [5], start: '10:00', end: '17:00', remarks: 'required' },
      { title: 'Solar panel cleaning', category: 'electrical', place: 'Phase 1: Sky Towers', who: 'Murugan Selvam', asset: 'Solar rooftop (120 kWp)', freq: 'monthly', days: [1, 16] },
      { title: 'Market Square parking lights check', category: 'electrical', place: 'Phase 3: Market Square', who: 'Murugan Selvam', freq: 'weekly', days: [6], start: '18:30', end: '19:30' },
      { title: 'Overhead tank cleaning', category: 'water', place: 'Phase 1: Sky Towers', who: 'Ravi Shankar', freq: 'quarterly', days: [15] },
      { title: 'Township fire drill', category: 'fire_safety', place: 'Palm Meadows Township', who: 'Prakash Menon', freq: 'half_yearly', days: [20], remarks: 'required' },
    ],
    work: [
      { kind: 'request', title: 'Water seepage in the bathroom ceiling', details: 'Damp patch spreading near the exhaust fan since Sunday.', category: 'plumbing',
        place: 'Sky B', unitIn: 'Sky B', priority: 'high', status: 'in_progress', who: 'Ravi Shankar', ageDays: 3, dueIn: 1, updates: [
          ['Prakash Menon', 'status', '', 'open'], ['Prakash Menon', 'assign', 'Ravi Shankar'],
          ['Ravi Shankar', 'status', 'Checked from the flat above: the waste coupling is loose.', 'in_progress'],
          ['Ravi Shankar', 'staff', 'Need access to the flat above tomorrow at 10. Owner informed.']] },
      { kind: 'request', title: 'Balcony light not working', details: 'The balcony light and the plug point next to it stopped working last night.', category: 'electrical',
        place: 'Phase 2: Palm Villas', unitIn: 'Phase 2: Palm Villas', priority: 'normal', status: 'new', ageDays: 0.2, updates: [] },
      { kind: 'request', title: 'Intercom not working', details: 'Cannot call the security desk from the kitchen intercom.', category: 'electrical',
        place: 'Sky A', unitIn: 'Sky A', priority: 'normal', status: 'done', who: 'Murugan Selvam', ageDays: 2, updates: [
          ['Joseph D\'Souza', 'status', '', 'open'], ['Joseph D\'Souza', 'assign', 'Murugan Selvam'],
          ['Murugan Selvam', 'status', '', 'in_progress'], ['Murugan Selvam', 'status', 'Replaced the handset cord. Tested both ways.', 'done']] },
      { kind: 'request', title: 'Parking slot marked with the wrong number', details: 'My slot shows SC-118; my allotment letter says SC-181.', category: 'general',
        place: 'Sky C', unitIn: 'Sky C', priority: 'low', status: 'closed', who: 'Joseph D\'Souza', ageDays: 12, updates: [
          ['Joseph D\'Souza', 'status', '', 'open'], ['Joseph D\'Souza', 'status', '', 'in_progress'],
          ['Joseph D\'Souza', 'status', 'Repainted as SC-181 after checking the allotment register.', 'done'], ['owner', 'status', 'Thank you.', 'closed']] },
      { kind: 'request', title: 'Mosquito fogging needed on Areca Row', details: 'Lots of mosquitoes in the evenings near the storm drain.', category: 'garden',
        place: 'Areca Row', unitIn: 'Areca Row', priority: 'normal', status: 'open', who: 'Kumaravel Pandian', ageDays: 1, dueIn: 1, updates: [
          ['Prakash Menon', 'status', 'Fogging scheduled with the pest control vendor.', 'open'], ['Prakash Menon', 'assign', 'Kumaravel Pandian']] },
      { kind: 'incident', title: 'Sky B lift 3 stopped between floors 7 and 8', details: 'Two residents inside. Alarm raised at 8:42 pm.', category: 'lifts',
        place: 'Sky B', priority: 'urgent', status: 'closed', who: 'Murugan Selvam', asset: 'Sky B lifts (4)', raisedBy: 'Basheer Ahmed', ageDays: 6, updates: [
          ['Murugan Selvam', 'status', 'Residents brought out safely in 12 minutes. Vendor called.', 'in_progress'],
          ['Murugan Selvam', 'staff', 'Vendor says the door operator board failed. Replacement under AMC.'],
          ['Murugan Selvam', 'status', 'Door operator replaced by the vendor; lift tested for an hour.', 'done'],
          ['Prakash Menon', 'status', 'Checked the vendor report and test log.', 'closed']] },
      { kind: 'incident', title: 'Power trip on the Phase 2 feeder', details: 'All villas on Coconut Lane without power for 40 minutes.', category: 'electrical',
        place: 'Phase 2: Palm Villas', priority: 'high', status: 'done', who: 'Murugan Selvam', raisedBy: 'Murugan Selvam', ageDays: 1, updates: [
          ['Murugan Selvam', 'status', '', 'in_progress'], ['Murugan Selvam', 'status', 'Reset the breaker; a loose neutral at feeder pillar 4 tightened.', 'done']] },
      { kind: 'maintenance', title: 'DG set 1 oil and filter change', details: 'Due at 1,600 running hours.', category: 'electrical', place: 'Phase 1: Sky Towers',
        priority: 'normal', status: 'open', who: 'Murugan Selvam', asset: 'DG set 1 (750 kVA)', raisedBy: 'Joseph D\'Souza', ageDays: 2, dueIn: 4, estimate: 18500,
        updates: [['Joseph D\'Souza', 'assign', 'Murugan Selvam']] },
      { kind: 'maintenance', title: 'Replace the pool pump seal', details: 'Water dripping from the main pump seal.', category: 'pool', place: 'Phase 1: Sky Towers',
        priority: 'high', status: 'on_hold', who: 'Saravanan Muthu', asset: 'Pool filtration system', raisedBy: 'Saravanan Muthu', ageDays: 5, dueIn: -2, updates: [
          ['Saravanan Muthu', 'status', '', 'in_progress'], ['Saravanan Muthu', 'status', 'Seal kit on order with the vendor; expected Friday.', 'on_hold']] },
      { kind: 'project', title: 'Clubhouse roof waterproofing', details: 'Leaks in the banquet hall during the last monsoon. Three quotes compared; recommended vendor offers a 7-year warranty.',
        category: 'general', place: 'Palm Meadows Township', priority: 'high', status: 'open', who: 'Prakash Menon', ageDays: 4, dueIn: 30, estimate: 420000,
        approval: { by: 'Rajesh Sharma', votes: ['Sridhar Natarajan', 'Anitha Pillai', 'Karthik Rao'] },
        updates: [['Prakash Menon', 'note', 'Work can start once the federation council approves.']] },
      { kind: 'project', title: 'EV charging points for Sky Towers parking', details: 'Twelve 7.4 kW points across the three towers, billed to each user.',
        category: 'electrical', place: 'Phase 1: Sky Towers', priority: 'normal', status: 'open', who: 'Joseph D\'Souza', ageDays: 9, dueIn: 60, estimate: 750000,
        updates: [['Joseph D\'Souza', 'staff', 'Waiting for the third quote.']] },
      { kind: 'maintenance', title: 'Repaint Market Square parking markings', details: 'Faded bay lines and arrows.', category: 'general', place: 'Phase 3: Market Square',
        priority: 'low', status: 'closed', who: 'Prakash Menon', ageDays: 20, updates: [
          ['Prakash Menon', 'status', '', 'in_progress'], ['Prakash Menon', 'status', 'Repainted over two nights.', 'done'], ['Prakash Menon', 'status', '', 'closed']] },
    ],
  },
  'riverside-greens': {
    staff: [
      ['Selvi Murugan', '+919000020101', 'facility_manager'], ['Anwar Basha', '+919000020102', 'staff'], ['Pandi Durai', '+919000020103', 'staff'],
      ['Kala Raman', '+919000020104', 'staff'],
    ],
    assets: [
      ['Ganga Block lifts (2)', 'lift', 'Ganga Block', 'Velan Lifts & Escalators'], ['Kaveri Block lifts (2)', 'lift', 'Kaveri Block', 'Velan Lifts & Escalators'],
      ['Yamuna Block lifts (2)', 'lift', 'Yamuna Block', 'Velan Lifts & Escalators'], ['DG set (500 kVA)', 'generator', 'Riverside Greens', 'Kaveri Power Systems'],
      ['Sewage treatment plant', 'sewage_treatment', 'Riverside Greens', 'Neervalam Water Engineers'], ['Swimming pool filtration', 'pool', 'Riverside Greens', 'BlueWave Pools', 'Swimming pool'],
    ],
    contracts: [
      ['Ganga Block lifts (2)', 'Ganga Block', 'amc', 'Ganga Block lifts AMC', 'Velan Lifts & Escalators', 22, 160000],
      ['Kaveri Block lifts (2)', 'Kaveri Block', 'amc', 'Kaveri Block lifts AMC', 'Velan Lifts & Escalators', 180, 160000],
      ['Yamuna Block lifts (2)', 'Yamuna Block', 'amc', 'Yamuna Block lifts AMC', 'Velan Lifts & Escalators', 180, 160000],
      ['DG set (500 kVA)', 'Riverside Greens', 'amc', 'DG set AMC', 'Kaveri Power Systems', -8, 82000],
      [null, 'Riverside Greens', 'licence', 'Fire safety certificate (NOC)', 'Fire and rescue services', 210, null],
      [null, 'Riverside Greens', 'insurance', 'Common property insurance', 'Sahyadri General Insurance (sample)', 45, 210000],
    ],
    routines: [
      { title: 'Gate security round', category: 'security', place: 'Riverside Greens', who: 'Anwar Basha', freq: 'daily', start: '06:00', end: '07:00' },
      { title: 'Ganga Block lift check', category: 'lifts', place: 'Ganga Block', who: 'Pandi Durai', asset: 'Ganga Block lifts (2)', freq: 'weekly', days: [1], start: '10:00', end: '12:00' },
      { title: 'Kaveri Block lift check', category: 'lifts', place: 'Kaveri Block', who: 'Pandi Durai', asset: 'Kaveri Block lifts (2)', freq: 'weekly', days: [3], start: '10:00', end: '12:00' },
      { title: 'Yamuna Block lift check', category: 'lifts', place: 'Yamuna Block', who: 'Pandi Durai', asset: 'Yamuna Block lifts (2)', freq: 'weekly', days: [5], start: '10:00', end: '12:00' },
      { title: 'STP readings', category: 'water', place: 'Riverside Greens', who: 'Pandi Durai', asset: 'Sewage treatment plant', freq: 'daily', start: '08:00', end: '09:00', reading: ['Treated water', 'KL', 0, 0] },
      { title: 'Corridor and lobby cleaning', category: 'housekeeping', place: 'Riverside Greens', who: 'Kala Raman', freq: 'daily', start: '08:00', end: '11:00' },
      { title: 'Garbage collection', category: 'waste', place: 'Riverside Greens', who: 'Kala Raman', freq: 'daily', start: '07:00', end: '08:30' },
      { title: 'Pool water test', category: 'pool', place: 'Riverside Greens', who: 'Pandi Durai', asset: 'Swimming pool filtration', freq: 'daily', start: '06:30', end: '07:30', reading: ['Free chlorine', 'ppm', 0, 0] },
      { title: 'Sump and overhead tank levels', category: 'water', place: 'Riverside Greens', who: 'Pandi Durai', freq: 'daily', start: '17:00', end: '18:00', reading: ['Tank level', '%', 0, 0] },
    ],
    work: [
      { kind: 'request', title: 'Kitchen sink blocked', details: 'Water not draining since morning.', category: 'plumbing', place: 'Kaveri Block', unitIn: 'Kaveri Block',
        priority: 'normal', status: 'in_progress', who: 'Pandi Durai', ageDays: 1, dueIn: 0, updates: [['Selvi Murugan', 'status', '', 'open'], ['Selvi Murugan', 'assign', 'Pandi Durai'], ['Pandi Durai', 'status', '', 'in_progress']] },
      { kind: 'request', title: 'Doorbell not working', details: '', category: 'electrical', place: 'Yamuna Block', unitIn: 'Yamuna Block', priority: 'low', status: 'new', ageDays: 0.3, updates: [] },
      { kind: 'incident', title: 'Water leak from the Ganga Block overhead tank', details: 'Overflow pipe cracked.', category: 'plumbing', place: 'Ganga Block', priority: 'high',
        status: 'done', who: 'Pandi Durai', raisedBy: 'Anwar Basha', ageDays: 2, updates: [['Pandi Durai', 'status', '', 'in_progress'], ['Pandi Durai', 'status', 'Replaced 3 m of overflow pipe.', 'done']] },
      { kind: 'maintenance', title: 'DG set AMC renewal: get quotes', details: 'Current AMC has lapsed.', category: 'electrical', place: 'Riverside Greens', priority: 'high', status: 'open',
        who: 'Selvi Murugan', raisedBy: 'Selvi Murugan', ageDays: 6, dueIn: -1, updates: [['Selvi Murugan', 'staff', 'Two quotes received; one more due.']] },
    ],
  },
  'maple-court': {
    staff: [['Anbu Selvan', '+919000010101', 'facility_manager'], ['Muthu Kumar', '+919000010102', 'staff'], ['Rani Devi', '+919000010103', 'staff']],
    assets: [['Lifts (2)', 'lift', 'Maple Court', 'Velan Lifts & Escalators'], ['DG set (125 kVA)', 'generator', 'Maple Court', 'Kaveri Power Systems'],
      ['Borewell pump', 'pump', 'Maple Court', 'Local plumber'], ['Fire extinguishers (24)', 'fire_safety', 'Maple Court', 'Agni Suraksha Services']],
    contracts: [
      ['Lifts (2)', 'Maple Court', 'amc', 'Lift AMC', 'Velan Lifts & Escalators', 9, 118000],
      ['DG set (125 kVA)', 'Maple Court', 'amc', 'DG set AMC', 'Kaveri Power Systems', 120, 42000],
      ['Fire extinguishers (24)', 'Maple Court', 'inspection', 'Extinguisher refilling and certification', 'Agni Suraksha Services', 34, 9600],
    ],
    routines: [
      { title: 'Morning building services check', category: 'general', place: 'Maple Court', who: 'Muthu Kumar', backup: 'Anbu Selvan', freq: 'daily', start: '09:00', end: '10:00',
        instructions: 'Lifts, pumps, common lights, CCTV recorder and the generator panel.' },
      { title: 'Evening building services check', category: 'general', place: 'Maple Court', who: 'Muthu Kumar', backup: 'Anbu Selvan', freq: 'daily', start: '18:00', end: '19:00' },
      { title: 'Common area cleaning', category: 'housekeeping', place: 'Maple Court', who: 'Rani Devi', freq: 'daily', start: '07:30', end: '09:30' },
      { title: 'Garbage collection check', category: 'waste', place: 'Maple Court', who: 'Rani Devi', freq: 'daily', start: '12:00', end: '12:30' },
      { title: 'EB meter reading (common)', category: 'electrical', place: 'Maple Court', who: 'Muthu Kumar', freq: 'monthly', days: [1], reading: ['Meter reading', 'kWh', 0, 0] },
      { title: 'DG set test run', category: 'electrical', place: 'Maple Court', who: 'Muthu Kumar', asset: 'DG set (125 kVA)', freq: 'weekly', days: [6], start: '11:00', end: '12:00' },
    ],
    work: [
      { kind: 'request', title: 'Bathroom tap leaking', details: '', category: 'plumbing', place: 'A Wing', unitIn: 'A Wing', priority: 'normal', status: 'open', who: 'Muthu Kumar',
        ageDays: 1, dueIn: 1, updates: [['Anbu Selvan', 'status', '', 'open'], ['Anbu Selvan', 'assign', 'Muthu Kumar']] },
      { kind: 'incident', title: 'Lift 2 door not closing fully', details: 'Door sensor dirty or misaligned.', category: 'lifts', place: 'Maple Court', priority: 'high',
        status: 'done', who: 'Muthu Kumar', asset: 'Lifts (2)', raisedBy: 'Muthu Kumar', ageDays: 3, updates: [['Muthu Kumar', 'status', '', 'in_progress'], ['Muthu Kumar', 'status', 'Vendor cleaned and realigned the sensor.', 'done']] },
    ],
  },
};
