// Finance: the chart, receipts and payments, owners' dues and payment intimations, billing, and vouchers.
//
// Finance permissions apply community-wide. Owners and residents see only their own homes' dues.
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../actor.ts';
import type { Runner, Services } from '../app.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import * as engine from '../services/approvals.ts';
import { account, balances, cashAccount, duesByUnit, financeToday, fyOf, post, reverse, rupee, settings, systemAccount } from '../services/ledger.ts';
import { myHomes, nodeRef, PLACE } from '../services/operations.ts';
import { date, idParam, optText, rupeesToPaise, text, uuid, z } from './z.ts';

export const canViewBooks = (a: Actor) => a.can('finance.view') || a.can('finance.manage');
export const canKeepBooks = (a: Actor) => a.can('finance.manage');
const canPrepare = (a: Actor) => a.canAnywhere('finance.prepare') || a.can('finance.manage');
const MODES = ['upi', 'neft', 'imps', 'rtgs', 'cheque', 'cash', 'card', 'other'] as const;
const money = rupeesToPaise.transform((v, ctx) => {
  if (v === null || v === '0') { ctx.addIssue({ code: 'custom', message: 'enter an amount' }); return z.NEVER; }
  return Number(v);
});

async function homeOf(tx: Tx, actor: Actor, unitId: string) {
  const u = await one(tx, `select u.id, u.label, u.node_id from app.units u where u.id = $1 and u.archived_at is null`, [unitId]) ?? notFound('That home');
  if (canViewBooks(actor)) return u;
  if (!(await myHomes(tx, actor.personId)).some(h => h.id === unitId)) notFound('That home');
  return u;
}

// One home's statement: every charge and payment, with a running balance.
async function statement(tx: Tx, unitId: string) {
  return many(tx, `select j.id, j.ref, j.kind, j.txn_date, j.due_on, j.narration, j.reference, j.mode, l.memo,
      l.debit_paise::bigint as charged, l.credit_paise::bigint as paid,
      sum(l.debit_paise - l.credit_paise) over (order by j.txn_date, l.id)::bigint as balance
    from app.journal_lines l join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
    join app.ledger_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id and a.system_key = 'receivables'
    where l.unit_id = $1 order by j.txn_date, l.id`, [unitId]);
}

