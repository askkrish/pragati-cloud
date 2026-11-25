// Project delivery on a work order: requests for quotation, the contract and its changes,
// milestones, and the handover. Permits for requests that need the committee's permission.
import { useState } from 'react';
import { api, rupees, shortDate } from '../api.ts';
import { ErrorNote, Link, Sheet, useAction, useApi } from '../ui.tsx';

const HO_STATUS: Record<string, string> = { submitted: 'Waiting for acceptance', accepted: 'Accepted', returned: 'Returned', superseded: 'Replaced' };
const APPROVAL: Record<string, string> = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

type SheetName = null | 'rfq' | 'contract' | 'sign' | 'change' | 'milestone' | 'handover' | { done: any } | { respond: any };

export function Delivery({ workId, onChange }: { workId: string; onChange: () => void }) {
  const { data: d, error, reload } = useApi<any>(`/api/work/${workId}/delivery`);
  const [sheet, setSheet] = useState<SheetName>(null);
  if (error || !d) return null;
  const done = () => { setSheet(null); reload(); onChange(); };
  if (d.limited) return d.handovers.length ? <section>
    <header><h2>Handover</h2></header>
    <Handovers rows={d.handovers} onRespond={h => setSheet({ respond: h })} />
    {sheet && typeof sheet === 'object' && 'respond' in sheet && <Sheet open onClose={() => setSheet(null)} title={`Answer ${sheet.respond.ref}`}><RespondForm h={sheet.respond} onDone={done} /></Sheet>}
  </section> : null;

  const c = d.contract;
  const progress = d.milestones.length ? d.milestones.filter((m: any) => m.done_on).length / d.milestones.length : null;
  return <section className="delivery">
    <header><h2>Delivery</h2></header>

    {/* Contract and money */}
    {c ? <div className="panel pad">
      <div className="head-row"><h3>Contract {c.ref} with {c.vendor}</h3>
        {c.signed_on ? <span className="tag w-done">Signed {shortDate(c.signed_on)}</span> : <span className="tag w-on_hold">Not yet signed</span>}</div>
      <div className="tiles">
        <div className="tile"><span className="big">{rupees(c.committed_paise)}</span><span>committed{c.changes.some((x: any) => x.status === 'approved') ? `, from ${rupees(c.amount_paise)} signed` : ''}</span></div>
        <div className="tile"><span className="big">{rupees(d.paid_paise)}</span><span>paid{d.vouchers_pending_paise > 0 ? `; ${rupees(d.vouchers_pending_paise)} on vouchers waiting` : ''}</span></div>
        {c.finish_by_now && <div className="tile"><span className="big">{shortDate(c.finish_by_now)}</span><span>finish by{c.finish_by_now !== c.finish_by ? `, moved from ${shortDate(c.finish_by)}` : ''}</span></div>}
        {progress !== null && <div className="tile"><span className="big">{Math.round(progress * 100)}%</span><span>of milestones done</span></div>}
      </div>
      {c.terms && <p className="quiet" style={{ whiteSpace: 'pre-wrap' }}>Terms: {c.terms}</p>}
      {c.earlier_note && <p className="quiet">Recorded without a vendor choice on the platform: {c.earlier_note}</p>}
      {c.signed_file_id && <p><a href={`/api/files/${c.signed_file_id}`}>Signed copy</a>{c.signed_reference ? `, ${c.signed_reference}` : ''}</p>}
      <div className="actions">
        {d.actions.sign && <button className="primary" onClick={() => setSheet('sign')}>Record the signed copy</button>}
        {d.actions.change && c.signed_on && <button onClick={() => setSheet('change')}>Propose a change</button>}
      </div>
      {c.changes.length > 0 && <><h3>Change orders</h3><div className="rows">{c.changes.map((x: any) => <Link key={x.id} to={`/approvals/${x.approval_id}`} className="row">
        <span><span className="title">{x.ref}: {x.scope}</span><br /><span className="meta">{x.reason}. {x.days_delta ? `${x.days_delta > 0 ? '+' : ''}${x.days_delta} days. ` : ''}{x.proposed_by_name}, {shortDate(x.created_at)}</span></span>
        <span className="side"><b className="num">{Number(x.delta_paise) >= 0 ? '+' : '−'}{rupees(Math.abs(Number(x.delta_paise)))}</b><br /><span className={`tag a-${x.status}`}>{APPROVAL[x.status]}</span></span>
      </Link>)}</div></>}
    </div> : <div className="panel pad">
      {d.award ? <p>Awarded to <b>{d.award.vendor}</b> for {rupees(d.award.total_paise)} ({d.award.approval_ref}). Record the contract to track changes, milestones and payments.</p>
        : <p className="quiet">The contract is recorded once a vendor is chosen through the approval rules.</p>}
      {d.actions.contract && <div className="actions"><button className={d.award ? 'primary' : ''} onClick={() => setSheet('contract')}>
        {d.award ? 'Record the contract' : 'Record an earlier agreement'}</button></div>}
    </div>}

    {/* Requests for quotation */}
    {(d.rfqs.length > 0 || d.actions.rfq) && <div>
      <div className="head-row"><h3>Requests for quotation</h3>{d.actions.rfq && <button onClick={() => setSheet('rfq')}>New request</button>}</div>
      {d.rfqs.length ? <div className="rows">{d.rfqs.map((r: any) => <div key={r.id} className="row">
        <span><span className="title">{r.ref}: replies by {shortDate(r.reply_by)}</span><br /><span className="meta" style={{ whiteSpace: 'pre-wrap' }}>{r.scope}</span><br />
          <span className="meta">{r.vendors.length ? r.vendors.map((v: any) => `${v.name} ${v.quoted ? '(quoted)' : '(waiting)'}`).join(', ') : 'No vendors named'}</span></span>
      </div>)}</div> : <p className="quiet">Send the same written scope to every vendor so their quotations can be compared.</p>}
    </div>}

    {/* Milestones */}
    {(d.milestones.length > 0 || d.actions.milestone) && <div>
      <div className="head-row"><h3>Milestones</h3>{d.actions.milestone && <button onClick={() => setSheet('milestone')}>Add a milestone</button>}</div>
      {d.milestones.length ? <div className="rows">{d.milestones.map((m: any) => <div key={m.id} className="row">
        <span><span className="title">{m.done_on ? '✓ ' : ''}{m.title}</span><br /><span className="meta">
          {m.done_on ? `Done ${shortDate(m.done_on)} by ${m.done_by_name}. ${m.done_note}` : `Due ${shortDate(m.due_on)}`}{m.amount_paise ? `. Payment ${rupees(m.amount_paise)}` : ''}</span></span>
        <span className="side">{!m.done_on && (m.due_on < d.today ? <span className="tag w-overdue">Overdue</span> : null)}
          {!m.done_on && <button onClick={() => setSheet({ done: m })}>Mark done</button>}</span>
      </div>)}</div> : <p className="quiet">Break the work into dated steps, with any payment due at each.</p>}
    </div>}

    {/* Handover */}
    {(d.handovers.length > 0 || d.actions.handover) && <div>
      <div className="head-row"><h3>Handover</h3>{d.actions.handover && <button className="primary" onClick={() => setSheet('handover')}>Submit for handover</button>}</div>
      {d.handovers.length ? <Handovers rows={d.handovers} onRespond={h => setSheet({ respond: h })} />
        : <p className="quiet">When the work is complete, record the tests and any defects; the person you name checks it and accepts it, which completes the work.</p>}
    </div>}

    <Sheet open={sheet === 'rfq'} onClose={() => setSheet(null)} title="Request for quotation"><RfqForm workId={workId} onDone={done} /></Sheet>
    <Sheet open={sheet === 'contract'} onClose={() => setSheet(null)} title="Contract"><ContractForm workId={workId} award={d.award} onDone={done} /></Sheet>
    {c && <Sheet open={sheet === 'sign'} onClose={() => setSheet(null)} title="Signed contract"><SignForm contract={c} onDone={done} /></Sheet>}
    {c && <Sheet open={sheet === 'change'} onClose={() => setSheet(null)} title="Propose a change"><ChangeForm contract={c} onDone={done} /></Sheet>}
    <Sheet open={sheet === 'milestone'} onClose={() => setSheet(null)} title="Milestone"><MilestoneForm workId={workId} onDone={done} /></Sheet>
    <Sheet open={sheet === 'handover'} onClose={() => setSheet(null)} title="Submit for handover"><HandoverForm workId={workId} onDone={done} /></Sheet>
    {sheet && typeof sheet === 'object' && 'done' in sheet && <Sheet open onClose={() => setSheet(null)} title={sheet.done.title}><MilestoneDone m={sheet.done} onDone={done} /></Sheet>}
    {sheet && typeof sheet === 'object' && 'respond' in sheet && <Sheet open onClose={() => setSheet(null)} title={`Answer ${sheet.respond.ref}`}><RespondForm h={sheet.respond} onDone={done} /></Sheet>}
  </section>;
}

