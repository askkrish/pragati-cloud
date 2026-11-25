// Finance: the books balance and cannot be changed, billing charges the right homes, payments
// settle the oldest dues first, owners see only their own homes, vouchers go through approval,
// closed periods and reconciled bank dates are locked, and the reports agree with each other.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addDays, localNow } from '../server/src/services/schedule.ts';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
let roles: any[];
let accounts: any[];
let bank: any;
const today = localNow('Asia/Kolkata').day;
const ok = (r: { status: number; body: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const acct = (key: string) => accounts.find(a => a.system_key === key || a.code === key);

before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'fin');
  roles = (await C.admin.get('/api/roles')).body;
  accounts = ok(await C.admin.get('/api/finance/accounts'));
});
after(() => h.close());

async function member(name: string, phone: string, roleKey: string, scopeNodeId: string | null = null) {
  const p = await C.person(name, phone);
  ok(await C.admin.post('/api/members', { personId: p.id, roleId: roles.find(r => r.key === roleKey).id, scopeNodeId }));
  return { person: p, client: h.client(C.host, await h.sessionFor(C.id, phone)) };
}

test('a new community starts with a chart of accounts and a Treasurer role', () => {
  assert.ok(accounts.length >= 25);
  for (const k of ['receivables', 'general_fund', 'corpus_fund', 'sinking_fund', 'maintenance', 'tds_payable']) assert.ok(acct(k), k);
  assert.ok(roles.some(r => r.key === 'treasurer' && r.permissions.includes('finance.manage')));
});

test('a bank account opens with its balance against the general fund; the trial balance balances', async () => {
  const b = ok(await C.admin.post('/api/finance/accounts', { name: 'Operating account', cashKind: 'bank', bankName: 'Sample Bank', last4: '4321',
    opening: '2,50,000', openedOn: addDays(today, -40) }));
  ok(await C.admin.post('/api/finance/accounts', { name: 'Petty cash', cashKind: 'cash', opening: 5000, openedOn: addDays(today, -40) }));
  accounts = ok(await C.admin.get('/api/finance/accounts'));
  bank = accounts.find(a => a.id === b.id);
  assert.equal(bank.balance, 25000000);
  const tb = ok(await C.admin.get('/api/finance/reports/trial'));
  assert.equal(tb.totals.debit, tb.totals.credit);
  assert.equal(tb.rows.find((r: any) => r.name === 'General fund').credit, 25500000);
});

test('billing charges each home by area for one block, skips homes without an area, and runs once per period', async () => {
  const unit2 = ok(await C.admin.post('/api/units', { nodeId: C.blockA.id, unitTypeId: C.types.find((t: any) => t.code === '3bhk').id, label: 'A-102', carpetSqft: 1450 }));
  ok(await C.admin.post('/api/units', { nodeId: C.blockA.id, unitTypeId: C.types.find((t: any) => t.code === '3bhk').id, label: 'A-103' }));
  const plan = ok(await C.admin.post('/api/finance/plans', { name: 'Block A maintenance', frequency: 'monthly', basis: 'area', areaField: 'carpet_sqft',
    rate: '3.50', scopeNodeId: C.blockA.id, categories: ['apartment'], accountId: acct('maintenance').id, dueDays: 10 }));
  const run1 = ok(await C.admin.post('/api/finance/runs', { planId: plan.id, periodLabel: 'Month 1', issueOn: addDays(today, -35) }));
  assert.equal(run1.units, 2);
  assert.equal(run1.total, 350000 + 507500);
  assert.deepEqual(run1.skipped, [{ label: 'A-103', reason: 'no carpet area recorded' }]);
  ok(await C.admin.post('/api/finance/runs', { planId: plan.id, periodLabel: 'month 1', issueOn: addDays(today, -35) }), 409);
  // Nothing reaches the books until the run is posted.
  let dues = ok(await C.admin.get('/api/finance/dues?owing=1'));
  assert.equal(dues.rows.length, 0);
  ok(await C.admin.post(`/api/finance/runs/${run1.id}/post`, {}));
  const run2 = ok(await C.admin.post('/api/finance/runs', { planId: plan.id, periodLabel: 'Month 2', issueOn: addDays(today, -5) }));
  ok(await C.admin.post(`/api/finance/runs/${run2.id}/post`, {}));
  dues = ok(await C.admin.get('/api/finance/dues?owing=1'));
  const a101 = dues.rows.find((r: any) => r.label === 'A-101');
  assert.equal(a101.balance, 700000);
  assert.equal(a101.buckets.d30, 350000, 'month 1 is 1-30 days overdue');
  assert.equal(a101.buckets.current, 350000);
  assert.ok(dues.rows.find((r: any) => r.label === 'A-102'));
  void unit2;
});

