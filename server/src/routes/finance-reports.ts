// Finance reports, the Tally export, and bank reconciliation.
import type { FastifyInstance } from 'fastify';
import type { Runner, Services } from '../app.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import { balances, cashAccount, duesByUnit, financeToday, fyOf, rupee, settings } from '../services/ledger.ts';
import { PLACE } from '../services/operations.ts';
import { addDays } from '../services/schedule.ts';
import { canKeepBooks, canViewBooks } from './finance.ts';
import { date, idParam, uuid, z } from './z.ts';

type Report = { title: string; subtitle: string; columns: { key: string; label: string; money?: boolean }[]; rows: Record<string, unknown>[];
  totals?: Record<string, unknown>; note?: string };
const inr = (paise: number) => (paise / 100).toFixed(2);
const TYPE: Record<string, string> = { asset: 'Asset', liability: 'Liability', funds: 'Fund', income: 'Income', expense: 'Expense' };
const day = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

async function report(tx: Tx, kind: string, q: { from?: string; to?: string; asOf?: string; fy?: number; nodeId?: string }): Promise<Report> {
  const today = await financeToday(tx);
  const s = await settings(tx);
  const fy = fyOf(today, s.fy_start_month);
  const to = q.to ?? q.asOf ?? today, from = q.from ?? fy.start;
  const money = (key: string, label: string) => ({ key, label, money: true });
  switch (kind) {
    case 'trial': {
      const rows = (await balances(tx, to)).filter(a => Number(a.balance) !== 0)
        .map(a => ({ code: a.code, name: a.name, type: TYPE[a.type], debit: Math.max(0, Number(a.balance)), credit: Math.max(0, -Number(a.balance)) }));
      const dr = rows.reduce((s, r) => s + r.debit, 0), cr = rows.reduce((s, r) => s + r.credit, 0);
      return { title: 'Trial balance', subtitle: `As on ${day(to)}`, columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account' },
        { key: 'type', label: 'Type' }, money('debit', 'Debit'), money('credit', 'Credit')], rows, totals: { name: 'Total', debit: dr, credit: cr },
        note: dr === cr ? undefined : `The trial balance is out by ${rupee(Math.abs(dr - cr))}.` };
    }
    case 'income': {
      // Income and expenditure, for the whole community or the costs and income of one place.
      const rows = await many(tx, `select a.code, a.name, a.type,
          coalesce(sum(case when a.type = 'income' then l.credit_paise - l.debit_paise else l.debit_paise - l.credit_paise end), 0)::bigint as amount
        from app.ledger_accounts a join app.journal_lines l on l.tenant_id = a.tenant_id and l.account_id = a.id
        join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
        left join app.property_nodes n on n.tenant_id = l.tenant_id and n.id = l.node_id
        where a.type in ('income', 'expense') and j.txn_date between $1 and $2
          and ($3::uuid is null or n.id = $3 or $3 = any (n.ancestor_ids))
        group by a.id having sum(l.debit_paise - l.credit_paise) <> 0 order by a.type desc, a.code`, [from, to, q.nodeId ?? null]);
      const inc = rows.filter(r => r.type === 'income').reduce((s, r) => s + Number(r.amount), 0);
      const exp = rows.filter(r => r.type === 'expense').reduce((s, r) => s + Number(r.amount), 0);
      const place = q.nodeId ? (await one(tx, `select name from app.property_nodes where id = $1`, [q.nodeId]))?.name : null;
      return { title: 'Income and expenditure', subtitle: `${day(from)} to ${day(to)}${place ? `, ${place}` : ''}`,
        columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'type', label: 'Type' }, money('amount', 'Amount')],
        rows: rows.map(r => ({ ...r, type: TYPE[r.type], amount: Number(r.amount) })),
        totals: { name: inc - exp >= 0 ? 'Surplus' : 'Deficit', amount: inc - exp }, note: `Income ${rupee(inc)}; expenditure ${rupee(exp)}.` };
    }
    case 'balance': {
      const all = await balances(tx, to);
      const surplus = -all.filter(a => ['income', 'expense'].includes(a.type)).reduce((s, a) => s + Number(a.balance), 0);
      const recv = await duesByUnit(tx, to);
      const owed = [...recv.values()].reduce((s, d) => s + Math.max(0, d.balance), 0), advance = [...recv.values()].reduce((s, d) => s + Math.max(0, -d.balance), 0);
      const rows: any[] = [];
      for (const a of all.filter(x => ['asset', 'liability', 'funds'].includes(x.type) && Number(x.balance) !== 0)) {
        if (a.system_key === 'receivables') {
          if (owed) rows.push({ side: 'Assets', code: a.code, name: 'Maintenance due from homes', amount: owed });
          if (advance) rows.push({ side: 'Liabilities', code: a.code, name: 'Maintenance paid in advance', amount: advance });
          continue;
        }
        rows.push({ side: a.type === 'asset' ? 'Assets' : a.type === 'funds' ? 'Funds' : 'Liabilities', code: a.code, name: a.name,
          amount: a.type === 'asset' ? Number(a.balance) : -Number(a.balance) });
      }
      if (surplus) rows.push({ side: 'Funds', code: '', name: 'Income and expenditure: accumulated surplus', amount: surplus });
      const assets = rows.filter(r => r.side === 'Assets').reduce((s, r) => s + r.amount, 0);
      const other = rows.filter(r => r.side !== 'Assets').reduce((s, r) => s + r.amount, 0);
      return { title: 'Balance sheet', subtitle: `As on ${day(to)}`, columns: [{ key: 'side', label: '' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' },
        money('amount', 'Amount')], rows: rows.sort((a, b) => ['Assets', 'Liabilities', 'Funds'].indexOf(a.side) - ['Assets', 'Liabilities', 'Funds'].indexOf(b.side)),
        totals: { name: 'Total assets', amount: assets }, note: assets === other ? `Funds and liabilities also total ${rupee(other)}.` : `Funds and liabilities total ${rupee(other)}: a difference of ${rupee(assets - other)} to look into.` };
    }
    case 'cash': {
      const rows = (await balances(tx, to, from)).filter(a => a.cash_kind).map(a => ({ name: a.name, opening: Number(a.opening), received: Number(a.period_debit),
        paid: Number(a.period_credit), closing: Number(a.balance), reconciled: a.reconciled_through ?? 'Not yet' }));
      return { title: 'Cash and bank', subtitle: `${day(from)} to ${day(to)}`, columns: [{ key: 'name', label: 'Account' }, money('opening', 'Opening'), money('received', 'In'),
        money('paid', 'Out'), money('closing', 'Closing'), { key: 'reconciled', label: 'Reconciled up to' }], rows,
        totals: { name: 'Total', opening: rows.reduce((s, r) => s + r.opening, 0), received: rows.reduce((s, r) => s + r.received, 0),
          paid: rows.reduce((s, r) => s + r.paid, 0), closing: rows.reduce((s, r) => s + r.closing, 0) } };
    }
    case 'dues': {
      const d = await duesByUnit(tx, to);
      const units = await many(tx, `select u.id, u.label, ${PLACE()} as place,
          (select string_agg(p.full_name, ', ') from app.ownerships o join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id
            where o.unit_id = u.id and o.ends_on is null) as owners
        from app.units u join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
        where u.id = any ($1) and ($2::uuid is null or n.id = $2 or $2 = any (n.ancestor_ids))`, [[...d.keys()], q.nodeId ?? null]);
      const rows = units.map(u => ({ ...u, ...d.get(u.id)! })).filter(r => r.balance !== 0).sort((a, b) => b.balance - a.balance)
        .map(r => ({ label: r.label, place: r.place, owners: r.owners ?? '', balance: r.balance, current: r.buckets.current, d30: r.buckets.d30, d60: r.buckets.d60,
          d90: r.buckets.d90, over90: r.buckets.over90 }));
      const sum = (k: string) => rows.reduce((s, r: any) => s + r[k], 0);
      return { title: 'Dues by home', subtitle: `As on ${day(to)}. Overdue days are counted from each charge's due date; payments settle the oldest charges first.`,
        columns: [{ key: 'label', label: 'Home' }, { key: 'owners', label: 'Owners' }, money('balance', 'Balance'), money('current', 'Not yet due'),
          money('d30', '1–30 days'), money('d60', '31–60'), money('d90', '61–90'), money('over90', 'Over 90')], rows,
        totals: { label: 'Total', balance: sum('balance'), current: sum('current'), d30: sum('d30'), d60: sum('d60'), d90: sum('d90'), over90: sum('over90') },
        note: 'A negative balance is an advance paid by the home.' };
    }
    case 'collection': {
      const rows = await many(tx, `select to_char(j.txn_date, 'YYYY-MM') as month,
          coalesce(sum(l.debit_paise) filter (where j.kind = 'charge'), 0)::bigint as billed,
          coalesce(sum(l.credit_paise) filter (where j.kind = 'receipt'), 0)::bigint as collected
        from app.journal_lines l join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
        join app.ledger_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id and a.system_key = 'receivables'
        where j.txn_date between $1 and $2 group by 1 order by 1`, [from, to]);
      const out = rows.map(r => ({ month: r.month, billed: Number(r.billed), collected: Number(r.collected),
        rate: Number(r.billed) ? `${Math.round(Number(r.collected) / Number(r.billed) * 100)}%` : '' }));
      const b = out.reduce((s, r) => s + r.billed, 0), c = out.reduce((s, r) => s + r.collected, 0);
      return { title: 'Billing and collection', subtitle: `${day(from)} to ${day(to)}`, columns: [{ key: 'month', label: 'Month' }, money('billed', 'Billed'),
        money('collected', 'Collected'), { key: 'rate', label: 'Collected / billed' }], rows: out,
        totals: { month: 'Total', billed: b, collected: c, rate: b ? `${Math.round(c / b * 100)}%` : '' } };
    }
    case 'budget': {
      const year = q.fy ?? fy.year;
      const start = `${year}-${String(s.fy_start_month).padStart(2, '0')}-01`, end = addDays(`${year + 1}-${String(s.fy_start_month).padStart(2, '0')}-01`, -1);
      const rows = await many(tx, `select a.code, a.name, a.type, coalesce(b.amount_paise, 0)::bigint as budget,
          coalesce((select sum(case when a.type = 'income' then l.credit_paise - l.debit_paise else l.debit_paise - l.credit_paise end)
            from app.journal_lines l join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
            where l.account_id = a.id and j.txn_date between $2 and least($3::date, $4::date)), 0)::bigint as actual
        from app.ledger_accounts a left join app.budgets b on b.tenant_id = a.tenant_id and b.account_id = a.id and b.fy_start = $1
        where a.type in ('income', 'expense') order by a.type desc, a.code`, [year, start, end, today]);
      const out = rows.filter(r => Number(r.budget) || Number(r.actual)).map(r => ({ code: r.code, name: r.name, type: r.type, budget: Number(r.budget),
        actual: Number(r.actual), left: Number(r.budget) - Number(r.actual), used: Number(r.budget) ? `${Math.round(Number(r.actual) / Number(r.budget) * 100)}%` : '' }));
      return { title: 'Budget and actual', subtitle: `Financial year ${year}–${String(year + 1).slice(2)}, actual up to ${today < end ? today : end}`,
        columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, money('budget', 'Budget'), money('actual', 'Actual'), money('left', 'Remaining'),
          { key: 'used', label: 'Used' }], rows: out };
    }
    case 'daybook': {
      const rows = await many(tx, `select j.txn_date, j.ref, j.kind, j.narration, j.reference, a.code, a.name as account, l.debit_paise::bigint as debit,
          l.credit_paise::bigint as credit, u.label as unit, v.name as vendor
        from app.journals j join app.journal_lines l on l.tenant_id = j.tenant_id and l.journal_id = j.id
        join app.ledger_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
        left join app.units u on u.tenant_id = l.tenant_id and u.id = l.unit_id left join app.vendors v on v.tenant_id = l.tenant_id and v.id = l.vendor_id
        where j.txn_date between $1 and $2 order by j.txn_date, j.created_at, l.id limit 20000`, [from, to]);
      return { title: 'Day book', subtitle: `${day(from)} to ${day(to)}`, columns: [{ key: 'txn_date', label: 'Date' }, { key: 'ref', label: 'Entry' },
        { key: 'narration', label: 'Narration' }, { key: 'account', label: 'Account' }, { key: 'party', label: 'Home or vendor' }, money('debit', 'Debit'), money('credit', 'Credit')],
        rows: rows.map(r => ({ ...r, party: r.unit ?? r.vendor ?? '', debit: Number(r.debit), credit: Number(r.credit) })) };
    }
    default: return fail(404, 'Choose a report.', 'not_found');
  }
}

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(r: Report) {
  const head = r.columns.map(c => c.money ? `${c.label} (INR)` : c.label);
  const fmt = (row: Record<string, unknown>) => r.columns.map(c => csvCell(c.money && typeof row[c.key] === 'number' ? inr(row[c.key] as number) : row[c.key]));
  return '﻿' + [[r.title, r.subtitle].map(csvCell).join(','), head.map(csvCell).join(','), ...r.rows.map(x => fmt(x).join(',')),
    ...(r.totals ? [fmt(r.totals).join(',')] : [])].join('\r\n') + '\r\n';
}

