// Procurement: quotations and the comparison on a work order, choosing a vendor, and the vendor directory.
import { useState } from 'react';
import { api, phoneDisplay, rupees, shortDate } from '../api.ts';
import { can, useApp, type Me } from '../main.tsx';
import { ErrorNote, Link, Loading, navigate, PageHead, Sheet, useAction, useApi } from '../ui.tsx';
import { CATEGORY } from './labels.ts';
import { ReadButton, ReadNote } from './Reading.tsx';
import { WorkTabs } from './Work.tsx';

export const seesProcurement = (me: Me) => can(me, 'procurement.view') || can(me, 'procurement.manage');
const VENDOR_CATEGORY: Record<string, string> = { ...CATEGORY, civil: 'Civil work', painting: 'Painting', pest_control: 'Pest control',
  supplies: 'Supplies', professional: 'Professional services' };
const TAX: Record<string, string> = { included: 'GST included', excluded: 'Plus GST', unclear: 'GST not stated' };
const APPROVAL: Record<string, string> = { pending: 'waiting for approval', approved: 'approved', rejected: 'not approved', withdrawn: 'withdrawn' };

// ================================================================== on a work order
export function Quotations({ workId, onChange }: { workId: string; onChange: () => void }) {
  const { data: d, loading, error, reload } = useApi(`/api/work/${workId}/quotes`);
  const [sheet, setSheet] = useState<null | 'add' | 'select' | 'review'>(null);
  const [revise, setRevise] = useState<any>(null);
  const [aside, setAside] = useState<any>(null);
  const [asideNote, setAsideNote] = useState('');
  const act = useAction();
  if (loading && !d) return <Loading what="quotations" />;
  if (error) return <ErrorNote error={error} />;
  const done = () => { setSheet(null); setRevise(null); reload(); onChange(); };
  return <section>
    <header><h2>Quotations</h2>{d.rows.length > 0 && <span className="quiet">{d.rows.length} current</span>}</header>
    {d.award && <p className="note ok">Awarded to <strong>{d.award.vendor}</strong> for {rupees(d.award.tax === 'excluded' && d.award.gst_paise
      ? Number(d.award.amount_paise) + Number(d.award.gst_paise) : d.award.amount_paise)}. <Link to={`/approvals/${d.award.approval_id}`}>{d.award.approval_ref}</Link> approved.</p>}
    {d.pending && <p className="note">{d.pending.chosen_by} recommended <strong>{d.pending.vendor}</strong>: {d.pending.reason}{' '}
      <Link to={`/approvals/${d.pending.approval_id}`}>{d.pending.approval_ref}</Link> is waiting for approval.</p>}
    {d.rows.length > 0 && <>
      <div className="table-wrap"><table className="grid compare">
        <thead><tr><th>Vendor</th><th className="num">Quoted</th><th className="num">With GST</th><th className="wide">Time</th><th className="wide">Warranty</th>
          <th className="wide">Valid until</th><th className="wide">Payment</th></tr></thead>
        <tbody>{d.rows.map((r: any) => <tr key={r.id} className={r.lowest ? 'lowest' : ''}>
          <td><strong>{r.vendor}</strong>{r.lowest && <span className="tag day-done" style={{ marginLeft: 6 }}>Lowest</span>}<br />
            <span className="quiet">{r.ref}{r.file_id && <>, <a href={`/api/files/${r.file_id}`}>quotation</a></>}</span>
            <p className="scope">{r.scope}{r.exclusions && <><br /><span className="quiet">Not included: {r.exclusions}</span></>}</p>
            {d.actions.add && <span className="row-actions"><button className="quiet-btn" onClick={() => { setRevise(r); setSheet('add'); }}>Revise</button>
              <button className="quiet-btn" onClick={() => setAside(r)}>Set aside</button></span>}</td>
          <td className="num">{rupees(r.amount_paise)}<br /><span className="quiet">{TAX[r.tax]}</span></td>
          <td className="num">{r.total_paise !== null ? rupees(r.total_paise) : <span className="stop">To confirm</span>}</td>
          <td className="wide">{r.timeline || <span className="faint">Not stated</span>}</td>
          <td className="wide">{r.warranty || <span className="faint">Not stated</span>}</td>
          <td className={`wide ${r.lapsed ? 'stop' : ''}`}>{r.valid_until ? shortDate(r.valid_until) : <span className="faint">Not stated</span>}</td>
          <td className="wide">{r.payment_terms || <span className="faint">Not stated</span>}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="checks"><p>{d.summary}</p>{d.checks.length > 0 && <ul>{d.checks.map((c: string) => <li key={c}>{c}</li>)}</ul>}</div>
    </>}
    {!d.rows.length && !d.award && <p className="quiet">No quotations yet.{d.actions.add ? ' Record each vendor\'s quotation to compare them side by side.' : ''}</p>}
    <ErrorNote error={act.error} />
    <div className="actions">
      {d.actions.add && <button onClick={() => { setRevise(null); setSheet('add'); }}>Add a quotation</button>}
      {d.actions.select && <button className="primary" onClick={() => setSheet('select')}>Choose a vendor</button>}
      {d.actions.review && <button onClick={() => setSheet('review')}>Review {d.award.vendor}</button>}
    </div>
    {d.earlier.length > 0 && <details><summary className="quiet">Earlier quotations ({d.earlier.length})</summary>
      <div className="rows" style={{ marginTop: 8 }}>{d.earlier.map((q: any) => <div key={q.id} className="row">
        <span><span className="title">{q.vendor}, {q.ref}</span><br /><span className="meta">{q.withdrawn_at ? `Set aside: ${q.withdrawn_note}` : 'Replaced by a revised quotation'}</span></span>
        <span className="side num">{rupees(q.amount_paise)}</span></div>)}</div></details>}
    {d.selections.filter((s: any) => s.status !== 'pending' && s.status !== 'approved').map((s: any) => <p key={s.id} className="quiet">
      {s.chosen_by} recommended {s.vendor} on {shortDate(s.created_at)}; <Link to={`/approvals/${s.approval_id}`}>{s.approval_ref}</Link> {APPROVAL[s.status]}.</p>)}
    {aside && <Sheet open onClose={() => setAside(null)} title={`Set aside ${aside.vendor}'s quotation`}>
      <p className="quiet">It stays on record but leaves the comparison.</p>
      <label className="field">Reason<textarea value={asideNote} onChange={e => setAsideNote(e.target.value)} placeholder="For example, the vendor withdrew" /></label>
      <ErrorNote error={act.error} />
      <button className="primary" disabled={act.busy || !asideNote.trim()} onClick={() => act.run(async () => {
        await api.post(`/api/quotes/${aside.id}/withdraw`, { note: asideNote }); setAside(null); setAsideNote(''); reload(); })}>Set aside</button>
    </Sheet>}
    {sheet === 'add' && <Sheet open onClose={() => setSheet(null)} title={revise ? `Revised quotation from ${revise.vendor}` : 'Add a quotation'}>
      <QuoteForm workId={workId} revise={revise} onDone={done} /></Sheet>}
    {sheet === 'select' && <Sheet open onClose={() => setSheet(null)} title="Choose a vendor"><SelectForm workId={workId} rows={d.rows} onDone={(id: string) => { done(); navigate(`/approvals/${id}`); }} /></Sheet>}
    {sheet === 'review' && <Sheet open onClose={() => setSheet(null)} title={`Review ${d.award.vendor}`}><ReviewForm vendorId={d.award.vendor_id} workId={workId} onDone={done} /></Sheet>}
  </section>;
}

function QuoteForm({ workId, revise, onDone }: { workId: string; revise: any; onDone: () => void }) {
  const vendors = useApi<any[]>('/api/vendors');
  const [f, setF] = useState({ vendorId: revise?.vendor_id ?? '', newName: '', newPhone: '', amount: '', tax: 'included', gst: '', scope: revise?.scope ?? '',
    exclusions: revise?.exclusions ?? '', timeline: revise?.timeline ?? '', warranty: revise?.warranty ?? '', validUntil: '', paymentTerms: revise?.payment_terms ?? '',
    reference: '', receivedOn: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) });
  const [file, setFile] = useState<File | null>(null);
  const [readId, setReadId] = useState<string | null>(null);
  const [read, setRead] = useState<any>(null);
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const isNew = f.vendorId === 'new';
  // Fields read from the document go into the form; the vendor is matched by name, or entered as new.
  const fill = (r: any, id: string) => {
    const name = (r.vendorName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const match = name ? (vendors.data ?? []).find(v => v.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === name) : null;
    setF(v => ({ ...v, ...(revise ? {} : match ? { vendorId: match.id } : r.vendorName ? { vendorId: 'new', newName: r.vendorName } : {}),
      amount: r.amount != null ? String(r.amount) : v.amount, tax: r.tax ?? v.tax, gst: r.gst != null ? String(r.gst) : v.gst, scope: r.scope ?? v.scope,
      exclusions: r.exclusions ?? v.exclusions, timeline: r.timeline ?? v.timeline, warranty: r.warranty ?? v.warranty, validUntil: r.validUntil ?? v.validUntil,
      paymentTerms: r.paymentTerms ?? v.paymentTerms, receivedOn: r.quoteDate ?? v.receivedOn }));
    setRead(r); setReadId(id);
  };
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const fileId = readId ?? (file ? (await api.upload('/api/files?purpose=quotation', file)).id : null);
    await api.post(`/api/work/${workId}/quotes`, { ...(isNew ? { newVendor: { name: f.newName, phone: f.newPhone || null } } : { vendorId: f.vendorId }),
      amount: f.amount, tax: f.tax, gst: f.tax === 'excluded' ? f.gst || null : null, scope: f.scope, exclusions: f.exclusions, timeline: f.timeline,
      warranty: f.warranty, validUntil: f.validUntil || null, paymentTerms: f.paymentTerms, reference: f.reference || null, receivedOn: f.receivedOn, fileId,
      replacesId: revise?.id ?? null });
    onDone();
  }); }}>
    <label className="field">The quotation (PDF or photo)<input type="file" accept=".pdf,image/*" onChange={e => { setFile(e.target.files?.[0] ?? null); setReadId(null); setRead(null); }} /></label>
    <ReadButton kind="quotation" file={file} onRead={fill} />
    <ReadNote fields={read} />
    {!revise && <label className="field">Vendor<select required value={f.vendorId} onChange={set('vendorId')}>
      <option value="">Choose…</option>{(vendors.data ?? []).filter(v => v.status !== 'blocked').map(v => <option key={v.id} value={v.id}>{v.name}{v.city ? `, ${v.city}` : ''}</option>)}
      <option value="new">A new vendor…</option></select></label>}
    {isNew && <div className="two"><label className="field">Vendor's name<input required value={f.newName} onChange={set('newName')} /></label>
      <label className="field">Phone<input value={f.newPhone} onChange={set('newPhone')} /></label></div>}
    <div className="two">
      <label className="field">Amount quoted, ₹<input required inputMode="decimal" value={f.amount} onChange={set('amount')} /></label>
      <label className="field">GST<select value={f.tax} onChange={set('tax')}><option value="included">Included in the amount</option>
        <option value="excluded">Added on top</option><option value="unclear">Not stated</option></select></label>
      {f.tax === 'excluded' && <label className="field">GST amount, ₹<input inputMode="decimal" value={f.gst} onChange={set('gst')} placeholder="If the quotation shows it" /></label>}
    </div>
    <label className="field">Scope<textarea required value={f.scope} onChange={set('scope')} placeholder="What the vendor will do, quantities, materials" /></label>
    <label className="field">Not included<input value={f.exclusions} onChange={set('exclusions')} placeholder="For example, scaffolding, debris removal" /></label>
    <div className="two">
      <label className="field">Time to complete<input value={f.timeline} onChange={set('timeline')} placeholder="3 weeks" /></label>
      <label className="field">Warranty<input value={f.warranty} onChange={set('warranty')} placeholder="5 years" /></label>
      <label className="field">Price valid until<input type="date" value={f.validUntil} onChange={set('validUntil')} /></label>
      <label className="field">Received on<input type="date" value={f.receivedOn} onChange={set('receivedOn')} /></label>
    </div>
    <label className="field">Payment terms<input value={f.paymentTerms} onChange={set('paymentTerms')} placeholder="30% advance, balance on completion" /></label>
    <label className="field">Quotation number<input value={f.reference} onChange={set('reference')} /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>{revise ? 'Save the revised quotation' : 'Add quotation'}</button></div>
  </form>;
}

