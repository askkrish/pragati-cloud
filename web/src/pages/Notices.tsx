// Notices, the records library, report packs, and pages made for printing or saving as PDF.
import { useState } from 'react';
import { api, rupees, shortDate } from '../api.ts';
import { t } from '../i18n.ts';
import { can, useApp } from '../main.tsx';
import { ErrorNote, Link, Loading, navigate, PageHead, Sheet, useAction, useApi } from '../ui.tsx';
import type { TreeNode } from './Home.tsx';
import { CATEGORY } from './labels.ts';

const NCAT: Record<string, string> = { general: 'General', maintenance: 'Maintenance', meeting: 'Meeting', finance: 'Finance', security: 'Security', event: 'Event',
  emergency: 'Emergency' };
const AUD: Record<string, string> = { everyone: 'Everyone', owners: 'Owners', committee: 'The committee', staff: 'Staff' };
const DCAT: Record<string, string> = { bye_laws: 'Bye-laws', minutes: 'Minutes', agm: 'AGM and general meetings', financial: 'Accounts', audit: 'Audit reports', legal: 'Legal',
  contracts: 'Contracts', insurance: 'Insurance', statutory: 'Licences and statutory', circulars: 'Circulars', plans: 'Plans and drawings', other: 'Other' };
const VIS: Record<string, string> = { everyone: 'Everyone', owners: 'Owners', committee: 'Committee', finance: 'Finance' };
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const publishes = (me: any) => me.permissions.includes('notices.publish');

// ================================================================ notices
export function NoticeBoard() {
  const { me } = useApp();
  const { data, loading, error, reload } = useApi<any[]>(`/api/notices?all=${publishes(me) ? 1 : 0}&limit=100`);
  const [add, setAdd] = useState(false);
  return <>
    <PageHead title={t('Notices')}>{publishes(me) && <button className="primary" onClick={() => setAdd(true)}>New notice</button>}</PageHead>
    <ErrorNote error={error} />
    {loading && !data ? <Loading /> : <div className="rows">{data?.length ? data.map(n => <Link key={n.id} to={`/notices/${n.id}`} className={`row notice ${n.read ? '' : 'unread'}`}>
      <span><span className="title">{n.pinned && <span className="pin" aria-label="Pinned">📌 </span>}{n.title}</span><br />
        <span className="meta">{NCAT[n.category]}{n.audience !== 'everyone' ? `, for ${AUD[n.audience].toLowerCase()}` : ''}{n.place ? `, ${n.place}` : ''}. {n.by}</span></span>
      <span className="side">{n.scheduled ? <span className="tag w-on_hold">From {when(n.publish_at)}</span> : !n.live ? <span className="tag">Ended</span>
        : <span className="quiet">{shortDate(n.publish_at)}</span>}{n.category === 'emergency' && <><br /><span className="tag w-overdue">Urgent</span></>}</span>
    </Link>) : <p className="empty">No notices.</p>}</div>}
    {add && <Sheet open onClose={() => setAdd(false)} title="New notice"><NoticeForm onDone={id => { setAdd(false); reload(); navigate(`/notices/${id}`); }} /></Sheet>}
  </>;
}

