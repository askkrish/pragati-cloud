// Sample books for the demo communities, from the start of the financial year to today. Every
// person, amount, bank and reference is invented; the UPI ID points at a bank that does not exist.
import { randomUUID } from 'node:crypto';
import { Actor } from '../server/src/actor.ts';
import { many, one, type Tx } from '../server/src/db.ts';
import * as engine from '../server/src/services/approvals.ts';
import { fyOf, post } from '../server/src/services/ledger.ts';
import { addDays, localNow } from '../server/src/services/schedule.ts';

type Plan = { name: string; freq: 'monthly' | 'quarterly'; basis: 'area' | 'unit_type' | 'flat'; area?: string; rate?: number; types?: Record<string, number>;
  scope: string | null; cats: string[]; account: string };
type Expense = { payee: string; vendor?: string; account: string; amount: number; scope?: string; tds?: number };
type Config = { treasurer: string; preparer: string; opening: number; corpus: number; petty: number; plans: Plan[]; expenses: Expense[]; payRate: number };

const CONFIG: Record<string, Config> = {
  'palm-meadows': {
    treasurer: 'Rajesh Sharma', preparer: 'Prakash Menon', opening: 1840000, corpus: 12500000, petty: 15000, payRate: 0.9,
    plans: [
      { name: 'Monthly maintenance: Sky Towers apartments', freq: 'monthly', basis: 'area', area: 'super_sqft', rate: 4, scope: 'Phase 1: Sky Towers', cats: ['apartment'], account: '4000' },
      { name: 'Monthly maintenance: villas and row houses', freq: 'monthly', basis: 'area', area: 'plot_sqft', rate: 3, scope: 'Phase 2: Palm Villas', cats: ['villa', 'row_house'], account: '4000' },
      { name: 'Monthly maintenance: shops and offices', freq: 'monthly', basis: 'unit_type', types: { Shop: 2500, Office: 4000 }, scope: 'Phase 3: Market Square', cats: ['commercial'], account: '4000' },
      { name: 'Sinking fund contribution', freq: 'quarterly', basis: 'flat', rate: 1500, scope: null, cats: ['apartment', 'villa', 'row_house'], account: '3200' },
    ],
    expenses: [
      { payee: 'Staff payroll', account: '5000', amount: 950000 },
      { payee: 'Kaval Security Services', vendor: 'Kaval Security Services', account: '5010', amount: 560000, tds: 11200 },
      { payee: 'Suththam Facility Services', vendor: 'Suththam Facility Services', account: '5020', amount: 420000, tds: 8400 },
      { payee: 'Electricity board', account: '5030', amount: 840000 },
      { payee: 'Water tanker supply', account: '5040', amount: 190000 },
      { payee: 'Diesel supplier', account: '5070', amount: 140000 },
      { payee: 'Green Fairway Turf Care', vendor: 'Green Fairway Turf Care', account: '5080', amount: 160000, tds: 3200 },
      { payee: 'Velan Lifts & Escalators', vendor: 'Velan Lifts & Escalators', account: '5060', amount: 90000, tds: 1800, scope: 'Phase 1: Sky Towers' },
    ],
  },
  'riverside-greens': {
    treasurer: 'Lakshmi Subramanian', preparer: 'Selvi Murugan', opening: 620000, corpus: 3800000, petty: 8000, payRate: 0.88,
    plans: [{ name: 'Monthly maintenance', freq: 'monthly', basis: 'area', area: 'carpet_sqft', rate: 3.5, scope: null, cats: ['apartment'], account: '4000' }],
    expenses: [{ payee: 'Staff payroll', account: '5000', amount: 240000 }, { payee: 'Electricity board', account: '5030', amount: 160000 },
      { payee: 'Security agency', account: '5010', amount: 120000 }],
  },
  'maple-court': {
    treasurer: 'Padma Natarajan', preparer: 'Anbu Selvan', opening: 185000, corpus: 900000, petty: 5000, payRate: 0.94,
    plans: [{ name: 'Monthly maintenance', freq: 'monthly', basis: 'unit_type', types: { '2 BHK': 3200, '3 BHK': 4100 }, scope: null, cats: ['apartment'], account: '4000' }],
    expenses: [{ payee: 'Staff salaries', account: '5000', amount: 62000 }, { payee: 'Electricity board', account: '5030', amount: 38000 },
      { payee: 'Velan Lifts & Escalators', account: '5060', amount: 9800 }],
  },
};

