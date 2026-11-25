// The books: posting balanced journals, reversing them, and reading balances and dues.
// The database enforces balance, permanence, closed periods and reconciled bank dates; the checks
// here give the same rules plain-English messages before anything is written.
import type { Actor } from '../actor.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, notFound } from '../errors.ts';
import { localNow } from './schedule.ts';

export type Line = { accountId: string; debit?: number; credit?: number; unitId?: string | null; vendorId?: string | null;
  nodeId?: string | null; memo?: string };
export type JournalInput = { kind: 'opening' | 'receipt' | 'payment' | 'transfer' | 'charge' | 'journal'; date: string; dueOn?: string | null;
  narration: string; reference?: string | null; mode?: string | null; unitId?: string | null; vendorId?: string | null;
  source?: string; fileId?: string | null; lines: Line[] };

const PREFIX: Record<string, string> = { opening: 'OB', receipt: 'RC', payment: 'PY', transfer: 'TR', charge: 'CH', journal: 'JV', reversal: 'RV' };
export const rupee = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 });

export async function financeToday(tx: Tx) {
  return localNow((await one(tx, `select timezone from app.tenants`))!.timezone).day;
}
export async function settings(tx: Tx) {
  await tx.query(`insert into app.finance_settings default values on conflict do nothing`);
  return (await one(tx, `select * from app.finance_settings`))!;
}
export async function systemAccount(tx: Tx, key: string) {
  return (await one(tx, `select * from app.ledger_accounts where system_key = $1`, [key])) ?? fail(500, `The ${key} account is missing from the chart.`);
}
export async function account(tx: Tx, id: string) {
  return await one(tx, `select * from app.ledger_accounts where id = $1`, [id]) ?? notFound('That account');
}
export async function cashAccount(tx: Tx, id: string) {
  const a = await account(tx, id);
  if (!a.cash_kind) fail(400, 'Choose a bank or cash account.', 'invalid');
  if (a.archived_at) fail(400, `${a.name} is no longer in use.`, 'invalid');
  return a;
}