function NoticeForm({ onDone }: { onDone: (id: string) => void }) {
  const tree = useApi<{ nodes: TreeNode[] }>('/api/property/tree');
  const [f, setF] = useState({ title: '', body: '', category: 'general', audience: 'everyone', scopeNodeId: '', publishAt: '', expiresOn: '', pinned: false });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const places = (tree.data?.nodes ?? []).filter(n => n.in_scope && n.kind !== 'floor' && n.parent_id);
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const fileId = file ? (await api.upload('/api/files?purpose=notice', file)).id : null;
    const r = await api.post('/api/notices', { ...f, scopeNodeId: f.scopeNodeId || null, publishAt: f.publishAt ? new Date(f.publishAt).toISOString() : undefined,
      expiresOn: f.expiresOn || null, fileId });
    onDone(r.id); }); }}>
    <label className="field">Title<input required value={f.title} onChange={set('title')} placeholder="For example, Water supply off on Sunday morning" /></label>
    <label className="field">Notice<textarea required rows={6} value={f.body} onChange={set('body')} placeholder="What is happening, when, what residents should do, whom to contact" /></label>
    <div className="two">
      <label className="field">Kind<select value={f.category} onChange={set('category')}>{Object.entries(NCAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">For<select value={f.audience} onChange={set('audience')}>{Object.entries(AUD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">Where<select value={f.scopeNodeId} onChange={set('scopeNodeId')}><option value="">The whole community</option>
        {places.map(n => <option key={n.id} value={n.id}>{'  '.repeat(n.depth - 1)}{n.name}</option>)}</select></label>
      <label className="field">Publish at (optional)<input type="datetime-local" value={f.publishAt} onChange={set('publishAt')} /></label>
      <label className="field">Take down after (optional)<input type="date" value={f.expiresOn} onChange={set('expiresOn')} /></label>
      <label className="field">Attachment (optional)<input type="file" accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
    </div>
    <label className="check"><input type="checkbox" checked={f.pinned} onChange={set('pinned')} />Pin to the top</label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>{f.publishAt ? 'Schedule notice' : 'Publish notice'}</button></div>
  </form>;
}

export function NoticeView({ id }: { id: string }) {
  const { data: n, loading, error, reload } = useApi(`/api/notices/${id}`);
  const [note, setNote] = useState('');
  const [sheet, setSheet] = useState(false);
  const act = useAction();
  if (loading && !n) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  return <>
    <PageHead title={n.title} crumbs={[{ to: '/notices', label: t('Notices') }, { label: n.ref }]}>
      {n.category === 'emergency' && <span className="tag w-overdue">Urgent</span>}{n.withdrawn_at && <span className="tag">Withdrawn</span>}</PageHead>
    <p className="quiet">{NCAT[n.category]}. For {AUD[n.audience].toLowerCase()}{n.place ? ` in ${n.place}` : ''}. {n.by}, {when(n.publish_at)}{n.expires_on ? `; until ${shortDate(n.expires_on)}` : ''}.</p>
    <div className="notice-body">{n.body}</div>
    {n.file_id && <p><a className="button" href={`/api/files/${n.file_id}`}>Open the attachment</a></p>}
    {n.withdrawn_at && <p className="note">Withdrawn: {n.withdrawn_note}</p>}
    {n.publisher && <section>
      <p className="quiet">Opened by {n.reads} {n.reads === 1 ? 'person' : 'people'} so far.</p>
      {!n.withdrawn_at && <div className="actions"><button onClick={() => setSheet(true)}>Withdraw</button></div>}
    </section>}
    {sheet && <Sheet open onClose={() => setSheet(false)} title="Withdraw this notice">
      <label className="field">Reason<input value={note} onChange={e => setNote(e.target.value)} /></label>
      <ErrorNote error={act.error} />
      <button className="primary" disabled={act.busy || !note.trim()} onClick={() => act.run(async () => { await api.post(`/api/notices/${id}/withdraw`, { note }); setSheet(false); reload(); })}>Withdraw</button>
    </Sheet>}
  </>;
}

export function NoticesPanel() {
  const { data } = useApi<any[]>('/api/notices?limit=4');
  if (!data?.length) return null;
  const unread = data.filter(n => !n.read).length;
  return <section>
    <header><h2>{t('Notices')}{unread > 0 && <span className="badge" style={{ marginLeft: 10, verticalAlign: 'middle' }}>{unread}</span>}</h2><Link to="/notices">All notices</Link></header>
    <div className="rows">{data.slice(0, 3).map(n => <Link key={n.id} to={`/notices/${n.id}`} className={`row notice ${n.read ? '' : 'unread'}`}>
      <span><span className="title">{n.pinned && '📌 '}{n.title}</span><br /><span className="meta">{NCAT[n.category]}{n.place ? `, ${n.place}` : ''}</span></span>
      <span className="side quiet">{shortDate(n.publish_at)}</span></Link>)}</div>
  </section>;
}

// ================================================================ records library
export function Library() {
  const { me } = useApp();
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const { data, loading, error, reload } = useApi<any[]>(`/api/documents?${new URLSearchParams({ ...(cat ? { category: cat } : {}), ...(q ? { q } : {}) })}`);
  const [add, setAdd] = useState(false);
  const manage = me.permissions.includes('documents.manage');
  return <>
    <PageHead title="Records library">{manage && <button className="primary" onClick={() => setAdd(true)}>Add a document</button>}</PageHead>
    <div className="head-row" style={{ alignItems: 'end' }}>
      <input className="search" type="search" placeholder="Search titles" value={q} onChange={e => setQ(e.target.value)} />
      <select value={cat} onChange={e => setCat(e.target.value)} style={{ width: 'auto' }} aria-label="Kind"><option value="">Every kind</option>
        {Object.entries(DCAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
    </div>
    <ErrorNote error={error} />
    {loading && !data ? <Loading /> : <div className="rows">{data?.length ? data.map(d => <Link key={d.id} to={`/records/${d.id}`} className="row">
      <span><span className="title">{d.title}</span><br /><span className="meta">{DCAT[d.category]}{d.dated_on ? `, ${shortDate(d.dated_on)}` : ''}{d.version > 1 ? `, version ${d.version}` : ''}
        {manage ? `. Seen by: ${VIS[d.visibility].toLowerCase()}` : ''}</span></span>
      <span className="side">{d.reviewOverdue ? <span className="tag w-overdue">Review overdue</span> : d.reviewDue ? <span className="tag w-on_hold">Review by {shortDate(d.review_on)}</span>
        : <span className="quiet">{d.file_name.split('.').pop()?.toUpperCase()}</span>}</span></Link>) : <p className="empty">No documents here.</p>}</div>}
    {add && <Sheet open onClose={() => setAdd(false)} title="Add a document"><DocumentForm onDone={id => { setAdd(false); reload(); navigate(`/records/${id}`); }} /></Sheet>}
  </>;
}

function DocumentForm({ replaces, onDone }: { replaces?: any; onDone: (id: string) => void }) {
  const [f, setF] = useState({ title: replaces?.title ?? '', category: replaces?.category ?? 'minutes', description: replaces?.description ?? '',
    visibility: replaces?.visibility ?? 'committee', datedOn: '', reviewOn: '' });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const up = await api.upload('/api/files?purpose=document', file!);
    const r = await api.post('/api/documents', { ...f, fileId: up.id, datedOn: f.datedOn || null, reviewOn: f.reviewOn || null, replacesId: replaces?.id ?? null });
    onDone(r.id); }); }}>
    <label className="field">The file (PDF or image)<input type="file" required accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
    <label className="field">Title<input required value={f.title} onChange={set('title')} /></label>
    <div className="two">
      <label className="field">Kind<select value={f.category} onChange={set('category')}>{Object.entries(DCAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">Who can see it<select value={f.visibility} onChange={set('visibility')}>
        <option value="everyone">Everyone: owners and residents</option><option value="owners">Owners only</option>
        <option value="committee">The committee</option><option value="finance">The treasurer and finance team</option></select></label>
      <label className="field">Dated<input type="date" value={f.datedOn} onChange={set('datedOn')} /></label>
      <label className="field">Next review (optional)<input type="date" value={f.reviewOn} onChange={set('reviewOn')} /></label>
    </div>
    <label className="field">Description (optional)<textarea value={f.description} onChange={set('description')} /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy || !file}>{replaces ? 'Add the new version' : 'Add to the library'}</button></div>
  </form>;
}