function Handovers({ rows, onRespond }: { rows: any[]; onRespond: (h: any) => void }) {
  return <div className="rows">{rows.map(h => <div key={h.id} className="row handover">
    <span><span className="title">{h.ref}: to {h.recipient}</span> <span className={`tag ho-${h.status}`}>{HO_STATUS[h.status]}</span><br />
      <span className="meta">Tests: {h.tests}</span><br /><span className="meta">Defects: {h.defects}</span>
      {h.warranty && <><br /><span className="meta">Warranty: {h.warranty}</span></>}
      {h.assets?.length > 0 && <><br /><span className="meta">Assets: {h.assets.join(', ')}</span></>}
      {h.file_id && <><br /><a href={`/api/files/${h.file_id}`}>{h.file_name}</a></>}
      {h.response_note && <><br /><span className="meta"><b>{HO_STATUS[h.status]}</b>: {h.response_note}{h.response_file_id && <> (<a href={`/api/files/${h.response_file_id}`}>{h.response_file_name}</a>)</>}</span></>}
      <br /><span className="meta">Submitted by {h.submitted_by_name}, {shortDate(h.created_at)}</span></span>
    {h.canRespond && <span className="side"><button className="primary" onClick={() => onRespond(h)}>Accept or return</button></span>}
  </div>)}</div>;
}

