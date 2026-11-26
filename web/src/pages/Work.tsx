// Operations: the day's checklist, work orders and service requests, routines and the asset register.
import { useEffect, useMemo, useState } from 'react';
import { api, rupees, shortDate } from '../api.ts';
import { can, useApp, type Me } from '../main.tsx';
import { appendSpoken, ErrorNote, Link, Loading, navigate, PageHead, Sheet, useAction, useApi, usePath, VoiceButton } from '../ui.tsx';
import type { TreeNode } from './Home.tsx';
import { CATEGORY } from './labels.ts';
import { Quotations, seesProcurement } from './Procurement.tsx';
import { Delivery, Permit, PERMIT_KINDS } from './Delivery.tsx';
import { isNetworkError, queueCheck, useOffline } from '../offline.ts';
export { CATEGORY };

export const isStaff = (me: Me) => ['operations.view', 'operations.update', 'operations.manage'].some(p => can(me, p));
const seesAll = (me: Me) => can(me, 'operations.view') || can(me, 'operations.manage');

const DAY_STATUS: Record<string, string> = { done: 'Done', skipped: 'Skipped', blocked: 'Blocked', in_progress: 'Started', missed: 'Missed',
  due: 'Due now', upcoming: 'Later' };
export const WORK_STATUS: Record<string, string> = { new: 'New', open: 'Open', in_progress: 'In progress', on_hold: 'On hold', done: 'Done',
  closed: 'Closed', cancelled: 'Cancelled' };
const KIND: Record<string, string> = { request: 'Service request', incident: 'Incident', maintenance: 'Maintenance', project: 'Project' };
const PRIORITY: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const ASSET_KIND: Record<string, string> = { lift: 'Lifts', generator: 'Generator', pump: 'Pump', transformer: 'Transformer', electrical: 'Electrical',
  water_treatment: 'Water treatment', sewage_treatment: 'Sewage treatment', fire_safety: 'Fire safety', cctv: 'CCTV', access_control: 'Access control',
  pool: 'Pool', hvac: 'Air conditioning', solar: 'Solar', gym: 'Gym', garden: 'Garden', vehicle: 'Vehicle', other: 'Other' };