function SelectForm({ workId, rows, onDone }: { workId: string; rows: any[]; onDone: (approvalId: string) => void }) {
  const [quoteId, setQuoteId] = useState(rows.find(r => r.lowest)?.id ?? '');
  const [reason, setReason] = useState('');
  const [single, setSingle] = useState('');
  const { busy, error, run } = useAction();
  return <>
    <p className="quiet">Your choice goes to the committee under the community's approval rules, with every quotation and the checks shown here.</p>
    <div className="rows">{rows.map(r => <label key={r.id} className="row pick">
      <span><input type="radio" name="quote" checked={quoteId === r.id} onChange={() => setQuoteId(r.id)} /> <strong>{r.vendor}</strong>
        {r.lapsed && <span className="stop"> (lapsed)</span>}</span>
      <span className="side num">{r.total_paise !== null ? rupees(r.total_paise) : `${rupees(r.amount_paise)}, GST to confirm`}</span></label>)}</div>
    <label className="field">Why this vendor<textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Price on the same scope, warranty, track record" /></label>
    {rows.length === 1 && <label className="field">Why there is only one quotation<input value={single} onChange={e => setSingle(e.target.value)}
      placeholder="For example, the only authorised service agent" /></label>}
    <ErrorNote error={error} />
    <button className="primary" disabled={busy || !quoteId || !reason.trim() || (rows.length === 1 && !single.trim())}
      onClick={() => run(async () => { const r = await api.post(`/api/work/${workId}/select`, { quoteId, reason, singleQuoteReason: single || undefined }); onDone(r.approvalId); })}>
      Send for approval</button>
  </>;
}