function RfqForm({ workId, onDone }: { workId: string; onDone: () => void }) {
  const vendors = useApi<any[]>('/api/vendors');
  const [f, setF] = useState({ scope: '', replyBy: '', vendorIds: [] as string[] });
  const { busy, error, run } = useAction();
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => { await api.post(`/api/work/${workId}/rfqs`, f); onDone(); }); }}>
    <label className="field">Scope: the work, quantities, specifications, and what is excluded<textarea required rows={6} value={f.scope} onChange={e => setF({ ...f, scope: e.target.value })} /></label>
    <label className="field">Replies by<input type="date" required min={todayIso()} value={f.replyBy} onChange={e => setF({ ...f, replyBy: e.target.value })} /></label>
    <fieldset className="field"><legend>Vendors asked</legend>
      <div className="checks">{(vendors.data ?? []).filter(v => v.status !== 'blocked').map(v => <label key={v.id} className="check">
        <input type="checkbox" checked={f.vendorIds.includes(v.id)} onChange={e => setF({ ...f, vendorIds: e.target.checked ? [...f.vendorIds, v.id] : f.vendorIds.filter(x => x !== v.id) })} />{v.name}</label>)}</div>
    </fieldset>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Record the request</button></div>
  </form>;
}

function ContractForm({ workId, award, onDone }: { workId: string; award: any; onDone: () => void }) {
  const vendors = useApi<any[]>(award ? null : '/api/vendors');
  const [f, setF] = useState({ amount: award ? String(award.total_paise / 100) : '', startsOn: '', finishBy: '', terms: '', vendorId: '', earlierNote: '' });
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    await api.post(`/api/work/${workId}/contract`, { amount: f.amount, startsOn: f.startsOn || null, finishBy: f.finishBy || null, terms: f.terms,
      ...(award ? {} : { vendorId: f.vendorId, earlierNote: f.earlierNote }) }); onDone(); }); }}>
    {award ? <p className="quiet">With {award.vendor}, as approved in {award.approval_ref}. The amount can be lower after negotiation, not higher.</p> : <>
      <p className="note">Use this only for an agreement made before the platform was used. New work goes through quotations and approval first.</p>
      <label className="field">Vendor<select required value={f.vendorId} onChange={set('vendorId')}><option value="">Choose</option>
        {(vendors.data ?? []).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label className="field">How it was agreed<input required value={f.earlierNote} onChange={set('earlierNote')} placeholder="For example, approved at the council meeting of 12 October" /></label>
    </>}
    <div className="two">
      <label className="field">Contract amount, with GST (₹)<input required inputMode="decimal" value={f.amount} onChange={set('amount')} /></label>
      <label className="field">Starts<input type="date" value={f.startsOn} onChange={set('startsOn')} /></label>
      <label className="field">Finish by<input type="date" value={f.finishBy} onChange={set('finishBy')} /></label>
    </div>
    <label className="field">Payment and other terms<textarea value={f.terms} onChange={set('terms')} placeholder="For example, 30% advance, 60% on installation, 10% after a month" /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Record the contract</button></div>
  </form>;
}