test('a payment settles the oldest charge first; the same reference cannot be receipted twice', async () => {
  ok(await C.admin.post('/api/finance/receipts', { date: addDays(today, -2), accountId: bank.id, amount: 3500, mode: 'upi', reference: 'UTR0001', unitId: C.unitA.id }));
  ok(await C.admin.post('/api/finance/receipts', { date: addDays(today, -2), accountId: bank.id, amount: 3500, mode: 'upi', reference: 'utr0001', unitId: C.unitA.id }), 409);
  ok(await C.admin.post('/api/finance/receipts', { date: addDays(today, -2), accountId: bank.id, amount: 3500, mode: 'neft', unitId: C.unitA.id }), 400);
  const st = ok(await C.admin.get(`/api/finance/units/${C.unitA.id}/statement`));
  assert.equal(st.dues.balance, 350000);
  assert.equal(st.dues.buckets.d30, 0);
  assert.equal(st.dues.buckets.current, 350000);
  assert.equal(st.lines.at(-1).balance, '350000');
});

test('owners see only their own dues, report a payment, and the treasurer confirms or rejects it', async () => {
  ok(await C.admin.post(`/api/units/${C.unitA.id}/owners`, { newPerson: { name: 'Owner A', phone: '+919000500001' }, sharePct: 100 }));
  const owner = h.client(C.host, await h.sessionFor(C.id, '+919000500001'));
  const mine = ok(await owner.get('/api/my/dues'));
  assert.equal(mine.homes.length, 1);
  assert.equal(mine.homes[0].dues.balance, 350000);
  ok(await owner.get(`/api/finance/units/${C.unitB.id}/statement`), 404);
  ok(await owner.get('/api/finance/dues'), 403);
  const claim = ok(await owner.post('/api/my/claims', { unitId: C.unitA.id, amount: 3500, paidOn: addDays(today, -1), mode: 'upi', reference: 'UTR0002' }));
  ok(await owner.post('/api/my/claims', { unitId: C.unitA.id, amount: 3500, paidOn: addDays(today, -1), mode: 'upi', reference: 'UTR0002' }), 409);
  ok(await owner.post('/api/my/claims', { unitId: C.unitB.id, amount: 100, paidOn: today, mode: 'upi', reference: 'UTR0003' }), 404);
  const { client: treasurer } = await member('Treasurer T', '+919000500002', 'treasurer');
  ok(await treasurer.post(`/api/finance/claims/${claim.id}/confirm`, { accountId: bank.id }));
  assert.equal(ok(await owner.get('/api/my/dues')).homes[0].dues.balance, 0);
  const bad = ok(await owner.post('/api/my/claims', { unitId: C.unitA.id, amount: 999, paidOn: today, mode: 'upi', reference: 'UTR9999' }));
  ok(await treasurer.post(`/api/finance/claims/${bad.id}/reject`, {}), 400);
  ok(await treasurer.post(`/api/finance/claims/${bad.id}/reject`, { note: 'Not in the bank statement' }));
  assert.equal(ok(await owner.get('/api/my/dues')).claims.find((c: any) => c.id === bad.id).status, 'rejected');
});