// Tally: masters (ledgers, with each home as a debtor) and vouchers. Import the masters first.
const xml = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TALLY_GROUP = (a: any) => a.cash_kind === 'bank' ? 'Bank Accounts' : a.cash_kind === 'cash' ? 'Cash-in-Hand'
  : a.system_key === 'tds_payable' ? 'Duties & Taxes' : a.type === 'asset' ? 'Current Assets' : a.type === 'liability' ? 'Current Liabilities'
  : a.type === 'funds' ? 'Reserves & Surplus' : a.type === 'income' ? 'Indirect Incomes' : 'Indirect Expenses';
const unitLedger = (label: string) => `Flat ${label}`;
function envelope(report: string, body: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE>\n <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>\n <BODY><IMPORTDATA>\n`
    + `  <REQUESTDESC><REPORTNAME>${report}</REPORTNAME></REQUESTDESC>\n  <REQUESTDATA>\n${body}  </REQUESTDATA>\n </IMPORTDATA></BODY>\n</ENVELOPE>\n`;
}

export async function financeReportRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  const params = z.object({ from: date.optional(), to: date.optional(), asOf: date.optional(), fy: z.coerce.number().int().optional(), nodeId: uuid.optional(),
    format: z.enum(['json', 'csv']).default('json') });

  app.get('/api/finance/reports/:kind', async (req, reply) => {
    const { kind } = z.object({ kind: z.string().max(20) }).parse(req.params);
    const q = params.parse(req.query);
    const r = await run.auth(req, async ({ tx, actor }) => {
      if (!canViewBooks(actor)) forbidden();
      return report(tx, kind, q);
    });
    if (q.format === 'csv') return reply.header('content-type', 'text/csv; charset=utf-8').header('cache-control', 'private, no-store')
      .header('content-disposition', `attachment; filename="${kind}-${q.to ?? q.asOf ?? 'today'}.csv"`).send(toCsv(r));
    return r;
  });

  app.get('/api/finance/export/tally', async (req, reply) => {
    const q = z.object({ part: z.enum(['masters', 'vouchers']), from: date.optional(), to: date.optional() }).parse(req.query);
    const body = await run.auth(req, async ({ tx, actor, audit }) => {
      if (!canViewBooks(actor)) forbidden();
      const today = await financeToday(tx);
      const fy = fyOf(today, (await settings(tx)).fy_start_month);
      const accounts = await many(tx, `select * from app.ledger_accounts order by code`);
      const name = new Map(accounts.map(a => [a.id, a.name]));
      if (q.part === 'masters') {
        const units = await many(tx, `select distinct u.label from app.units u join app.journal_lines l on l.tenant_id = u.tenant_id and l.unit_id = u.id order by u.label`);
        const ledgers = [...accounts.filter(a => a.system_key !== 'receivables').map(a => [a.name, TALLY_GROUP(a)]),
          ...units.map(u => [unitLedger(u.label), 'Sundry Debtors'])];
        await audit('finance.exported', 'tenant', null, 'Downloaded Tally masters');
        return envelope('All Masters', ledgers.map(([n, g]) => `   <TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xml(n)}" ACTION="Create">`
          + `<NAME.LIST><NAME>${xml(n)}</NAME></NAME.LIST><PARENT>${xml(g)}</PARENT><ISBILLWISEON>No</ISBILLWISEON></LEDGER></TALLYMESSAGE>\n`).join(''));
      }
      const from = q.from ?? fy.start, to = q.to ?? today;
      const journals = await many(tx, `select j.*, (select json_agg(json_build_object('account_id', l.account_id, 'debit', l.debit_paise, 'credit', l.credit_paise,
          'unit', u.label) order by l.id) from app.journal_lines l left join app.units u on u.tenant_id = l.tenant_id and u.id = l.unit_id where l.journal_id = j.id) as lines
        from app.journals j where j.txn_date between $1 and $2 order by j.txn_date, j.created_at`, [from, to]);
      const recvId = accounts.find(a => a.system_key === 'receivables')?.id;
      const type = (k: string) => ({ receipt: 'Receipt', payment: 'Payment', transfer: 'Contra' } as Record<string, string>)[k] ?? 'Journal';
      await audit('finance.exported', 'tenant', null, `Downloaded Tally vouchers ${from} to ${to}`);
      return envelope('Vouchers', journals.map(j => `   <TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${type(j.kind)}" ACTION="Create">`
        + `<DATE>${String(j.txn_date).replace(/-/g, '')}</DATE><VOUCHERTYPENAME>${type(j.kind)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(j.ref)}</VOUCHERNUMBER>`
        + `<NARRATION>${xml(j.narration + (j.reference ? ` Ref ${j.reference}` : ''))}</NARRATION>`
        + j.lines.map((l: any) => {
          const ledger = l.account_id === recvId && l.unit ? unitLedger(l.unit) : name.get(l.account_id);
          const dr = Number(l.debit) > 0;
          return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${dr ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`
            + `<AMOUNT>${dr ? '-' : ''}${inr(Number(dr ? l.debit : l.credit))}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
        }).join('') + `</VOUCHER></TALLYMESSAGE>\n`).join(''));
    });
    return reply.header('content-type', 'application/xml; charset=utf-8').header('cache-control', 'private, no-store')
      .header('content-disposition', `attachment; filename="tally-${q.part}.xml"`).send(body);
  });

  // ================================================================ bank reconciliation
  async function bookLines(tx: Tx, accountId: string, from: string, to: string) {
    return many(tx, `select l.id, j.txn_date, j.ref, j.narration, j.reference, (l.debit_paise - l.credit_paise)::bigint as amount,
        exists (select 1 from app.bank_statement_lines s where s.matched_line_id = l.id) as matched
      from app.journal_lines l join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
      where l.account_id = $1 and j.txn_date between $2 and $3 order by j.txn_date, l.id`, [accountId, from, to]);
  }
  async function bookBalance(tx: Tx, accountId: string, through: string) {
    return Number((await one(tx, `select coalesce(sum(l.debit_paise - l.credit_paise), 0)::bigint as b from app.journal_lines l
      join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id where l.account_id = $1 and j.txn_date <= $2`, [accountId, through]))!.b);
  }

  app.get('/api/finance/accounts/:id/reconcile', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor)) forbidden();
    const a = await cashAccount(tx, idParam.parse(req.params).id);
    const st = await one(tx, `select * from app.bank_statements where account_id = $1 and status = 'open' order by created_at desc limit 1`, [a.id]);
    const history = await many(tx, `select id, period_start, period_end, opening_paise, closing_paise, reconciled_at from app.bank_statements
      where account_id = $1 and status = 'reconciled' order by period_end desc limit 24`, [a.id]);
    if (!st) return { account: a, statement: null, history, nextStart: a.reconciled_through ? addDays(a.reconciled_through, 1) : null };
    const lines = await many(tx, `select s.*, j.ref as matched_ref, j.txn_date as matched_date from app.bank_statement_lines s
      left join app.journal_lines l on l.tenant_id = s.tenant_id and l.id = s.matched_line_id
      left join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id where s.statement_id = $1 order by s.txn_date, s.id`, [st.id]);
    const book = await bookLines(tx, a.id, st.period_start, st.period_end);
    const opening = await bookBalance(tx, a.id, addDays(st.period_start, -1)), closing = await bookBalance(tx, a.id, st.period_end);
    const checks = {
      opening: { statement: Number(st.opening_paise), book: opening, ok: Number(st.opening_paise) === opening },
      closing: { statement: Number(st.closing_paise), book: closing, ok: Number(st.closing_paise) === closing },
      statementUnmatched: lines.filter(l => !l.matched_line_id).length, bookUnmatched: book.filter(b => !b.matched).length,
    };
    return { account: a, history, statement: { ...st, lines, book: book.map(b => ({ ...b, amount: Number(b.amount) })), checks,
      canReconcile: canKeepBooks(actor) && checks.opening.ok && checks.closing.ok && !checks.statementUnmatched && !checks.bookUnmatched } };
  }));

  // Import a statement: a CSV with Date, Description, Reference and either Amount or Debit and Credit columns.
  app.post('/api/finance/accounts/:id/statements', { bodyLimit: 2 * 1024 * 1024 }, async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const a = await cashAccount(tx, idParam.parse(req.params).id);
    if (a.cash_kind !== 'bank') fail(400, 'Statements are for bank accounts. Count cash and post any difference instead.', 'invalid');
    const b = z.object({ csv: z.string().min(10).max(1_500_000), periodStart: date, periodEnd: date, opening: z.union([z.number(), z.string()]),
      closing: z.union([z.number(), z.string()]) }).parse(req.body);
    if (await one(tx, `select 1 from app.bank_statements where account_id = $1 and status = 'open'`, [a.id])) fail(409, 'Finish or discard the open statement first.', 'invalid');
    if (a.reconciled_through && b.periodStart !== addDays(a.reconciled_through, 1))
      fail(400, `This account is reconciled up to ${a.reconciled_through}; the next statement starts on ${addDays(a.reconciled_through, 1)}.`, 'invalid');
    if (b.periodEnd < b.periodStart || b.periodEnd > await financeToday(tx)) fail(400, 'Check the statement period.', 'invalid');
    const amount = (v: string | number) => { const n = Math.round(Number(String(v).replace(/[,₹\s]/g, '').replace(/^\((.*)\)$/, '-$1')) * 100);
      if (!Number.isFinite(n)) fail(400, `"${v}" is not an amount.`, 'invalid'); return n; };
    const rows = parseStatement(b.csv, amount);
    const outside = rows.find(r => r.date < b.periodStart || r.date > b.periodEnd);
    if (outside) fail(400, `A transaction on ${outside.date} is outside the statement period.`, 'invalid');
    const opening = amount(b.opening), closing = amount(b.closing);
    const net = rows.reduce((s, r) => s + r.amount, 0);
    if (opening + net !== closing) fail(400, `The transactions do not add up: ${rupee(opening)} plus ${rupee(net)} is not the closing ${rupee(closing)}.`, 'invalid');
    const st = await one(tx, `insert into app.bank_statements (account_id, period_start, period_end, opening_paise, closing_paise, created_by)
      values ($1, $2, $3, $4, $5, $6) returning id`, [a.id, b.periodStart, b.periodEnd, opening, closing, actor.personId]);
    await tx.query(`insert into app.bank_statement_lines (statement_id, txn_date, description, reference, amount_paise)
      select $1, x.d, x.n, x.r, x.a from unnest($2::date[], $3::text[], $4::text[], $5::bigint[]) as x(d, n, r, a)`,
      [st!.id, rows.map(r => r.date), rows.map(r => r.description), rows.map(r => r.reference), rows.map(r => r.amount)]);
    const matched = await autoMatch(tx, st!.id, a.id);
    await audit('finance.statement', 'ledger_account', a.id, `Bank statement ${b.periodStart} to ${b.periodEnd} imported for ${a.name}: ${rows.length} lines, ${matched} matched`);
    return { id: st!.id, lines: rows.length, matched };
  }));

  app.post('/api/finance/statement-lines/:id/match', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canKeepBooks(actor)) forbidden();
    const id = z.coerce.number().int().parse((req.params as any).id);
    const b = z.object({ journalLineId: z.coerce.number().int().nullable() }).parse(req.body);
    const s = await one(tx, `select s.*, st.account_id, st.status, st.period_start, st.period_end from app.bank_statement_lines s
      join app.bank_statements st on st.tenant_id = s.tenant_id and st.id = s.statement_id where s.id = $1`, [id]) ?? notFound('That statement line');
    if (s.status !== 'open') fail(409, 'This statement is already reconciled.', 'closed');
    if (b.journalLineId !== null) {
      const l = await one(tx, `select l.id, (l.debit_paise - l.credit_paise)::bigint as amount, j.txn_date from app.journal_lines l
        join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id where l.id = $1 and l.account_id = $2`, [b.journalLineId, s.account_id])
        ?? fail(400, 'That entry is not on this account.', 'invalid');
      if (Number(l!.amount) !== Number(s.amount_paise)) fail(400, 'The amounts differ. Post a correction in the books first.', 'invalid');
      if (l!.txn_date < s.period_start || l!.txn_date > s.period_end) fail(400, 'That entry is outside the statement period.', 'invalid');
    }
    await tx.query(`update app.bank_statement_lines set matched_line_id = $2 where id = $1`, [id, b.journalLineId]);
    return { ok: true };
  }));

  app.post('/api/finance/statements/:id/reconcile', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const st = await one(tx, `select * from app.bank_statements where id = $1 for update`, [idParam.parse(req.params).id]) ?? notFound('That statement');
    if (st.status !== 'open') fail(409, 'Already reconciled.', 'closed');
    const lines = await many(tx, `select matched_line_id from app.bank_statement_lines where statement_id = $1`, [st.id]);
    const book = await bookLines(tx, st.account_id, st.period_start, st.period_end);
    const opening = await bookBalance(tx, st.account_id, addDays(st.period_start, -1)), closing = await bookBalance(tx, st.account_id, st.period_end);
    if (Number(st.opening_paise) !== opening) fail(400, `The books show ${rupee(opening)} at the start, the bank ${rupee(Number(st.opening_paise))}.`, 'invalid');
    if (Number(st.closing_paise) !== closing) fail(400, `The books show ${rupee(closing)} at the end, the bank ${rupee(Number(st.closing_paise))}.`, 'invalid');
    if (lines.some(l => !l.matched_line_id) || book.some(b => !b.matched)) fail(400, 'Match every bank line and every book entry first.', 'invalid');
    await tx.query(`update app.bank_statements set status = 'reconciled', reconciled_at = now() where id = $1`, [st.id]);
    await tx.query(`update app.ledger_accounts set reconciled_through = $2 where id = $1`, [st.account_id, st.period_end]);
    await audit('finance.reconciled', 'ledger_account', st.account_id, `Bank reconciled up to ${st.period_end}`);
    return { ok: true };
  }));

  app.post('/api/finance/statements/:id/discard', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const st = await one(tx, `select * from app.bank_statements where id = $1`, [idParam.parse(req.params).id]) ?? notFound('That statement');
    if (st.status !== 'open') fail(409, 'A reconciled statement is kept.', 'closed');
    await tx.query(`delete from app.bank_statements where id = $1`, [st.id]);
    await audit('finance.statement_discarded', 'ledger_account', st.account_id, `Statement ${st.period_start} to ${st.period_end} discarded`);
    return { ok: true };
  }));
}