function SignForm({ contract, onDone }: { contract: any; onDone: () => void }) {
  const [f, setF] = useState({ signedOn: todayIso(), reference: '' });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const up = await api.upload('/api/files?purpose=contract', file!);
    await api.post(`/api/contracts/${contract.id}/sign`, { ...f, fileId: up.id }); onDone(); }); }}>
    <label className="field">Signed copy (PDF or photo)<input type="file" required accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
    <div className="two">
      <label className="field">Signed on<input type="date" required max={todayIso()} value={f.signedOn} onChange={e => setF({ ...f, signedOn: e.target.value })} /></label>
      <label className="field">Agreement or work order number<input required value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} /></label>
    </div>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy || !file}>Save</button></div>
  </form>;
}

function ChangeForm({ contract, onDone }: { contract: any; onDone: () => void }) {
  const [f, setF] = useState({ scope: '', reason: '', delta: '', daysDelta: '0' });
  const { busy, error, run } = useAction();
  const delta = Number(f.delta.replace(/[₹,\s]/g, '')) || 0;
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => { await api.post(`/api/contracts/${contract.id}/changes`, f); onDone(); }); }}>
    <label className="field">What changes<textarea required value={f.scope} onChange={e => setF({ ...f, scope: e.target.value })} /></label>
    <label className="field">Why<textarea required value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} /></label>
    <div className="two">
      <label className="field">Change in amount (₹, negative for a saving)<input required inputMode="decimal" value={f.delta} onChange={e => setF({ ...f, delta: e.target.value })} /></label>
      <label className="field">Change in time (days)<input type="number" value={f.daysDelta} onChange={e => setF({ ...f, daysDelta: e.target.value })} /></label>
    </div>
    <p className="quiet">The contract becomes {rupees((contract.committed_paise + Math.round(delta * 100)))} once approved. The change goes through the approval rules.</p>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Send for approval</button></div>
  </form>;
}

function MilestoneForm({ workId, onDone }: { workId: string; onDone: () => void }) {
  const [f, setF] = useState({ title: '', dueOn: '', amount: '' });
  const { busy, error, run } = useAction();
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => { await api.post(`/api/work/${workId}/milestones`, f); onDone(); }); }}>
    <label className="field">Milestone<input required value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="For example, civil work and cabling complete" /></label>
    <div className="two">
      <label className="field">Due<input type="date" required value={f.dueOn} onChange={e => setF({ ...f, dueOn: e.target.value })} /></label>
      <label className="field">Payment due at this step (₹, optional)<input inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
    </div>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Add</button></div>
  </form>;
}

function MilestoneDone({ m, onDone }: { m: any; onDone: () => void }) {
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => { await api.patch(`/api/milestones/${m.id}`, { done: true, note }); onDone(); }); }}>
    <label className="field">What was completed, and how it was checked<textarea required value={note} onChange={e => setNote(e.target.value)} /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Mark done</button></div>
  </form>;
}