const CONTRACT_KIND: Record<string, string> = { amc: 'AMC', warranty: 'Warranty', insurance: 'Insurance', licence: 'Licence', inspection: 'Inspection', other: 'Other' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- small helpers ----------
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const dayLabel = (d: string, today: string) => {
  if (d === today) return 'Today';
  if (d === addDays(today, -1)) return 'Yesterday';
  if (d === addDays(today, 1)) return 'Tomorrow';
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
const timeOf = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '';
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const query = () => new URLSearchParams(location.search);

function useTree() {
  const tree = useApi<{ nodes: TreeNode[] }>('/api/property/tree');
  const places = (tree.data?.nodes ?? []).filter(n => n.in_scope && n.kind !== 'floor');
  return { places, loading: tree.loading };
}
function PlaceSelect({ value, onChange, places, label = 'Place' }: { value: string; onChange: (v: string) => void; places: TreeNode[]; label?: string }) {
  return <label className="field">{label}<select value={value} onChange={e => onChange(e.target.value)} required>
    <option value="">Choose…</option>
    {places.map(n => <option key={n.id} value={n.id}>{'  '.repeat(n.depth)}{n.name}</option>)}</select></label>;
}
function PersonSelect({ value, onChange, label, people, none = 'Nobody yet' }: { value: string; onChange: (v: string) => void; label: string; people: any[]; none?: string }) {
  return <label className="field">{label}<select value={value} onChange={e => onChange(e.target.value)}>
    <option value="">{none}</option>{people.map(p => <option key={p.id} value={p.id}>{p.full_name}{p.role ? `, ${p.role}` : ''}</option>)}</select></label>;
}

export function WorkTabs() {
  const { me } = useApp();
  const path = usePath().split('?')[0];
  const tabs = [['/work', 'Today'], ['/work/orders', 'Work orders'], ['/work/routines', 'Routines'], ...(seesAll(me) ? [['/work/assets', 'Assets and renewals']] : []),
    ...(seesProcurement(me) ? [['/work/vendors', 'Vendors']] : [])];
  return <nav className="tabs" aria-label="Operations">
    {tabs.map(([to, label]) => <Link key={to} to={to} className="button" aria-current={(to === '/work' ? path === to : path.startsWith(to)) ? 'page' : undefined}>{label}</Link>)}
  </nav>;
}

// ================================================================== Today
export function Today() {
  const { me } = useApp();
  const path = usePath();
  const params = new URLSearchParams(path.split('?')[1] ?? '');
  const date = params.get('date'), place = params.get('place');
  const qs = new URLSearchParams({ ...(date ? { date } : {}), ...(place ? { place } : {}) }).toString();
  const { data, loading, error, reload } = useApi(`/api/ops/today${qs ? `?${qs}` : ''}`);
  const queued = useOffline().queued;
  const [filter, setFilter] = useState<'all' | 'mine' | 'open'>('all');
  const [open, setOpen] = useState<any>(null);
  if (!isStaff(me)) { navigate('/requests'); return null; }
  if (loading && !data) return <><PageHead title="Today" /><WorkTabs /><Loading /></>;
  if (error) return <ErrorNote error={error} />;
  const day: string = data.date;
  const rows = (data.rows as any[]).filter(r => filter === 'all' || (filter === 'mine' ? [r.assignee_id, r.backup_id].includes(me.person.id)
    : !['done', 'skipped'].includes(r.status)));
  const slot = (t: string | null) => !t ? 'Any time' : t < '12:00' ? 'Morning' : t < '17:00' ? 'Afternoon' : 'Evening';
  const groups = ['Morning', 'Afternoon', 'Evening', 'Any time'].map(g => [g, rows.filter(r => slot(r.start_time) === g)] as const).filter(([, rs]) => rs.length);
  const c = data.counts;
  const go = (d: string) => navigate(`/work${d === data.today && !place ? '' : `?${new URLSearchParams({ ...(d !== data.today ? { date: d } : {}), ...(place ? { place } : {}) })}`}`);
  const waiting = (r: any) => queued.some(q => q.routineId === r.routine_id && q.day === day);
  return <>
    <PageHead title={dayLabel(day, data.today) === 'Today' ? 'Today' : dayLabel(day, data.today)}>
      <div className="day-nav">
        <button onClick={() => go(addDays(day, -1))} aria-label="Previous day">‹</button>
        <input type="date" value={day} max={addDays(data.today, 30)} onChange={e => e.target.value && go(e.target.value)} aria-label="Choose a day" />
        <button onClick={() => go(addDays(day, 1))} aria-label="Next day">›</button>
      </div>
    </PageHead>
    <WorkTabs />
    <p className="quiet small register-link">Checks written in a paper register? <Link to="/work/register">Enter a register page</Link></p>
    {data.place && <p className="note">Checks at {data.place.name} and the places inside it. <Link to={date ? `/work?date=${date}` : '/work'}>Show every place</Link></p>}
    <section className="daybar" aria-label="Progress">
      <div className="daybar-track" role="img" aria-label={`${c.done} of ${c.scheduled} done, ${c.missed} missed`}>
        {(['done', 'skipped', 'blocked', 'missed'] as const).map(k => c[k] > 0 &&
          <i key={k} className={`seg ${k}`} style={{ width: `${(c[k] / Math.max(1, c.scheduled)) * 100}%` }} />)}
      </div>
      <p><strong className="num">{c.done} of {c.scheduled}</strong> checks done{c.missed ? <>, <span className="stop">{c.missed} missed</span></> : ''}
        {c.due ? `, ${c.due} due now` : ''}{c.late ? `, ${c.late} done late` : ''}{c.skipped ? `, ${c.skipped} skipped` : ''}{c.blocked ? `, ${c.blocked} blocked` : ''}.</p>
    </section>
    <div className="tabs" role="group" aria-label="Show">
      {([['all', 'All'], ['open', 'Not done yet'], ['mine', 'Given to me']] as const).map(([k, l]) =>
        <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
    </div>
    {!rows.length && <p className="empty rows">{data.rows.length ? 'Nothing here with this filter.' : 'No routines are scheduled on this day.'}</p>}
    {groups.map(([g, rs]) => <section key={g}>
      <header><h2>{g}</h2></header>
      <div className="rows">{rs.map(r => <button key={r.routine_id} className={`row check-row s-${r.status}`} onClick={() => setOpen(r)}>
        <span className="mark" aria-hidden="true" />
        <span><span className="title">{r.title}</span><br />
          <span className="meta">{r.start_time ? `${r.start_time}${r.end_time ? `–${r.end_time}` : ''}, ` : ''}{r.place}{r.assignee ? `. ${r.assignee}` : ''}</span>
          {r.check?.note && <><br /><span className="meta note-line">“{r.check.note}”</span></>}</span>
        <span className="side">{waiting(r) ? <span className="tag w-on_hold">Waiting to send</span> : <span className={`tag day-${r.status}`}>{DAY_STATUS[r.status]}{r.late ? ', late' : ''}</span>}
          {r.check?.reading && <><br /><span className="num quiet">{Number(r.check.reading)} {r.needs.reading?.unit ?? ''}</span></>}</span>
      </button>)}</div>
    </section>)}
    {open && <CheckSheet row={open} day={day} today={data.today} onClose={() => setOpen(null)} onDone={() => { setOpen(null); reload(); }} />}
  </>;
}

function CheckSheet({ row, day, today, onClose, onDone }: { row: any; day: string; today: string; onClose: () => void; onDone: () => void }) {
  const nowHm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const [status, setStatus] = useState<string>(row.check?.status ?? 'done');
  const [performedAt, setPerformedAt] = useState(row.check?.performed_at ? timeOf(row.check.performed_at) : day === today ? nowHm : (row.start_time ?? ''));
  const [note, setNote] = useState<string>(row.check?.note ?? '');
  const [reading, setReading] = useState(row.check?.reading ? String(Number(row.check.reading)) : '');
  const [reference, setReference] = useState(row.check?.reference ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [raise, setRaise] = useState(false);
  const { busy, error, run } = useAction();
  const n = row.needs;
  const save = () => run(async () => {
    const body = { status, performedAt: status === 'done' ? performedAt || null : null, note, reading: reading || null, reference: reference || null,
      photoFileId: null as string | null, raiseWorkOrder: raise };
    try {
      if (file) body.photoFileId = (await api.upload('/api/files?purpose=work_photo', file)).id;
      await api.put(`/api/routines/${row.routine_id}/checks/${day}`, body);
    } catch (e) {
      // No network: keep the check on this phone and send it when the network is back.
      if (!isNetworkError(e) || n.photo && status === 'done' && file) throw isNetworkError(e) ? new Error('This check needs its photo, which cannot be sent offline. Try again when there is signal.') : e;
      queueCheck({ routineId: row.routine_id, day, title: row.title, body: { ...body, note: file ? `${note}${note ? ' ' : ''}(photo not sent: recorded offline)`.trim() : note } });
    }
    onDone();
  });
  const noteLabel = status === 'skipped' ? 'Why it was skipped' : status === 'blocked' ? 'What is stopping the work' : n.remarks === 'required' ? 'Completion remarks' : 'Note (optional)';
  return <Sheet open onClose={onClose} title={row.title}>
    <p className="quiet">{row.place}{row.start_time ? `. Window ${row.start_time}${row.end_time ? `–${row.end_time}` : ''}` : ''}. {dayLabel(day, today)}.</p>
    {row.check && <p className="note">Recorded {DAY_STATUS[row.check.status].toLowerCase()} by {row.check.recorded_by}, {when(row.check.recorded_at)}.
      {row.check.work_order_id && <> <Link to={`/work/orders/${row.check.work_order_id}`}>See the work order</Link>.</>}</p>}
    {!row.canRecord ? <p className="quiet">You can see this routine but it is not given to you.</p> : <>
      <div className="tabs" role="radiogroup" aria-label="What happened">
        {(['done', 'in_progress', 'skipped', 'blocked'] as const).map(s => <button key={s} role="radio" aria-checked={status === s} aria-pressed={status === s}
          onClick={() => setStatus(s)}>{DAY_STATUS[s]}</button>)}
      </div>
      {status === 'done' && <label className="field">Time it was done<input type="time" value={performedAt} onChange={e => setPerformedAt(e.target.value)} />
        {row.end_time && performedAt >= row.end_time && <span className="hint">After {row.end_time}: this will count as late.</span>}</label>}
      {status === 'done' && n.reading && <label className="field">{n.reading.label}{n.reading.unit ? ` (${n.reading.unit})` : ''}
        <input inputMode="decimal" value={reading} onChange={e => setReading(e.target.value)} required /></label>}
      {status === 'done' && n.reference && <label className="field">Reference number<input value={reference} onChange={e => setReference(e.target.value)} /></label>}
      <label className="field">{noteLabel}<textarea value={note} onChange={e => setNote(e.target.value)} /></label>
      <VoiceButton label="Speak the remarks" onText={x => setNote(n => appendSpoken(n, x))} />
      {(status === 'done' || status === 'blocked') && <label className="field">Photo{n.photo && status === 'done' ? ' (needed)' : ' (optional)'}
        <input type="file" accept="image/*" capture="environment" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>}
      {status === 'blocked' && !row.check?.work_order_id && <label className="check"><input type="checkbox" checked={raise} onChange={e => setRaise(e.target.checked)} />
        Raise a work order so this gets fixed</label>}
      <ErrorNote error={error} />
      <button className="primary" disabled={busy} onClick={save}>Save</button>
    </>}
  </Sheet>;
}

// ================================================================== Work orders
export function WorkOrders() {
  const { me } = useApp();
  const [view, setView] = useState(query().get('view') ?? (can(me, 'operations.manage') ? 'open' : 'mine'));
  const [q, setQ] = useState('');
  const { data, loading, error } = useApi<any[]>(`/api/work?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  if (!isStaff(me)) { navigate('/requests'); return null; }
  return <>
    <PageHead title="Work orders">{(can(me, 'operations.manage') || can(me, 'operations.update')) &&
      <Link to="/work/orders/new" className="button primary">New work order</Link>}</PageHead>
    <WorkTabs />
    <div className="head-row">
      <div className="tabs" role="group" aria-label="Show">
        {[['open', 'Open'], ['mine', 'Given to me'], ['requests', 'Service requests'], ['overdue', 'Overdue'], ['done', 'To verify'], ['closed', 'Closed']].map(([k, l]) =>
          <button key={k} aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}
      </div>
      <input className="search" type="search" placeholder="Search by title, number or home" value={q} onChange={e => setQ(e.target.value)} />
    </div>
    <ErrorNote error={error} />
    {loading && !data ? <Loading /> : <WorkRows rows={data ?? []} empty={view === 'mine' ? 'Nothing is given to you right now.' : 'No work orders here.'} />}
  </>;
}

function WorkRows({ rows, empty }: { rows: any[]; empty: string }) {
  return <div className="rows">{rows.length ? rows.map(w => <Link key={w.id} to={`/work/orders/${w.id}`} className="row">
    <span><span className="title">{w.title}</span><br />
      <span className="meta">{w.ref}, {KIND[w.kind]}. {w.unit ? `${w.unit}, ` : ''}{w.place}{w.assignee ? `. ${w.assignee}` : ''}</span></span>
    <span className="side">{['urgent', 'high'].includes(w.priority) && <span className={`tag pri-${w.priority}`}>{PRIORITY[w.priority]}</span>}{' '}
      <span className={`tag w-${w.status}`}>{WORK_STATUS[w.status]}</span><br />
      <span className={w.overdue ? 'stop' : 'quiet'}>{w.due_on ? `${w.overdue ? 'Overdue, was due' : 'Due'} ${shortDate(w.due_on)}` : shortDate(w.created_at)}</span></span>
  </Link>) : <p className="empty">{empty}</p>}</div>;
}

export function WorkOrderView({ id }: { id: string }) {
  const { me, refreshMe } = useApp();
  const { data: w, loading, error, reload } = useApi(`/api/work/${id}`);
  const [move, setMove] = useState<any>(null);
  const [edit, setEdit] = useState(false);
  const act = useAction();
  if (loading && !w) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const staffView = isStaff(me);
  const back = staffView ? { to: '/work/orders', label: 'Work orders' } : { to: '/requests', label: 'My requests' };
  const doMove = (to: string, note = '') => act.run(async () => { await api.post(`/api/work/${id}/status`, { to, note }); setMove(null); reload(); });
  return <>
    <PageHead title={w.title} crumbs={[back, { label: w.ref }]}>
      <span>{['urgent', 'high'].includes(w.priority) && <span className={`tag pri-${w.priority}`}>{PRIORITY[w.priority]}</span>} <span className={`tag w-${w.status}`}>{w.statusLabel}</span></span>
    </PageHead>
    <dl className="facts">
      <div><dt>Kind</dt><dd>{KIND[w.kind]}, {CATEGORY[w.category].toLowerCase()}</dd></div>
      <div><dt>Place</dt><dd>{w.unit ? `${w.unit}, ` : ''}{w.place}</dd></div>
      {w.asset && <div><dt>Asset</dt><dd>{staffView ? <Link to={`/work/assets/${w.assetId}`}>{w.asset}</Link> : w.asset}</dd></div>}
      <div><dt>Raised by</dt><dd>{w.raisedBy}, {shortDate(w.createdAt)}</dd></div>
      <div><dt>Given to</dt><dd>{w.assignee ?? 'Not yet'}</dd></div>
      {w.dueOn && <div><dt>Due</dt><dd>{shortDate(w.dueOn)}</dd></div>}
      {w.estimatePaise && <div><dt>Estimate</dt><dd>{rupees(w.estimatePaise)}</dd></div>}
      {w.approval && <div><dt>Approval</dt><dd><Link to={`/approvals/${w.approval.id}`}>{w.approval.ref}</Link>, {w.approval.status}</dd></div>}
      {w.routineRef && <div><dt>From routine</dt><dd><Link to={`/work/routines/${w.routineId}`}>{w.routineRef}</Link>, {shortDate(w.occurrenceOn)}</dd></div>}
    </dl>
    {w.details && <p style={{ maxWidth: '68ch', whiteSpace: 'pre-wrap' }}>{w.details}</p>}
    {(w.actions.moves.length > 0 || w.actions.edit || w.actions.requestApproval) && <div className="actions">
      {w.actions.moves.map((m: any, i: number) => <button key={m.to} className={i === 0 ? 'primary' : ''} disabled={act.busy}
        onClick={() => m.needsNote || m.to === 'cancelled' ? setMove(m) : doMove(m.to)}>{m.label}</button>)}
      {w.actions.edit && <button onClick={() => setEdit(true)}>Assign or change</button>}
      {w.actions.requestApproval && <button disabled={act.busy} onClick={() => act.run(async () => {
        const r = await api.post(`/api/work/${id}/approval`, {}); refreshMe(); navigate(`/approvals/${r.id}`); })}>Send for approval</button>}
    </div>}
    <ErrorNote error={act.error} />
    {w.permit && <Permit w={w} onChange={reload} />}
    {staffView && seesProcurement(me) && <Quotations workId={id} onChange={reload} />}
    {(w.kind === 'project' || w.contract) && <Delivery workId={id} onChange={reload} />}
    <section>
      <header><h2>Updates</h2></header>
      <ol className="trail">{w.updates.map((u: any) => <li key={u.id} className={`k-${u.kind}${u.staff_only ? ' staff' : ''}`}>
        <span className="when">{when(u.at)}</span>
        <div><strong>{u.by}</strong>{' '}{u.kind === 'status' ? <>moved it to <b>{WORK_STATUS[u.to_status]?.toLowerCase()}</b></>
          : u.kind === 'created' ? 'raised it' : u.kind === 'photo' ? 'added a photo' : u.kind === 'assigned' ? '' : u.kind === 'approval' ? '' : ''}
          {u.staff_only && <span className="tag staff-tag">Staff only</span>}
          {u.body && <p className={u.kind === 'note' || u.kind === 'status' || u.kind === 'photo' ? '' : 'quiet'}>{u.body}</p>}
          {u.file_id && <a href={`/api/files/${u.file_id}`}><img className="thumb" src={`/api/files/${u.file_id}`} alt="Photo attached to this update" /></a>}
        </div>
      </li>)}</ol>
      {w.actions.note && <NoteForm id={id} staff={w.actions.staffNote} onDone={reload} />}
    </section>
    <Sheet open={!!move} onClose={() => setMove(null)} title={move?.label ?? ''}>
      <MoveForm move={move} busy={act.busy} error={act.error} onSave={(note: string) => doMove(move.to, note)} />
    </Sheet>
    {edit && <EditWork w={w} onClose={() => setEdit(false)} onDone={() => { setEdit(false); reload(); }} />}
  </>;
}

function MoveForm({ move, busy, error, onSave }: { move: any; busy: boolean; error: string | null; onSave: (n: string) => void }) {
  const [note, setNote] = useState('');
  if (!move) return null;
  const label = move.to === 'done' ? 'What was done' : move.to === 'on_hold' ? 'What it is waiting for' : move.needsNote ? 'Reason' : 'Note (optional)';
  return <>
    <label className="field">{label}<textarea value={note} onChange={e => setNote(e.target.value)} /></label>
    <VoiceButton onText={x => setNote(n => appendSpoken(n, x))} />
    <ErrorNote error={error} />
    <button className="primary" disabled={busy || (move.needsNote && !note.trim())} onClick={() => onSave(note)}>{move.label}</button>
  </>;
}

function NoteForm({ id, staff, onDone }: { id: string; staff: boolean; onDone: () => void }) {
  const [body, setBody] = useState('');
  const [staffOnly, setStaffOnly] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState(0);
  const { busy, error, run } = useAction();
  return <form className="form panel pad" onSubmit={e => { e.preventDefault(); run(async () => {
    const fileId = file ? (await api.upload('/api/files?purpose=work_photo', file)).id : null;
    await api.post(`/api/work/${id}/updates`, { body, staffOnly, fileId });
    setBody(''); setFile(null); setStaffOnly(false); setKey(k => k + 1); onDone();
  }); }}>
    <label className="field">Add an update<textarea value={body} onChange={e => setBody(e.target.value)} placeholder="What happened, what is needed next" /></label>
    <VoiceButton label="Speak the update" onText={x => setBody(b => appendSpoken(b, x))} />
    <div className="two">
      <label className="field">Photo (optional)<input key={key} type="file" accept="image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
      {staff && <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={staffOnly} onChange={e => setStaffOnly(e.target.checked)} />
        Staff only: the person who raised it will not see this</label>}
    </div>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy || (!body.trim() && !file)}>Add update</button></div>
  </form>;
}

function EditWork({ w, onClose, onDone }: { w: any; onClose: () => void; onDone: () => void }) {
  const people = useApi<any[]>('/api/ops/people');
  const [f, setF] = useState({ assigneeId: w.assigneeId ?? '', dueOn: w.dueOn ?? '', priority: w.priority, category: w.category,
    estimate: w.estimatePaise ? String(Number(w.estimatePaise) / 100) : '' });
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <Sheet open onClose={onClose} title="Assign or change">
    {people.loading ? <Loading /> : <PersonSelect label="Given to" value={f.assigneeId} onChange={v => setF({ ...f, assigneeId: v })} people={people.data ?? []} />}
    <div className="form two">
      <label className="field">Due by<input type="date" value={f.dueOn} onChange={set('dueOn')} /></label>
      <label className="field">Priority<select value={f.priority} onChange={set('priority')}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">Kind of work<select value={f.category} onChange={set('category')}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">Estimate, ₹<input inputMode="decimal" value={f.estimate} onChange={set('estimate')} /></label>
    </div>
    <ErrorNote error={error} />
    <button className="primary" disabled={busy} onClick={() => run(async () => {
      await api.patch(`/api/work/${w.id}`, { assigneeId: f.assigneeId || null, dueOn: f.dueOn || null, priority: f.priority, category: f.category, estimate: f.estimate || null });
      onDone();
    })}>Save</button>
  </Sheet>;
}

export function WorkOrderNew() {
  const { me } = useApp();
  const { places, loading } = useTree();
  const people = useApi<any[]>(can(me, 'operations.manage') ? '/api/ops/people' : null);
  const assets = useApi<any[]>(seesAll(me) ? '/api/assets' : null);
  const qs = query();
  const [f, setF] = useState({ kind: can(me, 'operations.manage') ? 'maintenance' : 'incident', title: '', details: '', category: 'general', priority: 'normal',
    nodeId: '', assetId: qs.get('asset') ?? '', assigneeId: '', dueOn: '', estimate: '' });
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  useEffect(() => {
    const a = assets.data?.find(x => x.id === f.assetId);
    if (a && !f.nodeId) { const p = places.find(n => n.name === a.place.split(' › ').pop()); if (p) setF(x => ({ ...x, nodeId: p.id })); }
  }, [assets.data, places.length]);
  if (loading) return <Loading />;
  const mgr = can(me, 'operations.manage');
  return <>
    <PageHead title="New work order" crumbs={[{ to: '/work/orders', label: 'Work orders' }]} />
    <form className="form" style={{ maxWidth: 680 }} onSubmit={e => { e.preventDefault(); run(async () => {
      const r = await api.post('/api/work', { ...f, assetId: f.assetId || null, assigneeId: f.assigneeId || null, dueOn: f.dueOn || null, estimate: f.estimate || null,
        nodeId: f.nodeId || undefined });
      navigate(`/work/orders/${r.id}`);
    }); }}>
      <div className="two">
        <label className="field">Kind<select value={f.kind} onChange={set('kind')}>
          <option value="incident">Incident: something went wrong</option><option value="maintenance">Maintenance</option>
          {mgr && <option value="project">Project</option>}</select></label>
        <label className="field">Kind of work<select value={f.category} onChange={set('category')}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <label className="field">What needs doing<input required minLength={3} value={f.title} onChange={set('title')} placeholder="For example, Sky B lift 3 door not closing" /></label>
      <label className="field">Details<textarea value={f.details} onChange={set('details')} /></label>
      <div className="two">
        <PlaceSelect value={f.nodeId} onChange={v => setF({ ...f, nodeId: v })} places={places} />
        {(assets.data?.length ?? 0) > 0 && <label className="field">Asset (optional)<select value={f.assetId} onChange={set('assetId')}>
          <option value="">None</option>{assets.data!.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
      </div>
      <div className="two">
        <label className="field">Priority<select value={f.priority} onChange={set('priority')}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {mgr && <PersonSelect label="Give to" value={f.assigneeId} onChange={v => setF({ ...f, assigneeId: v })} people={people.data ?? []} />}
        {mgr && <label className="field">Due by<input type="date" value={f.dueOn} onChange={set('dueOn')} /></label>}
        {mgr && <label className="field">Estimate, ₹<input inputMode="decimal" value={f.estimate} onChange={set('estimate')} /></label>}
      </div>
      <ErrorNote error={error} />
      <div className="actions"><button className="primary" disabled={busy}>Raise work order</button></div>
    </form>
  </>;
}

// ================================================================== Service requests (owners and residents)
export function Requests() {
  const { me } = useApp();
  const { data, loading, reload } = useApi<any[]>('/api/work?view=raised');
  const [f, setF] = useState({ unitId: me.homes[0]?.id ?? '', title: '', details: '', category: 'general', urgent: false, permitKind: '' });
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState(0);
  const { busy, error, run } = useAction();
  const homes = me.homes.filter((h, i, a) => a.findIndex(x => x.id === h.id) === i);
  return <>
    <PageHead title="My requests" />
    {homes.length > 0 ? <form className="form panel pad" style={{ maxWidth: 680 }} onSubmit={e => { e.preventDefault(); run(async () => {
      const r = await api.post('/api/work', { kind: 'request', unitId: f.unitId, title: f.title, details: f.details, category: f.category, priority: f.urgent ? 'urgent' : 'normal',
        permitKind: f.permitKind || null });
      if (file) {
        const up = await api.upload('/api/files?purpose=work_photo', file);
        await api.post(`/api/work/${r.id}/updates`, { body: 'Photo', fileId: up.id });
      }
      setF({ ...f, title: '', details: '', urgent: false, permitKind: '' }); setFile(null); setKey(k => k + 1); reload();
    }); }}>
      <h2>Raise a request</h2>
      <div className="two">
        {homes.length > 1 && <label className="field">For<select value={f.unitId} onChange={e => setF({ ...f, unitId: e.target.value })}>
          {homes.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}</select></label>}
        <label className="field">Kind of problem<select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>
          {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <label className="field">What is the problem<input required minLength={3} value={f.title} onChange={e => setF({ ...f, title: e.target.value })}
        placeholder="For example, water leaking from the bathroom ceiling" /></label>
      <label className="field">More details (optional)<textarea value={f.details} onChange={e => setF({ ...f, details: e.target.value })}
        placeholder="When it started, the best time to visit" /></label>
      <VoiceButton label="Speak the problem" onText={x => setF(v => v.title.trim() ? { ...v, details: appendSpoken(v.details, x) }
        : { ...v, title: appendSpoken('', x).slice(0, 120), details: x.length > 120 ? appendSpoken(v.details, x) : v.details })} />
      <label className="field">Photo (optional)<input key={key} type="file" accept="image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
      <label className="field">Does this need the committee's permission?<select value={f.permitKind} onChange={e => setF({ ...f, permitKind: e.target.value })}>
        <option value="">No: it is a problem to fix</option>{Object.entries(PERMIT_KINDS).map(([k, v]) => <option key={k} value={k}>Yes: {v.toLowerCase()}</option>)}</select></label>
      <label className="check"><input type="checkbox" checked={f.urgent} onChange={e => setF({ ...f, urgent: e.target.checked })} />This is urgent (a safety risk, no water or no power)</label>
      <ErrorNote error={error} />
      <div className="actions"><button className="primary" disabled={busy}>Send request</button></div>
    </form> : <p className="note">Requests are raised for your home. Your association office will link your home to your account.</p>}
    <section>
      <header><h2>Requests you raised</h2></header>
      {loading && !data ? <Loading /> : <WorkRows rows={data ?? []} empty="You have not raised any requests yet." />}
    </section>
  </>;
}

// ================================================================== Routines
export function RoutineList() {
  const { me } = useApp();
  const { data, loading, error } = useApi<any[]>('/api/routines');
  const [cat, setCat] = useState('');
  if (!isStaff(me)) { navigate('/requests'); return null; }
  const rows = (data ?? []).filter(r => !cat || r.category === cat);
  const cats = [...new Set((data ?? []).map(r => r.category))];
  return <>
    <PageHead title="Routines">{can(me, 'operations.manage') && <span className="actions"><Link to="/work/qr" className="button">QR labels for places</Link>
      <Link to="/work/routines/new" className="button primary">New routine</Link></span>}</PageHead>
    <WorkTabs />
    {cats.length > 1 && <div className="tabs" role="group" aria-label="Kind of work">
      <button aria-pressed={!cat} onClick={() => setCat('')}>All</button>
      {cats.map(c => <button key={c} aria-pressed={cat === c} onClick={() => setCat(c)}>{CATEGORY[c]}</button>)}</div>}
    <ErrorNote error={error} />
    {loading && !data ? <Loading /> : <div className="rows">{rows.length ? rows.map(r => {
      const pct = r.last30.due ? Math.round((r.last30.done / r.last30.due) * 100) : null;
      return <Link key={r.id} to={`/work/routines/${r.id}`} className="row">
        <span><span className="title">{r.title}</span><br /><span className="meta">{r.schedule}. {r.place}{r.assignee ? `. ${r.assignee}` : ''}</span></span>
        <span className="side">{pct === null ? <span className="quiet">Not due yet</span> : <>
          <span className={`num ${pct < 85 ? 'stop' : ''}`}>{pct}% done</span><br />
          <span className="quiet">{r.last30.done} of {r.last30.due}{r.last30.missed ? `, ${r.last30.missed} missed` : ''}</span></>}</span>
      </Link>;
    }) : <p className="empty">No routines yet.{can(me, 'operations.manage') ? ' Add the checks your staff do every day, week or month.' : ''}</p>}</div>}
    {(data?.length ?? 0) > 0 && <p className="faint">Done in the last 30 days, out of the checks that were due.</p>}
  </>;
}

export function RoutineView({ id }: { id: string }) {
  const { data: r, loading, error, reload } = useApi(`/api/routines/${id}`);
  const [edit, setEdit] = useState(false);
  const [open, setOpen] = useState<any>(null);
  const act = useAction();
  if (loading && !r) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const past = r.days.filter((d: any) => d.day <= r.today);
  const upcoming = r.days.filter((d: any) => d.day > r.today).reverse().slice(0, 5);
  return <>
    <PageHead title={r.title} crumbs={[{ to: '/work/routines', label: 'Routines' }, { label: r.ref }]}>
      {r.archivedAt && <span className="tag">Stopped</span>}
    </PageHead>
    <dl className="facts">
      <div><dt>When</dt><dd>{r.schedule}</dd></div>
      <div><dt>Place</dt><dd>{r.place}</dd></div>
      <div><dt>Given to</dt><dd>{r.assignee ?? 'Nobody yet'}{r.backup ? `; backup ${r.backup}` : ''}</dd></div>
      {r.asset && <div><dt>Asset</dt><dd><Link to={`/work/assets/${r.assetId}`}>{r.asset}</Link></dd></div>}
      <div><dt>Kind of work</dt><dd>{CATEGORY[r.category]}</dd></div>
    </dl>
    {r.instructions && <p style={{ maxWidth: '68ch', whiteSpace: 'pre-wrap' }}>{r.instructions}</p>}
    {r.canManage && <div className="actions">
      <button onClick={() => setEdit(true)}>Change</button>
      <button disabled={act.busy} onClick={() => act.run(async () => { await api.post(`/api/routines/${id}/archive`, {}); reload(); })}>{r.archivedAt ? 'Start again' : 'Stop this routine'}</button>
    </div>}
    <section>
      <header><h2>Last 30 days</h2></header>
      <div className="strip" role="list" aria-label="Each scheduled day, oldest first">
        {[...past].reverse().map((d: any) => <button key={d.day} role="listitem" className={`cell s-${d.status}${d.late ? ' late' : ''}`}
          title={`${dayLabel(d.day, r.today)}: ${DAY_STATUS[d.status]}${d.late ? ', late' : ''}`} onClick={() => setOpen(d)}>
          <span>{new Date(d.day + 'T00:00:00Z').getUTCDate()}</span></button>)}
      </div>
      <p className="legend">{['done', 'missed', 'skipped', 'blocked', 'due'].map(s => <span key={s}><i className={`cell s-${s}`} />{DAY_STATUS[s]}</span>)}
        <span><i className="cell s-done late" />Done late</span></p>
    </section>
    <section>
      <header><h2>Recent days</h2>{upcoming.length > 0 && <span className="quiet">Next: {upcoming.map((d: any) => dayLabel(d.day, r.today)).join(', ')}</span>}</header>
      <div className="rows">{past.slice(0, 14).map((d: any) => <button key={d.day} className={`row check-row s-${d.status}`} onClick={() => setOpen(d)}>
        <span className="mark" aria-hidden="true" />
        <span><span className="title">{dayLabel(d.day, r.today)}</span><br /><span className="meta">
          {d.check ? `${d.check.recorded_by}${d.check.performed_at ? ` at ${timeOf(d.check.performed_at)}` : ''}${d.check.reading ? `. ${Number(d.check.reading)} ${d.needs.reading?.unit ?? ''}` : ''}` : 'Nothing recorded'}
          {d.check?.note ? `. “${d.check.note}”` : ''}</span></span>
        <span className="side"><span className={`tag day-${d.status}`}>{DAY_STATUS[d.status]}{d.late ? ', late' : ''}</span></span>
      </button>)}</div>
    </section>
    {r.versions.length > 1 && <section>
      <header><h2>Schedule history</h2></header>
      <div className="rows">{r.versions.map((v: any) => <div key={v.effective_from} className="row">
        <span><span className="title">{v.summary}</span><br /><span className="meta">From {shortDate(v.effective_from)}{v.by ? `, set by ${v.by}` : ''}</span></span></div>)}</div>
    </section>}
    {open && <CheckSheet row={{ ...open, canRecord: r.canRecord && !r.archivedAt }} day={open.day} today={r.today} onClose={() => setOpen(null)} onDone={() => { setOpen(null); reload(); }} />}
    {edit && <Sheet open onClose={() => setEdit(false)} title="Change this routine"><RoutineForm existing={r} onDone={() => { setEdit(false); reload(); }} /></Sheet>}
  </>;
}

export function RoutineNew() {
  return <>
    <PageHead title="New routine" crumbs={[{ to: '/work/routines', label: 'Routines' }]} />
    <div style={{ maxWidth: 680 }}><RoutineForm onDone={id => navigate(`/work/routines/${id}`)} /></div>
  </>;
}

function RoutineForm({ existing, onDone }: { existing?: any; onDone: (id: string) => void }) {
  const { places, loading } = useTree();
  const people = useApi<any[]>('/api/ops/people');
  const assets = useApi<any[]>('/api/assets');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const c = existing?.current;
  const [f, setF] = useState(() => ({
    title: existing?.title ?? '', instructions: existing?.instructions ?? '', category: existing?.category ?? 'general', nodeId: existing?.nodeId ?? '',
    assetId: existing?.assetId ?? '', assigneeId: existing?.assigneeId ?? '', backupId: existing?.backupId ?? '',
    frequency: c?.frequency ?? 'daily', every: String(c?.every ?? 1), weekdays: (c?.weekdays ?? [1]) as number[],
    monthDays: (c?.month_days ?? [1]).map((d: number) => d === 31 ? 'last' : String(d)).join(', '),
    startsOn: c?.starts_on ?? today, endsOn: c?.ends_on ?? '', startTime: c?.start_time ?? '', endTime: c?.end_time ?? '',
    remarks: c?.remarks ?? 'exception', readingLabel: c?.reading_label ?? '', readingUnit: c?.reading_unit ?? '', photoRequired: !!c?.photo_required,
    referenceRequired: !!c?.reference_required, effectiveFrom: today, paused: !!c?.paused,
  }));
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  if (loading) return <Loading />;
  const monthly = ['monthly', 'quarterly', 'half_yearly', 'annually'].includes(f.frequency);
  const save = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    const monthDays = f.monthDays.split(/[,\s]+/).filter(Boolean).map((s: string) => s.toLowerCase() === 'last' ? 31 : Number(s));
    const schedule = { frequency: f.frequency, every: Number(f.every) || 1, weekdays: f.weekdays, monthDays, startsOn: f.startsOn, endsOn: f.endsOn || null,
      startTime: f.startTime || null, endTime: f.endTime || null, remarks: f.remarks, readingLabel: f.readingLabel || null, readingUnit: f.readingUnit || null,
      photoRequired: f.photoRequired, referenceRequired: f.referenceRequired, paused: f.paused, ...(existing ? { effectiveFrom: f.effectiveFrom } : {}) };
    const body = { title: f.title, instructions: f.instructions, category: f.category, nodeId: f.nodeId, assetId: f.assetId || null,
      assigneeId: f.assigneeId || null, backupId: f.backupId || null, schedule };
    if (existing) { await api.patch(`/api/routines/${existing.id}`, body); onDone(existing.id); }
    else { const r = await api.post('/api/routines', body); onDone(r.id); }
  }); };
  return <form className="form" onSubmit={save}>
    <label className="field">What is checked<input required minLength={3} value={f.title} onChange={set('title')} placeholder="For example, pool chlorine and pH check" /></label>
    <label className="field">Instructions (optional)<textarea value={f.instructions} onChange={set('instructions')} placeholder="What to look at, what to record, whom to call" /></label>
    <div className="two">
      <PlaceSelect value={f.nodeId} onChange={v => setF({ ...f, nodeId: v })} places={places} />
      <label className="field">Kind of work<select value={f.category} onChange={set('category')}>{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <PersonSelect label="Given to" value={f.assigneeId} onChange={v => setF({ ...f, assigneeId: v })} people={people.data ?? []} />
      <PersonSelect label="Backup" value={f.backupId} onChange={v => setF({ ...f, backupId: v })} people={people.data ?? []} none="No backup" />
      {(assets.data?.length ?? 0) > 0 && <label className="field">Asset (optional)<select value={f.assetId} onChange={set('assetId')}>
        <option value="">None</option>{assets.data!.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
    </div>
    <fieldset className="panel pad form">
      <legend>When it is due</legend>
      <div className="two">
        <label className="field">How often<select value={f.frequency} onChange={set('frequency')}>
          <option value="daily">Every day</option><option value="weekly">On days of the week</option><option value="monthly">On days of the month</option>
          <option value="quarterly">Every three months</option><option value="half_yearly">Every six months</option><option value="annually">Every year</option>
          <option value="once">Once</option></select></label>
        {['daily', 'weekly', 'monthly'].includes(f.frequency) && <label className="field">Repeat every<input type="number" min={1} max={f.frequency === 'daily' ? 366 : f.frequency === 'weekly' ? 52 : 12}
          value={f.every} onChange={set('every')} /><span className="hint">{f.frequency === 'daily' ? 'days' : f.frequency === 'weekly' ? 'weeks' : 'months'}</span></label>}
      </div>
      {f.frequency === 'weekly' && <div className="tabs" role="group" aria-label="Days of the week">{WEEKDAYS.map((d, i) =>
        <button type="button" key={d} aria-pressed={f.weekdays.includes(i)} onClick={() => setF({ ...f, weekdays: f.weekdays.includes(i) ? f.weekdays.filter(x => x !== i) : [...f.weekdays, i] })}>{d}</button>)}</div>}
      {monthly && <label className="field">Days of the month<input value={f.monthDays} onChange={set('monthDays')} placeholder="1, 15, last" />
        <span className="hint">Use "last" for the last day of the month. {f.frequency !== 'monthly' ? 'Counted from the month it starts.' : ''}</span></label>}
      <div className="two">
        <label className="field">{f.frequency === 'once' ? 'On' : 'Starting'}<input type="date" required value={f.startsOn} onChange={set('startsOn')} /></label>
        {f.frequency !== 'once' && <label className="field">Ending (optional)<input type="date" value={f.endsOn} onChange={set('endsOn')} /></label>}
        <label className="field">From (optional)<input type="time" value={f.startTime} onChange={set('startTime')} /></label>
        <label className="field">Until (optional)<input type="time" value={f.endTime} onChange={set('endTime')} /><span className="hint">After this it counts as missed, and work recorded later counts as late.</span></label>
      </div>
    </fieldset>
    <fieldset className="panel pad form">
      <legend>What staff record when it is done</legend>
      <label className="field">Remarks<select value={f.remarks} onChange={set('remarks')}>
        <option value="exception">Only when something is wrong</option><option value="optional">Optional</option><option value="required">Always</option></select></label>
      <div className="two">
        <label className="field">A reading (optional)<input value={f.readingLabel} onChange={set('readingLabel')} placeholder="For example, Free chlorine" /></label>
        <label className="field">Its unit<input value={f.readingUnit} onChange={set('readingUnit')} placeholder="ppm" /></label>
      </div>
      <label className="check"><input type="checkbox" checked={f.photoRequired} onChange={set('photoRequired')} />A photo is needed</label>
      <label className="check"><input type="checkbox" checked={f.referenceRequired} onChange={set('referenceRequired')} />A reference number is needed (a gate pass or a vendor's job card)</label>
    </fieldset>
    {existing && <div className="two">
      <label className="field">These changes apply from<input type="date" min={today} value={f.effectiveFrom} onChange={set('effectiveFrom')} />
        <span className="hint">Days before this keep the old schedule.</span></label>
      <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.paused} onChange={set('paused')} />Pause from that day</label>
    </div>}
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>{existing ? 'Save changes' : 'Set up routine'}</button></div>
  </form>;
}

// ================================================================== Assets and renewals
export function AssetList() {
  const { me } = useApp();
  const assets = useApi<any[]>('/api/assets');
  const due = useApi<any[]>('/api/renewals?within=60');
  const [sheet, setSheet] = useState(false);
  const byPlace = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const a of assets.data ?? []) m.set(a.place, [...(m.get(a.place) ?? []), a]);
    return [...m.entries()];
  }, [assets.data]);
  return <>
    <PageHead title="Assets and renewals">{can(me, 'operations.manage') && <div className="actions">
      <Link to="/work/assets/new" className="button primary">Add an asset</Link>
      <button onClick={() => setSheet(true)}>Add a renewal</button></div>}</PageHead>
    <WorkTabs />
    <section>
      <header><h2>Renewals due</h2><span className="quiet">Overdue, and due in the next 60 days</span></header>
      {due.loading && !due.data ? <Loading /> : <RenewalRows rows={due.data ?? []} onChange={() => { due.reload(); assets.reload(); }} />}
    </section>
    <section>
      <header><h2>Register</h2></header>
      <ErrorNote error={assets.error} />
      {assets.loading && !assets.data ? <Loading /> : byPlace.length ? byPlace.map(([place, rows]) => <div key={place} style={{ display: 'grid', gap: 8 }}>
        <h3>{place}</h3>
        <div className="rows">{rows.map(a => <Link key={a.id} to={`/work/assets/${a.id}`} className="row">
          <span><span className="title">{a.name}</span><br /><span className="meta">{a.ref}, {ASSET_KIND[a.kind]}{a.facility ? `, ${a.facility}` : ''}{a.service_by ? `. Serviced by ${a.service_by}` : ''}</span></span>
          <span className="side">{a.overdue ? <span className="tag w-overdue">Renewal overdue</span> : a.next_renewal ? <span className="quiet">Renew by {shortDate(a.next_renewal)}</span> : null}
            {a.open_work > 0 && <><br /><span className="quiet">{a.open_work} open work</span></>}</span>
        </Link>)}</div>
      </div>) : <p className="empty rows">No assets yet. Add lifts, generators, pumps and other equipment to keep their AMCs and service history together.</p>}
    </section>
    {sheet && <Sheet open onClose={() => setSheet(false)} title="Add a renewal"><ContractForm onDone={() => { setSheet(false); due.reload(); assets.reload(); }} /></Sheet>}
  </>;
}

function RenewalRows({ rows, onChange, history }: { rows: any[]; onChange: () => void; history?: boolean }) {
  const { me } = useApp();
  const [renew, setRenew] = useState<any>(null);
  return <>
    <div className="rows">{rows.length ? rows.map(c => <div key={c.id} className="row">
      <span><span className="title">{c.title}</span><br /><span className="meta">{c.ref}, {CONTRACT_KIND[c.kind]}{c.provider ? `, ${c.provider}` : ''}
        {c.asset && !history ? `. ${c.asset}` : ''}{c.amount_paise ? `. ${rupees(c.amount_paise)}` : ''}</span></span>
      <span className="side"><span className={`tag r-${c.state}`}>{c.state === 'overdue' ? `Ended ${shortDate(c.ends_on)}` : c.state === 'renewed' ? 'Renewed'
        : c.state === 'due' ? `Ends ${shortDate(c.ends_on)}` : `Until ${shortDate(c.ends_on)}`}</span>
        {c.file_id && <><br /><a href={`/api/files/${c.file_id}`}>Document</a></>}
        {can(me, 'operations.manage') && ['overdue', 'due', 'active'].includes(c.state) && <><br /><button className="quiet-btn" onClick={() => setRenew(c)}>Renew</button></>}</span>
    </div>) : <p className="empty">{history ? 'Nothing recorded yet.' : 'Nothing is due in the next 60 days.'}</p>}</div>
    {renew && <Sheet open onClose={() => setRenew(null)} title={`Renew: ${renew.title}`}><ContractForm renewing={renew} onDone={() => { setRenew(null); onChange(); }} /></Sheet>}
  </>;
}

function ContractForm({ renewing, assetId, onDone }: { renewing?: any; assetId?: string; onDone: () => void }) {
  const { places } = useTree();
  const assets = useApi<any[]>(renewing || assetId ? null : '/api/assets');
  const [f, setF] = useState({ assetId: assetId ?? '', nodeId: '', kind: 'amc', title: '', provider: renewing?.provider ?? '', reference: '',
    startsOn: renewing?.ends_on ?? '', endsOn: '', amount: '', notes: '' });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const fileId = file ? (await api.upload('/api/files?purpose=contract', file)).id : null;
    if (renewing) await api.post(`/api/renewals/${renewing.id}/renew`, { startsOn: f.startsOn || null, endsOn: f.endsOn, provider: f.provider || null,
      reference: f.reference || null, amount: f.amount || null, fileId, notes: f.notes });
    else await api.post('/api/renewals', { assetId: f.assetId || null, nodeId: f.assetId ? undefined : f.nodeId || undefined, kind: f.kind, title: f.title,
      provider: f.provider || null, reference: f.reference || null, startsOn: f.startsOn || null, endsOn: f.endsOn, amount: f.amount || null, fileId, notes: f.notes });
    onDone();
  }); }}>
    {!renewing && <>
      <label className="field">What it is<input required minLength={3} value={f.title} onChange={set('title')} placeholder="For example, Lift AMC or Fire NOC" /></label>
      <div className="two">
        <label className="field">Kind<select value={f.kind} onChange={set('kind')}>{Object.entries(CONTRACT_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {!assetId && <label className="field">For an asset<select value={f.assetId} onChange={set('assetId')}><option value="">No, for a place</option>
          {(assets.data ?? []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
      </div>
      {!f.assetId && !assetId && <PlaceSelect value={f.nodeId} onChange={v => setF({ ...f, nodeId: v })} places={places} />}
    </>}
    <div className="two">
      <label className="field">Provider<input value={f.provider} onChange={set('provider')} /></label>
      <label className="field">Policy or certificate number<input value={f.reference} onChange={set('reference')} /></label>
      <label className="field">Starts<input type="date" value={f.startsOn} onChange={set('startsOn')} /></label>
      <label className="field">Ends<input type="date" required value={f.endsOn} onChange={set('endsOn')} /></label>
      <label className="field">Amount, ₹<input inputMode="decimal" value={f.amount} onChange={set('amount')} /></label>
      <label className="field">Document (optional)<input type="file" accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
    </div>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>{renewing ? 'Record the renewal' : 'Save'}</button></div>
  </form>;
}

export function AssetView({ id }: { id: string }) {
  const { data: a, loading, error, reload } = useApi(`/api/assets/${id}`);
  const [sheet, setSheet] = useState(false);
  const [log, setLog] = useState(false);
  if (loading && !a) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  return <>
    <PageHead title={a.name} crumbs={[{ to: '/work/assets', label: 'Assets and renewals' }, { label: a.ref }]} />
    <dl className="facts">
      <div><dt>Kind</dt><dd>{ASSET_KIND[a.kind]}</dd></div>
      <div><dt>Place</dt><dd>{a.place}{a.facility ? `, ${a.facility}` : ''}</dd></div>
      {a.service_by && <div><dt>Serviced by</dt><dd>{a.service_by}</dd></div>}
      {(a.make || a.model) && <div><dt>Make and model</dt><dd>{[a.make, a.model].filter(Boolean).join(' ')}</dd></div>}
      {a.serial_no && <div><dt>Serial number</dt><dd>{a.serial_no}</dd></div>}
      {a.installed_on && <div><dt>Installed</dt><dd>{shortDate(a.installed_on)}</dd></div>}
    </dl>
    {a.notes && <p style={{ maxWidth: '68ch', whiteSpace: 'pre-wrap' }}>{a.notes}</p>}
    <div className="actions">
      <Link to={`/work/orders/new?asset=${a.id}`} className="button">Raise a work order</Link>
      {a.canManage && <button onClick={() => setSheet(true)}>Add a renewal</button>}
    </div>
    <section><header><h2>Service and inspection log</h2>{a.canLog && <button onClick={() => setLog(true)}>Record a service or inspection</button>}</header>
      {a.nextServiceOn && <p className={a.serviceOverdue ? 'note' : 'quiet'}>Next service {a.serviceOverdue ? 'was due' : 'due'} on {shortDate(a.nextServiceOn)}.</p>}
      <div className="rows">{a.services.length ? a.services.map((x: any) => <div key={x.id} className="row">
        <span><span className="title">{shortDate(x.serviced_on)}: {SERVICE_KIND[x.kind]} by {x.provider}</span><br />
          <span className="meta">{x.notes || 'No remarks'}{x.next_due_on ? `. Next due ${shortDate(x.next_due_on)}` : ''}. Recorded by {x.recorded_by_name}</span>
          {(x.file_id || x.work_ref) && <><br /><span className="meta">{x.file_id && <a href={`/api/files/${x.file_id}`}>{x.file_name}</a>}{x.file_id && x.work_ref ? '; ' : ''}
            {x.work_ref && <Link to={`/work/orders/${x.work_order_id}`}>{x.work_ref}</Link>}</span></>}</span>
        <span className="side"><span className={`tag sv-${x.outcome}`}>{OUTCOME[x.outcome]}</span></span></div>)
        : <p className="empty">No services or inspections recorded yet.</p>}</div></section>
    <section><header><h2>AMC, warranty and licences</h2></header><RenewalRows rows={a.contracts} onChange={reload} history /></section>
    {a.routines.length > 0 && <section><header><h2>Routines</h2></header>
      <div className="rows">{a.routines.map((r: any) => <Link key={r.id} to={`/work/routines/${r.id}`} className="row"><span className="title">{r.title}</span><span className="side quiet">{r.ref}</span></Link>)}</div></section>}
    <section><header><h2>Work history</h2></header>
      <div className="rows">{a.work.length ? a.work.map((w: any) => <Link key={w.id} to={`/work/orders/${w.id}`} className="row">
        <span><span className="title">{w.title}</span><br /><span className="meta">{w.ref}, {KIND[w.kind]}, {shortDate(w.created_at)}</span></span>
        <span className="side"><span className={`tag w-${w.status}`}>{WORK_STATUS[w.status]}</span></span></Link>) : <p className="empty">No work recorded on this asset yet.</p>}</div></section>
    {sheet && <Sheet open onClose={() => setSheet(false)} title="Add a renewal"><ContractForm assetId={a.id} onDone={() => { setSheet(false); reload(); }} /></Sheet>}
    {log && <Sheet open onClose={() => setLog(false)} title="Service or inspection"><ServiceForm assetId={a.id} onDone={(w: string | null) => { setLog(false); reload(); if (w) navigate(`/work/orders/${w}`); }} /></Sheet>}
  </>;
}

const SERVICE_KIND: Record<string, string> = { service: 'Service', inspection: 'Inspection', repair: 'Repair', statutory: 'Statutory inspection' };
const OUTCOME: Record<string, string> = { passed: 'Passed', follow_up: 'Follow-up needed', out_of_service: 'Out of service' };

function ServiceForm({ assetId, onDone }: { assetId: string; onDone: (workId: string | null) => void }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [f, setF] = useState({ servicedOn: today, kind: 'service', provider: '', outcome: 'passed', notes: '', nextDueOn: '', raiseWorkOrder: true });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const fileId = file ? (await api.upload('/api/files?purpose=evidence', file)).id : null;
    const r = await api.post(`/api/assets/${assetId}/services`, { ...f, nextDueOn: f.nextDueOn || null, fileId, raiseWorkOrder: f.outcome !== 'passed' && f.raiseWorkOrder });
    onDone(r.workId); }); }}>
    <div className="two">
      <label className="field">Date<input type="date" required max={today} value={f.servicedOn} onChange={set('servicedOn')} /></label>
      <label className="field">Kind<select value={f.kind} onChange={set('kind')}>{Object.entries(SERVICE_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">Done by<input required value={f.provider} onChange={set('provider')} placeholder="Vendor or technician" /></label>
      <label className="field">Outcome<select value={f.outcome} onChange={set('outcome')}>{Object.entries(OUTCOME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">Next due (optional)<input type="date" min={f.servicedOn} value={f.nextDueOn} onChange={set('nextDueOn')} /></label>
      <label className="field">Service report (optional)<input type="file" accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
    </div>
    <label className="field">Remarks{f.outcome !== 'passed' ? ': what needs attention' : ' (optional)'}<textarea required={f.outcome !== 'passed'} value={f.notes} onChange={set('notes')} /></label>
    {f.outcome !== 'passed' && <label className="check"><input type="checkbox" checked={f.raiseWorkOrder} onChange={set('raiseWorkOrder')} />Raise a work order for it</label>}
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Save</button></div>
  </form>;
}

export function AssetNew() {
  const { places, loading } = useTree();
  const [f, setF] = useState({ name: '', kind: 'lift', nodeId: '', serviceBy: '', make: '', model: '', serialNo: '', installedOn: '', notes: '' });
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  if (loading) return <Loading />;
  return <>
    <PageHead title="Add an asset" crumbs={[{ to: '/work/assets', label: 'Assets and renewals' }]} />
    <form className="form" style={{ maxWidth: 680 }} onSubmit={e => { e.preventDefault(); run(async () => {
      const r = await api.post('/api/assets', { ...f, installedOn: f.installedOn || null });
      navigate(`/work/assets/${r.id}`);
    }); }}>
      <div className="two">
        <label className="field">Name<input required minLength={2} value={f.name} onChange={set('name')} placeholder="For example, Block A lifts (2)" /></label>
        <label className="field">Kind<select value={f.kind} onChange={set('kind')}>{Object.entries(ASSET_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <PlaceSelect value={f.nodeId} onChange={v => setF({ ...f, nodeId: v })} places={places} />
        <label className="field">Serviced by<input value={f.serviceBy} onChange={set('serviceBy')} /></label>
        <label className="field">Make<input value={f.make} onChange={set('make')} /></label>
        <label className="field">Model<input value={f.model} onChange={set('model')} /></label>
        <label className="field">Serial number<input value={f.serialNo} onChange={set('serialNo')} /></label>
        <label className="field">Installed on<input type="date" value={f.installedOn} onChange={set('installedOn')} /></label>
      </div>
      <label className="field">Notes<textarea value={f.notes} onChange={set('notes')} /></label>
      <ErrorNote error={error} />
      <div className="actions"><button className="primary" disabled={busy}>Add to the register</button></div>
    </form>
  </>;
}

// ================================================================== Home page panel
export function OperationsPanel() {
  const { me } = useApp();
  const { data } = useApi('/api/ops/summary');
  if (!data) return null;
  if (!isStaff(me)) {
    if (!data.canRaiseRequest && !data.myRequests.length) return null;
    return <section>
      <header><h2>Your requests</h2><Link to="/requests">{data.canRaiseRequest ? 'Raise a request' : 'All requests'}</Link></header>
      {data.myRequests.length ? <WorkRows rows={data.myRequests} empty="" /> : <p className="quiet">Something to fix at home or in the common areas? Raise a request and follow it here.</p>}
    </section>;
  }
  const c = data.checks, w = data.work, r = data.renewals;
  return <section>
    <header><h2>Operations today</h2><Link to="/work">Open the checklist</Link></header>
    <div className="ops-tiles">
      <Link to="/work" className="tile">
        <span className="big num">{c.done}<small>/{c.scheduled}</small></span><span>checks done today</span>
        <span className={c.missed ? 'stop' : 'quiet'}>{c.missed ? `${c.missed} missed today` : c.due ? `${c.due} due now` : 'Nothing missed today'}</span>
      </Link>
      <Link to="/work/orders" className="tile">
        <span className="big num">{w.open}</span><span>open work orders</span>
        <span className={w.overdue ? 'stop' : 'quiet'}>{w.overdue ? `${w.overdue} overdue` : 'None overdue'}{w.new_requests ? `, ${w.new_requests} new request${w.new_requests > 1 ? 's' : ''}` : ''}</span>
      </Link>
      {r && <Link to="/work/assets" className="tile">
        <span className="big num">{r.overdue + r.due_soon}</span><span>renewals due</span>
        <span className={r.overdue ? 'stop' : 'quiet'}>{r.overdue ? `${r.overdue} overdue` : 'None overdue'}</span>
      </Link>}
      <Link to="/work/routines" className="tile">
        <span className="big num">{c.missed7}</span><span>checks missed this week</span>
        <span className="quiet">{c.late7} done late</span>
      </Link>
    </div>
  </section>;
}