export async function financeRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  // ================================================================ settings and the chart
  app.get('/api/finance/settings', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor)) forbidden();
    return settings(tx);
  }));
  app.patch('/api/finance/settings', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const b = z.object({ fyStartMonth: z.coerce.number().int().min(1).max(12).optional(), paymentInstructions: z.string().trim().max(1000).optional(),
      upiId: z.string().trim().regex(/^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$/, 'is not a valid UPI ID').nullable().optional()
        .or(z.literal('').transform(() => null)) }).parse(req.body);
    await settings(tx);
    await tx.query(`update app.finance_settings set fy_start_month = coalesce($1, fy_start_month), payment_instructions = coalesce($2, payment_instructions),
      upi_id = case when $3 then $4 else upi_id end, updated_at = now()`,
      [b.fyStartMonth ?? null, b.paymentInstructions ?? null, b.upiId !== undefined, b.upiId ?? null]);
    await audit('finance.settings', 'tenant', null, 'Changed finance settings', { changed: Object.keys(b) });
    return { ok: true };
  }));

  // Closing a period locks every entry on or before that day.
  app.post('/api/finance/close', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const b = z.object({ through: date }).parse(req.body);
    const s = await settings(tx);
    if (b.through > await financeToday(tx)) fail(400, 'A period can be closed only up to today.', 'invalid');
    if (s.books_closed_through && b.through <= s.books_closed_through) fail(400, `The books are already closed up to ${s.books_closed_through}.`, 'invalid');
    const pending = await one(tx, `select count(*)::int as n from app.billing_runs where status = 'draft' and issue_on <= $1`, [b.through]);
    if (pending!.n) fail(409, `Post or cancel the ${pending!.n} draft billing run(s) dated in this period first.`, 'invalid');
    await tx.query(`update app.finance_settings set books_closed_through = $1, updated_at = now()`, [b.through]);
    await audit('finance.closed', 'tenant', null, `Books closed up to ${b.through}`);
    return { ok: true };
  }));

  app.get('/api/finance/accounts', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor) && !canPrepare(actor)) forbidden();
    const rows = await balances(tx, await financeToday(tx));
    return rows.map(r => ({ ...r, balance: Number(r.balance) }));
  }));

  app.post('/api/finance/accounts', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const b = z.object({ name: text(80), type: z.enum(['asset', 'liability', 'funds', 'income', 'expense']).optional(), code: z.string().trim().toUpperCase().optional(),
      cashKind: z.enum(['bank', 'cash']).optional(), bankName: optText(80), last4: z.string().regex(/^\d{4}$/, 'must be the last 4 digits').nullable().optional(),
      opening: rupeesToPaise, openingNegative: z.boolean().default(false), openedOn: date.optional() }).parse(req.body);
    const type = b.cashKind ? 'asset' : b.type ?? fail(400, 'Choose the kind of account.', 'invalid');
    let code = b.code;
    if (!code) {
      const base = b.cashKind ? 1000 : { asset: 1400, liability: 2500, funds: 3300, income: 4100, expense: 5300 }[type!]!;
      const taken = new Set((await many(tx, `select code from app.ledger_accounts`)).map(r => r.code));
      let n = base; while (taken.has(String(n))) n += 1;
      code = String(n);
    }
    const a = await one(tx, `insert into app.ledger_accounts (code, name, type, cash_kind, bank_name, account_last4) values ($1, $2, $3, $4, $5, $6) returning id`,
      [code, b.name, type, b.cashKind ?? null, b.bankName, b.last4 ?? null]);
    const opening = Number(b.opening ?? 0);
    if (opening > 0) {
      const fund = await systemAccount(tx, 'general_fund');
      const amount = opening, neg = b.openingNegative;
      await post(tx, actor, { kind: 'opening', date: b.openedOn ?? await financeToday(tx), narration: `Opening balance of ${b.name}`, source: 'opening',
        lines: [{ accountId: neg ? fund.id : a!.id, debit: amount }, { accountId: neg ? a!.id : fund.id, credit: amount }] });
    }
    await audit('finance.account_added', 'ledger_account', a!.id, `Added ${b.cashKind ? `${b.cashKind} account` : 'ledger account'} ${code} ${b.name}`);
    return { id: a!.id, code };
  }));

  app.patch('/api/finance/accounts/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const a = await account(tx, idParam.parse(req.params).id);
    const b = z.object({ name: text(80).optional(), archived: z.boolean().optional() }).parse(req.body);
    if (b.archived && a.system_key) fail(400, 'This account is needed by the platform and cannot be retired.', 'invalid');
    if (b.archived) {
      const bal = (await balances(tx, await financeToday(tx))).find(r => r.id === a.id);
      if (bal && Number(bal.balance) !== 0) fail(400, `${a.name} still has a balance of ${rupee(Math.abs(Number(bal.balance)))}. Move it first.`, 'invalid');
    }
    await tx.query(`update app.ledger_accounts set name = coalesce($2, name), archived_at = case when $3::boolean is null then archived_at
      when $3 then now() else null end where id = $1`, [a.id, b.name ?? null, b.archived ?? null]);
    await audit('finance.account_changed', 'ledger_account', a.id, `${a.code} ${b.name ?? a.name}${b.archived ? ' retired' : ''}`);
    return { ok: true };
  }));

  // ================================================================ overview
  app.get('/api/finance/overview', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor) && !canPrepare(actor)) forbidden();
    const day = await financeToday(tx);
    const s = await settings(tx);
    const fy = fyOf(day, s.fy_start_month);
    const monthStart = day.slice(0, 8) + '01';
    const out: Record<string, unknown> = { today: day, fy, closedThrough: s.books_closed_through };
    out.vouchers = await one(tx, `select count(*) filter (where v.status = 'submitted' and r.status = 'pending')::int as awaiting_approval,
        count(*) filter (where v.status = 'submitted' and r.status = 'approved')::int as to_pay,
        coalesce(sum(v.amount_paise - v.tds_paise) filter (where v.status = 'submitted' and r.status = 'approved'), 0)::bigint as to_pay_paise
      from app.vouchers v left join app.approval_requests r on r.tenant_id = v.tenant_id and r.id = v.approval_request_id`);
    if (!canViewBooks(actor)) return out;
    const bal = await balances(tx, day, fy.start);
    out.cash = bal.filter(a => a.cash_kind && !a.archived_at).map(a => ({ id: a.id, name: a.name, kind: a.cash_kind, bank: a.bank_name, last4: a.account_last4,
      balance: Number(a.balance), reconciledThrough: a.reconciled_through }));
    out.funds = bal.filter(a => a.type === 'funds').map(a => ({ name: a.name, balance: -Number(a.balance) }));
    const income = bal.filter(a => a.type === 'income').reduce((s, a) => s + Number(a.period_credit) - Number(a.period_debit), 0);
    const expense = bal.filter(a => a.type === 'expense').reduce((s, a) => s + Number(a.period_debit) - Number(a.period_credit), 0);
    out.year = { income, expense, surplus: income - expense };
    const dues = [...(await duesByUnit(tx, day)).values()];
    out.dues = { outstanding: dues.reduce((s, d) => s + Math.max(0, d.balance), 0), advance: dues.reduce((s, d) => s + Math.max(0, -d.balance), 0),
      homes: dues.filter(d => d.balance > 0).length, over90: dues.reduce((s, d) => s + d.buckets.over90, 0),
      overdue: dues.reduce((s, d) => s + d.buckets.d30 + d.buckets.d60 + d.buckets.d90 + d.buckets.over90, 0) };
    out.month = await one(tx, `select
        coalesce(sum(l.debit_paise) filter (where j.kind = 'charge'), 0)::bigint as billed,
        coalesce(sum(l.credit_paise) filter (where j.kind in ('receipt')), 0)::bigint as collected
      from app.journal_lines l join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
      join app.ledger_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id and a.system_key = 'receivables'
      where j.txn_date between $1 and $2`, [monthStart, day]);
    out.claims = (await one(tx, `select count(*)::int as n from app.payment_claims where status = 'pending'`))!.n;
    return out;
  }));

  // ================================================================ the day book and entries
  app.get('/api/finance/journals', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor)) forbidden();
    const q = z.object({ from: date.optional(), to: date.optional(), kind: z.string().max(20).optional(), accountId: uuid.optional(), unitId: uuid.optional(),
      q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const rows = await many(tx, `select j.id, j.ref, j.kind, j.txn_date, j.narration, j.reference, j.mode, j.source, j.reverses_id, u.label as unit, v.name as vendor,
        p.full_name as by, exists (select 1 from app.journals r where r.reverses_id = j.id) as reversed,
        (select sum(debit_paise) from app.journal_lines l where l.journal_id = j.id)::bigint as amount,
        (select json_agg(json_build_object('account', a.name, 'code', a.code, 'debit', l.debit_paise, 'credit', l.credit_paise, 'unit', lu.label, 'memo', l.memo) order by l.id)
           from app.journal_lines l join app.ledger_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
           left join app.units lu on lu.tenant_id = l.tenant_id and lu.id = l.unit_id where l.journal_id = j.id) as lines
      from app.journals j left join app.units u on u.tenant_id = j.tenant_id and u.id = j.unit_id
      left join app.vendors v on v.tenant_id = j.tenant_id and v.id = j.vendor_id
      left join app.people p on p.tenant_id = j.tenant_id and p.id = j.created_by
      where ($1::date is null or j.txn_date >= $1) and ($2::date is null or j.txn_date <= $2) and ($3::text is null or j.kind = $3)
        and ($4::uuid is null or exists (select 1 from app.journal_lines l where l.journal_id = j.id and l.account_id = $4))
        and ($5::uuid is null or exists (select 1 from app.journal_lines l where l.journal_id = j.id and l.unit_id = $5))
        and ($6::text is null or j.ref ilike $6 || '%' or j.narration ilike '%' || $6 || '%' or j.reference ilike '%' || $6 || '%')
      order by j.txn_date desc, j.created_at desc limit $7`,
      [q.from ?? null, q.to ?? null, q.kind ?? null, q.accountId ?? null, q.unitId ?? null, q.q || null, q.limit]);
    // A billing run's many lines are summarised rather than listed.
    return rows.map(r => ({ ...r, amount: Number(r.amount), lines: r.lines.length > 8 ? [...r.lines.slice(0, 3), { more: r.lines.length - 3 }] : r.lines }));
  }));

  const receiptBody = z.object({ date, accountId: uuid, amount: money, mode: z.enum(MODES), reference: optText(100),
    narration: z.string().trim().max(500).optional(), unitId: uuid.nullable().optional(), creditAccountId: uuid.nullable().optional(), fileId: uuid.nullable().optional() })
    .refine(v => !!v.unitId !== !!v.creditAccountId, 'choose a home, or another account the money is for');

  // Money received: from a home against its dues, or for anything else (interest, bookings, corpus).
  app.post('/api/finance/receipts', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const b = receiptBody.parse(req.body);
    const cash = await cashAccount(tx, b.accountId);
    if (b.mode !== 'cash' && !b.reference) fail(400, 'Enter the UTR, cheque or transaction number.', 'invalid');
    if (b.reference && await one(tx, `select ref from app.journals j where j.kind = 'receipt' and lower(j.reference) = lower($1)
        and not exists (select 1 from app.journals r where r.reverses_id = j.id)`, [b.reference]))
      fail(409, `A receipt with reference ${b.reference} is already recorded.`, 'duplicate');
    let credit: any, unit: any = null;
    if (b.unitId) {
      unit = await one(tx, `select id, label, node_id from app.units where id = $1`, [b.unitId]) ?? notFound('That home');
      credit = await systemAccount(tx, 'receivables');
    } else {
      credit = await account(tx, b.creditAccountId!);
      if (credit.cash_kind) fail(400, 'To move money between bank and cash accounts, record a transfer.', 'invalid');
    }
    const j = await post(tx, actor, { kind: 'receipt', date: b.date, narration: b.narration || (unit ? `Payment received from ${unit.label}` : `Received: ${credit.name}`),
      reference: b.reference, mode: b.mode, unitId: unit?.id ?? null, fileId: b.fileId ?? null,
      lines: [{ accountId: cash.id, debit: b.amount }, { accountId: credit.id, credit: b.amount, unitId: unit?.id ?? null, nodeId: unit?.node_id ?? null }] });
    await audit('finance.receipt', 'journal', j.id, `${j.ref}: ${rupee(b.amount)} received${unit ? ` from ${unit.label}` : ''} into ${cash.name}`);
    return j;
  }));

  // Payments made without a voucher: bank charges, refunds of deposits and the like.
  app.post('/api/finance/payments', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const b = z.object({ date, accountId: uuid, amount: money, mode: z.enum(MODES), reference: optText(100), narration: text(500),
      debitAccountId: uuid, nodeId: uuid.nullable().optional(), vendorId: uuid.nullable().optional() }).parse(req.body);
    const cash = await cashAccount(tx, b.accountId);
    const debit = await account(tx, b.debitAccountId);
    if (debit.cash_kind) fail(400, 'To move money between bank and cash accounts, record a transfer.', 'invalid');
    const j = await post(tx, actor, { kind: 'payment', date: b.date, narration: b.narration, reference: b.reference, mode: b.mode, vendorId: b.vendorId ?? null,
      lines: [{ accountId: debit.id, debit: b.amount, nodeId: b.nodeId ?? null, vendorId: b.vendorId ?? null }, { accountId: cash.id, credit: b.amount }] });
    await audit('finance.payment', 'journal', j.id, `${j.ref}: ${rupee(b.amount)} paid from ${cash.name} (${debit.name})`);
    return j;
  }));

  app.post('/api/finance/transfers', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const b = z.object({ date, fromId: uuid, toId: uuid, amount: money, reference: optText(100), narration: z.string().trim().max(500).optional() }).parse(req.body);
    if (b.fromId === b.toId) fail(400, 'Choose two different accounts.', 'invalid');
    const from = await cashAccount(tx, b.fromId), to = await cashAccount(tx, b.toId);
    const j = await post(tx, actor, { kind: 'transfer', date: b.date, narration: b.narration || `Transfer from ${from.name} to ${to.name}`, reference: b.reference,
      lines: [{ accountId: to.id, debit: b.amount }, { accountId: from.id, credit: b.amount }] });
    await audit('finance.transfer', 'journal', j.id, `${j.ref}: ${rupee(b.amount)} from ${from.name} to ${to.name}`);
    return j;
  }));

  // A journal entry: for corrections, provisions and anything the other forms do not cover.
  app.post('/api/finance/journals', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const line = z.object({ accountId: uuid, debit: rupeesToPaise, credit: rupeesToPaise, unitId: uuid.nullable().optional(), vendorId: uuid.nullable().optional(),
      nodeId: uuid.nullable().optional(), memo: z.string().trim().max(300).optional() });
    const b = z.object({ date, narration: text(500), reference: optText(100), lines: z.array(line).min(2).max(40) }).parse(req.body);
    const j = await post(tx, actor, { kind: 'journal', date: b.date, narration: b.narration, reference: b.reference,
      lines: b.lines.map(l => ({ accountId: l.accountId, debit: Number(l.debit ?? 0), credit: Number(l.credit ?? 0), unitId: l.unitId ?? null,
        vendorId: l.vendorId ?? null, nodeId: l.nodeId ?? null, memo: l.memo })) });
    await audit('finance.journal', 'journal', j.id, `${j.ref}: journal entry, ${b.narration}`);
    return j;
  }));

  // A one-off charge to a home: a late fee, a move-in charge, a corpus contribution.
  app.post('/api/finance/charges', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const b = z.object({ unitId: uuid, date, dueOn: date.optional(), amount: money, accountId: uuid, narration: text(500) }).parse(req.body);
    const unit = await one(tx, `select id, label, node_id from app.units where id = $1`, [b.unitId]) ?? notFound('That home');
    const credit = await account(tx, b.accountId);
    if (!['income', 'funds', 'liability'].includes(credit.type) || credit.system_key === 'receivables') fail(400, 'Charge a home to an income or fund account.', 'invalid');
    const recv = await systemAccount(tx, 'receivables');
    const j = await post(tx, actor, { kind: 'charge', date: b.date, dueOn: b.dueOn ?? b.date, narration: b.narration, unitId: unit.id,
      lines: [{ accountId: recv.id, debit: b.amount, unitId: unit.id, nodeId: unit.node_id }, { accountId: credit.id, credit: b.amount, nodeId: unit.node_id }] });
    await audit('finance.charge', 'journal', j.id, `${j.ref}: ${rupee(b.amount)} charged to ${unit.label} (${credit.name})`);
    return j;
  }));

  app.post('/api/finance/journals/:id/reverse', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const { id } = idParam.parse(req.params);
    const b = z.object({ reason: text(300), date: date.optional() }).parse(req.body);
    const j = await one(tx, `select ref, source from app.journals where id = $1`, [id]) ?? notFound('That entry');
    const r = await reverse(tx, actor, id, b.reason, b.date);
    // A reversed voucher payment becomes payable again; a reversed confirmation reopens the owner's intimation.
    await tx.query(`update app.vouchers set status = 'submitted', journal_id = null where journal_id = $1`, [id]);
    await tx.query(`update app.payment_claims set status = 'pending', journal_id = null, decided_by = null, decided_at = null where journal_id = $1`, [id]);
    await tx.query(`update app.billing_runs set status = 'cancelled' where journal_id = $1`, [id]);
    await audit('finance.reversed', 'journal', r.id, `${r.ref} reverses ${j.ref}: ${b.reason}`);
    return r;
  }));

  // ================================================================ dues
  app.get('/api/finance/dues', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor)) forbidden();
    const q = z.object({ nodeId: uuid.optional(), q: z.string().trim().max(60).optional(), owing: z.coerce.boolean().default(false) }).parse(req.query);
    const day = await financeToday(tx);
    const dues = await duesByUnit(tx, day);
    const units = await many(tx, `select u.id, u.label, ${PLACE()} as place,
        (select string_agg(p.full_name, ', ' order by o.share_pct desc) from app.ownerships o join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id
          where o.unit_id = u.id and o.ends_on is null) as owners
      from app.units u join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
      where u.archived_at is null and ($1::uuid is null or n.id = $1 or $1 = any (n.ancestor_ids))
        and ($2::text is null or u.label ilike $2 || '%' or exists (select 1 from app.ownerships o join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id
          where o.unit_id = u.id and o.ends_on is null and p.full_name ilike '%' || $2 || '%'))
      order by u.label`, [q.nodeId ?? null, q.q || null]);
    const rows = units.map(u => ({ ...u, ...(dues.get(u.id) ?? { balance: 0, charged: 0, paid: 0, buckets: { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 }, oldest_due: null }) }))
      .filter(r => !q.owing || r.balance > 0);
    return { today: day, rows: rows.sort((a, b) => b.balance - a.balance || a.label.localeCompare(b.label)),
      totals: { outstanding: rows.reduce((s, r) => s + Math.max(0, r.balance), 0), advance: rows.reduce((s, r) => s + Math.max(0, -r.balance), 0) } };
  }));

  app.get('/api/finance/units/:id/statement', async req => run.auth(req, async ({ tx, actor }) => {
    const u = await homeOf(tx, actor, idParam.parse(req.params).id);
    const day = await financeToday(tx);
    const d = (await duesByUnit(tx, day, [u.id])).get(u.id);
    return { unit: u, lines: await statement(tx, u.id), dues: d ?? null, today: day };
  }));

  // What an owner or resident sees: their homes' dues, how to pay, and what they have told the treasurer.
  app.get('/api/my/dues', async req => run.auth(req, async ({ tx, actor }) => {
    const homes = await myHomes(tx, actor.personId);
    const day = await financeToday(tx);
    const dues = await duesByUnit(tx, day, homes.map(h => h.id));
    const s = await settings(tx);
    const out = [];
    for (const h of homes) out.push({ unit: h, dues: dues.get(h.id) ?? null, lines: (await statement(tx, h.id)).slice(-12).reverse() });
    const claims = await many(tx, `select c.*, u.label from app.payment_claims c join app.units u on u.tenant_id = c.tenant_id and u.id = c.unit_id
      where c.unit_id = any ($1) order by c.created_at desc limit 20`, [homes.map(h => h.id)]);
    return { today: day, homes: out, claims, howToPay: { upi: s.upi_id, instructions: s.payment_instructions } };
  }));

  app.post('/api/my/claims', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = z.object({ unitId: uuid, amount: money, paidOn: date, mode: z.enum(MODES), reference: z.string().trim().min(3, 'Enter the UTR or cheque number').max(100),
      note: z.string().trim().max(500).default(''), fileId: uuid.nullable().optional() }).parse(req.body);
    const u = await homeOf(tx, actor, b.unitId);
    if (!(await myHomes(tx, actor.personId)).some(h => h.id === u.id)) forbidden();
    if (b.paidOn > await financeToday(tx)) fail(400, 'The payment date cannot be in the future.', 'invalid');
    if (await one(tx, `select 1 from app.payment_claims where lower(reference) = lower($1) and status <> 'rejected'`, [b.reference]))
      fail(409, 'A payment with this reference has already been reported.', 'duplicate');
    if (b.fileId && !await one(tx, `select 1 from app.files where id = $1 and purpose = 'payment_proof' and uploaded_by = $2`, [b.fileId, actor.personId]))
      fail(400, 'Upload the payment screenshot again.', 'invalid');
    const c = await one(tx, `insert into app.payment_claims (unit_id, person_id, amount_paise, paid_on, mode, reference, note, file_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [u.id, actor.personId, b.amount, b.paidOn, b.mode, b.reference, b.note, b.fileId ?? null]);
    await audit('finance.claim', 'payment_claim', c!.id, `${actor.name} reported a payment of ${rupee(b.amount)} for ${u.label}`);
    return { id: c!.id };
  }));

  app.get('/api/finance/claims', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor)) forbidden();
    const q = z.object({ status: z.enum(['pending', 'confirmed', 'rejected']).default('pending') }).parse(req.query);
    return many(tx, `select c.*, u.label, p.full_name as person, d.full_name as decided_by_name, j.ref as journal_ref from app.payment_claims c
      join app.units u on u.tenant_id = c.tenant_id and u.id = c.unit_id join app.people p on p.tenant_id = c.tenant_id and p.id = c.person_id
      left join app.people d on d.tenant_id = c.tenant_id and d.id = c.decided_by left join app.journals j on j.tenant_id = c.tenant_id and j.id = c.journal_id
      where c.status = $1 order by c.created_at ${q.status === 'pending' ? 'asc' : 'desc'} limit 200`, [q.status]);
  }));

  app.post('/api/finance/claims/:id/confirm', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const c = await one(tx, `select c.*, u.label, u.node_id from app.payment_claims c join app.units u on u.tenant_id = c.tenant_id and u.id = c.unit_id
      where c.id = $1`, [idParam.parse(req.params).id]) ?? notFound('That payment');
    if (c.status !== 'pending') fail(409, 'This payment has already been decided.', 'closed');
    const b = z.object({ accountId: uuid, date: date.optional() }).parse(req.body);
    const cash = await cashAccount(tx, b.accountId);
    if (await one(tx, `select 1 from app.journals j where j.kind = 'receipt' and lower(j.reference) = lower($1)
        and not exists (select 1 from app.journals r where r.reverses_id = j.id)`, [c.reference]))
      fail(409, `A receipt with reference ${c.reference} is already in the books.`, 'duplicate');
    const recv = await systemAccount(tx, 'receivables');
    const j = await post(tx, actor, { kind: 'receipt', date: b.date ?? c.paid_on, narration: `Payment from ${c.label} (reported by the owner)`, reference: c.reference,
      mode: c.mode, unitId: c.unit_id, source: 'claim', fileId: c.file_id,
      lines: [{ accountId: cash.id, debit: Number(c.amount_paise) }, { accountId: recv.id, credit: Number(c.amount_paise), unitId: c.unit_id, nodeId: c.node_id }] });
    await tx.query(`update app.payment_claims set status = 'confirmed', journal_id = $2, decided_by = $3, decided_at = now() where id = $1`, [c.id, j.id, actor.personId]);
    await audit('finance.claim_confirmed', 'payment_claim', c.id, `${j.ref}: ${rupee(Number(c.amount_paise))} from ${c.label} confirmed`);
    return j;
  }));

  app.post('/api/finance/claims/:id/reject', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const c = await one(tx, `select c.*, u.label from app.payment_claims c join app.units u on u.tenant_id = c.tenant_id and u.id = c.unit_id where c.id = $1`,
      [idParam.parse(req.params).id]) ?? notFound('That payment');
    if (c.status !== 'pending') fail(409, 'This payment has already been decided.', 'closed');
    const b = z.object({ note: text(500) }).parse(req.body);
    await tx.query(`update app.payment_claims set status = 'rejected', decision_note = $2, decided_by = $3, decided_at = now() where id = $1`, [c.id, b.note, actor.personId]);
    await audit('finance.claim_rejected', 'payment_claim', c.id, `Payment reported for ${c.label} not found: ${b.note}`);
    return { ok: true };
  }));

  // ================================================================ billing
  app.get('/api/finance/plans', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor)) forbidden();
    return many(tx, `select c.*, ${PLACE()} as place, a.name as account, a.code as account_code,
        (select max(r.issue_on) from app.billing_runs r where r.plan_id = c.id and r.status = 'posted') as last_billed
      from app.charge_plans c join app.property_nodes n on n.tenant_id = c.tenant_id and n.id = c.scope_node_id
      join app.ledger_accounts a on a.tenant_id = c.tenant_id and a.id = c.account_id order by c.active desc, c.name`);
  }));

  const planBody = z.object({ name: text(120), frequency: z.enum(['monthly', 'quarterly', 'half_yearly', 'annually', 'once']),
    basis: z.enum(['area', 'unit_type', 'flat']), areaField: z.enum(['carpet_sqft', 'builtup_sqft', 'super_sqft', 'plot_sqft', 'uds_sqft']).nullable().optional(),
    rate: rupeesToPaise, unitTypeRates: z.record(z.string().uuid(), z.union([z.number(), z.string()])).default({}),
    scopeNodeId: uuid, categories: z.array(z.enum(['apartment', 'villa', 'row_house', 'plot', 'commercial', 'other'])).min(1),
    accountId: uuid, dueDays: z.coerce.number().int().min(0).max(120).default(15), active: z.boolean().default(true) });

  async function planValues(tx: Tx, b: z.infer<typeof planBody>) {
    if (b.basis === 'area' && (!b.areaField || !b.rate)) fail(400, 'Choose which area is charged and the rate per sq ft.', 'invalid');
    if (b.basis === 'flat' && !b.rate) fail(400, 'Enter the amount charged to each home.', 'invalid');
    const rates: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.unitTypeRates)) {
      const n = Math.round(Number(String(v).replace(/[,₹\s]/g, '')) * 100);
      if (!Number.isFinite(n) || n < 0) fail(400, 'Check the amounts for each kind of home.', 'invalid');
      if (n > 0) rates[k] = n;
    }
    if (b.basis === 'unit_type' && !Object.keys(rates).length) fail(400, 'Enter an amount for at least one kind of home.', 'invalid');
    const acc = await account(tx, b.accountId);
    if (!['income', 'funds'].includes(acc.type)) fail(400, 'Bill to an income or fund account.', 'invalid');
    await nodeRef(tx, b.scopeNodeId);
    return rates;
  }

  app.post('/api/finance/plans', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const b = planBody.parse(req.body);
    const rates = await planValues(tx, b);
    const ref = (await one(tx, `select app.next_ref('plan', 'BP') as ref`))!.ref;
    const p = await one(tx, `insert into app.charge_plans (ref, name, frequency, basis, area_field, rate_paise, unit_type_rates, scope_node_id, categories, account_id, due_days, active, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [ref, b.name, b.frequency, b.basis, b.basis === 'area' ? b.areaField : null, b.basis === 'unit_type' ? null : b.rate, rates, b.scopeNodeId, b.categories,
        b.accountId, b.dueDays, b.active, actor.personId]);
    await audit('finance.plan_created', 'charge_plan', p!.id, `${ref}: ${b.name}`);
    return { id: p!.id, ref };
  }));

  app.patch('/api/finance/plans/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const { id } = idParam.parse(req.params);
    const p = await one(tx, `select * from app.charge_plans where id = $1`, [id]) ?? notFound('That billing plan');
    const b = planBody.parse({ ...{ name: p.name, frequency: p.frequency, basis: p.basis, areaField: p.area_field, rate: p.rate_paise ? Number(p.rate_paise) / 100 : null,
      unitTypeRates: Object.fromEntries(Object.entries(p.unit_type_rates).map(([k, v]) => [k, Number(v) / 100])), scopeNodeId: p.scope_node_id,
      categories: p.categories, accountId: p.account_id, dueDays: p.due_days, active: p.active }, ...(req.body as object) });
    const rates = await planValues(tx, b);
    await tx.query(`update app.charge_plans set name = $2, frequency = $3, basis = $4, area_field = $5, rate_paise = $6, unit_type_rates = $7, scope_node_id = $8,
      categories = $9, account_id = $10, due_days = $11, active = $12 where id = $1`,
      [id, b.name, b.frequency, b.basis, b.basis === 'area' ? b.areaField : null, b.basis === 'unit_type' ? null : b.rate, rates, b.scopeNodeId, b.categories,
        b.accountId, b.dueDays, b.active]);
    await audit('finance.plan_changed', 'charge_plan', id, `${p.ref} changed`);
    return { ok: true };
  }));

  app.get('/api/finance/runs', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor)) forbidden();
    return many(tx, `select r.*, c.name as plan, c.ref as plan_ref, j.ref as journal_ref,
        exists (select 1 from app.journals x where x.reverses_id = r.journal_id) as reversed
      from app.billing_runs r join app.charge_plans c on c.tenant_id = r.tenant_id and c.id = r.plan_id
      left join app.journals j on j.tenant_id = r.tenant_id and j.id = r.journal_id order by r.issue_on desc, r.created_at desc limit 100`);
  }));

  app.get('/api/finance/runs/:id', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor)) forbidden();
    const r = await one(tx, `select r.*, c.name as plan, c.ref as plan_ref, j.ref as journal_ref from app.billing_runs r
      join app.charge_plans c on c.tenant_id = r.tenant_id and c.id = r.plan_id left join app.journals j on j.tenant_id = r.tenant_id and j.id = r.journal_id
      where r.id = $1`, [idParam.parse(req.params).id]) ?? notFound('That billing run');
    const lines = await many(tx, `select l.*, u.label, ${PLACE()} as place from app.billing_run_lines l join app.units u on u.tenant_id = l.tenant_id and u.id = l.unit_id
      join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id where l.run_id = $1 order by u.label`, [r.id]);
    return { ...r, lines, canPost: canKeepBooks(actor) && r.status === 'draft' };
  }));

  // A draft run works out each home's charge; nothing reaches the books until it is posted.
  app.post('/api/finance/runs', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const b = z.object({ planId: uuid, periodLabel: text(40), issueOn: date, dueOn: date.optional() }).parse(req.body);
    const p = await one(tx, `select * from app.charge_plans where id = $1`, [b.planId]) ?? notFound('That billing plan');
    if (!p.active) fail(400, 'This billing plan is switched off.', 'invalid');
    if (await one(tx, `select 1 from app.billing_runs where plan_id = $1 and lower(period_label) = lower($2) and status <> 'cancelled'`, [p.id, b.periodLabel]))
      fail(409, `${p.name} has already been billed for ${b.periodLabel}.`, 'duplicate');
    const due = b.dueOn ?? new Date(Date.parse(b.issueOn) + p.due_days * 86_400_000).toISOString().slice(0, 10);
    if (due < b.issueOn) fail(400, 'The due date must be on or after the issue date.', 'invalid');
    const units = await many(tx, `select u.id, u.label, u.unit_type_id, t.name as type, t.category, u.${p.area_field ?? 'super_sqft'}::numeric as area
      from app.units u join app.unit_types t on t.tenant_id = u.tenant_id and t.id = u.unit_type_id
      join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
      where u.archived_at is null and (n.id = $1 or $1 = any (n.ancestor_ids)) and t.category = any ($2) order by u.label`, [p.scope_node_id, p.categories]);
    const lines: { unit_id: string; amount: number; basis: string }[] = [], skipped: { label: string; reason: string }[] = [];
    const areaLabel: Record<string, string> = { carpet_sqft: 'carpet', builtup_sqft: 'built-up', super_sqft: 'super built-up', plot_sqft: 'plot', uds_sqft: 'UDS' };
    for (const u of units) {
      if (p.basis === 'area') {
        if (!u.area || Number(u.area) <= 0) { skipped.push({ label: u.label, reason: `no ${areaLabel[p.area_field]} area recorded` }); continue; }
        const amount = Math.round(Number(u.area) * Number(p.rate_paise) / 100) * 100;
        lines.push({ unit_id: u.id, amount, basis: `${Number(u.area).toLocaleString('en-IN')} sq ft ${areaLabel[p.area_field]} × ${rupee(Number(p.rate_paise))}` });
      } else if (p.basis === 'unit_type') {
        const rate = p.unit_type_rates[u.unit_type_id];
        if (!rate) { skipped.push({ label: u.label, reason: `no amount set for ${u.type}` }); continue; }
        lines.push({ unit_id: u.id, amount: Number(rate), basis: `${u.type}` });
      } else lines.push({ unit_id: u.id, amount: Number(p.rate_paise), basis: 'Same for every home' });
    }
    if (!lines.length) fail(400, 'No homes would be charged by this plan. Check its place, kinds of home and rates.', 'invalid');
    const ref = (await one(tx, `select app.next_ref('billing_run', 'BR') as ref`))!.ref;
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const r = await one(tx, `insert into app.billing_runs (ref, plan_id, period_label, issue_on, due_on, total_paise, units, skipped, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`, [ref, p.id, b.periodLabel, b.issueOn, due, total, lines.length, JSON.stringify(skipped), actor.personId]);
    await tx.query(`insert into app.billing_run_lines (run_id, unit_id, amount_paise, basis) select $1, x.u, x.a, x.b
      from unnest($2::uuid[], $3::bigint[], $4::text[]) as x(u, a, b)`, [r!.id, lines.map(l => l.unit_id), lines.map(l => l.amount), lines.map(l => l.basis)]);
    await audit('finance.run_drafted', 'billing_run', r!.id, `${ref}: ${p.name} for ${b.periodLabel}, ${lines.length} homes, ${rupee(total)} (draft)`);
    return { id: r!.id, ref, total, units: lines.length, skipped };
  }));

  app.post('/api/finance/runs/:id/post', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const r = await one(tx, `select r.*, c.name as plan, c.account_id, c.scope_node_id from app.billing_runs r
      join app.charge_plans c on c.tenant_id = r.tenant_id and c.id = r.plan_id where r.id = $1 for update of r`, [idParam.parse(req.params).id]) ?? notFound('That billing run');
    if (r.status !== 'draft') fail(409, 'Only a draft run can be posted.', 'closed');
    const lines = await many(tx, `select l.unit_id, l.amount_paise, l.basis, u.node_id from app.billing_run_lines l join app.units u on u.tenant_id = l.tenant_id and u.id = l.unit_id
      where l.run_id = $1`, [r.id]);
    const recv = await systemAccount(tx, 'receivables');
    const total = lines.reduce((s, l) => s + Number(l.amount_paise), 0);
    const j = await post(tx, actor, { kind: 'charge', date: r.issue_on, dueOn: r.due_on, narration: `${r.plan}: ${r.period_label}`, source: 'billing',
      lines: [...lines.map(l => ({ accountId: recv.id, debit: Number(l.amount_paise), unitId: l.unit_id, nodeId: l.node_id, memo: l.basis })),
        { accountId: r.account_id, credit: total, nodeId: r.scope_node_id, memo: `${lines.length} homes` }] });
    await tx.query(`update app.billing_runs set status = 'posted', journal_id = $2, posted_by = $3, posted_at = now(), total_paise = $4 where id = $1`,
      [r.id, j.id, actor.personId, total]);
    await audit('finance.run_posted', 'billing_run', r.id, `${r.ref} posted as ${j.ref}: ${lines.length} homes charged ${rupee(total)}`);
    return { journal: j, total, units: lines.length };
  }));

  app.post('/api/finance/runs/:id/cancel', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const r = await one(tx, `select * from app.billing_runs where id = $1`, [idParam.parse(req.params).id]) ?? notFound('That billing run');
    if (r.status !== 'draft') fail(409, 'A posted run is corrected by reversing its entry.', 'closed');
    await tx.query(`update app.billing_runs set status = 'cancelled' where id = $1`, [r.id]);
    await audit('finance.run_cancelled', 'billing_run', r.id, `${r.ref} discarded`);
    return { ok: true };
  }));

  // ================================================================ vouchers
  const VOUCHER_SQL = `select v.*, a.name as account, a.code as account_code, ${PLACE()} as place, w.ref as work_ref, w.title as work_title, vn.name as vendor,
      p.full_name as prepared_by_name, r.ref as approval_ref, r.status as approval_status, j.ref as journal_ref, j.txn_date as paid_on, j.reference as paid_reference
    from app.vouchers v join app.ledger_accounts a on a.tenant_id = v.tenant_id and a.id = v.account_id
    join app.property_nodes n on n.tenant_id = v.tenant_id and n.id = v.node_id
    left join app.work_orders w on w.tenant_id = v.tenant_id and w.id = v.work_order_id
    left join app.vendors vn on vn.tenant_id = v.tenant_id and vn.id = v.vendor_id
    join app.people p on p.tenant_id = v.tenant_id and p.id = v.prepared_by
    left join app.approval_requests r on r.tenant_id = v.tenant_id and r.id = v.approval_request_id
    left join app.journals j on j.tenant_id = v.tenant_id and j.id = v.journal_id`;
  const voucherState = (v: any) => v.status === 'paid' ? 'paid' : v.status === 'cancelled' ? 'cancelled'
    : v.approval_status === 'approved' ? 'to_pay' : v.approval_status === 'pending' ? 'awaiting_approval' : v.approval_status ?? 'awaiting_approval';

  app.get('/api/finance/vouchers', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor) && !canPrepare(actor)) forbidden();
    const q = z.object({ state: z.enum(['open', 'to_pay', 'paid', 'all']).default('open'), workOrderId: uuid.optional() }).parse(req.query);
    const rows = (await many(tx, `${VOUCHER_SQL} where ($1::uuid is null or v.work_order_id = $1) order by v.created_at desc limit 300`, [q.workOrderId ?? null]))
      .map(v => ({ ...v, state: voucherState(v) }));
    return rows.filter(v => q.state === 'all' || (q.state === 'open' ? ['awaiting_approval', 'to_pay'].includes(v.state) : v.state === q.state));
  }));

  app.get('/api/finance/vouchers/:id', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor) && !canPrepare(actor)) forbidden();
    const v = await one(tx, `${VOUCHER_SQL} where v.id = $1`, [idParam.parse(req.params).id]) ?? notFound('That voucher');
    const state = voucherState(v);
    return { ...v, state, actions: { pay: canKeepBooks(actor) && state === 'to_pay',
      cancel: (canKeepBooks(actor) || v.prepared_by === actor.personId) && ['awaiting_approval', 'to_pay', 'rejected', 'withdrawn'].includes(state) } };
  }));

  // A voucher is decided by the approval rules for spending, by amount and place.
  app.post('/api/finance/vouchers', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canPrepare(actor)) forbidden();
    const b = z.object({ vendorId: uuid.nullable().optional(), payee: z.string().trim().max(120).optional(), description: text(1000), amount: money,
      tds: rupeesToPaise, accountId: uuid, nodeId: uuid, workOrderId: uuid.nullable().optional(), invoiceNo: optText(60), invoiceDate: date.nullable().optional(),
      fileId: uuid.nullable().optional() }).parse(req.body);
    const acc = await account(tx, b.accountId);
    if (!['expense', 'asset', 'liability'].includes(acc.type) || acc.cash_kind || acc.system_key === 'receivables')
      fail(400, 'Choose what the payment is for: an expense account, a deposit or an advance.', 'invalid');
    const vendor = b.vendorId ? await one(tx, `select id, name, status, status_note from app.vendors where id = $1`, [b.vendorId]) ?? notFound('That vendor') : null;
    if (vendor?.status === 'blocked') fail(400, `${vendor.name} is blocked: ${vendor.status_note}`, 'invalid');
    const payee = vendor?.name ?? b.payee ?? fail(400, 'Say who is to be paid.', 'invalid');
    const tds = Number(b.tds ?? 0);
    if (tds >= b.amount) fail(400, 'TDS must be less than the amount.', 'invalid');
    const node = await nodeRef(tx, b.nodeId);
    if (b.workOrderId && !await one(tx, `select 1 from app.work_orders where id = $1`, [b.workOrderId])) notFound('That work order');
    if (b.fileId && !await one(tx, `select 1 from app.files where id = $1 and purpose = 'invoice'`, [b.fileId])) fail(400, 'Upload the invoice again.', 'invalid');
    if (vendor && b.invoiceNo && await one(tx, `select ref from app.vouchers where vendor_id = $1 and lower(invoice_no) = lower($2) and status <> 'cancelled'`, [vendor.id, b.invoiceNo]))
      fail(409, `Invoice ${b.invoiceNo} from ${vendor.name} is already on a voucher.`, 'duplicate');
    const ref = (await one(tx, `select app.next_ref('voucher', 'PV') as ref`))!.ref;
    const v = await one(tx, `insert into app.vouchers (ref, vendor_id, payee, description, amount_paise, tds_paise, account_id, node_id, work_order_id, invoice_no, invoice_date,
        file_id, prepared_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [ref, vendor?.id ?? null, payee, b.description, b.amount, tds, acc.id, node.id, b.workOrderId ?? null, b.invoiceNo, b.invoiceDate ?? null, b.fileId ?? null, actor.personId]);
    const res = await engine.propose(tx, actor, { subjectType: 'expense', subjectId: v!.id, title: `${ref}: ${payee}`.slice(0, 200),
      details: `${b.description}\n${acc.code} ${acc.name}${b.invoiceNo ? `. Invoice ${b.invoiceNo}` : ''}${tds ? `. TDS ${rupee(tds)}; net payable ${rupee(b.amount - tds)}` : ''}`,
      amountPaise: String(b.amount), scopeNodeId: node.id });
    await tx.query(`update app.vouchers set approval_request_id = $2 where id = $1`, [v!.id, res!.id]);
    await audit('finance.voucher', 'voucher', v!.id, `${ref}: ${rupee(b.amount)} to ${payee}, sent for approval as ${res!.ref}`);
    return { id: v!.id, ref, approvalId: res!.id, approvalRef: res!.ref };
  }));

  app.post('/api/finance/vouchers/:id/pay', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const v = await one(tx, `${VOUCHER_SQL} where v.id = $1`, [idParam.parse(req.params).id]) ?? notFound('That voucher');
    if (voucherState(v) !== 'to_pay') fail(409, v.status === 'paid' ? 'This voucher has already been paid.' : 'This voucher has not been approved.', 'closed');
    const b = z.object({ accountId: uuid, date, mode: z.enum(MODES), reference: optText(100) }).parse(req.body);
    if (b.mode !== 'cash' && !b.reference) fail(400, 'Enter the UTR or cheque number.', 'invalid');
    const cash = await cashAccount(tx, b.accountId);
    const amount = Number(v.amount_paise), tds = Number(v.tds_paise);
    const lines = [{ accountId: v.account_id, debit: amount, nodeId: v.node_id, vendorId: v.vendor_id }, { accountId: cash.id, credit: amount - tds }];
    if (tds) lines.push({ accountId: (await systemAccount(tx, 'tds_payable')).id, credit: tds, vendorId: v.vendor_id } as any);
    const j = await post(tx, actor, { kind: 'payment', date: b.date, narration: `${v.ref}: ${v.payee}. ${v.description}`.slice(0, 500), reference: b.reference,
      mode: b.mode, vendorId: v.vendor_id, source: 'voucher', fileId: v.file_id, lines });
    await tx.query(`update app.vouchers set status = 'paid', journal_id = $2 where id = $1`, [v.id, j.id]);
    await audit('finance.voucher_paid', 'voucher', v.id, `${v.ref} paid as ${j.ref}: ${rupee(amount - tds)} to ${v.payee}${tds ? ` (TDS ${rupee(tds)})` : ''}`);
    return j;
  }));

  app.post('/api/finance/vouchers/:id/cancel', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const v = await one(tx, `${VOUCHER_SQL} where v.id = $1`, [idParam.parse(req.params).id]) ?? notFound('That voucher');
    if (!canKeepBooks(actor) && v.prepared_by !== actor.personId) forbidden();
    if (['paid', 'cancelled'].includes(v.status)) fail(409, v.status === 'paid' ? 'A paid voucher is corrected by reversing its payment.' : 'Already cancelled.', 'closed');
    const b = z.object({ note: text(500) }).parse(req.body);
    if (v.approval_status === 'pending') await engine.withdraw(tx, actor, v.approval_request_id, `Voucher cancelled: ${b.note}`).catch(() => {
      // The preparer may not be the proposer of record; the request is then closed as rejected by the treasurer.
      if (canKeepBooks(actor)) return engine.reject(tx, actor, v.approval_request_id, `Voucher cancelled: ${b.note}`);
      throw new Error('cannot close approval');
    });
    await tx.query(`update app.vouchers set status = 'cancelled', cancelled_note = $2 where id = $1`, [v.id, b.note]);
    await audit('finance.voucher_cancelled', 'voucher', v.id, `${v.ref} cancelled: ${b.note}`);
    return { ok: true };
  }));

  // ================================================================ budgets
  app.get('/api/finance/budgets', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canViewBooks(actor)) forbidden();
    const s = await settings(tx);
    const fy = z.object({ fy: z.coerce.number().int().min(2000).max(2100).optional() }).parse(req.query).fy ?? fyOf(await financeToday(tx), s.fy_start_month).year;
    return many(tx, `select a.id, a.code, a.name, a.type, b.amount_paise from app.ledger_accounts a
      left join app.budgets b on b.tenant_id = a.tenant_id and b.account_id = a.id and b.fy_start = $1
      where a.type in ('income', 'expense') and a.archived_at is null order by a.code`, [fy]);
  }));
  app.put('/api/finance/budgets', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canKeepBooks(actor)) forbidden();
    const b = z.object({ fy: z.coerce.number().int().min(2000).max(2100), items: z.array(z.object({ accountId: uuid, amount: rupeesToPaise })).max(200) }).parse(req.body);
    for (const i of b.items) {
      if (i.amount === null) await tx.query(`delete from app.budgets where fy_start = $1 and account_id = $2`, [b.fy, i.accountId]);
      else await tx.query(`insert into app.budgets (fy_start, account_id, amount_paise) values ($1, $2, $3)
        on conflict (tenant_id, fy_start, account_id) do update set amount_paise = excluded.amount_paise`, [b.fy, i.accountId, i.amount]);
    }
    await audit('finance.budget', 'tenant', null, `Budget for ${b.fy}–${String(b.fy + 1).slice(2)} updated`);
    return { ok: true };
  }));

}