export function DocumentView({ id }: { id: string }) {
  const { data: d, loading, error } = useApi(`/api/documents/${id}`);
  const [sheet, setSheet] = useState(false);
  if (loading && !d) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  return <>
    <PageHead title={d.title} crumbs={[{ to: '/records', label: 'Records library' }, { label: d.ref }]} />
    <dl className="facts">
      <div><dt>Kind</dt><dd>{DCAT[d.category]}</dd></div>
      {d.dated_on && <div><dt>Dated</dt><dd>{shortDate(d.dated_on)}</dd></div>}
      <div><dt>Version</dt><dd>{d.version}</dd></div>
      <div><dt>Who can see it</dt><dd>{VIS[d.visibility]}{d.place ? `, ${d.place}` : ''}</dd></div>
      {d.review_on && <div><dt>Next review</dt><dd>{shortDate(d.review_on)}</dd></div>}
      <div><dt>Added by</dt><dd>{d.by}, {shortDate(d.created_at)}</dd></div>
    </dl>
    {d.description && <p style={{ whiteSpace: 'pre-wrap', maxWidth: '68ch' }}>{d.description}</p>}
    <div className="actions"><a className="button primary" href={`/api/files/${d.file_id}`}>Open {d.file_name}</a>
      {d.canManage && <button onClick={() => setSheet(true)}>Upload a new version</button>}</div>
    {d.versions.length > 0 && <section><header><h2>Earlier versions</h2></header>
      <div className="rows">{d.versions.map((v: any) => <a key={v.id} className="row" href={`/api/files/${v.file_id}`}><span><span className="title">Version {v.version}</span><br />
        <span className="meta">{v.file_name}, added by {v.by} on {shortDate(v.created_at)}</span></span></a>)}</div></section>}
    {sheet && <Sheet open onClose={() => setSheet(false)} title="New version"><DocumentForm replaces={d} onDone={nid => { setSheet(false); navigate(`/records/${nid}`); }} /></Sheet>}
  </>;
}