test('a voucher is prepared, approved under the rules, and paid with TDS deducted', async () => {
  const committee = ok(await C.admin.get('/api/committees'))[0];
  const { person: cm, client: cmClient } = await member('Committee C', '+919000500003', 'committee_member');
  ok(await C.admin.post(`/api/committees/${committee.id}/seats`, { personId: cm.id }));
  const { client: fm } = await member('Facility M', '+919000500004', 'facility_manager');
  const vendor = ok(await fm.post('/api/vendors', { name: 'Velan Lifts & Escalators', categories: ['lifts'] }));
  const v = ok(await fm.post('/api/finance/vouchers', { vendorId: vendor.id, description: 'Lift AMC, first quarter', amount: 30000, tds: 600,
    accountId: acct('5060').id, nodeId: C.root.id, invoiceNo: 'VL/2026/118' }));
  ok(await fm.post('/api/finance/vouchers', { vendorId: vendor.id, description: 'Same invoice again', amount: 30000, accountId: acct('5060').id,
    nodeId: C.root.id, invoiceNo: 'vl/2026/118' }), 409);
  const treasurer = h.client(C.host, await h.sessionFor(C.id, '+919000500002'));
  ok(await treasurer.post(`/api/finance/vouchers/${v.id}/pay`, { accountId: bank.id, date: today, mode: 'neft', reference: 'N1' }), 409);
  ok(await cmClient.post(`/api/approvals/${v.approvalId}/vote`, { vote: 'approve' }));
  ok(await cmClient.post(`/api/finance/vouchers/${v.id}/pay`, { accountId: bank.id, date: today, mode: 'neft', reference: 'N1' }), 403);
  const pay = ok(await treasurer.post(`/api/finance/vouchers/${v.id}/pay`, { accountId: bank.id, date: today, mode: 'neft', reference: 'NEFT778' }));
  assert.match(pay.ref, /^PY-/);
  const detail = ok(await treasurer.get(`/api/finance/vouchers/${v.id}`));
  assert.equal(detail.state, 'paid');
  const tb = ok(await treasurer.get('/api/finance/reports/trial'));
  assert.equal(tb.rows.find((r: any) => r.name === 'AMC charges').debit, 3000000);
  assert.equal(tb.rows.find((r: any) => r.name === 'TDS payable').credit, 60000);
  ok(await treasurer.post(`/api/finance/vouchers/${v.id}/pay`, { accountId: bank.id, date: today, mode: 'neft', reference: 'N2' }), 409);
});

test('entries are permanent: corrections are reversals, and the database refuses edits and unbalanced entries', async () => {
  const r = ok(await C.admin.post('/api/finance/receipts', { date: today, accountId: bank.id, amount: 1000, mode: 'cash', creditAccountId: acct('4090').id,
    narration: 'Scrap sale' }));
  const rev = ok(await C.admin.post(`/api/finance/journals/${r.id}/reverse`, { reason: 'Wrong account' }));
  assert.match(rev.ref, /^RV-/);
  ok(await C.admin.post(`/api/finance/journals/${r.id}/reverse`, { reason: 'Again' }), 409);
  ok(await C.admin.post(`/api/finance/journals/${rev.id}/reverse`, { reason: 'Undo' }), 400);
  await assert.rejects(h.asApp(C.id, `update app.journals set narration = 'changed' where id = $1`, [r.id]), /permission denied|cannot be changed/);
  await assert.rejects(h.asApp(C.id, `delete from app.journal_lines where journal_id = $1`, [r.id]), /permission denied|cannot be changed/);
  ok(await C.admin.post('/api/finance/journals', { date: today, narration: 'Unbalanced', lines: [{ accountId: bank.id, debit: 10 }, { accountId: acct('4090').id, credit: 9 }] }), 400);
  await assert.rejects(h.asApp(C.id, `with j as (insert into app.journals (ref, kind, txn_date, narration) values ('X-1', 'journal', current_date, 'raw') returning id)
    insert into app.journal_lines (journal_id, account_id, debit_paise) select j.id, $1, 500 from j`, [bank.id]), /must balance/);
});

test('reports agree: the balance sheet balances, income less expenditure is the surplus, and dues match receivables', async () => {
  const bs = ok(await C.admin.get('/api/finance/reports/balance'));
  assert.match(bs.note, /also total/);
  const ie = ok(await C.admin.get(`/api/finance/reports/income?from=${addDays(today, -60)}&to=${today}`));
  assert.equal(ie.totals.amount, 350000 + 507500 + 350000 + 507500 - 3000000);
  const dues = ok(await C.admin.get('/api/finance/reports/dues'));
  const tb = ok(await C.admin.get('/api/finance/reports/trial'));
  assert.equal(dues.totals.balance, tb.rows.find((r: any) => r.name === 'Maintenance receivable').debit);
  const csv = await C.admin.call('GET', '/api/finance/reports/trial?format=csv');
  assert.match(csv.raw.body, /^﻿Trial balance/);
  const masters = (await C.admin.call('GET', '/api/finance/export/tally?part=masters')).raw.body;
  assert.match(masters, /<LEDGER NAME="Flat A-101" ACTION="Create">.*<PARENT>Sundry Debtors<\/PARENT>/);
  const vouchers = (await C.admin.call('GET', '/api/finance/export/tally?part=vouchers&from=' + addDays(today, -60))).raw.body;
  assert.match(vouchers, /<VOUCHERTYPENAME>Receipt<\/VOUCHERTYPENAME>/);
  assert.equal((vouchers.match(/<VOUCHER /g) ?? []).length, (vouchers.match(/<\/VOUCHER>/g) ?? []).length);
});