export async function post(tx: Tx, actor: Actor | null, j: JournalInput) {
  const today = await financeToday(tx);
  if (j.date > today) fail(400, 'Entries cannot be dated in the future.', 'invalid');
  const s = await settings(tx);
  if (s.books_closed_through && j.date <= s.books_closed_through)
    fail(400, `The books are closed up to ${s.books_closed_through}. Use a later date, or post a correction in the open period.`, 'closed');
  const lines = j.lines.filter(l => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  if (lines.length < 2) fail(400, 'An entry needs at least two lines.', 'invalid');
  for (const l of lines) {
    if (!Number.isSafeInteger(l.debit ?? 0) || !Number.isSafeInteger(l.credit ?? 0) || ((l.debit ?? 0) > 0 && (l.credit ?? 0) > 0))
      fail(400, 'Each line is either a debit or a credit, in whole paise.', 'invalid');
  }
  const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0), cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (dr !== cr) fail(400, `The entry does not balance: debits ${rupee(dr)}, credits ${rupee(cr)}.`, 'invalid');
  const accounts = await many(tx, `select * from app.ledger_accounts where id = any ($1)`, [[...new Set(lines.map(l => l.accountId))]]);
  for (const l of lines) {
    const a = accounts.find(x => x.id === l.accountId) ?? fail(400, 'One of the accounts was not found.', 'invalid');
    if (a!.archived_at) fail(400, `${a!.name} is no longer in use.`, 'invalid');
    if (a!.reconciled_through && j.date <= a!.reconciled_through)
      fail(400, `${a!.name} is reconciled with the bank up to ${a!.reconciled_through}. Use a later date.`, 'closed');
    if (a!.system_key === 'receivables' && !l.unitId) fail(400, 'Say which home this charge or payment is for.', 'invalid');
    if (a!.system_key === 'payables' && !l.vendorId) fail(400, 'Say which vendor this is for.', 'invalid');
  }
  const ref = (await one(tx, `select app.next_ref($1, $2) as ref`, [`journal_${j.kind}`, PREFIX[j.kind]]))!.ref;
  const row = await one(tx, `insert into app.journals (ref, kind, txn_date, due_on, narration, reference, mode, unit_id, vendor_id, source, file_id, created_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [ref, j.kind, j.date, j.dueOn ?? null, j.narration.trim().slice(0, 500), j.reference || null, j.mode ?? null, j.unitId ?? null, j.vendorId ?? null,
      j.source ?? 'manual', j.fileId ?? null, actor?.personId || null]);
  // One statement for all lines, so a billing run of hundreds of homes posts quickly.
  await tx.query(`insert into app.journal_lines (journal_id, account_id, debit_paise, credit_paise, unit_id, vendor_id, node_id, memo)
    select $1, x.account_id, x.debit, x.credit, x.unit_id, x.vendor_id, x.node_id, x.memo
      from unnest($2::uuid[], $3::bigint[], $4::bigint[], $5::uuid[], $6::uuid[], $7::uuid[], $8::text[])
        as x(account_id, debit, credit, unit_id, vendor_id, node_id, memo)`,
    [row!.id, lines.map(l => l.accountId), lines.map(l => l.debit ?? 0), lines.map(l => l.credit ?? 0), lines.map(l => l.unitId ?? null),
      lines.map(l => l.vendorId ?? null), lines.map(l => l.nodeId ?? null), lines.map(l => (l.memo ?? '').slice(0, 300))]);
  return { id: row!.id as string, ref: ref as string };
}

// A correction: the same lines with debits and credits swapped, on a date in the open period.
export async function reverse(tx: Tx, actor: Actor, journalId: string, reason: string, date?: string) {
  const j = await one(tx, `select * from app.journals where id = $1`, [journalId]) ?? notFound('That entry');
  if (j.kind === 'reversal') fail(400, 'A reversal cannot itself be reversed. Post a new entry instead.', 'invalid');
  if (await one(tx, `select 1 from app.journals where reverses_id = $1`, [journalId])) fail(409, `${j.ref} has already been reversed.`, 'closed');
  const lines = await many(tx, `select * from app.journal_lines where journal_id = $1 order by id`, [journalId]);
  const day = date ?? await financeToday(tx);
  const s = await settings(tx);
  if (s.books_closed_through && day <= s.books_closed_through) fail(400, `The books are closed up to ${s.books_closed_through}.`, 'closed');
  const ref = (await one(tx, `select app.next_ref('journal_reversal', 'RV') as ref`))!.ref;
  const row = await one(tx, `insert into app.journals (ref, kind, txn_date, due_on, narration, reference, mode, unit_id, vendor_id, reverses_id, source, created_by)
    values ($1, 'reversal', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [ref, day, j.due_on, `Reversal of ${j.ref}: ${reason}`.slice(0, 500), j.reference, j.mode, j.unit_id, j.vendor_id, j.id, j.source, actor.personId]);
  for (const l of lines) await tx.query(`insert into app.journal_lines (journal_id, account_id, debit_paise, credit_paise, unit_id, vendor_id, node_id, memo)
    values ($1, $2, $3, $4, $5, $6, $7, $8)`, [row!.id, l.account_id, l.credit_paise, l.debit_paise, l.unit_id, l.vendor_id, l.node_id, l.memo]);
  return { id: row!.id as string, ref: ref as string };
}

// Balance of each account (debit positive) as of a day, and optionally the movement within a period.
export async function balances(tx: Tx, asOf: string, from?: string) {
  return many(tx, `select a.id, a.code, a.name, a.type, a.system_key, a.cash_kind, a.bank_name, a.account_last4, a.reconciled_through, a.archived_at,
      coalesce(sum(l.debit_paise - l.credit_paise) filter (where j.txn_date <= $1::date), 0)::bigint as balance,
      coalesce(sum(l.debit_paise - l.credit_paise) filter (where $2::date is not null and j.txn_date < $2::date), 0)::bigint as opening,
      coalesce(sum(l.debit_paise) filter (where $2::date is not null and j.txn_date between $2::date and $1::date), 0)::bigint as period_debit,
      coalesce(sum(l.credit_paise) filter (where $2::date is not null and j.txn_date between $2::date and $1::date), 0)::bigint as period_credit
    from app.ledger_accounts a
    left join app.journal_lines l on l.tenant_id = a.tenant_id and l.account_id = a.id
    left join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
    group by a.id order by a.code`, [asOf, from ?? null]);
}

// What each home owes, oldest charges settled first, with the unpaid part grouped by how overdue it is.
export type Dues = { unit_id: string; balance: number; charged: number; paid: number; buckets: { current: number; d30: number; d60: number; d90: number; over90: number };
  oldest_due: string | null };
export async function duesByUnit(tx: Tx, asOf: string, unitIds?: string[]): Promise<Map<string, Dues>> {
  const rows = await many(tx, `select l.unit_id, l.debit_paise::bigint as debit, l.credit_paise::bigint as credit, coalesce(j.due_on, j.txn_date) as due, j.txn_date
    from app.journal_lines l join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
    join app.ledger_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id and a.system_key = 'receivables'
    where j.txn_date <= $1::date and ($2::uuid[] is null or l.unit_id = any ($2))
    order by l.unit_id, coalesce(j.due_on, j.txn_date), l.id`, [asOf, unitIds ?? null]);
  const out = new Map<string, Dues>();
  const byUnit = new Map<string, any[]>();
  for (const r of rows) byUnit.set(r.unit_id, [...(byUnit.get(r.unit_id) ?? []), r]);
  for (const [unit, rs] of byUnit) {
    let credits = rs.reduce((s, r) => s + Number(r.credit), 0);
    const charged = rs.reduce((s, r) => s + Number(r.debit), 0);
    const d: Dues = { unit_id: unit, balance: charged - credits, charged, paid: credits, buckets: { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 }, oldest_due: null };
    for (const r of rs.filter(r => Number(r.debit) > 0)) {
      const settled = Math.min(credits, Number(r.debit));
      credits -= settled;
      const left = Number(r.debit) - settled;
      if (left <= 0) continue;
      d.oldest_due ??= r.due;
      const age = Math.round((Date.parse(asOf) - Date.parse(r.due)) / 86_400_000);
      const k = age <= 0 ? 'current' : age <= 30 ? 'd30' : age <= 60 ? 'd60' : age <= 90 ? 'd90' : 'over90';
      d.buckets[k] += left;
    }
    out.set(unit, d);
  }
  return out;
}

export function fyOf(day: string, startMonth: number) {
  const [y, m] = day.split('-').map(Number);
  const start = m >= startMonth ? y : y - 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const end = new Date(Date.UTC(start + 1, startMonth - 1, 0)).toISOString().slice(0, 10);
  return { start: `${start}-${pad(startMonth)}-01`, end, label: startMonth === 1 ? `${start}` : `${start}–${String(start + 1).slice(2)}`, year: start };
}
