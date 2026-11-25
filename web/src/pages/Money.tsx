// Finance: the treasurer's books, owners' dues, billing, vouchers, the bank and reports.
import { useEffect, useState } from 'react';
import { api, rupees, shortDate } from '../api.ts';
import { can, useApp, type Me } from '../main.tsx';
import { ErrorNote, Link, Loading, navigate, PageHead, Sheet, useAction, useApi, usePath } from '../ui.tsx';
import type { TreeNode } from './Home.tsx';

export const seesBooks = (me: Me) => can(me, 'finance.view') || can(me, 'finance.manage');
export const keepsBooks = (me: Me) => can(me, 'finance.manage');
export const preparesVouchers = (me: Me) => can(me, 'finance.prepare') || can(me, 'finance.manage');
const MODES: Record<string, string> = { upi: 'UPI', neft: 'NEFT', imps: 'IMPS', rtgs: 'RTGS', cheque: 'Cheque', cash: 'Cash', card: 'Card', other: 'Other' };
const KIND: Record<string, string> = { opening: 'Opening', receipt: 'Receipt', payment: 'Payment', transfer: 'Transfer', charge: 'Charge', journal: 'Journal', reversal: 'Reversal' };
const TYPE: Record<string, string> = { asset: 'Asset', liability: 'Liability', funds: 'Fund', income: 'Income', expense: 'Expense' };
const FREQ: Record<string, string> = { monthly: 'Monthly', quarterly: 'Quarterly', half_yearly: 'Every six months', annually: 'Yearly', once: 'Once' };
const AREA: Record<string, string> = { carpet_sqft: 'Carpet area', builtup_sqft: 'Built-up area', super_sqft: 'Super built-up area', plot_sqft: 'Plot area', uds_sqft: 'UDS' };
const CATS: Record<string, string> = { apartment: 'Apartments', villa: 'Villas', row_house: 'Row houses', plot: 'Plots', commercial: 'Shops and offices', other: 'Other' };
const VSTATE: Record<string, string> = { awaiting_approval: 'Waiting for approval', to_pay: 'Approved, to pay', paid: 'Paid', cancelled: 'Cancelled', rejected: 'Not approved',
  withdrawn: 'Withdrawn' };
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const rs = (p: number | string | null | undefined) => rupees(p ?? 0) || '₹0';
const signed = (p: number) => p < 0 ? `${rs(-p)} advance` : rs(p);

function useAccounts() {
  const { data } = useApi<any[]>('/api/finance/accounts');
  const all = data ?? [];
  return { all, cash: all.filter(a => a.cash_kind && !a.archived_at), of: (...types: string[]) => all.filter(a => types.includes(a.type) && !a.cash_kind && !a.archived_at
    && a.system_key !== 'receivables') };
}
function AccountSelect({ label, value, onChange, accounts, none }: { label: string; value: string; onChange: (v: string) => void; accounts: any[]; none?: string }) {
  return <label className="field">{label}<select value={value} onChange={e => onChange(e.target.value)} required={!none}>
    <option value="">{none ?? 'Choose…'}</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.cash_kind ? a.name : `${a.code} ${a.name}`}</option>)}</select></label>;
}
function ModeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <label className="field">How it was paid<select value={value} onChange={e => onChange(e.target.value)}>
    {Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>;
}

export function MoneyTabs() {
  const { me } = useApp();
  const path = usePath().split('?')[0];
  const tabs = [['/money', 'Overview'], ...(seesBooks(me) ? [['/money/dues', 'Dues'], ['/money/billing', 'Billing']] : []), ['/money/vouchers', 'Vouchers'],
    ...(seesBooks(me) ? [['/money/bank', 'Bank and cash'], ['/money/reports', 'Reports'], ['/money/settings', 'Settings']] : [])];
  return <nav className="tabs" aria-label="Finance">
    {tabs.map(([to, label]) => <Link key={to} to={to} className="button" aria-current={(to === '/money' ? path === to : path.startsWith(to)) ? 'page' : undefined}>{label}</Link>)}
  </nav>;
}

// ================================================================ overview
export function MoneyHome() {
  const { me } = useApp();
  const { data: d, loading, error, reload } = useApi('/api/finance/overview');
  const [sheet, setSheet] = useState<null | 'receipt' | 'payment' | 'transfer'>(null);
  if (!seesBooks(me) && !preparesVouchers(me)) { navigate('/dues'); return null; }
  if (loading && !d) return <><PageHead title="Money" /><MoneyTabs /><Loading /></>;
  if (error) return <ErrorNote error={error} />;
  const cashTotal = (d.cash ?? []).reduce((s: number, a: any) => s + a.balance, 0);
  return <>
    <PageHead title="Money">{keepsBooks(me) && <div className="actions">
      <button className="primary" onClick={() => setSheet('receipt')}>Record money received</button>
      <button onClick={() => setSheet('payment')}>Record a payment</button>
      <button onClick={() => setSheet('transfer')}>Transfer</button></div>}</PageHead>
    <MoneyTabs />
    {d.cash && <section>
      <header><h2>Cash and bank</h2><span className="quiet">{rs(cashTotal)} in all</span></header>
      <div className="ops-tiles">{d.cash.map((a: any) => <Link key={a.id} to={`/money/bank/${a.id}`} className="tile">
        <span className="big num money-big">{rs(a.balance)}</span><span>{a.name}{a.last4 ? ` ··${a.last4}` : ''}</span>
        <span className={a.kind === 'bank' && !a.reconciledThrough ? 'stop' : 'quiet'}>{a.kind === 'cash' ? 'Cash in hand'
          : a.reconciledThrough ? `Matched with the bank up to ${shortDate(a.reconciledThrough)}` : 'Not yet matched with the bank'}</span></Link>)}
        {!d.cash.length && <p className="quiet">No bank or cash accounts yet. Add them under Bank and cash.</p>}</div>
    </section>}
    {d.dues && <section>
      <header><h2>Dues</h2><Link to="/money/dues">All homes</Link></header>
      <div className="ops-tiles">
        <Link to="/money/dues" className="tile"><span className="big num money-big">{rs(d.dues.outstanding)}</span><span>owed by {d.dues.homes} homes</span>
          <span className={d.dues.over90 ? 'stop' : 'quiet'}>{d.dues.over90 ? `${rs(d.dues.over90)} overdue by more than 90 days` : `${rs(d.dues.overdue)} overdue`}</span></Link>
        <div className="tile"><span className="big num money-big">{rs(d.month.collected)}</span><span>collected this month</span>
          <span className="quiet">{rs(d.month.billed)} billed this month</span></div>
        {d.claims > 0 && <Link to="/money/dues" className="tile"><span className="big num">{d.claims}</span><span>payments reported by owners</span>
          <span className="stop">To check against the bank</span></Link>}
        {d.dues.advance > 0 && <div className="tile"><span className="big num money-big">{rs(d.dues.advance)}</span><span>paid in advance</span></div>}
      </div>
    </section>}
    <section>
      <header><h2>Vouchers</h2><Link to="/money/vouchers">All vouchers</Link></header>
      <div className="ops-tiles">
        <Link to="/money/vouchers" className="tile"><span className="big num">{d.vouchers.awaiting_approval}</span><span>waiting for approval</span></Link>
        <Link to="/money/vouchers?state=to_pay" className="tile"><span className="big num">{d.vouchers.to_pay}</span><span>approved, to pay</span>
          <span className="quiet">{rs(d.vouchers.to_pay_paise)}</span></Link>
      </div>
    </section>
    {d.year && <section>
      <header><h2>This financial year</h2><span className="quiet">{d.fy.label}{d.closedThrough ? `. Books closed up to ${shortDate(d.closedThrough)}` : ''}</span></header>
      <dl className="facts">
        <div><dt>Income</dt><dd>{rs(d.year.income)}</dd></div>
        <div><dt>Expenditure</dt><dd>{rs(d.year.expense)}</dd></div>
        <div><dt>{d.year.surplus >= 0 ? 'Surplus' : 'Deficit'}</dt><dd className={d.year.surplus < 0 ? 'stop' : ''}>{rs(Math.abs(d.year.surplus))}</dd></div>
        {d.funds.filter((f: any) => f.balance).map((f: any) => <div key={f.name}><dt>{f.name}</dt><dd>{rs(f.balance)}</dd></div>)}
      </dl>
    </section>}
    {sheet === 'receipt' && <Sheet open onClose={() => setSheet(null)} title="Money received"><ReceiptForm onDone={() => { setSheet(null); reload(); }} /></Sheet>}
    {sheet === 'payment' && <Sheet open onClose={() => setSheet(null)} title="Record a payment"><PaymentForm onDone={() => { setSheet(null); reload(); }} /></Sheet>}
    {sheet === 'transfer' && <Sheet open onClose={() => setSheet(null)} title="Move money between accounts"><TransferForm onDone={() => { setSheet(null); reload(); }} /></Sheet>}
  </>;
}