// Matches each bank line to one book entry of the same amount: first where the bank's reference
// appears in the entry's reference or narration within a week, then where only one entry of that
// amount falls within three days. Anything else is left for the treasurer to match by hand.
async function autoMatch(tx: Tx, statementId: string, accountId: string) {
  const st = (await one(tx, `select * from app.bank_statements where id = $1`, [statementId]))!;
  const lines = await many(tx, `select * from app.bank_statement_lines where statement_id = $1 and matched_line_id is null order by txn_date, id`, [statementId]);
  const book = (await many(tx, `select l.id, j.txn_date, lower(coalesce(j.reference, '') || ' ' || j.narration) as text, (l.debit_paise - l.credit_paise)::bigint as amount
    from app.journal_lines l join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
    where l.account_id = $1 and j.txn_date between $2 and $3
      and not exists (select 1 from app.bank_statement_lines s where s.matched_line_id = l.id)`, [accountId, st.period_start, st.period_end]))
    .map(b => ({ ...b, amount: Number(b.amount), used: false }));
  const near = (a: string, b: string, days: number) => Math.abs(Date.parse(a) - Date.parse(b)) <= days * 86_400_000;
  let matched = 0;
  for (const pass of [1, 2]) {
    for (const s of lines.filter(l => !l.matched_line_id)) {
      const ref = String(s.reference || '').toLowerCase().trim();
      const cands = book.filter(b => !b.used && b.amount === Number(s.amount_paise) && (pass === 1
        ? ref.length >= 4 && b.text.includes(ref) && near(b.txn_date, s.txn_date, 7)
        : near(b.txn_date, s.txn_date, 3)));
      if (cands.length !== 1) continue;
      cands[0].used = true; s.matched_line_id = cands[0].id; matched++;
      await tx.query(`update app.bank_statement_lines set matched_line_id = $2 where id = $1`, [s.id, cands[0].id]);
    }
  }
  return matched;
}