test('bank reconciliation matches the statement, then locks the account up to that day', async () => {
  const start = addDays(today, -40);
  const lines = ok(await C.admin.get(`/api/finance/journals?accountId=${bank.id}&from=${start}&limit=200`));
  const book = lines.map((j: any) => ({ date: j.txn_date, ref: j.reference ?? j.ref, amount: j.lines.filter((l: any) => l.account === 'Operating account')
    .reduce((s: number, l: any) => s + Number(l.debit) - Number(l.credit), 0) })).filter((x: any) => x.amount !== 0 && x.ref !== bank.ref);
  // The bank shows the opening deposit as the opening balance, and everything else as lines.
  const opening = book.find((b: any) => b.amount === 25000000);
  const rest = book.filter((b: any) => b !== opening);
  const total = rest.reduce((s: number, b: any) => s + b.amount, 0);
  const csv = ['Date,Description,Reference,Amount', ...rest.map((b: any) => `${b.date.split('-').reverse().join('/')},Transfer,${b.ref},${(b.amount / 100).toFixed(2)}`)].join('\n');
  ok(await C.admin.post(`/api/finance/accounts/${bank.id}/statements`, { csv, periodStart: addDays(start, 1), periodEnd: today, opening: '2,50,000', closing: '1' }), 400);
  const st = ok(await C.admin.post(`/api/finance/accounts/${bank.id}/statements`, { csv, periodStart: addDays(start, 1), periodEnd: today,
    opening: 250000, closing: (25000000 + total) / 100 }));
  assert.equal(st.matched, st.lines);
  const view = ok(await C.admin.get(`/api/finance/accounts/${bank.id}/reconcile`));
  assert.equal(view.statement.canReconcile, true, JSON.stringify(view.statement.checks));
  ok(await C.admin.post(`/api/finance/statements/${view.statement.id}/reconcile`, {}));
  ok(await C.admin.post('/api/finance/receipts', { date: today, accountId: bank.id, amount: 10, mode: 'cash', creditAccountId: acct('4090').id }), 400);
});

test('closing a period locks it, also in the database', async () => {
  ok(await C.admin.post('/api/finance/close', { through: addDays(today, -1) }));
  const petty = accounts.find(a => a.name === 'Petty cash');
  ok(await C.admin.post('/api/finance/receipts', { date: addDays(today, -1), accountId: petty.id, amount: 10, mode: 'cash', creditAccountId: acct('4090').id }), 400);
  await assert.rejects(h.asApp(C.id, `insert into app.journals (ref, kind, txn_date, narration) values ('X-2', 'journal', $1, 'raw')`, [addDays(today, -1)]), /closed/);
  ok(await C.admin.post('/api/finance/receipts', { date: today, accountId: petty.id, amount: 10, mode: 'cash', creditAccountId: acct('4090').id }));
});

test('committee members read the books but cannot post; block committees and staff cannot read them', async () => {
  const { client: cm } = await member('Committee R', '+919000500010', 'committee_member');
  ok(await cm.get('/api/finance/reports/trial'));
  ok(await cm.post('/api/finance/receipts', { date: today, accountId: bank.id, amount: 10, mode: 'cash', creditAccountId: acct('4090').id }), 403);
  const { client: bc } = await member('Block B', '+919000500011', 'block_committee_member', C.blockB.id);
  ok(await bc.get('/api/finance/reports/trial'), 403);
  const { client: staff } = await member('Staff S', '+919000500012', 'staff');
  ok(await staff.get('/api/finance/overview'), 403);
});

test('every finance list and report loads', async () => {
  for (const p of ['/api/finance/overview', '/api/finance/accounts', '/api/finance/journals', '/api/finance/dues', '/api/finance/claims', '/api/finance/plans',
    '/api/finance/runs', '/api/finance/vouchers?state=all', '/api/finance/budgets', '/api/finance/settings', ...['income', 'balance', 'trial', 'cash', 'dues',
      'collection', 'budget', 'daybook'].map(k => `/api/finance/reports/${k}`), `/api/finance/accounts/${bank.id}/reconcile`]) ok(await C.admin.get(p));
});