function ReceiptForm({ unit, onDone }: { unit?: { id: string; label: string }; onDone: () => void }) {
  const acc = useAccounts();
  const [f, setF] = useState({ forHome: true, unitLabel: unit?.label ?? '', unitId: unit?.id ?? '', creditAccountId: '', accountId: '', amount: '', date: todayIST(),
    mode: 'upi', reference: '', narration: '' });
  const units = useApi<any>(f.forHome && !unit && f.unitLabel.length >= 2 ? `/api/finance/dues?q=${encodeURIComponent(f.unitLabel)}` : null);
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    await api.post('/api/finance/receipts', { date: f.date, accountId: f.accountId, amount: f.amount, mode: f.mode, reference: f.reference || null,
      narration: f.narration || undefined, unitId: f.forHome ? f.unitId : null, creditAccountId: f.forHome ? null : f.creditAccountId });
    onDone();
  }); }}>
    {!unit && <div className="tabs" role="radiogroup">{[[true, 'From a home'], [false, 'Anything else']].map(([v, l]) =>
      <button type="button" key={String(v)} aria-pressed={f.forHome === v} onClick={() => setF({ ...f, forHome: v as boolean })}>{l as string}</button>)}</div>}
    {f.forHome && !unit && <label className="field">Home<input value={f.unitLabel} onChange={e => setF({ ...f, unitLabel: e.target.value, unitId: '' })} placeholder="Type the home number" />
      {units.data?.rows?.length > 0 && !f.unitId && <div className="rows picks">{units.data.rows.slice(0, 6).map((u: any) =>
        <button type="button" key={u.id} className="row" onClick={() => setF({ ...f, unitId: u.id, unitLabel: u.label, amount: u.balance > 0 ? String(u.balance / 100) : f.amount })}>
          <span><span className="title">{u.label}</span><br /><span className="meta">{u.owners}</span></span><span className="side num">{signed(u.balance)}</span></button>)}</div>}</label>}
    {unit && <p className="quiet">For {unit.label}.</p>}
    {!f.forHome && <AccountSelect label="What it is for" value={f.creditAccountId} onChange={v => setF({ ...f, creditAccountId: v })} accounts={acc.of('income', 'funds', 'liability', 'asset')} />}
    <div className="two">
      <AccountSelect label="Into" value={f.accountId} onChange={v => setF({ ...f, accountId: v })} accounts={acc.cash} />
      <label className="field">Amount, ₹<input required inputMode="decimal" value={f.amount} onChange={set('amount')} /></label>
      <label className="field">Date<input type="date" required max={todayIST()} value={f.date} onChange={set('date')} /></label>
      <ModeSelect value={f.mode} onChange={v => setF({ ...f, mode: v })} />
    </div>
    {f.mode !== 'cash' && <label className="field">UTR, cheque or transaction number<input value={f.reference} onChange={set('reference')} required /></label>}
    <label className="field">Narration (optional)<input value={f.narration} onChange={set('narration')} /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy || (f.forHome && !f.unitId)}>Record</button></div>
  </form>;
}

function PaymentForm({ onDone }: { onDone: () => void }) {
  const acc = useAccounts();
  const [f, setF] = useState({ accountId: '', debitAccountId: '', amount: '', date: todayIST(), mode: 'neft', reference: '', narration: '' });
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    await api.post('/api/finance/payments', { ...f, reference: f.reference || null }); onDone(); }); }}>
    <p className="quiet">For bank charges, refunds and the like. Payments to vendors go through a voucher so the committee approves them.</p>
    <div className="two">
      <AccountSelect label="From" value={f.accountId} onChange={v => setF({ ...f, accountId: v })} accounts={acc.cash} />
      <AccountSelect label="For" value={f.debitAccountId} onChange={v => setF({ ...f, debitAccountId: v })} accounts={acc.of('expense', 'liability', 'asset', 'funds')} />
      <label className="field">Amount, ₹<input required inputMode="decimal" value={f.amount} onChange={set('amount')} /></label>
      <label className="field">Date<input type="date" required max={todayIST()} value={f.date} onChange={set('date')} /></label>
      <ModeSelect value={f.mode} onChange={v => setF({ ...f, mode: v })} />
      <label className="field">Reference<input value={f.reference} onChange={set('reference')} /></label>
    </div>
    <label className="field">Narration<input required value={f.narration} onChange={set('narration')} /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Record payment</button></div>
  </form>;
}

function TransferForm({ onDone }: { onDone: () => void }) {
  const acc = useAccounts();
  const [f, setF] = useState({ fromId: '', toId: '', amount: '', date: todayIST(), reference: '' });
  const { busy, error, run } = useAction();
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    await api.post('/api/finance/transfers', { ...f, reference: f.reference || null }); onDone(); }); }}>
    <div className="two">
      <AccountSelect label="From" value={f.fromId} onChange={v => setF({ ...f, fromId: v })} accounts={acc.cash} />
      <AccountSelect label="To" value={f.toId} onChange={v => setF({ ...f, toId: v })} accounts={acc.cash} />
      <label className="field">Amount, ₹<input required inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
      <label className="field">Date<input type="date" required max={todayIST()} value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></label>
    </div>
    <label className="field">Reference (optional)<input value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Transfer</button></div>
  </form>;
}

// ================================================================ dues
function Ageing({ b }: { b: any }) {
  const parts = [['current', 'Not yet due'], ['d30', '1–30 days'], ['d60', '31–60'], ['d90', '61–90'], ['over90', 'Over 90']].filter(([k]) => b[k] > 0);
  const total = parts.reduce((s, [k]) => s + b[k], 0);
  if (!total) return null;
  return <span className="ageing" role="img" aria-label={parts.map(([k, l]) => `${l}: ${rs(b[k])}`).join(', ')}>
    {parts.map(([k]) => <i key={k} className={`age-${k}`} style={{ width: `${(b[k] / total) * 100}%` }} />)}</span>;
}