// A small CSV reader for bank statements: quoted fields, a header row naming the columns, and the
// date formats Indian banks use.
export function parseStatement(source: string, amount: (v: string) => number) {
  const table: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (c === '"' && source[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; continue; }
    if (c === '"' && !cell) quoted = true;
    else if (c === ',') { row.push(cell.trim()); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && source[i + 1] === '\n') i++; row.push(cell.trim()); cell = ''; if (row.some(Boolean)) table.push(row); row = []; }
    else cell += c;
  }
  row.push(cell.trim()); if (row.some(Boolean)) table.push(row);
  const head = (table.shift() ?? []).map(h => h.replace(/^﻿/, '').toLowerCase());
  const col = (...names: string[]) => head.findIndex(h => names.some(n => h.includes(n)));
  const di = col('date'), ni = col('description', 'narration', 'particulars', 'details'), ri = col('reference', 'ref', 'cheque', 'chq', 'utr');
  const ai = col('amount'), dr = col('debit', 'withdrawal'), cr = col('credit', 'deposit');
  if (di < 0 || (ai < 0 && (dr < 0 || cr < 0))) fail(400, 'The first row must name the columns: Date, Description, Reference, and Amount (or Debit and Credit).', 'invalid');
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const day = (v: string, n: number) => {
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) return v;
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(v);
    if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = /^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{2,4})$/.exec(v);
    if (m && MONTHS.includes(m[2].toLowerCase())) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return fail(400, `Row ${n}: "${v}" is not a date.`, 'invalid');
  };
  return table.map((r, i) => {
    const amt = ai >= 0 ? amount(r[ai] || '0') : amount(r[cr] || '0') - amount(r[dr] || '0');
    return { date: day(r[di] ?? '', i + 2), description: (ni >= 0 ? r[ni] : '').slice(0, 300), reference: (ri >= 0 ? r[ri] : '').slice(0, 100), amount: amt };
  }).filter(r => r.amount !== 0);
}