function Score({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return <div className="field"><span>{label}</span><div className="tabs" role="radiogroup" aria-label={label}>
    {[1, 2, 3, 4, 5].map(n => <button type="button" key={n} role="radio" aria-checked={value === n} aria-pressed={value === n} onClick={() => onChange(n)}>{n}</button>)}
  </div></div>;
}
function ReviewForm({ vendorId, workId, onDone }: { vendorId: string; workId?: string; onDone: () => void }) {
  const [f, setF] = useState({ quality: 0, timeliness: 0, value: 0, wouldRehire: true, comment: '' });
  const { busy, error, run } = useAction();
  return <>
    <Score label="Quality of work" value={f.quality} onChange={n => setF({ ...f, quality: n })} />
    <Score label="On time" value={f.timeliness} onChange={n => setF({ ...f, timeliness: n })} />
    <Score label="Value for money" value={f.value} onChange={n => setF({ ...f, value: n })} />
    <label className="check"><input type="checkbox" checked={f.wouldRehire} onChange={e => setF({ ...f, wouldRehire: e.target.checked })} />We would hire them again</label>
    <label className="field">Comment<textarea value={f.comment} onChange={e => setF({ ...f, comment: e.target.value })} placeholder="Needed for a score of 2 or less" /></label>
    <ErrorNote error={error} />
    <button className="primary" disabled={busy || !f.quality || !f.timeliness || !f.value}
      onClick={() => run(async () => { await api.post(`/api/vendors/${vendorId}/reviews`, { ...f, workOrderId: workId ?? null }); onDone(); })}>Save review</button>
  </>;
}

// ================================================================== vendor directory
const stars = (n: number | null) => n === null ? '' : `${Number(n).toFixed(1)} of 5`;

export function VendorList() {
  const { me } = useApp();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const { data, loading, error, reload } = useApi<any[]>(`/api/vendors?${new URLSearchParams({ ...(q ? { q } : {}), ...(cat ? { category: cat } : {}) })}`);
  const [add, setAdd] = useState(false);
  return <>
    <PageHead title="Vendors">{can(me, 'procurement.manage') && <button className="primary" onClick={() => setAdd(true)}>Add a vendor</button>}</PageHead>
    <WorkTabs />
    <div className="head-row" style={{ alignItems: 'end' }}>
      <input className="search" type="search" placeholder="Search by name or city" value={q} onChange={e => setQ(e.target.value)} />
      <select style={{ maxWidth: 240 }} value={cat} onChange={e => setCat(e.target.value)} aria-label="Kind of work">
        <option value="">All kinds of work</option>{Object.entries(VENDOR_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
    </div>
    <ErrorNote error={error} />
    {loading && !data ? <Loading /> : <div className="rows">{data?.length ? data.map(v => <Link key={v.id} to={`/work/vendors/${v.id}`} className="row">
      <span><span className="title">{v.name}</span>{v.status !== 'active' && <span className={`tag ${v.status === 'blocked' ? 'w-overdue' : 'w-on_hold'}`} style={{ marginLeft: 8 }}>
        {v.status === 'blocked' ? 'Blocked' : 'On hold'}</span>}<br />
        <span className="meta">{v.categories.map((c: string) => VENDOR_CATEGORY[c]).join(', ') || 'No kind of work set'}{v.city ? `. ${v.city}` : ''}</span></span>
      <span className="side">{v.rating !== null ? <><span className="num">{stars(v.rating)}</span><br /><span className="quiet">{v.reviews} review{v.reviews === 1 ? '' : 's'}</span></>
        : <span className="quiet">Not reviewed</span>}{v.awards > 0 && <><br /><span className="quiet">{v.awards} awarded</span></>}</span>
    </Link>) : <p className="empty">No vendors here yet.</p>}</div>}
    {add && <Sheet open onClose={() => setAdd(false)} title="Add a vendor"><VendorForm onDone={id => { setAdd(false); reload(); navigate(`/work/vendors/${id}`); }} /></Sheet>}
  </>;
}

function VendorForm({ existing, onDone }: { existing?: any; onDone: (id: string) => void }) {
  const [f, setF] = useState({ name: existing?.name ?? '', categories: (existing?.categories ?? []) as string[], contactName: existing?.contact_name ?? '',
    phone: existing?.phone ?? '', email: existing?.email ?? '', gstin: existing?.gstin ?? '', city: existing?.city ?? '', address: existing?.address ?? '',
    website: existing?.website ?? '', notes: existing?.notes ?? '' });
  const { busy, error, run } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
    const body = { ...f, contactName: f.contactName || null, phone: f.phone || null, email: f.email || null, gstin: f.gstin || null, city: f.city || null,
      address: f.address || null, website: f.website || null };
    if (existing) { await api.patch(`/api/vendors/${existing.id}`, body); onDone(existing.id); }
    else onDone((await api.post('/api/vendors', body)).id);
  }); }}>
    <label className="field">Name<input required value={f.name} onChange={set('name')} /></label>
    <div className="field"><span>Kinds of work</span><div className="tabs" role="group">{Object.entries(VENDOR_CATEGORY).map(([k, v]) =>
      <button type="button" key={k} aria-pressed={f.categories.includes(k)} onClick={() => setF({ ...f, categories: f.categories.includes(k)
        ? f.categories.filter(c => c !== k) : [...f.categories, k] })}>{v}</button>)}</div></div>
    <div className="two">
      <label className="field">Contact person<input value={f.contactName} onChange={set('contactName')} /></label>
      <label className="field">Phone<input value={f.phone} onChange={set('phone')} /></label>
      <label className="field">Email<input type="email" value={f.email} onChange={set('email')} /></label>
      <label className="field">GSTIN<input value={f.gstin} onChange={set('gstin')} placeholder="33ABCDE1234F1Z5" /></label>
      <label className="field">City<input value={f.city} onChange={set('city')} /></label>
      <label className="field">Website<input value={f.website} onChange={set('website')} /></label>
    </div>
    <label className="field">Address<input value={f.address} onChange={set('address')} /></label>
    <label className="field">Notes<textarea value={f.notes} onChange={set('notes')} /></label>
    <ErrorNote error={error} />
    <div className="actions"><button className="primary" disabled={busy}>{existing ? 'Save' : 'Add vendor'}</button></div>
  </form>;
}