export function DuesList() {
  const tree = useApi<{ nodes: TreeNode[] }>('/api/property/tree');
  const [q, setQ] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [owing, setOwing] = useState(true);
  const { data, loading, error, reload } = useApi(`/api/finance/dues?${new URLSearchParams({ ...(q ? { q } : {}), ...(nodeId ? { nodeId } : {}), owing: owing ? '1' : '' })}`);
  const places = (tree.data?.nodes ?? []).filter(n => n.depth === 1 || (n.depth === 2 && (tree.data?.nodes ?? []).some(p => p.id === n.parent_id && p.kind === 'phase')));
  return <>
    <PageHead title="Dues" />
    <MoneyTabs />
    <Claims onChange={reload} />
    <div className="head-row" style={{ alignItems: 'end' }}>
      <input className="search" type="search" placeholder="Home number or owner's name" value={q} onChange={e => setQ(e.target.value)} />
      <div className="actions">
        {places.length > 0 && <select value={nodeId} onChange={e => setNodeId(e.target.value)} aria-label="Place" style={{ width: 'auto' }}>
          <option value="">Whole community</option>{places.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select>}
        <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" checked={owing} onChange={e => setOwing(e.target.checked)} />Only homes that owe</label>
      </div>
    </div>
    <ErrorNote error={error} />
    {data && <p className="quiet">{rs(data.totals.outstanding)} owed{data.totals.advance ? `; ${rs(data.totals.advance)} paid in advance` : ''}. Payments settle the oldest charges first.</p>}
    {loading && !data ? <Loading /> : <div className="rows">{data.rows.length ? data.rows.slice(0, 400).map((u: any) => <Link key={u.id} to={`/money/units/${u.id}`} className="row">
      <span><span className="title">{u.label}</span><br /><span className="meta">{u.owners || 'No owner recorded'}. {u.place}</span></span>
      <span className="side"><span className={`num ${u.buckets.over90 ? 'stop' : ''}`}>{signed(u.balance)}</span><br /><Ageing b={u.buckets} /></span>
    </Link>) : <p className="empty">{owing ? 'No home owes anything.' : 'No homes found.'}</p>}</div>}
    <p className="legend"><span><i className="age-current" />Not yet due</span><span><i className="age-d30" />1–30 days overdue</span><span><i className="age-d60" />31–60</span>
      <span><i className="age-d90" />61–90</span><span><i className="age-over90" />Over 90 days</span></p>
  </>;
}

function Claims({ onChange }: { onChange: () => void }) {
  const { me } = useApp();
  const { data, reload } = useApi<any[]>('/api/finance/claims');
  const acc = useAccounts();
  const [open, setOpen] = useState<any>(null);
  const [accountId, setAccountId] = useState('');
  const [note, setNote] = useState('');
  const act = useAction();
  if (!data?.length) return null;
  const done = () => { setOpen(null); setNote(''); reload(); onChange(); };
  return <section className="panel pad">
    <header><h2>Payments reported by owners</h2><span className="quiet">Check each against the bank before confirming</span></header>
    <div className="rows">{data.map(c => <div key={c.id} className="row">
      <span><span className="title">{c.label}: {rs(c.amount_paise)}</span><br />
        <span className="meta">{c.person}, paid {shortDate(c.paid_on)} by {MODES[c.mode]}, ref {c.reference}{c.note ? `. “${c.note}”` : ''}
          {c.file_id && <>. <a href={`/api/files/${c.file_id}`}>Screenshot</a></>}</span></span>
      <span className="side">{keepsBooks(me) && <button onClick={() => setOpen(c)}>Check</button>}</span></div>)}</div>
    {open && <Sheet open onClose={() => setOpen(null)} title={`${open.label}: ${rs(open.amount_paise)}`}>
      <p className="quiet">Reported by {open.person}: paid on {shortDate(open.paid_on)} by {MODES[open.mode]}, reference <strong>{open.reference}</strong>.</p>
      <AccountSelect label="Received into" value={accountId} onChange={setAccountId} accounts={acc.cash} />
      <ErrorNote error={act.error} />
      <button className="primary" disabled={act.busy || !accountId} onClick={() => act.run(async () => {
        await api.post(`/api/finance/claims/${open.id}/confirm`, { accountId }); done(); })}>It's in the bank: confirm</button>
      <label className="field">Or, if it is not in the bank, tell the owner why<textarea value={note} onChange={e => setNote(e.target.value)} /></label>
      <button disabled={act.busy || !note.trim()} onClick={() => act.run(async () => { await api.post(`/api/finance/claims/${open.id}/reject`, { note }); done(); })}>Not found</button>
    </Sheet>}
  </section>;
}

export function UnitStatement({ id }: { id: string }) {
  const { me } = useApp();
  const { data: d, loading, error, reload } = useApi(`/api/finance/units/${id}/statement`);
  const [sheet, setSheet] = useState<null | 'receipt' | 'charge'>(null);
  if (loading && !d) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const bal = d.dues?.balance ?? 0;
  return <>
    <PageHead title={`${d.unit.label}: dues`} crumbs={[{ to: '/money/dues', label: 'Dues' }, { label: d.unit.label }]}>
      {keepsBooks(me) && <div className="actions"><button className="primary" onClick={() => setSheet('receipt')}>Record a payment</button>
        <button onClick={() => setSheet('charge')}>Add a charge</button></div>}
    </PageHead>
    <dl className="facts">
      <div><dt>{bal < 0 ? 'Paid in advance' : 'Owed now'}</dt><dd className={bal > 0 ? 'stop' : ''}>{rs(Math.abs(bal))}</dd></div>
      {d.dues && Object.entries({ current: 'Not yet due', d30: '1–30 days overdue', d60: '31–60', d90: '61–90', over90: 'Over 90' }).filter(([k]) => d.dues.buckets[k] > 0)
        .map(([k, l]) => <div key={k}><dt>{l}</dt><dd>{rs(d.dues.buckets[k])}</dd></div>)}
    </dl>
    <Statement lines={d.lines} />
    {sheet === 'receipt' && <Sheet open onClose={() => setSheet(null)} title={`Payment from ${d.unit.label}`}><ReceiptForm unit={d.unit} onDone={() => { setSheet(null); reload(); }} /></Sheet>}
    {sheet === 'charge' && <Sheet open onClose={() => setSheet(null)} title={`Charge ${d.unit.label}`}><ChargeForm unit={d.unit} onDone={() => { setSheet(null); reload(); }} /></Sheet>}
  </>;
}

function Statement({ lines }: { lines: any[] }) {
  if (!lines.length) return <p className="empty rows">Nothing charged or paid yet.</p>;
  return <div className="table-wrap"><table className="grid">
    <thead><tr><th>Date</th><th>What</th><th className="num">Charged</th><th className="num">Paid</th><th className="num">Balance</th></tr></thead>
    <tbody>{lines.map((l: any, i: number) => <tr key={i}>
      <td>{shortDate(l.txn_date)}</td>
      <td>{l.narration}<br /><span className="quiet">{l.ref}{l.reference ? `, ${l.reference}` : ''}{l.due_on && Number(l.charged) > 0 ? `. Due ${shortDate(l.due_on)}` : ''}{l.memo ? `. ${l.memo}` : ''}</span></td>
      <td className="num">{Number(l.charged) ? rs(l.charged) : ''}</td><td className="num">{Number(l.paid) ? rs(l.paid) : ''}</td>
      <td className="num">{signed(Number(l.balance))}</td></tr>)}</tbody></table></div>;
}

function ChargeForm({ unit, onDone }: { unit: any; onDone: () => void }) {
  const acc = useAccounts();
  const [f, setF] = useState({ accountId: '', amount: '', date: todayIST(), dueOn: '', narration: '' });
  const { busy, error, run } = useAction();
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    await api.post('/api/finance/charges', { unitId: unit.id, ...f, dueOn: f.dueOn || undefined }); onDone(); }); }}>
    <AccountSelect label="For" value={f.accountId} onChange={v => setF({ ...f, accountId: v })} accounts={acc.of('income', 'funds', 'liability')} />
    <div className="two">
      <label className="field">Amount, ₹<input required inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
      <label className="field">Date<input type="date" required max={todayIST()} value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></label>
      <label className="field">Due by<input type="date" value={f.dueOn} onChange={e => setF({ ...f, dueOn: e.target.value })} /></label>
    </div>
    <label className="field">What it is<input required value={f.narration} onChange={e => setF({ ...f, narration: e.target.value })} placeholder="For example, late payment charge for October" /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Add charge</button></div>
  </form>;
}

// ================================================================ owners: my dues
export function MyDues() {
  const { community } = useApp();
  const { data: d, loading, error, reload } = useApi('/api/my/dues');
  const [pay, setPay] = useState<any>(null);
  if (loading && !d) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  return <>
    <PageHead title="My dues" />
    {!d.homes.length && <p className="note">Your association office will link your home to your account; then your dues show here.</p>}
    {d.homes.map((h: any) => {
      const bal = h.dues?.balance ?? 0;
      const upi = d.howToPay.upi && bal > 0
        ? `upi://pay?pa=${encodeURIComponent(d.howToPay.upi)}&pn=${encodeURIComponent(community.brandName)}&am=${(bal / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`Maintenance ${h.unit.label}`)}` : null;
      return <section key={h.unit.id} className="panel pad">
        <header><h2>{h.unit.label}</h2>{h.dues?.oldest_due && bal > 0 && <span className="quiet">Oldest unpaid charge was due {shortDate(h.dues.oldest_due)}</span>}</header>
        <p className="amount">{bal > 0 ? rs(bal) : bal < 0 ? `${rs(-bal)} in advance` : 'Nothing due'}</p>
        <div className="actions">
          {upi && <a className="button primary" href={upi}>Pay {rs(bal)} by UPI</a>}
          <button onClick={() => setPay(h)}>I have paid</button>
        </div>
        {h.lines.length > 0 && <details><summary className="quiet">Recent charges and payments</summary><Statement lines={[...h.lines].reverse()} /></details>}
      </section>;
    })}
    {(d.howToPay.upi || d.howToPay.instructions) && <section>
      <header><h2>How to pay</h2></header>
      {d.howToPay.upi && <p>UPI: <strong>{d.howToPay.upi}</strong></p>}
      {d.howToPay.instructions && <p style={{ whiteSpace: 'pre-wrap', maxWidth: '68ch' }}>{d.howToPay.instructions}</p>}
      <p className="quiet">After paying, tap "I have paid" with the UTR or cheque number, so the treasurer can match it.</p>
    </section>}
    {d.claims.length > 0 && <section><header><h2>Payments you reported</h2></header>
      <div className="rows">{d.claims.map((c: any) => <div key={c.id} className="row">
        <span><span className="title">{c.label}: {rs(c.amount_paise)}</span><br /><span className="meta">Paid {shortDate(c.paid_on)}, ref {c.reference}
          {c.status === 'rejected' ? `. Not found: ${c.decision_note}` : ''}</span></span>
        <span className="side"><span className={`tag ${c.status === 'confirmed' ? 'day-done' : c.status === 'rejected' ? 'w-overdue' : 'w-open'}`}>
          {c.status === 'confirmed' ? 'Received' : c.status === 'rejected' ? 'Not found' : 'Being checked'}</span></span></div>)}</div></section>}
    {pay && <Sheet open onClose={() => setPay(null)} title={`Payment for ${pay.unit.label}`}><ClaimForm home={pay} onDone={() => { setPay(null); reload(); }} /></Sheet>}
  </>;
}