function HandoverForm({ workId, onDone }: { workId: string; onDone: () => void }) {
  const people = useApi<any[]>(`/api/work/${workId}/handover-people`);
  const assets = useApi<any[]>('/api/assets');
  const [f, setF] = useState({ tests: '', defects: '', warranty: '', recipientId: '', assetIds: [] as string[] });
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const fileId = file ? (await api.upload('/api/files?purpose=evidence', file)).id : null;
    await api.post(`/api/work/${workId}/handover`, { ...f, fileId }); onDone(); }); }}>
    <label className="field">Tests done and their results<textarea required value={f.tests} onChange={set('tests')} /></label>
    <label className="field">Defects still open (write "None" if there are none)<textarea required value={f.defects} onChange={set('defects')} /></label>
    <label className="field">Warranty and service terms<input value={f.warranty} onChange={set('warranty')} /></label>
    <label className="field">Assets installed or affected<select multiple value={f.assetIds} onChange={e => setF({ ...f, assetIds: [...e.target.selectedOptions].map(o => o.value) })} style={{ minHeight: 90 }}>
      {(assets.data ?? []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <label className="field">Completion report or certificate (optional)<input type="file" accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
    <label className="field">Who checks and accepts it<select required value={f.recipientId} onChange={set('recipientId')}><option value="">Choose</option>
      {(people.data ?? []).map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Submit</button></div>
  </form>;
}

function RespondForm({ h, onDone }: { h: any; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  const send = (decision: string) => run(async () => {
    const fileId = file ? (await api.upload('/api/files?purpose=evidence', file)).id : null;
    await api.post(`/api/handovers/${h.id}/respond`, { decision, note, fileId }); onDone(); });
  return <div className="form">
    <p className="quiet">Accepting completes the work. Returning sends it back to be fixed.</p>
    <label className="field">What you checked, or what must be fixed<textarea value={note} onChange={e => setNote(e.target.value)} /></label>
    <label className="field">Photo or document (optional)<input type="file" accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy || note.trim().length < 3} onClick={() => send('accepted')}>Accept</button>
      <button disabled={busy || note.trim().length < 3} onClick={() => send('returned')}>Return to be fixed</button></div>
  </div>;
}

// ------------------------------------------------------------------ permits
const PERMIT_STATUS: Record<string, string> = { approved: 'Permit granted', declined: 'Permit declined', revoked: 'Permit revoked' };
export const PERMIT_KINDS: Record<string, string> = { terrace_work: 'Terrace drilling or cabling', renovation: 'Renovation in my home', moving: 'Moving in or out', other: 'Other work needing permission' };

export function Permit({ w, onChange }: { w: any; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const p = w.permit;
  return <section className="panel pad permit">
    <div className="head-row"><h2>Permit: {w.permitLabel}</h2>
      {p.granted ? <span className="tag w-done">Granted</span> : p.expired ? <span className="tag w-overdue">Expired</span>
        : p.latest ? <span className={`tag p-${p.latest.status}`}>{PERMIT_STATUS[p.latest.status]}</span> : <span className="tag w-on_hold">Waiting for the committee</span>}</div>
    {p.latest ? <>
      <p>{p.latest.note}</p>
      {p.latest.conditions && <p><b>Conditions:</b> {p.latest.conditions}</p>}
      {p.latest.valid_until && <p className="quiet">Valid until {shortDate(p.latest.valid_until)}.</p>}
      <p className="quiet small">{p.latest.by}, {shortDate(p.latest.decided_at)}</p>
    </> : <p className="quiet">Work cannot start until the committee grants the permit.</p>}
    {w.actions.decidePermit && <div className="actions"><button className="primary" onClick={() => setOpen(true)}>{p.latest?.status === 'approved' ? 'Revoke the permit' : 'Decide'}</button></div>}
    <Sheet open={open} onClose={() => setOpen(false)} title="Permit"><PermitForm w={w} onDone={() => { setOpen(false); onChange(); }} /></Sheet>
  </section>;
}

function PermitForm({ w, onDone }: { w: any; onDone: () => void }) {
  const inForce = w.permit.latest?.status === 'approved';
  const [f, setF] = useState({ decision: inForce ? 'revoked' : 'approved', note: '', conditions: '', validUntil: '' });
  const { busy, error, run } = useAction();
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    await api.post(`/api/work/${w.id}/permit`, { ...f, validUntil: f.validUntil || null }); onDone(); }); }}>
    {!inForce && <label className="field">Decision<select value={f.decision} onChange={e => setF({ ...f, decision: e.target.value })}>
      <option value="approved">Grant the permit</option><option value="declined">Decline</option></select></label>}
    <label className="field">{f.decision === 'approved' ? 'Approval reference or reason' : 'Reason'}<textarea required value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></label>
    {f.decision === 'approved' && <>
      <label className="field">Conditions (optional)<textarea value={f.conditions} onChange={e => setF({ ...f, conditions: e.target.value })} placeholder="For example, no drilling into the waterproofing; work between 10 am and 5 pm" /></label>
      <label className="field">Valid until (optional)<input type="date" min={todayIso()} value={f.validUntil} onChange={e => setF({ ...f, validUntil: e.target.value })} /></label>
    </>}
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>Save</button></div>
  </form>;
}

export function HandoversPanel() {
  const { data } = useApi<any[]>('/api/handovers/mine');
  if (!data?.length) return null;
  return <section>
    <header><h2>Handovers to check</h2></header>
    <div className="rows">{data.map(h => <Link key={h.id} to={`/work/orders/${h.work_id}`} className="row">
      <span><span className="title">{h.work_ref}: {h.title}</span><br /><span className="meta">{h.ref} from {h.submitted_by}, {shortDate(h.created_at)}</span></span>
      <span className="side"><span className="tag w-on_hold">To check</span></span></Link>)}</div>
  </section>;
}