export function VendorView({ id }: { id: string }) {
  const { data: v, loading, error, reload } = useApi(`/api/vendors/${id}`);
  const [sheet, setSheet] = useState<null | 'edit' | 'review' | 'status'>(null);
  const [status, setStatus] = useState({ status: 'on_hold', note: '' });
  const act = useAction();
  if (loading && !v) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const s = v.scores;
  return <>
    <PageHead title={v.name} crumbs={[{ to: '/work/vendors', label: 'Vendors' }, { label: v.ref }]}>
      {v.status !== 'active' && <span className={`tag ${v.status === 'blocked' ? 'w-overdue' : 'w-on_hold'}`}>{v.status === 'blocked' ? 'Blocked' : 'On hold'}</span>}
    </PageHead>
    {v.status !== 'active' && <p className="note error">{v.status === 'blocked' ? 'Blocked' : 'On hold'}: {v.status_note}</p>}
    <dl className="facts">
      <div><dt>Kinds of work</dt><dd>{v.categories.map((c: string) => VENDOR_CATEGORY[c]).join(', ') || 'Not set'}</dd></div>
      {v.contact_name && <div><dt>Contact</dt><dd>{v.contact_name}</dd></div>}
      {v.phone && <div><dt>Phone</dt><dd><a href={`tel:${v.phone}`}>{phoneDisplay(v.phone)}</a></dd></div>}
      {v.email && <div><dt>Email</dt><dd><a href={`mailto:${v.email}`}>{v.email}</a></dd></div>}
      {v.gstin && <div><dt>GSTIN</dt><dd>{v.gstin}</dd></div>}
      {(v.city || v.address) && <div><dt>Address</dt><dd>{[v.address, v.city].filter(Boolean).join(', ')}</dd></div>}
    </dl>
    {v.notes && <p style={{ maxWidth: '68ch', whiteSpace: 'pre-wrap' }}>{v.notes}</p>}
    <div className="actions">
      <button onClick={() => setSheet('review')}>Add a review</button>
      {v.canManage && <button onClick={() => setSheet('edit')}>Edit</button>}
      {v.canManage && (v.status === 'active' ? <button onClick={() => setSheet('status')}>Put on hold or block</button>
        : <button disabled={act.busy} onClick={() => act.run(async () => { await api.patch(`/api/vendors/${id}`, { status: 'active' }); reload(); })}>Make active again</button>)}
    </div>
    <ErrorNote error={act.error} />
    <section>
      <header><h2>How they have done</h2><span className="quiet">{s.count ? `${s.count} review${s.count === 1 ? '' : 's'}` : 'No reviews yet'}</span></header>
      {s.count > 0 && <div className="ops-tiles">
        {([['Quality of work', s.quality], ['On time', s.timeliness], ['Value for money', s.value]] as const).map(([l, n]) =>
          <div key={l} className="tile"><span className="big num">{Number(n).toFixed(1)}<small>/5</small></span><span>{l}</span></div>)}
        <div className="tile"><span className="big num">{s.rehire}<small>/{s.count}</small></span><span>would hire again</span></div>
      </div>}
      {v.reviews.length > 0 && <div className="rows">{v.reviews.map((r: any) => <div key={r.id} className="row">
        <span><span className="title">{r.by}{r.work_ref ? `, for ${r.work_title}` : ''}</span><br />
          <span className="meta">Quality {r.quality}, on time {r.timeliness}, value {r.value}. {r.would_rehire ? 'Would hire again.' : 'Would not hire again.'}{r.comment ? ` “${r.comment}”` : ''}</span></span>
        <span className="side quiet">{shortDate(r.created_at)}</span></div>)}</div>}
    </section>
    <section>
      <header><h2>Quotations</h2></header>
      <div className="rows">{v.quotes.length ? v.quotes.map((q: any) => <Link key={q.id} to={`/work/orders/${q.work_id}`} className="row">
        <span><span className="title">{q.work_title}</span><br /><span className="meta">{q.ref} on {q.work_ref}, {shortDate(q.received_on)}</span></span>
        <span className="side"><span className="num">{rupees(q.amount_paise)}</span><br />
          <span className={`tag ${q.chosen === 'approved' ? 'day-done' : q.chosen === 'pending' ? 'w-open' : ''}`}>{q.chosen === 'approved' ? 'Awarded'
            : q.chosen === 'pending' ? 'Recommended' : q.other_awarded ? 'Not chosen' : q.replaced_by ? 'Revised' : q.withdrawn_at ? 'Set aside' : 'Open'}</span></span>
      </Link>) : <p className="empty">No quotations from this vendor yet.</p>}</div>
    </section>
    {v.contracts.length > 0 && <section><header><h2>Contracts</h2></header>
      <div className="rows">{v.contracts.map((c: any) => <div key={c.id} className="row"><span className="title">{c.title}</span>
        <span className="side quiet">{c.renewed_by ? 'Renewed' : `Until ${shortDate(c.ends_on)}`}</span></div>)}</div></section>}
    {sheet === 'edit' && <Sheet open onClose={() => setSheet(null)} title="Edit vendor"><VendorForm existing={v} onDone={() => { setSheet(null); reload(); }} /></Sheet>}
    {sheet === 'review' && <Sheet open onClose={() => setSheet(null)} title={`Review ${v.name}`}><ReviewForm vendorId={id} onDone={() => { setSheet(null); reload(); }} /></Sheet>}
    {sheet === 'status' && <Sheet open onClose={() => setSheet(null)} title="Put on hold or block">
      <div className="tabs" role="radiogroup">{[['on_hold', 'On hold'], ['blocked', 'Blocked']].map(([k, l]) =>
        <button key={k} aria-pressed={status.status === k} onClick={() => setStatus({ ...status, status: k })}>{l}</button>)}</div>
      <p className="quiet">{status.status === 'blocked' ? 'A blocked vendor cannot be given new quotations or chosen.' : 'On hold: quotations can be recorded, but the vendor cannot be chosen.'}</p>
      <label className="field">Reason<textarea value={status.note} onChange={e => setStatus({ ...status, note: e.target.value })} /></label>
      <ErrorNote error={act.error} />
      <button className="primary" disabled={act.busy || !status.note.trim()} onClick={() => act.run(async () => {
        await api.patch(`/api/vendors/${id}`, { status: status.status, statusNote: status.note }); setSheet(null); reload(); })}>Save</button>
    </Sheet>}
  </>;
}