function ClaimForm({ home, onDone }: { home: any; onDone: () => void }) {
  const [f, setF] = useState({ amount: home.dues?.balance > 0 ? String(home.dues.balance / 100) : '', paidOn: todayIST(), mode: 'upi', reference: '', note: '' });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const fileId = file ? (await api.upload('/api/files?purpose=payment_proof', file)).id : null;
    await api.post('/api/my/claims', { unitId: home.unit.id, ...f, fileId }); onDone(); }); }}>
    <div className="two">
      <label className="field">Amount paid, ₹<input required inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
      <label className="field">Paid on<input type="date" required max={todayIST()} value={f.paidOn} onChange={e => setF({ ...f, paidOn: e.target.value })} /></label>
      <ModeSelect value={f.mode} onChange={v => setF({ ...f, mode: v })} />
      <label className="field">UTR or cheque number<input required minLength={3} value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} /></label>
    </div>
    <label className="field">Screenshot (optional)<input type="file" accept="image/*,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
    <label className="field">Note (optional)<input value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Send to the treasurer</button></div>
  </form>;
}

// ================================================================ billing
export function Billing() {
  const { me } = useApp();
  const plans = useApi<any[]>('/api/finance/plans');
  const runs = useApi<any[]>('/api/finance/runs');
  const [sheet, setSheet] = useState<null | 'plan' | 'run'>(null);
  const [edit, setEdit] = useState<any>(null);
  return <>
    <PageHead title="Billing">{keepsBooks(me) && <div className="actions">
      <button className="primary" onClick={() => setSheet('run')} disabled={!plans.data?.some(p => p.active)}>Bill homes</button>
      <button onClick={() => { setEdit(null); setSheet('plan'); }}>New billing plan</button></div>}</PageHead>
    <MoneyTabs />
    <section>
      <header><h2>Billing plans</h2><span className="quiet">What each home is charged, and how often</span></header>
      {plans.loading && !plans.data ? <Loading /> : <div className="rows">{plans.data?.length ? plans.data.map(p => <button key={p.id} className="row" onClick={() => { if (keepsBooks(me)) { setEdit(p); setSheet('plan'); } }}>
        <span><span className="title">{p.name}</span>{!p.active && <span className="tag" style={{ marginLeft: 8 }}>Off</span>}<br />
          <span className="meta">{FREQ[p.frequency]}. {p.basis === 'area' ? `${rs(p.rate_paise)} per sq ft of ${AREA[p.area_field].toLowerCase()}` : p.basis === 'flat' ? `${rs(p.rate_paise)} per home`
            : 'By kind of home'}. {p.place}; {p.categories.map((c: string) => CATS[c].toLowerCase()).join(', ')}. To {p.account_code} {p.account}.</span></span>
        <span className="side quiet">{p.last_billed ? `Last billed ${shortDate(p.last_billed)}` : 'Not billed yet'}</span></button>)
        : <p className="empty">No billing plans yet. A plan says what each home pays: by area, by kind of home, or the same for all.</p>}</div>}
    </section>
    <section>
      <header><h2>Bills issued</h2></header>
      {runs.loading && !runs.data ? <Loading /> : <div className="rows">{runs.data?.length ? runs.data.map(r => <Link key={r.id} to={`/money/runs/${r.id}`} className="row">
        <span><span className="title">{r.plan}: {r.period_label}</span><br /><span className="meta">{r.ref}. Issued {shortDate(r.issue_on)}, due {shortDate(r.due_on)}. {r.units} homes</span></span>
        <span className="side"><span className="num">{rs(r.total_paise)}</span><br /><span className={`tag ${r.status === 'posted' && !r.reversed ? 'day-done' : r.status === 'draft' ? 'w-on_hold' : ''}`}>
          {r.reversed || r.status === 'cancelled' ? 'Cancelled' : r.status === 'posted' ? 'Posted' : 'Draft'}</span></span></Link>)
        : <p className="empty">No bills issued yet.</p>}</div>}
    </section>
    {sheet === 'plan' && <Sheet open onClose={() => setSheet(null)} title={edit ? `Change ${edit.name}` : 'New billing plan'}>
      <PlanForm plan={edit} onDone={() => { setSheet(null); plans.reload(); }} /></Sheet>}
    {sheet === 'run' && <Sheet open onClose={() => setSheet(null)} title="Bill homes"><RunForm plans={(plans.data ?? []).filter(p => p.active)} /></Sheet>}
  </>;
}

function PlanForm({ plan, onDone }: { plan: any; onDone: () => void }) {
  const acc = useAccounts();
  const tree = useApi<{ nodes: TreeNode[] }>('/api/property/tree');
  const types = useApi<any[]>('/api/unit-types');
  const [f, setF] = useState(() => ({ name: plan?.name ?? '', frequency: plan?.frequency ?? 'monthly', basis: plan?.basis ?? 'area', areaField: plan?.area_field ?? 'super_sqft',
    rate: plan?.rate_paise ? String(Number(plan.rate_paise) / 100) : '', scopeNodeId: plan?.scope_node_id ?? '', categories: (plan?.categories ?? ['apartment', 'villa', 'row_house', 'plot']) as string[],
    accountId: plan?.account_id ?? '', dueDays: String(plan?.due_days ?? 15), active: plan?.active ?? true,
    unitTypeRates: Object.fromEntries(Object.entries(plan?.unit_type_rates ?? {}).map(([k, v]) => [k, String(Number(v) / 100)])) as Record<string, string> }));
  const { busy, error, run } = useAction();
  useEffect(() => { if (!f.scopeNodeId && tree.data) setF(x => ({ ...x, scopeNodeId: tree.data!.nodes.find(n => n.parent_id === null)?.id ?? '' })); }, [tree.data]);
  useEffect(() => { if (!f.accountId && acc.all.length) setF(x => ({ ...x, accountId: acc.all.find(a => a.system_key === 'maintenance')?.id ?? '' })); }, [acc.all.length]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const places = (tree.data?.nodes ?? []).filter(n => n.in_scope && n.kind !== 'floor');
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const body = { ...f, dueDays: Number(f.dueDays), rate: f.basis === 'unit_type' ? null : f.rate, areaField: f.basis === 'area' ? f.areaField : null };
    if (plan) await api.patch(`/api/finance/plans/${plan.id}`, body); else await api.post('/api/finance/plans', body);
    onDone(); }); }}>
    <label className="field">Name<input required value={f.name} onChange={set('name')} placeholder="For example, Monthly maintenance, Sky Towers" /></label>
    <div className="two">
      <label className="field">How often<select value={f.frequency} onChange={set('frequency')}>{Object.entries(FREQ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">Charged by<select value={f.basis} onChange={set('basis')}><option value="area">Area</option><option value="unit_type">Kind of home</option>
        <option value="flat">The same for every home</option></select></label>
      {f.basis === 'area' && <label className="field">Which area<select value={f.areaField} onChange={set('areaField')}>{Object.entries(AREA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
      {f.basis !== 'unit_type' && <label className="field">{f.basis === 'area' ? 'Rate per sq ft for each bill, ₹' : 'Amount per home for each bill, ₹'}
        <input required inputMode="decimal" value={f.rate} onChange={set('rate')} /></label>}
    </div>
    {f.basis === 'unit_type' && <fieldset className="panel pad form"><legend>Amount for each bill, ₹</legend><div className="two">
      {(types.data ?? []).map(t => <label key={t.id} className="field">{t.name}<input inputMode="decimal" value={f.unitTypeRates[t.id] ?? ''}
        onChange={e => setF({ ...f, unitTypeRates: { ...f.unitTypeRates, [t.id]: e.target.value } })} /></label>)}</div></fieldset>}
    <div className="two">
      <label className="field">Which homes<select value={f.scopeNodeId} onChange={set('scopeNodeId')}>{places.map(n => <option key={n.id} value={n.id}>{'  '.repeat(n.depth)}{n.name}</option>)}</select>
        <span className="hint">Choose one block or phase for costs only its homes share.</span></label>
      <AccountSelect label="Credited to" value={f.accountId} onChange={v => setF({ ...f, accountId: v })} accounts={acc.of('income', 'funds')} />
      <label className="field">Days to pay<input type="number" min={0} max={120} value={f.dueDays} onChange={set('dueDays')} /></label>
    </div>
    <div className="field"><span>Kinds of home charged</span><div className="tabs" role="group">{Object.entries(CATS).map(([k, v]) =>
      <button type="button" key={k} aria-pressed={f.categories.includes(k)} onClick={() => setF({ ...f, categories: f.categories.includes(k) ? f.categories.filter(c => c !== k) : [...f.categories, k] })}>{v}</button>)}</div></div>
    {plan && <label className="check"><input type="checkbox" checked={f.active} onChange={set('active')} />In use</label>}
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>{plan ? 'Save' : 'Create plan'}</button></div>
  </form>;
}

function RunForm({ plans }: { plans: any[] }) {
  const now = todayIST();
  const month = new Date(now + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const [f, setF] = useState({ planId: plans[0]?.id ?? '', periodLabel: month, issueOn: now, dueOn: '' });
  const { busy, error, run } = useAction();
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const r = await api.post('/api/finance/runs', { ...f, dueOn: f.dueOn || undefined }); navigate(`/money/runs/${r.id}`); }); }}>
    <label className="field">Billing plan<select value={f.planId} onChange={e => setF({ ...f, planId: e.target.value })}>{plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <div className="two">
      <label className="field">For the period<input required value={f.periodLabel} onChange={e => setF({ ...f, periodLabel: e.target.value })} /></label>
      <label className="field">Issue date<input type="date" required value={f.issueOn} onChange={e => setF({ ...f, issueOn: e.target.value })} /></label>
      <label className="field">Due date (optional)<input type="date" value={f.dueOn} onChange={e => setF({ ...f, dueOn: e.target.value })} /></label>
    </div>
    <p className="quiet">This prepares a draft. Check the amounts, then post it to the books.</p>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy || !f.planId}>Prepare bills</button></div>
  </form>;
}

export function RunView({ id }: { id: string }) {
  const { data: r, loading, error, reload } = useApi(`/api/finance/runs/${id}`);
  const act = useAction();
  const [q, setQ] = useState('');
  if (loading && !r) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const lines = r.lines.filter((l: any) => !q || l.label.toLowerCase().includes(q.toLowerCase()));
  return <>
    <PageHead title={`${r.plan}: ${r.period_label}`} crumbs={[{ to: '/money/billing', label: 'Billing' }, { label: r.ref }]}>
      <span className={`tag ${r.status === 'posted' ? 'day-done' : r.status === 'draft' ? 'w-on_hold' : ''}`}>{r.status === 'posted' ? 'Posted' : r.status === 'draft' ? 'Draft' : 'Cancelled'}</span>
    </PageHead>
    <dl className="facts">
      <div><dt>Homes charged</dt><dd>{r.units}</dd></div><div><dt>Total</dt><dd>{rs(r.total_paise)}</dd></div>
      <div><dt>Issued</dt><dd>{shortDate(r.issue_on)}</dd></div><div><dt>Due</dt><dd>{shortDate(r.due_on)}</dd></div>
      {r.journal_ref && <div><dt>In the books as</dt><dd>{r.journal_ref}</dd></div>}
    </dl>
    {r.skipped.length > 0 && <div className="checks"><p>{r.skipped.length} home{r.skipped.length > 1 ? 's were' : ' was'} left out:</p>
      <ul>{r.skipped.slice(0, 12).map((s: any) => <li key={s.label}>{s.label}: {s.reason}</li>)}{r.skipped.length > 12 && <li>and {r.skipped.length - 12} more</li>}</ul></div>}
    {r.canPost && <div className="actions">
      <button className="primary" disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/api/finance/runs/${id}/post`, {}); reload(); })}>Post {rs(r.total_paise)} to the books</button>
      <button disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/api/finance/runs/${id}/cancel`, {}); navigate('/money/billing'); })}>Discard draft</button>
    </div>}
    <ErrorNote error={act.error} />
    <input className="search" type="search" placeholder="Find a home" value={q} onChange={e => setQ(e.target.value)} />
    <div className="rows">{lines.slice(0, 500).map((l: any) => <div key={l.unit_id} className="row">
      <span><span className="title">{l.label}</span><br /><span className="meta">{l.basis}. {l.place}</span></span><span className="side num">{rs(l.amount_paise)}</span></div>)}</div>
  </>;
}