// ================================================================ report packs
export function Packs() {
  const { me } = useApp();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [end, setEnd] = useState(today);
  const last = new Date(Date.parse(today.slice(0, 8) + '01T00:00:00Z') - 86_400_000).toISOString().slice(0, 7);
  const [month, setMonth] = useState(last);
  const committee = ['committees.view', 'operations.view', 'finance.view'].some(p => can(me, p));
  return <>
    <PageHead title="Report packs" />
    <p className="quiet" style={{ maxWidth: '68ch' }}>Each pack opens as a page ready to print or save as PDF, in the language you have chosen.</p>
    {committee && <section className="panel pad">
      <h2>Weekly committee pack</h2>
      <p className="quiet">Checks done and missed, work opened and closed, the oldest open work, renewals, approvals, cash, payments and dues: each part for those who may see it.</p>
      <div className="actions" style={{ alignItems: 'end' }}>
        <label className="field">Week ending<input type="date" max={today} value={end} onChange={e => setEnd(e.target.value)} /></label>
        <Link to={`/print/weekly?end=${end}`} className="button primary">Open the pack</Link>
      </div>
    </section>}
    <section className="panel pad">
      <h2>Owners' monthly update</h2>
      <p className="quiet">How the community was looked after: checks done, requests fixed, work completed, collection rate. Counts only, no names or amounts.</p>
      <div className="actions" style={{ alignItems: 'end' }}>
        <label className="field">Month<input type="month" max={today.slice(0, 7)} value={month} onChange={e => setMonth(e.target.value)} /></label>
        <Link to={`/print/owners?month=${month}`} className="button primary">Open the update</Link>
      </div>
    </section>
  </>;
}

// ================================================================ printing
function PrintShell({ title, subtitle, children, back }: { title: string; subtitle: string; children: React.ReactNode; back: string }) {
  const { community } = useApp();
  return <div className="print-page">
    <div className="no-print actions" style={{ marginBottom: 18 }}><button className="primary" onClick={() => print()}>Print or save as PDF</button>
      <Link to={back} className="button">Back</Link></div>
    <header className="print-head"><div><p className="print-org">{community.platformName}</p><h1>{title}</h1><p className="quiet">{subtitle}</p></div></header>
    {children}
    <p className="print-foot">{community.platformName}. Printed {new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.</p>
  </div>;
}
const fmtDay = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtShort = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });

export function PrintWeekly() {
  const end = new URLSearchParams(location.search).get('end');
  const { data: p, error } = useApi(`/api/packs/weekly${end ? `?end=${end}` : ''}`);
  if (error) return <ErrorNote error={error} />;
  if (!p) return <Loading />;
  const pct = (a: number, b: number) => b ? `${Math.round(a / b * 100)}%` : '–';
  return <PrintShell title={t('Weekly committee pack')} subtitle={`${fmtDay(p.start)} to ${fmtDay(p.end)}`} back="/packs">
    <div className="print-grid">
      {p.checks && <div className="print-stat"><b>{pct(p.checks.total.done, p.checks.total.due)}</b><span>{t('checks done')} ({p.checks.total.done} / {p.checks.total.due})</span></div>}
      {p.checks && <div className="print-stat"><b>{p.checks.total.missed}</b><span>{t('checks missed')}</span></div>}
      {p.work && <div className="print-stat"><b>{p.work.open}</b><span>{t('open work orders')}, {p.work.overdue} {t('overdue')}</span></div>}
      {p.dues && <div className="print-stat"><b>{rupees(p.dues.outstanding)}</b><span>{t('dues outstanding')}, {p.dues.homes} {t('homes')}</span></div>}
    </div>
    {p.checks && <section><h2>{t('Routine checks')}</h2><table className="grid"><thead><tr><th>{t('Kind of work')}</th><th className="num">{t('Due')}</th><th className="num">{t('Done')}</th>
      <th className="num">{t('Missed')}</th><th className="num">{t('Late')}</th></tr></thead><tbody>{p.checks.byCategory.map((c: any) => <tr key={c.category}><td>{t(CATEGORY[c.category])}</td>
        <td className="num">{c.due}</td><td className="num">{c.done}</td><td className="num">{c.missed}</td><td className="num">{c.late}</td></tr>)}</tbody></table>
      {p.checks.missed.length > 0 && <><h3>{t('Missed checks')}</h3><ul>{p.checks.missed.map((m: any, i: number) => <li key={i}>{fmtDay(m.day)}: {m.title} ({m.place}{m.assignee ? `; ${m.assignee}` : ''})</li>)}</ul></>}</section>}
    {p.work && <section><h2>{t('Work orders')}</h2><p>{p.work.opened} {t('opened')}, {p.work.closed} {t('closed')}, {p.work.requests} {t('service requests raised this week')}.</p>
      {p.oldest.length > 0 && <table className="grid"><thead><tr><th>{t('Oldest open work')}</th><th>{t('Given to')}</th><th className="num">{t('Days open')}</th></tr></thead>
        <tbody>{p.oldest.map((w: any) => <tr key={w.ref}><td>{w.ref}: {w.title}</td><td>{w.assignee ?? '–'}</td><td className="num">{w.age}</td></tr>)}</tbody></table>}</section>}
    {p.renewals?.length > 0 && <section><h2>{t('Renewals overdue or due within 30 days')}</h2><ul>{p.renewals.map((r: any) => <li key={r.ref}>{r.title}{r.provider ? ` (${r.provider})` : ''}: {fmtDay(r.ends_on)}</li>)}</ul></section>}
    {p.approvals && <section><h2>{t('Waiting for approval')}</h2>{p.approvals.length ? <table className="grid"><tbody>{p.approvals.map((a: any) => <tr key={a.ref}>
      <td>{a.ref}: {a.title}</td><td className="num">{rupees(a.amount_paise)}</td><td className="num">{a.age} {t('days')}</td></tr>)}</tbody></table> : <p>{t('Nothing is waiting.')}</p>}
      {p.decided?.length > 0 && <p>{t('Decided this week')}: {p.decided.map((d: any) => `${d.ref} ${t(d.status === 'approved' ? 'Approved' : 'Rejected').toLowerCase()}`).join('; ')}.</p>}</section>}
    {p.cash && <section><h2>{t('Cash and bank')}</h2><table className="grid"><thead><tr><th>{t('Account')}</th><th className="num">{t('Opening')}</th><th className="num">{t('In')}</th>
      <th className="num">{t('Out')}</th><th className="num">{t('Closing')}</th></tr></thead><tbody>{p.cash.map((c: any) => <tr key={c.name}><td>{c.name}</td><td className="num">{rupees(c.opening)}</td>
        <td className="num">{rupees(c.received)}</td><td className="num">{rupees(c.paid)}</td><td className="num">{rupees(c.closing)}</td></tr>)}</tbody></table>
      {p.dues.over90 > 0 && <p>{rupees(p.dues.over90)} {t('overdue by more than 90 days, from')} {p.dues.over90Homes} {t('homes')}.</p>}
      {p.payments.length > 0 && <><h3>{t('Payments this week')}</h3><table className="grid"><tbody>{p.payments.map((x: any) => <tr key={x.ref}><td>{fmtDay(x.txn_date)}</td><td>{x.narration}</td>
        <td className="num">{rupees(x.amount)}</td></tr>)}</tbody></table></>}</section>}
    {p.notices.length > 0 && <section><h2>{t('Notices published')}</h2><ul>{p.notices.map((n: any) => <li key={n.ref}>{n.title}</li>)}</ul></section>}
  </PrintShell>;
}