export async function seedFinance(tx: Tx, slug: string, seedNo: number) {
  const c = CONFIG[slug];
  if (!c || await one(tx, `select 1 from app.journals limit 1`)) return;
  let s = seedNo;
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const today = localNow('Asia/Kolkata').day;
  const fy = fyOf(today, 4);
  // Sample owners can share a name with a committee member: prefer the person who holds a committee seat.
  const byName = async (n: string) => (await one(tx, `select p.id from app.people p where p.full_name = $1
    order by exists (select 1 from app.committee_seats s where s.person_id = p.id and s.ends_on is null) desc, p.created_at limit 1`, [n]))?.id ?? fail(`no person ${n}`);
  const acc = async (code: string) => (await one(tx, `select id from app.ledger_accounts where code = $1`, [code]))!.id;
  const node = async (name: string | null) => name ? (await one(tx, `select id from app.property_nodes where name = $1`, [name]))!.id
    : (await one(tx, `select id from app.property_nodes where parent_id is null`))!.id;
  const treasurerId = await byName(c.treasurer);
  const role = (await one(tx, `select id from app.roles where key = 'treasurer'`))!.id;
  await tx.query(`insert into app.memberships (person_id, role_id) values ($1, $2) on conflict do nothing`, [treasurerId, role]);
  const brand = (await one(tx, `select brand_name from app.tenants`))!.brand_name as string;
  await tx.query(`update app.finance_settings set upi_id = $1, payment_instructions = $2`, [`${slug}-demo@examplebank`,
    `This is a demo community: please do not pay anything.\nIn a real community this space shows the association's bank transfer details, the cheque payee name ("${brand} Owners Association") and the office hours for cash.`]);

  // ---------- accounts and opening balances ----------
  const mk = async (code: string, name: string, kind: string, bank: string | null, last4: string | null) =>
    (await one(tx, `insert into app.ledger_accounts (code, name, type, cash_kind, bank_name, account_last4) values ($1, $2, 'asset', $3, $4, $5) returning id`,
      [code, name, kind, bank, last4]))!.id as string;
  const opBank = await mk('1000', 'Operating account', 'bank', 'Sample Co-operative Bank', '2045');
  const fdBank = await mk('1010', 'Corpus fund account', 'bank', 'Sample Co-operative Bank', '7731');
  const petty = await mk('1050', 'Petty cash', 'cash', null, null);
  const J: Bulk[] = [];
  const general = await acc('3000'), corpus = await acc('3100'), recv = await acc('1100'), interest = await acc('4030');
  J.push({ kind: 'opening', date: fy.start, narration: 'Opening balance of the operating account', source: 'opening', lines: [[opBank, c.opening * 100, 0], [general, 0, c.opening * 100]] });
  J.push({ kind: 'opening', date: fy.start, narration: 'Opening balance of the corpus fund account', source: 'opening', lines: [[fdBank, c.corpus * 100, 0], [corpus, 0, c.corpus * 100]] });
  J.push({ kind: 'opening', date: fy.start, narration: 'Petty cash in hand', source: 'opening', lines: [[petty, c.petty * 100, 0], [general, 0, c.petty * 100]] });

  // ---------- billing plans and a run for every period so far ----------
  const months: string[] = [];
  for (let d = fy.start; d <= today; d = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 1)).toISOString().slice(0, 10)) months.push(d);
  const charges = new Map<string, { month: string; amount: number; due: string }[]>();
  const runs: { planId: string; period: string; issue: string; due: string; lines: { unit: string; amount: number; basis: string; node: string }[]; account: string; scope: string; name: string }[] = [];
  for (const p of c.plans) {
    const scope = await node(p.scope);
    const ref = (await one(tx, `select app.next_ref('plan', 'BP') as ref`))!.ref;
    const types = p.types ? Object.fromEntries(await Promise.all(Object.entries(p.types).map(async ([n, v]) =>
      [(await one(tx, `select id from app.unit_types where name = $1`, [n]))!.id, v * 100]))) : {};
    const planId = (await one(tx, `insert into app.charge_plans (ref, name, frequency, basis, area_field, rate_paise, unit_type_rates, scope_node_id, categories, account_id, due_days, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 14, $11) returning id`, [ref, p.name, p.freq, p.basis, p.area ?? null, p.rate ? Math.round(p.rate * 100) : null,
        types, scope, p.cats, await acc(p.account), treasurerId]))!.id;
    const units = await many(tx, `select u.id, u.label, u.node_id, u.unit_type_id, u.super_sqft, u.plot_sqft, u.carpet_sqft from app.units u
      join app.unit_types t on t.tenant_id = u.tenant_id and t.id = u.unit_type_id join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
      where (n.id = $1 or $1 = any (n.ancestor_ids)) and t.category = any ($2) order by u.label`, [scope, p.cats]);
    for (const [i, m] of months.entries()) {
      if (p.freq === 'quarterly' && i % 3 !== 0) continue;
      const lines = units.map(u => {
        const amount = p.basis === 'area' ? Math.round(Number(u[p.area!] ?? 0) * p.rate!) * 100 : p.basis === 'flat' ? p.rate! * 100 : types[u.unit_type_id] ?? 0;
        return { unit: u.id, amount, basis: p.basis === 'area' ? `${Number(u[p.area!])} sq ft × ₹${p.rate}` : p.basis === 'flat' ? 'Same for every home' : 'By kind of home', node: u.node_id };
      }).filter(l => l.amount > 0);
      const label = new Date(m + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const period = p.freq === 'quarterly' ? `Quarter from ${label}` : label;
      runs.push({ planId, period, issue: m, due: addDays(m, 14), lines, account: await acc(p.account), scope, name: p.name });
      for (const l of lines) charges.set(l.unit, [...(charges.get(l.unit) ?? []), { month: m, amount: l.amount, due: addDays(m, 14) }]);
    }
  }
  for (const r of runs) J.push({ kind: 'charge', date: r.issue, due: r.due, narration: `${r.name}: ${r.period}`, source: 'billing', run: r,
    lines: [...r.lines.map(l => [recv, l.amount, 0, l.unit, l.node, l.basis] as Line), [r.account, 0, r.lines.reduce((s, l) => s + l.amount, 0), null, r.scope, `${r.lines.length} homes`]] });

  // ---------- owners paying: most on time, some late, a few who have not paid for months ----------
  const homes = [...charges.keys()];
  const chronic = new Set(homes.filter(() => rand() < 0.035));
  const late = new Set(homes.filter(h => !chronic.has(h) && rand() < 0.12));
  const unitNode = new Map((await many(tx, `select id, node_id from app.units`)).map(u => [u.id, u.node_id]));
  let utr = 4200000 + Math.floor(rand() * 100000);
  for (const [unit, cs] of charges) {
    const byMonth = new Map<string, number>();
    for (const ch of cs) byMonth.set(ch.month, (byMonth.get(ch.month) ?? 0) + ch.amount);
    let carry = 0;
    for (const [i, m] of [...byMonth.keys()].sort().entries()) {
      carry += byMonth.get(m)!;
      const recent = months.length - 1 - i;           // 0 = this month
      const stop = chronic.has(unit) && recent < 5;
      const p = stop ? 0 : recent === 0 ? 0.45 : recent === 1 ? c.payRate - 0.1 : c.payRate + 0.06;
      if (late.has(unit) && i % 2 === 0 && recent > 0) continue;   // pays two months together
      if (rand() > p) continue;
      const day = addDays(m, 2 + Math.floor(rand() * (recent === 0 ? Math.max(1, Math.min(20, daysBetween(m, today))) : 24)));
      if (day > today) continue;
      const mode = rand() < 0.7 ? 'upi' : rand() < 0.85 ? 'neft' : 'cheque';
      J.push({ kind: 'receipt', date: day, narration: 'Maintenance payment', reference: mode === 'cheque' ? `CHQ ${100000 + Math.floor(rand() * 899999)}` : `UTR${++utr}`,
        mode, unit, source: 'seed', lines: [[opBank, carry, 0], [recv, 0, carry, unit, unitNode.get(unit)!]] });
      carry = 0;
    }
  }

  // ---------- history of spending: monthly payments up to last month ----------
  const vendorId = new Map<string, string>();
  for (const e of c.expenses.filter(e => e.vendor)) {
    let v = await one(tx, `select id from app.vendors where name = $1`, [e.vendor]);
    if (!v) v = await one(tx, `insert into app.vendors (ref, name, categories, created_by) values (app.next_ref('vendor', 'VN'), $1, $2, $3) returning id`,
      [e.vendor, [e.account === '5010' ? 'security' : e.account === '5020' ? 'housekeeping' : 'general'], treasurerId]);
    vendorId.set(e.vendor!, v!.id);
  }
  const tds = await acc('2400');
  let pv = 0;
  for (const m of months.slice(0, -1)) {
    for (const e of c.expenses) {
      const amount = Math.round(e.amount * (0.94 + rand() * 0.12)) * 100;
      const t = (e.tds ?? 0) * 100;
      const label = new Date(m + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      J.push({ kind: 'payment', date: addDays(m, 24 + Math.floor(rand() * 4)), narration: `${e.payee}: ${label}`, reference: `NEFT${880000 + ++pv}`, mode: 'neft',
        vendor: e.vendor ? vendorId.get(e.vendor) : undefined, source: 'seed',
        lines: [[await acc(e.account), amount, 0, null, await node(e.scope ?? null)], [opBank, 0, amount - t], ...(t ? [[tds, 0, t] as Line] : [])] });
    }
  }
  // Interest on the corpus fund at each quarter end.
  for (const q of ['06-30', '09-30', '12-31', '03-31']) {
    const d = `${q.startsWith('03') ? fy.year + 1 : fy.year}-${q}`;
    if (d <= today) J.push({ kind: 'receipt', date: d, narration: 'Interest on the corpus fund deposit', reference: `INT${d.replace(/-/g, '')}`, mode: 'neft', source: 'seed',
      lines: [[fdBank, Math.round(c.corpus * 0.017) * 100, 0], [interest, 0, Math.round(c.corpus * 0.017) * 100]] });
  }
  await bulk(tx, J.sort((a, b) => a.date.localeCompare(b.date)), treasurerId);

  // ---------- this month: vouchers through the approval rules ----------
  const preparer = new Actor('', await byName(c.preparer), c.preparer, '', [{ roleKey: 'facility_manager', roleName: '', scope: null, scopeName: null,
    perms: new Set(['approvals.propose', 'finance.prepare']) }]);
  const treasurer = new Actor('', treasurerId, c.treasurer, '', [{ roleKey: 'treasurer', roleName: '', scope: null, scopeName: null, perms: new Set(['finance.manage']) }]);
  const thisMonth = months[months.length - 1];
  for (const [i, e] of c.expenses.entries()) {
    const amount = Math.round(e.amount * (0.95 + rand() * 0.1)) * 100;
    const label = new Date(thisMonth + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const ref = (await one(tx, `select app.next_ref('voucher', 'PV') as ref`))!.ref;
    const nodeId = await node(e.scope ?? null);
    const v = (await one(tx, `insert into app.vouchers (ref, vendor_id, payee, description, amount_paise, tds_paise, account_id, node_id, invoice_no, invoice_date, prepared_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`, [ref, e.vendor ? vendorId.get(e.vendor) : null, e.payee, `${e.payee}: ${label}`, amount,
        (e.tds ?? 0) * 100, await acc(e.account), nodeId, e.vendor ? `INV/${thisMonth.slice(0, 7)}/${100 + i}` : null, e.vendor ? thisMonth : null, preparer.personId]))!.id;
    const req = await engine.propose(tx, preparer, { subjectType: 'expense', subjectId: v, title: `${ref}: ${e.payee}`, details: `${e.payee}: ${label}`,
      amountPaise: String(amount), scopeNodeId: nodeId });
    await tx.query(`update app.vouchers set approval_request_id = $2 where id = $1`, [v, req!.id]);
    // Most are approved and paid; the last two are still with the committee.
    if (i >= c.expenses.length - 2) continue;
    await approveAll(tx, req!.id);
    if (i % 3 === 2 || (await one(tx, `select status from app.approval_requests where id = $1`, [req!.id]))!.status !== 'approved') continue;
    const tdsP = (e.tds ?? 0) * 100;
    const paidOn = addDays(thisMonth, Math.min(daysBetween(thisMonth, today), 20));
    const j = await post(tx, treasurer, { kind: 'payment', date: paidOn, narration: `${ref}: ${e.payee}`, reference: `NEFT${990000 + i}`, mode: 'neft',
      vendorId: e.vendor ? vendorId.get(e.vendor) : null, source: 'voucher',
      lines: [{ accountId: await acc(e.account), debit: amount, nodeId }, { accountId: opBank, credit: amount - tdsP }, ...(tdsP ? [{ accountId: tds, credit: tdsP }] : [])] });
    await tx.query(`update app.vouchers set status = 'paid', journal_id = $2 where id = $1`, [v, j.id]);
  }

  // ---------- owners telling the treasurer they have paid ----------
  const owing = await many(tx, `select l.unit_id, sum(l.debit_paise - l.credit_paise)::bigint as bal from app.journal_lines l where l.account_id = $1
    group by l.unit_id having sum(l.debit_paise - l.credit_paise) > 0 order by md5(l.unit_id::text) limit 3`, [recv]);
  for (const [i, o] of owing.entries()) {
    const owner = await one(tx, `select person_id from app.ownerships where unit_id = $1 and ends_on is null order by share_pct desc limit 1`, [o.unit_id]);
    if (!owner) continue;
    await tx.query(`insert into app.payment_claims (unit_id, person_id, amount_paise, paid_on, mode, reference, note) values ($1, $2, $3, $4, 'upi', $5, $6)`,
      [o.unit_id, owner.person_id, o.bal, addDays(today, -i), `UTR${7700000 + i * 13}`, i === 0 ? 'Paid from my son\'s account' : '']);
  }

  // ---------- budget, the bank matched to the end of last month, the first half-year closed ----------
  const totals = await many(tx, `select l.account_id, a.type, sum(l.debit_paise - l.credit_paise)::bigint as v from app.journal_lines l
    join app.ledger_accounts a on a.id = l.account_id where a.type in ('income', 'expense') group by 1, 2`);
  const scale = 12 / Math.max(1, months.length);
  for (const t of totals) await tx.query(`insert into app.budgets (fy_start, account_id, amount_paise) values ($1, $2, $3)`,
    [fy.year, t.account_id, Math.round(Math.abs(Number(t.v)) * scale * (t.type === 'expense' ? 1.05 : 0.98) / 100000) * 100000]);
  const lastMonthEnd = addDays(thisMonth, -1);
  if (lastMonthEnd > fy.start) {
    const bal = async (through: string) => Number((await one(tx, `select coalesce(sum(l.debit_paise - l.credit_paise), 0)::bigint as b from app.journal_lines l
      join app.journals j on j.id = l.journal_id where l.account_id = $1 and j.txn_date <= $2`, [opBank, through]))!.b);
    await tx.query(`insert into app.bank_statements (account_id, period_start, period_end, opening_paise, closing_paise, status, created_by, reconciled_at)
      values ($1, $2, $3, $4, $5, 'reconciled', $6, now())`, [opBank, fy.start, lastMonthEnd, c.opening * 100, await bal(lastMonthEnd), treasurerId]);
    await tx.query(`update app.ledger_accounts set reconciled_through = $2 where id = $1`, [opBank, lastMonthEnd]);
  }
  const halfYear = addDays(`${fy.year}-10-01`, -1);
  if (halfYear < today) await tx.query(`update app.finance_settings set books_closed_through = $1`, [halfYear]);
  const n = (await one(tx, `select count(*)::int as n from app.journals`))!.n;
  console.log(`${slug}: ${n} entries in the books, ${runs.length} bills issued`);
}

// ------------------------------------------------------------------------------------------------
type Line = [account: string, debit: number, credit: number, unit?: string | null, node?: string | null, memo?: string];
type Bulk = { kind: string; date: string; due?: string; narration: string; reference?: string; mode?: string; unit?: string; vendor?: string; source: string;
  lines: Line[]; run?: any };
const PREFIX: Record<string, string> = { opening: 'OB', receipt: 'RC', payment: 'PY', charge: 'CH' };

// History goes in with two statements, so a year of a township's books loads in seconds.
async function bulk(tx: Tx, js: Bulk[], by: string) {
  const ids = js.map(() => randomUUID());
  for (let i = 0; i < js.length; i += 2000) {
    const part = js.slice(i, i + 2000), pid = ids.slice(i, i + 2000);
    await tx.query(`insert into app.journals (id, ref, kind, txn_date, due_on, narration, reference, mode, unit_id, vendor_id, source, created_by)
      select x.id, app.next_ref('journal_' || x.kind, x.prefix), x.kind, x.d, x.due, x.n, x.r, x.m, x.u, x.v, x.s, $12
        from unnest($1::uuid[], $2::text[], $3::text[], $4::date[], $5::date[], $6::text[], $7::text[], $8::text[], $9::uuid[], $10::uuid[], $11::text[])
        with ordinality as x(id, kind, prefix, d, due, n, r, m, u, v, s, o) order by x.o`,
      [pid, part.map(j => j.kind), part.map(j => PREFIX[j.kind]), part.map(j => j.date), part.map(j => j.due ?? null), part.map(j => j.narration),
        part.map(j => j.reference ?? null), part.map(j => j.mode ?? null), part.map(j => j.unit ?? null), part.map(j => j.vendor ?? null), part.map(j => j.source), by]);
  }
  const L: (string | number | null)[][] = [[], [], [], [], [], [], [], []];
  js.forEach((j, i) => j.lines.forEach(([a, d, c, u, n, m]) => {
    L[0].push(ids[i]); L[1].push(a); L[2].push(d); L[3].push(c); L[4].push(u ?? null); L[5].push(n ?? null); L[6].push(m ?? ''); L[7].push(j.vendor ?? null);
  }));
  for (let i = 0; i < L[0].length; i += 5000) {
    await tx.query(`insert into app.journal_lines (journal_id, account_id, debit_paise, credit_paise, unit_id, node_id, memo, vendor_id)
      select * from unnest($1::uuid[], $2::uuid[], $3::bigint[], $4::bigint[], $5::uuid[], $6::uuid[], $7::text[], $8::uuid[])`, L.map(col => col.slice(i, i + 5000)));
  }
  for (const [i, j] of js.entries()) {
    if (!j.run) continue;
    const r = j.run;
    const run = (await one(tx, `insert into app.billing_runs (ref, plan_id, period_label, issue_on, due_on, status, total_paise, units, journal_id, created_by, posted_by, posted_at)
      values (app.next_ref('billing_run', 'BR'), $1, $2, $3::date, $4, 'posted', $5, $6, $7, $8, $8, $9::timestamptz) returning id`,
      [r.planId, r.period, r.issue, r.due, r.lines.reduce((s: number, l: any) => s + l.amount, 0), r.lines.length, ids[i], by, `${r.issue}T10:00:00+05:30`]))!.id;
    await tx.query(`insert into app.billing_run_lines (run_id, unit_id, amount_paise, basis) select $1, x.u, x.a, x.b from unnest($2::uuid[], $3::bigint[], $4::text[]) as x(u, a, b)`,
      [run, r.lines.map((l: any) => l.unit), r.lines.map((l: any) => l.amount), r.lines.map((l: any) => l.basis)]);
  }
}

async function approveAll(tx: Tx, id: string) {
  for (let i = 0; i < 6; i++) {
    const r = (await one(tx, `select status, current_stage from app.approval_requests where id = $1`, [id]))!;
    if (r.status !== 'pending') return;
    const waiting = await many(tx, `select v.person_id from app.approval_stage_voters v
      left join app.approval_votes x on x.tenant_id = v.tenant_id and x.request_id = v.request_id and x.stage_no = v.stage_no and x.person_id = v.person_id
      where v.request_id = $1 and v.stage_no = $2 and x.vote is null`, [id, r.current_stage]);
    for (const v of waiting) {
      if ((await one(tx, `select status from app.approval_requests where id = $1`, [id]))!.status !== 'pending') return;
      await engine.vote(tx, new Actor('', v.person_id, '', '', []), id, 'approve', '');
    }
  }
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
function fail(m: string): never { throw new Error(m); }

// Earlier demo data gave the treasurer role to a sample owner who shares the treasurer's name.
// Put it with the committee's treasurer, the person who signs in. Demo communities only.
export async function fixDemoTreasurer(tx: Tx, slug: string) {
  const c = CONFIG[slug];
  if (!c) return;
  const role = await one(tx, `select id from app.roles where key = 'treasurer'`);
  const seated = await one(tx, `select p.id from app.people p where p.full_name = $1
    and exists (select 1 from app.committee_seats s where s.person_id = p.id and s.ends_on is null) order by p.created_at limit 1`, [c.treasurer]);
  if (!role || !seated) return;
  await tx.query(`insert into app.memberships (person_id, role_id) values ($1, $2) on conflict do nothing`, [seated.id, role.id]);
  const moved = await tx.query(`update app.memberships m set status = 'disabled', disabled_at = now() from app.people p
    where m.person_id = p.id and m.role_id = $1 and m.status = 'active' and p.full_name = $2 and p.id <> $3
      and not exists (select 1 from app.committee_seats s where s.person_id = p.id and s.ends_on is null)`, [role.id, c.treasurer, seated.id]);
  if (moved.rowCount) console.log(`${slug}: treasurer role moved to the committee's treasurer`);
}