// ================================================================ vouchers
export function Vouchers() {
  const { me } = useApp();
  const [state, setState] = useState(new URLSearchParams(location.search).get('state') ?? 'open');
  const { data, loading, error } = useApi<any[]>(`/api/finance/vouchers?state=${state}`);
  const [add, setAdd] = useState(false);
  return <>
    <PageHead title="Vouchers">{preparesVouchers(me) && <button className="primary" onClick={() => setAdd(true)}>New voucher</button>}</PageHead>
    <MoneyTabs />
    <div className="tabs" role="group">{[['open', 'Open'], ['to_pay', 'Approved, to pay'], ['paid', 'Paid'], ['all', 'All']].map(([k, l]) =>
      <button key={k} aria-pressed={state === k} onClick={() => setState(k)}>{l}</button>)}</div>
    <ErrorNote error={error} />
    {loading && !data ? <Loading /> : <div className="rows">{data?.length ? data.map(v => <Link key={v.id} to={`/money/vouchers/${v.id}`} className="row">
      <span><span className="title">{v.payee}</span><br /><span className="meta">{v.ref}. {v.description}{v.work_ref ? `. For ${v.work_ref}` : ''}</span></span>
      <span className="side"><span className="num">{rs(v.amount_paise)}</span><br /><span className={`tag ${v.state === 'paid' ? 'day-done' : v.state === 'to_pay' ? 'w-open'
        : ['rejected', 'cancelled', 'withdrawn'].includes(v.state) ? '' : 'w-on_hold'}`}>{VSTATE[v.state]}</span></span></Link>)
      : <p className="empty">No vouchers here.</p>}</div>}
    {add && <Sheet open onClose={() => setAdd(false)} title="New voucher"><VoucherForm onDone={id => { setAdd(false); navigate(`/money/vouchers/${id}`); }} /></Sheet>}
  </>;
}