export function PrintOwners() {
  const month = new URLSearchParams(location.search).get('month');
  const { data: p, error } = useApi(`/api/packs/owners${month ? `?month=${month}` : ''}`);
  if (error) return <ErrorNote error={error} />;
  if (!p) return <Loading />;
  const label = new Date(p.start + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return <PrintShell title={t("Owners' monthly update")} subtitle={label} back="/packs">
    <div className="print-grid">
      <div className="print-stat"><b>{p.checks.due ? `${Math.round(p.checks.done / p.checks.due * 100)}%` : '–'}</b><span>{t('of scheduled checks done')} ({p.checks.done} / {p.checks.due})</span></div>
      <div className="print-stat"><b>{p.work.resolved}</b><span>{t('requests fixed')}{p.work.requests ? `, ${t('of')} ${p.work.requests} ${t('raised')}` : ''}</span></div>
      {p.work.days_to_fix && <div className="print-stat"><b>{p.work.days_to_fix}</b><span>{t('days on average to fix a request')}</span></div>}
      <div className="print-stat"><b>{p.work.completed}</b><span>{t('maintenance jobs and projects completed')}</span></div>
      {p.collection !== null && <div className="print-stat"><b>{p.collection}%</b><span>{t('of the month\'s maintenance collected')}</span></div>}
      <div className="print-stat"><b>{p.work.projects}</b><span>{t('projects in progress')}</span></div>
    </div>
    <p>{p.notices} {t('notices were published for owners this month.')}</p>
    <p className="quiet">{t('Figures are counts for the whole community. Your own dues and requests are in the app.')}</p>
  </PrintShell>;
}

export function PrintStatement({ id }: { id: string }) {
  const { data: d, error } = useApi(`/api/finance/units/${id}/statement`);
  const { me } = useApp();
  if (error) return <ErrorNote error={error} />;
  if (!d) return <Loading />;
  const bal = d.dues?.balance ?? 0;
  return <PrintShell title={`${t('Statement of dues')}: ${d.unit.label}`} subtitle={`${t('As on')} ${fmtDay(d.today)}`} back={me.permissions.includes('finance.view') ? `/money/units/${id}` : '/dues'}>
    <p className="print-total">{bal > 0 ? `${t('Amount due')}: ${rupees(bal)}` : bal < 0 ? `${t('Paid in advance')}: ${rupees(-bal)}` : t('Nothing is due.')}</p>
    <table className="grid"><thead><tr><th>{t('Date')}</th><th>{t('Particulars')}</th><th className="num">{t('Charged')}</th><th className="num">{t('Paid')}</th><th className="num">{t('Balance')}</th></tr></thead>
      <tbody>{d.lines.map((l: any, i: number) => <tr key={i}><td className="nowrap">{fmtShort(l.txn_date)}</td><td>{l.narration}{l.reference ? ` (${l.reference})` : ''}<br /><span className="quiet">{l.ref}</span></td>
        <td className="num">{Number(l.charged) ? rupees(l.charged) : ''}</td><td className="num">{Number(l.paid) ? rupees(l.paid) : ''}</td><td className="num">{rupees(Math.abs(Number(l.balance))) || '₹0'}{Number(l.balance) < 0 ? ' Cr' : ''}</td></tr>)}</tbody></table>
  </PrintShell>;
}

export function PrintVoucher({ id }: { id: string }) {
  const { data: v, error } = useApi(`/api/finance/vouchers/${id}`);
  if (error) return <ErrorNote error={error} />;
  if (!v) return <Loading />;
  const net = Number(v.amount_paise) - Number(v.tds_paise);
  return <PrintShell title={`${t('Payment voucher')} ${v.ref}`} subtitle={fmtDay(String(v.created_at).slice(0, 10))} back={`/money/vouchers/${id}`}>
    <table className="grid voucher"><tbody>
      <tr><th>{t('Pay to')}</th><td>{v.payee}</td></tr>
      <tr><th>{t('For')}</th><td>{v.description}</td></tr>
      <tr><th>{t('Account')}</th><td>{v.account_code} {v.account}; {v.place}</td></tr>
      {v.invoice_no && <tr><th>{t('Invoice')}</th><td>{v.invoice_no}{v.invoice_date ? `, ${fmtDay(v.invoice_date)}` : ''}</td></tr>}
      <tr><th>{t('Amount')}</th><td><b>{rupees(v.amount_paise)}</b>{Number(v.tds_paise) > 0 && <>; {t('TDS')} {rupees(v.tds_paise)}; {t('net payable')} <b>{rupees(net)}</b></>}</td></tr>
      <tr><th>{t('Approval')}</th><td>{v.approval_ref ?? '–'}, {v.approval_status ?? '–'}</td></tr>
      <tr><th>{t('Paid')}</th><td>{v.journal_ref ? `${fmtDay(v.paid_on)}, ${v.journal_ref}${v.paid_reference ? `, ${v.paid_reference}` : ''}` : t('Not yet paid')}</td></tr>
    </tbody></table>
    <div className="signatures">{[t('Prepared by') + `: ${v.prepared_by_name}`, t('Treasurer'), t('President or Secretary'), t('Received by')].map(s => <div key={s}><span />{s}</div>)}</div>
  </PrintShell>;
}