function VoucherForm({ onDone }: { onDone: (id: string) => void }) {
  const acc = useAccounts();
  const vendors = useApi<any[]>('/api/vendors');
  const tree = useApi<{ nodes: TreeNode[] }>('/api/property/tree');
  const qs = new URLSearchParams(location.search);
  const [f, setF] = useState({ vendorId: '', payee: '', description: '', amount: '', tds: '', accountId: '', nodeId: '', workOrderId: qs.get('work') ?? '', invoiceNo: '', invoiceDate: '' });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { if (!f.nodeId && tree.data) setF(x => ({ ...x, nodeId: tree.data!.nodes.find(n => n.parent_id === null)?.id ?? '' })); }, [tree.data]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const places = (tree.data?.nodes ?? []).filter(n => n.in_scope && n.kind !== 'floor');
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const fileId = file ? (await api.upload('/api/files?purpose=invoice', file)).id : null;
    const r = await api.post('/api/finance/vouchers', { ...f, vendorId: f.vendorId || null, payee: f.payee || undefined, tds: f.tds || null, workOrderId: f.workOrderId || null,
      invoiceNo: f.invoiceNo || null, invoiceDate: f.invoiceDate || null, fileId });
    onDone(r.id); }); }}>
    <div className="two">
      <label className="field">Pay to<select value={f.vendorId} onChange={set('vendorId')}><option value="">Someone not in the vendor list</option>
        {(vendors.data ?? []).filter(v => v.status !== 'blocked').map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      {!f.vendorId && <label className="field">Payee's name<input required value={f.payee} onChange={set('payee')} /></label>}
    </div>
    <label className="field">For<input required value={f.description} onChange={set('description')} placeholder="For example, lift AMC, October to December" /></label>
    <div className="two">
      <label className="field">Amount, ₹<input required inputMode="decimal" value={f.amount} onChange={set('amount')} /></label>
      <label className="field">TDS to deduct, ₹ (optional)<input inputMode="decimal" value={f.tds} onChange={set('tds')} /></label>
      <AccountSelect label="Expense account" value={f.accountId} onChange={v => setF({ ...f, accountId: v })} accounts={acc.of('expense', 'asset', 'liability')} />
      <label className="field">Cost of<select value={f.nodeId} onChange={set('nodeId')}>{places.map(n => <option key={n.id} value={n.id}>{'  '.repeat(n.depth)}{n.name}</option>)}</select>
        <span className="hint">A cost for one block goes to its committee under the approval rules.</span></label>
      <label className="field">Invoice number<input value={f.invoiceNo} onChange={set('invoiceNo')} /></label>
      <label className="field">Invoice date<input type="date" value={f.invoiceDate} onChange={set('invoiceDate')} /></label>
    </div>
    <label className="field">Invoice (PDF or photo)<input type="file" accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Send for approval</button></div>
  </form>;
}

export function VoucherView({ id }: { id: string }) {
  const { data: v, loading, error, reload } = useApi(`/api/finance/vouchers/${id}`);
  const acc = useAccounts();
  const [sheet, setSheet] = useState<null | 'pay' | 'cancel'>(null);
  const [f, setF] = useState({ accountId: '', date: todayIST(), mode: 'neft', reference: '', note: '' });
  const act = useAction();
  if (loading && !v) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const net = Number(v.amount_paise) - Number(v.tds_paise);
  return <>
    <PageHead title={v.payee} crumbs={[{ to: '/money/vouchers', label: 'Vouchers' }, { label: v.ref }]}><span className={`tag ${v.state === 'paid' ? 'day-done' : 'w-on_hold'}`}>{VSTATE[v.state]}</span></PageHead>
    <p className="amount">{rs(v.amount_paise)}</p>
    <dl className="facts">
      <div><dt>For</dt><dd>{v.description}</dd></div>
      <div><dt>Account</dt><dd>{v.account_code} {v.account}</dd></div>
      <div><dt>Cost of</dt><dd>{v.place}</dd></div>
      {Number(v.tds_paise) > 0 && <div><dt>TDS deducted</dt><dd>{rs(v.tds_paise)}; pay {rs(net)}</dd></div>}
      {v.invoice_no && <div><dt>Invoice</dt><dd>{v.invoice_no}{v.invoice_date ? `, ${shortDate(v.invoice_date)}` : ''}{v.file_id && <>, <a href={`/api/files/${v.file_id}`}>copy</a></>}</dd></div>}
      {v.work_ref && <div><dt>Work order</dt><dd><Link to={`/work/orders/${v.work_order_id}`}>{v.work_ref}</Link></dd></div>}
      <div><dt>Prepared by</dt><dd>{v.prepared_by_name}, {shortDate(v.created_at)}</dd></div>
      {v.approval_ref && <div><dt>Approval</dt><dd><Link to={`/approvals/${v.approval_request_id}`}>{v.approval_ref}</Link>, {v.approval_status}</dd></div>}
      {v.journal_ref && <div><dt>Paid</dt><dd>{shortDate(v.paid_on)}, {v.journal_ref}{v.paid_reference ? `, ref ${v.paid_reference}` : ''}</dd></div>}
    </dl>
    {v.cancelled_note && <p className="note">Cancelled: {v.cancelled_note}</p>}
    <div className="actions">
      {v.actions.pay && <button className="primary" onClick={() => setSheet('pay')}>Pay {rs(net)}</button>}
      {v.actions.cancel && <button onClick={() => setSheet('cancel')}>Cancel voucher</button>}
    </div>
    {sheet === 'pay' && <Sheet open onClose={() => setSheet(null)} title={`Pay ${v.payee}`}>
      <div className="two">
        <AccountSelect label="From" value={f.accountId} onChange={x => setF({ ...f, accountId: x })} accounts={acc.cash} />
        <label className="field">Date<input type="date" max={todayIST()} value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></label>
        <ModeSelect value={f.mode} onChange={x => setF({ ...f, mode: x })} />
        <label className="field">UTR or cheque number<input value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} /></label>
      </div>
      <ErrorNote error={act.error} />
      <button className="primary" disabled={act.busy || !f.accountId} onClick={() => act.run(async () => {
        await api.post(`/api/finance/vouchers/${id}/pay`, { accountId: f.accountId, date: f.date, mode: f.mode, reference: f.reference || null }); setSheet(null); reload(); })}>
        Record payment of {rs(net)}</button>
    </Sheet>}
    {sheet === 'cancel' && <Sheet open onClose={() => setSheet(null)} title="Cancel voucher">
      <label className="field">Reason<textarea value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></label>
      <ErrorNote error={act.error} />
      <button className="primary" disabled={act.busy || !f.note.trim()} onClick={() => act.run(async () => {
        await api.post(`/api/finance/vouchers/${id}/cancel`, { note: f.note }); setSheet(null); reload(); })}>Cancel voucher</button>
    </Sheet>}
  </>;
}

// ================================================================ bank and cash
export function BankList() {
  const { me } = useApp();
  const acc = useAccounts();
  const [add, setAdd] = useState(false);
  return <>
    <PageHead title="Bank and cash">{keepsBooks(me) && <button className="primary" onClick={() => setAdd(true)}>Add an account</button>}</PageHead>
    <MoneyTabs />
    <div className="rows">{acc.cash.length ? acc.cash.map(a => <Link key={a.id} to={`/money/bank/${a.id}`} className="row">
      <span><span className="title">{a.name}</span><br /><span className="meta">{a.cash_kind === 'bank' ? `${a.bank_name ?? 'Bank'}${a.account_last4 ? `, account ending ${a.account_last4}` : ''}` : 'Cash in hand'}
        {a.cash_kind === 'bank' ? `. ${a.reconciled_through ? `Matched with the bank up to ${shortDate(a.reconciled_through)}` : 'Not yet matched with the bank'}` : ''}</span></span>
      <span className="side num">{rs(a.balance)}</span></Link>) : <p className="empty">Add your bank accounts and petty cash, with their balances on the day you start.</p>}</div>
    {add && <Sheet open onClose={() => setAdd(false)} title="Add a bank or cash account"><AccountForm cash onDone={() => { setAdd(false); location.reload(); }} /></Sheet>}
  </>;
}

function AccountForm({ cash, onDone }: { cash?: boolean; onDone: () => void }) {
  const [f, setF] = useState({ name: '', cashKind: 'bank', bankName: '', last4: '', opening: '', openedOn: todayIST(), type: 'expense' });
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    await api.post('/api/finance/accounts', cash ? { name: f.name, cashKind: f.cashKind, bankName: f.bankName || null, last4: f.last4 || null, opening: f.opening || null,
      openedOn: f.openedOn } : { name: f.name, type: f.type });
    onDone(); }); }}>
    {cash && <div className="tabs" role="radiogroup">{[['bank', 'Bank account'], ['cash', 'Cash in hand']].map(([k, l]) =>
      <button type="button" key={k} aria-pressed={f.cashKind === k} onClick={() => setF({ ...f, cashKind: k })}>{l}</button>)}</div>}
    <label className="field">Name<input required value={f.name} onChange={set('name')} placeholder={cash ? 'For example, Operating account' : 'For example, Festival expenses'} /></label>
    {!cash && <label className="field">Kind<select value={f.type} onChange={set('type')}>{Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
    {cash && f.cashKind === 'bank' && <div className="two">
      <label className="field">Bank<input value={f.bankName} onChange={set('bankName')} /></label>
      <label className="field">Last 4 digits of the account<input inputMode="numeric" maxLength={4} value={f.last4} onChange={set('last4')} />
        <span className="hint">Only the last four digits are kept.</span></label></div>}
    {cash && <div className="two">
      <label className="field">Balance on the starting day, ₹<input inputMode="decimal" value={f.opening} onChange={set('opening')} /></label>
      <label className="field">Starting day<input type="date" max={todayIST()} value={f.openedOn} onChange={set('openedOn')} /></label></div>}
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Add account</button></div>
  </form>;
}

export function BankView({ id }: { id: string }) {
  const { me } = useApp();
  const { data: d, loading, error, reload } = useApi(`/api/finance/accounts/${id}/reconcile`);
  const entries = useApi<any[]>(`/api/finance/journals?accountId=${id}&limit=60`);
  const [sheet, setSheet] = useState(false);
  const act = useAction();
  if (loading && !d) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const st = d.statement;
  return <>
    <PageHead title={d.account.name} crumbs={[{ to: '/money/bank', label: 'Bank and cash' }, { label: d.account.code }]}>
      {keepsBooks(me) && d.account.cash_kind === 'bank' && !st && <button className="primary" onClick={() => setSheet(true)}>Match a bank statement</button>}
    </PageHead>
    <p className="quiet">{d.account.reconciled_through ? `Matched with the bank up to ${shortDate(d.account.reconciled_through)}; entries on or before that day are locked.` : d.account.cash_kind === 'bank' ? 'Not yet matched with a bank statement.' : 'Cash in hand.'}</p>
    {st && <section className="panel pad">
      <header><h2>Statement {shortDate(st.period_start)} to {shortDate(st.period_end)}</h2></header>
      <dl className="facts">
        <div><dt>Opening: bank / books</dt><dd className={st.checks.opening.ok ? '' : 'stop'}>{rs(st.checks.opening.statement)} / {rs(st.checks.opening.book)}</dd></div>
        <div><dt>Closing: bank / books</dt><dd className={st.checks.closing.ok ? '' : 'stop'}>{rs(st.checks.closing.statement)} / {rs(st.checks.closing.book)}</dd></div>
        <div><dt>Bank lines not matched</dt><dd className={st.checks.statementUnmatched ? 'stop' : ''}>{st.checks.statementUnmatched}</dd></div>
        <div><dt>Book entries not matched</dt><dd className={st.checks.bookUnmatched ? 'stop' : ''}>{st.checks.bookUnmatched}</dd></div>
      </dl>
      <div className="table-wrap"><table className="grid"><thead><tr><th>Bank date</th><th>Description</th><th className="num">Amount</th><th>In the books</th></tr></thead>
        <tbody>{st.lines.map((l: any) => <tr key={l.id}><td>{shortDate(l.txn_date)}</td><td>{l.description}<br /><span className="quiet">{l.reference}</span></td>
          <td className="num">{rs(l.amount_paise)}</td>
          <td>{l.matched_line_id ? <>{l.matched_ref}{keepsBooks(me) && <button className="quiet-btn" onClick={() => act.run(async () => {
            await api.post(`/api/finance/statement-lines/${l.id}/match`, { journalLineId: null }); reload(); })}>Unmatch</button>}</>
            : keepsBooks(me) ? <select aria-label="Match to an entry" value="" onChange={e => e.target.value && act.run(async () => {
              await api.post(`/api/finance/statement-lines/${l.id}/match`, { journalLineId: Number(e.target.value) }); reload(); })}>
              <option value="">Not matched: choose…</option>{st.book.filter((b: any) => !b.matched && b.amount === Number(l.amount_paise))
                .map((b: any) => <option key={b.id} value={b.id}>{b.ref}, {shortDate(b.txn_date)}</option>)}</select> : <span className="stop">Not matched</span>}</td></tr>)}</tbody></table></div>
      {st.book.some((b: any) => !b.matched) && <><h3>Book entries not on the statement</h3>
        <div className="rows">{st.book.filter((b: any) => !b.matched).map((b: any) => <div key={b.id} className="row"><span><span className="title">{b.ref}</span><br />
          <span className="meta">{shortDate(b.txn_date)}. {b.narration}</span></span><span className="side num">{rs(b.amount)}</span></div>)}</div>
        <p className="quiet">If the bank has not recorded these yet, date them when the bank does: reverse and post again. If the bank shows something the books do not, post it, then match it.</p></>}
      <ErrorNote error={act.error} />
      {keepsBooks(me) && <div className="actions">
        <button className="primary" disabled={act.busy || !st.canReconcile} onClick={() => act.run(async () => { await api.post(`/api/finance/statements/${st.id}/reconcile`, {}); reload(); entries.reload(); })}>
          Matched: lock up to {shortDate(st.period_end)}</button>
        <button disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/api/finance/statements/${st.id}/discard`, {}); reload(); })}>Discard this statement</button>
      </div>}
    </section>}
    <section>
      <header><h2>Recent entries</h2></header>
      <Daybook rows={entries.data ?? []} accountName={d.account.name} />
    </section>
    {sheet && <Sheet open onClose={() => setSheet(false)} title="Match a bank statement"><StatementForm account={d.account} start={d.nextStart} onDone={() => { setSheet(false); reload(); }} /></Sheet>}
  </>;
}

function StatementForm({ account, start, onDone }: { account: any; start: string | null; onDone: () => void }) {
  const [f, setF] = useState({ periodStart: start ?? '', periodEnd: todayIST(), opening: '', closing: '' });
  const [csv, setCsv] = useState('');
  const { busy, error, run } = useAction();
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => { await api.post(`/api/finance/accounts/${account.id}/statements`, { csv, ...f }); onDone(); }); }}>
    <p className="quiet">Download the statement from your bank as a CSV file. The first row must name the columns: Date, Description, Reference, and Amount (or Debit and Credit).</p>
    <label className="field">Statement file (CSV)<input type="file" accept=".csv,text/csv" required onChange={async e => setCsv(await e.target.files?.[0]?.text() ?? '')} /></label>
    <div className="two">
      <label className="field">From<input type="date" required value={f.periodStart} readOnly={!!start} onChange={e => setF({ ...f, periodStart: e.target.value })} /></label>
      <label className="field">To<input type="date" required max={todayIST()} value={f.periodEnd} onChange={e => setF({ ...f, periodEnd: e.target.value })} /></label>
      <label className="field">Opening balance on the statement, ₹<input required inputMode="decimal" value={f.opening} onChange={e => setF({ ...f, opening: e.target.value })} /></label>
      <label className="field">Closing balance on the statement, ₹<input required inputMode="decimal" value={f.closing} onChange={e => setF({ ...f, closing: e.target.value })} /></label>
    </div>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy || !csv}>Import and match</button></div>
  </form>;
}

function Daybook({ rows, accountName }: { rows: any[]; accountName?: string }) {
  const { me } = useApp();
  const [rev, setRev] = useState<any>(null);
  const [reason, setReason] = useState('');
  const act = useAction();
  if (!rows.length) return <p className="empty rows">No entries yet.</p>;
  return <>
    <div className="table-wrap"><table className="grid"><thead><tr><th>Date</th><th>Entry</th><th>Accounts</th><th className="num">Amount</th>{keepsBooks(me) && <th />}</tr></thead>
      <tbody>{rows.map(j => {
        const own = accountName ? j.lines.filter((l: any) => l.account === accountName).reduce((s: number, l: any) => s + Number(l.debit ?? 0) - Number(l.credit ?? 0), 0) : null;
        return <tr key={j.id} className={j.reversed ? 'struck' : ''}><td>{shortDate(j.txn_date)}</td>
          <td><strong>{j.ref}</strong> {KIND[j.kind]}<br /><span className="quiet">{j.narration}{j.reference ? `. Ref ${j.reference}` : ''}{j.reversed ? '. Reversed' : ''}</span></td>
          <td className="quiet small">{j.lines.map((l: any, i: number) => l.more ? <div key={i}>and {l.more} more lines</div>
            : <div key={i}>{Number(l.debit) ? 'Dr' : 'Cr'} {l.account}{l.unit ? ` (${l.unit})` : ''}</div>)}</td>
          <td className="num">{own !== null ? <span className={own < 0 ? 'stop' : ''}>{own < 0 ? '−' : '+'}{rs(Math.abs(own))}</span> : rs(j.amount)}</td>
          {keepsBooks(me) && <td>{!j.reversed && j.kind !== 'reversal' && <button className="quiet-btn" onClick={() => setRev(j)}>Reverse</button>}</td>}</tr>;
      })}</tbody></table></div>
    {rev && <Sheet open onClose={() => setRev(null)} title={`Reverse ${rev.ref}`}>
      <p className="quiet">A reversal posts the same entry with debits and credits swapped, dated today. The original stays in the books.</p>
      <label className="field">Reason<input value={reason} onChange={e => setReason(e.target.value)} /></label>
      <ErrorNote error={act.error} />
      <button className="primary" disabled={act.busy || !reason.trim()} onClick={() => act.run(async () => {
        await api.post(`/api/finance/journals/${rev.id}/reverse`, { reason }); setRev(null); setReason(''); location.reload(); })}>Reverse</button>
    </Sheet>}
  </>;
}

// ================================================================ reports
const REPORTS: [string, string, 'period' | 'asof' | 'fy'][] = [['income', 'Income and expenditure', 'period'], ['balance', 'Balance sheet', 'asof'],
  ['trial', 'Trial balance', 'asof'], ['cash', 'Cash and bank', 'period'], ['dues', 'Dues by home', 'asof'], ['collection', 'Billing and collection', 'period'],
  ['budget', 'Budget and actual', 'fy'], ['daybook', 'Day book', 'period']];

export function Reports() {
  const [kind, setKind] = useState('income');
  const ov = useApi('/api/finance/overview');
  const [p, setP] = useState({ from: '', to: todayIST() });
  useEffect(() => { if (ov.data && !p.from) setP(x => ({ ...x, from: ov.data.fy.start })); }, [ov.data]);
  const mode = REPORTS.find(r => r[0] === kind)![2];
  const qs = new URLSearchParams(mode === 'period' ? { from: p.from, to: p.to } : mode === 'asof' ? { asOf: p.to } : {}).toString();
  const { data: r, loading, error } = useApi(p.from || mode !== 'period' ? `/api/finance/reports/${kind}?${qs}` : null);
  return <>
    <PageHead title="Reports" />
    <MoneyTabs />
    <div className="tabs" role="group" aria-label="Report">{REPORTS.map(([k, l]) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}</div>
    <div className="actions" style={{ alignItems: 'end' }}>
      {mode === 'period' && <label className="field">From<input type="date" value={p.from} onChange={e => setP({ ...p, from: e.target.value })} /></label>}
      {mode !== 'fy' && <label className="field">{mode === 'asof' ? 'As on' : 'To'}<input type="date" value={p.to} onChange={e => setP({ ...p, to: e.target.value })} /></label>}
      <a className="button" href={`/api/finance/reports/${kind}?${qs}&format=csv`}>Download for Excel</a>
    </div>
    <ErrorNote error={error} />
    {loading && !r ? <Loading /> : r && <section>
      <header><h2>{r.title}</h2><span className="quiet">{r.subtitle}</span></header>
      <div className="table-wrap"><table className="grid report"><thead><tr>{r.columns.map((c: any) => <th key={c.key} className={c.money ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>{r.rows.map((row: any, i: number) => <tr key={i}>{r.columns.map((c: any) => <td key={c.key} className={c.money ? 'num' : ''}>
          {c.money ? (row[c.key] ? rs(row[c.key]) : '') : row[c.key]}</td>)}</tr>)}</tbody>
        {r.totals && <tfoot><tr>{r.columns.map((c: any) => <td key={c.key} className={c.money ? 'num' : ''}>{c.money ? (r.totals[c.key] !== undefined ? rs(r.totals[c.key]) : '') : r.totals[c.key]}</td>)}</tr></tfoot>}
      </table></div>
      {r.note && <p className="quiet">{r.note}</p>}
      {!r.rows.length && <p className="empty">Nothing for this period.</p>}
    </section>}
    <section>
      <header><h2>Tally</h2></header>
      <p className="quiet">Import the ledgers first, then the entries. Each home appears in Tally as a debtor named "Flat" and its number.</p>
      <div className="actions"><a className="button" href="/api/finance/export/tally?part=masters">Ledgers for Tally</a>
        <a className="button" href={`/api/finance/export/tally?part=vouchers&from=${p.from}&to=${p.to}`}>Entries for Tally</a></div>
    </section>
  </>;
}

// ================================================================ settings
export function MoneySettings() {
  const { me } = useApp();
  const s = useApi('/api/finance/settings');
  const acc = useAccounts();
  const [f, setF] = useState<any>(null);
  const [close, setClose] = useState('');
  const [add, setAdd] = useState(false);
  const act = useAction();
  const [saved, setSaved] = useState('');
  useEffect(() => { if (s.data) setF({ fyStartMonth: s.data.fy_start_month, upiId: s.data.upi_id ?? '', paymentInstructions: s.data.payment_instructions }); }, [s.data]);
  if (!f) return <Loading />;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return <>
    <PageHead title="Finance settings" />
    <MoneyTabs />
    <form className="form panel pad" style={{ maxWidth: 680 }} onSubmit={e => { e.preventDefault(); act.run(async () => {
      await api.patch('/api/finance/settings', { ...f, upiId: f.upiId || null }); setSaved('Saved.'); s.reload(); }); }}>
      <h2>How owners pay</h2>
      <label className="field">UPI ID<input value={f.upiId} onChange={e => setF({ ...f, upiId: e.target.value })} placeholder="association@bank" disabled={!keepsBooks(me)} />
        <span className="hint">Owners get a button that opens their UPI app with the amount filled in.</span></label>
      <label className="field">Other ways to pay<textarea value={f.paymentInstructions} onChange={e => setF({ ...f, paymentInstructions: e.target.value })} disabled={!keepsBooks(me)}
        placeholder="Bank transfer details, cheque payee name, office hours for cash" /></label>
      <label className="field">Financial year starts in<select value={f.fyStartMonth} disabled={!keepsBooks(me)} onChange={e => setF({ ...f, fyStartMonth: Number(e.target.value) })}>
        {months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
      <ErrorNote error={act.error} />{saved && <p className="note ok">{saved}</p>}
      {keepsBooks(me) && <div className="actions"><button className="primary" disabled={act.busy}>Save</button></div>}
    </form>
    {keepsBooks(me) && <section className="panel pad" style={{ maxWidth: 680 }}>
      <h2>Close the books</h2>
      <p className="quiet">{s.data.books_closed_through ? `Closed up to ${shortDate(s.data.books_closed_through)}.` : 'No period is closed yet.'} After closing, nothing can be posted on or before that day; corrections go in the open period.</p>
      <div className="actions" style={{ alignItems: 'end' }}>
        <label className="field">Close up to<input type="date" max={todayIST()} value={close} onChange={e => setClose(e.target.value)} /></label>
        <button disabled={act.busy || !close} onClick={() => act.run(async () => { await api.post('/api/finance/close', { through: close }); s.reload(); setClose(''); })}>Close the books</button>
      </div>
    </section>}
    <section>
      <header><h2>Chart of accounts</h2>{keepsBooks(me) && <button onClick={() => setAdd(true)}>Add an account</button>}</header>
      <div className="table-wrap"><table className="grid"><thead><tr><th>Code</th><th>Account</th><th>Kind</th><th className="num">Balance</th></tr></thead>
        <tbody>{acc.all.map(a => <tr key={a.id} className={a.archived_at ? 'struck' : ''}><td>{a.code}</td><td>{a.name}</td><td>{a.cash_kind ? (a.cash_kind === 'bank' ? 'Bank' : 'Cash') : TYPE[a.type]}</td>
          <td className="num">{a.balance ? rs(Math.abs(a.balance)) + (a.balance < 0 ? ' Cr' : ' Dr') : ''}</td></tr>)}</tbody></table></div>
    </section>
    <Budgets />
    {add && <Sheet open onClose={() => setAdd(false)} title="Add an account"><AccountForm onDone={() => { setAdd(false); location.reload(); }} /></Sheet>}
  </>;
}

function Budgets() {
  const { me } = useApp();
  const ov = useApi('/api/finance/overview');
  const fy = ov.data?.fy.year;
  const b = useApi<any[]>(fy ? `/api/finance/budgets?fy=${fy}` : null);
  const [v, setV] = useState<Record<string, string>>({});
  const act = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (b.data) setV(Object.fromEntries(b.data.map(a => [a.id, a.amount_paise ? String(Number(a.amount_paise) / 100) : '']))); }, [b.data]);
  if (!b.data) return null;
  return <section>
    <header><h2>Budget for {ov.data.fy.label}</h2><span className="quiet">Compared with actual under Reports</span></header>
    <div className="table-wrap"><table className="grid"><thead><tr><th>Account</th><th className="num">Budget for the year, ₹</th></tr></thead>
      <tbody>{b.data.map(a => <tr key={a.id}><td>{a.code} {a.name}<br /><span className="quiet">{TYPE[a.type]}</span></td>
        <td className="num"><input inputMode="decimal" style={{ maxWidth: 160, textAlign: 'right' }} disabled={!keepsBooks(me)} value={v[a.id] ?? ''}
          onChange={e => { setSaved(false); setV({ ...v, [a.id]: e.target.value }); }} /></td></tr>)}</tbody></table></div>
    <ErrorNote error={act.error} />{saved && <p className="note ok">Budget saved.</p>}
    {keepsBooks(me) && <div className="actions"><button className="primary" disabled={act.busy} onClick={() => act.run(async () => {
      await api.put('/api/finance/budgets', { fy, items: b.data!.map(a => ({ accountId: a.id, amount: v[a.id] || null })) }); setSaved(true); })}>Save budget</button></div>}
  </section>;
}

// ================================================================ home page panels
export function MoneyPanel() {
  const { me } = useApp();
  const books = useApi(seesBooks(me) ? '/api/finance/overview' : null);
  const mine = useApi(!seesBooks(me) ? '/api/my/dues' : null);
  if (books.data?.dues) {
    const d = books.data;
    return <section>
      <header><h2>Money</h2><Link to="/money">Open the books</Link></header>
      <div className="ops-tiles">
        <Link to="/money/bank" className="tile"><span className="big num money-big">{rs((d.cash ?? []).reduce((s: number, a: any) => s + a.balance, 0))}</span><span>in bank and cash</span></Link>
        <Link to="/money/dues" className="tile"><span className="big num money-big">{rs(d.dues.outstanding)}</span><span>dues owed by {d.dues.homes} homes</span>
          <span className={d.dues.over90 ? 'stop' : 'quiet'}>{d.dues.over90 ? `${rs(d.dues.over90)} over 90 days` : 'Nothing over 90 days'}</span></Link>
        <Link to="/money/vouchers?state=to_pay" className="tile"><span className="big num">{d.vouchers.to_pay}</span><span>vouchers to pay</span>
          <span className="quiet">{d.vouchers.awaiting_approval} waiting for approval</span></Link>
      </div>
    </section>;
  }
  const homes = (mine.data?.homes ?? []).filter((h: any) => h.dues);
  if (!homes.length) return null;
  const total = homes.reduce((s: number, h: any) => s + Math.max(0, h.dues.balance), 0);
  return <section>
    <header><h2>Your dues</h2><Link to="/dues">{total > 0 ? 'Pay or see details' : 'See details'}</Link></header>
    <div className="rows">{homes.map((h: any) => <Link key={h.unit.id} to="/dues" className="row"><span className="title">{h.unit.label}</span>
      <span className={`side num ${h.dues.buckets.d30 + h.dues.buckets.d60 + h.dues.buckets.d90 + h.dues.buckets.over90 > 0 ? 'stop' : ''}`}>
        {h.dues.balance > 0 ? rs(h.dues.balance) : h.dues.balance < 0 ? `${rs(-h.dues.balance)} in advance` : 'Nothing due'}</span></Link>)}</div>
  </section>;
}
