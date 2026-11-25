import { useState } from 'react';
import { api, phoneDisplay, shortDate } from '../api.ts';
import { t } from '../i18n.ts';
import { can, useApp } from '../main.tsx';
import { ErrorNote, KIND_LABEL, Link, Loading, navigate, PageHead, Sheet, useAction, useApi } from '../ui.tsx';
import { SitePlan, type TreeNode } from './Home.tsx';

const CHILD_KINDS = ['phase', 'zone', 'block', 'tower', 'wing', 'sub_block', 'floor', 'street', 'cluster', 'other'];
const area = (v: any) => (v ? `${Number(v).toLocaleString('en-IN')} sq ft` : '');

export function PlaceView({ id }: { id: string | null }) {
  const { me } = useApp();
  const tree = useApi<{ nodes: TreeNode[]; canManage: boolean }>('/api/property/tree');
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState<null | 'place' | 'unit' | 'import'>(null);
  const nodes = tree.data?.nodes ?? [];
  const node = id ? nodes.find(n => n.id === id) : nodes.find(n => n.parent_id === null);
  const units = useApi(node && can(me, 'units.view') ? `/api/units?node=${node.id}&limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}` : null);
  if (tree.loading) return <Loading what="places" />;
  if (tree.error) return <ErrorNote error={tree.error} />;
  if (!node) return <><h1>Not found</h1><p>This place does not exist or is outside what you can see.</p></>;

  const chain: TreeNode[] = [];
  for (let p: TreeNode | undefined = node; p; p = nodes.find(n => n.id === p!.parent_id)) chain.unshift(p);
  const children = nodes.filter(n => n.parent_id === node.id);
  const manage = tree.data!.canManage && node.in_scope;
  const reload = () => { tree.reload(); units.reload(); };

  return <>
    <PageHead title={node.name} crumbs={chain.slice(0, -1).map(n => ({ to: n.parent_id ? `/places/${n.id}` : '/places', label: n.name }))}>
      {manage && <div className="actions">
        <button onClick={() => setSheet('place')}>Add a place</button>
        {can(me, 'units.manage') && <button onClick={() => setSheet('unit')}>Add a unit</button>}
        {!node.parent_id && can(me, 'units.manage') && can(me, 'people.manage') && <button onClick={() => setSheet('import')}>Import units</button>}
      </div>}
    </PageHead>
    <p className="quiet">{KIND_LABEL[node.kind]} with {node.units_total.toLocaleString('en-IN')} units
      {children.length ? ` in ${children.length} ${children.length === 1 ? 'place' : 'places'}` : ''}.</p>

    {children.length > 0 && <SitePlan nodes={nodes} focusId={node.id} />}

    {can(me, 'units.view') && <section>
      <header><h2>{t('Units')}</h2>
        <input className="search" type="search" placeholder="Unit number or owner's name" aria-label={t('Search')}
          value={q} onChange={e => setQ(e.target.value)} /></header>
      {units.loading && !units.data ? <Loading /> : units.data?.units.length ? <div className="table-wrap"><table className="grid">
        <thead><tr><th>Unit</th><th>Type</th><th className="wide">Place</th><th className="wide">Carpet area</th><th>{t('Owners')}</th></tr></thead>
        <tbody>{units.data.units.map((u: any) => <tr key={u.id} className="click" onClick={() => navigate(`/units/${u.id}`)}>
          <td><Link to={`/units/${u.id}`}>{u.label}</Link></td><td>{u.type}</td><td className="wide">{u.location}</td>
          <td className="wide num">{area(u.carpet_sqft || u.plot_sqft)}</td><td>{u.owners ?? <span className="faint">No owner recorded</span>}</td>
        </tr>)}</tbody></table>
        {units.data.total > units.data.units.length && <p className="empty">Showing {units.data.units.length} of {units.data.total.toLocaleString('en-IN')}. Search or open a place to narrow the list.</p>}
      </div> : <div className="rows"><p className="empty">{q ? 'No unit matches that search.' : 'No units here yet.'}</p></div>}
    </section>}

    <AddPlace open={sheet === 'place'} parent={node} onClose={() => setSheet(null)} onDone={reload} />
    <AddUnit open={sheet === 'unit'} parent={node} onClose={() => setSheet(null)} onDone={reload} />
    <ImportUnits open={sheet === 'import'} onClose={() => setSheet(null)} onDone={reload} />
  </>;
}

function AddPlace({ open, parent, onClose, onDone }: { open: boolean; parent: TreeNode; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ kind: 'block', name: '', code: '' });
  const { busy, error, run } = useAction();
  const save = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    await api.post('/api/property/nodes', { parentId: parent.id, kind: form.kind, name: form.name, code: form.code || null });
    setForm({ ...form, name: '', code: '' }); onDone(); onClose();
  }); };
  return <Sheet open={open} onClose={onClose} title={`Add a place in ${parent.name}`}>
    <form className="form" onSubmit={save}>
      <div className="two">
        <label className="field">Kind<select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
          {CHILD_KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
        <label className="field">Short code<input value={form.code} maxLength={20} onChange={e => setForm({ ...form, code: e.target.value })} />
          <span className="hint">Optional, for example A or T2</span></label>
      </div>
      <label className="field">Name<input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
        placeholder="The name residents use, for example Ganga Block" /></label>
      <ErrorNote error={error} />
      <button className="primary" disabled={busy}>Add place</button>
    </form>
  </Sheet>;
}

function AddUnit({ open, parent, onClose, onDone }: { open: boolean; parent: TreeNode; onClose: () => void; onDone: () => void }) {
  const types = useApi<any[]>(open ? '/api/unit-types' : null);
  const [f, setF] = useState<Record<string, string>>({ label: '', unitTypeId: '', floorNo: '', carpetSqft: '', superSqft: '', udsSqft: '' });
  const { busy, error, run } = useAction();
  const n = (v: string) => (v ? Number(v) : null);
  const save = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    const u = await api.post('/api/units', { nodeId: parent.id, unitTypeId: f.unitTypeId || types.data![0].id, label: f.label,
      floorNo: n(f.floorNo), carpetSqft: n(f.carpetSqft), superSqft: n(f.superSqft), udsSqft: n(f.udsSqft) });
    onDone(); onClose(); navigate(`/units/${u.id}`);
  }); };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return <Sheet open={open} onClose={onClose} title={`Add a unit in ${parent.name}`}>
    <form className="form" onSubmit={save}>
      <div className="two">
        <label className="field">Unit number<input required value={f.label} onChange={set('label')} placeholder="A-304" /></label>
        <label className="field">Type<select value={f.unitTypeId} onChange={set('unitTypeId')}>
          {types.data?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      </div>
      <div className="two">
        <label className="field">Floor<input inputMode="numeric" value={f.floorNo} onChange={set('floorNo')} /></label>
        <label className="field">Carpet area, sq ft<input inputMode="decimal" value={f.carpetSqft} onChange={set('carpetSqft')} /></label>
        <label className="field">Super area, sq ft<input inputMode="decimal" value={f.superSqft} onChange={set('superSqft')} /></label>
        <label className="field">Undivided land share, sq ft<input inputMode="decimal" value={f.udsSqft} onChange={set('udsSqft')} /></label>
      </div>
      <ErrorNote error={error} />
      <button className="primary" disabled={busy}>Add unit</button>
    </form>
  </Sheet>;
}

const SAMPLE = `location,unit,type,floor,carpet_sqft,super_sqft,uds_sqft,owner_name,owner_phone,owner_share
Ganga Block > Wing 1 > Floor 3,G1-301,2BHK,3,1120,1440,470,Asha Raman;Ravi Raman,98400 11111;98400 22222,50;50
Phase 2 > street:Palm Avenue,PALM-V07,Villa,,2600,,2400,Lakshmi Iyer,98400 33333,100`;

function ImportUnits({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const { busy, error, run } = useAction();
  const check = () => run(async () => setPreview(await api.post('/api/units/import', { csv, dryRun: true })));
  const commit = () => run(async () => { const r = await api.post('/api/units/import', { csv, dryRun: false }); setPreview(r); onDone(); });
  return <Sheet open={open} onClose={onClose} title="Import units from a spreadsheet">
    <p className="quiet">Save the sheet as CSV with one row per unit. Places in the location column are created if they are new.
      Owners with a mobile number can sign in straight away.</p>
    <label className="field">CSV file<input type="file" accept=".csv,text/csv" onChange={async e => {
      const file = e.target.files?.[0]; if (file) { setCsv(await file.text()); setPreview(null); } }} /></label>
    <details><summary>See the columns</summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>{SAMPLE}</pre></details>
    <ErrorNote error={error} />
    {preview && (preview.committed
      ? <p className="note ok">Imported {preview.unitsCreated} units, {preview.locationsCreated.length} new places and {preview.peopleCreated} people.</p>
      : <div className="form">
        <p className="note">{preview.rows} rows checked: {preview.unitsCreated} units, {preview.locationsCreated.length} new places and {preview.peopleCreated} new people would be added.</p>
        {preview.errors.length > 0 && <div className="rows">{preview.errors.slice(0, 30).map((er: any) =>
          <div key={er.row} className="row"><span>Row {er.row}: {er.message}</span></div>)}</div>}
      </div>)}
    <div className="actions">
      <button onClick={check} disabled={!csv || busy}>Check the file</button>
      <button className="primary" onClick={commit} disabled={!preview || preview.committed || preview.errors.length > 0 || busy}>Import</button>
    </div>
  </Sheet>;
}

// ------------------------------------------------------------------ one unit
export function UnitView({ id }: { id: string }) {
  const { data, error, loading, reload } = useApi(`/api/units/${id}`);
  const [sheet, setSheet] = useState<null | 'owner' | 'sale' | 'occupant'>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const { unit, owners, occupants, parking, meters } = data;
  const current = owners.filter((o: any) => !o.ends_on);
  const past = owners.filter((o: any) => o.ends_on);
  const path: { id: string; name: string; root: boolean }[] = unit.path ?? [];
  return <>
    <PageHead title={unit.label} crumbs={path.map(p => ({ label: p.name, to: data.canManage || data.canManagePeople || p.root ? (p.root ? '/places' : `/places/${p.id}`) : undefined }))} />
    <dl className="facts">
      <div><dt>Type</dt><dd>{unit.type}</dd></div>
      {unit.floor_no !== null && <div><dt>Floor</dt><dd>{unit.floor_no === 0 ? 'Ground' : unit.floor_no}</dd></div>}
      {unit.carpet_sqft && <div><dt>Carpet area</dt><dd>{area(unit.carpet_sqft)}</dd></div>}
      {unit.super_sqft && <div><dt>Super area</dt><dd>{area(unit.super_sqft)}</dd></div>}
      {unit.plot_sqft && <div><dt>Plot</dt><dd>{area(unit.plot_sqft)}</dd></div>}
      {unit.uds_sqft && <div><dt>Undivided land share</dt><dd>{area(unit.uds_sqft)}</dd></div>}
      <div><dt>Occupancy</dt><dd>{({ owner_occupied: 'Owner lives here', let_out: 'Let out', vacant: 'Vacant', under_construction: 'Under construction' } as any)[unit.occupancy]}</dd></div>
    </dl>

    <section>
      <header><h2>{t('Owners')}</h2>{data.canManagePeople && <div className="actions">
        <button onClick={() => setSheet('owner')}>Add an owner</button><button onClick={() => setSheet('sale')}>Record a sale</button></div>}</header>
      <div className="rows">
        {current.length ? current.map((o: any) => <div key={o.id} className="row">
          <span><Link to={`/people/${o.person_id}`} className="title">{o.full_name}</Link><br />
            <span className="meta">Since {shortDate(o.starts_on)}{o.phone ? `, ${phoneDisplay(o.phone)}` : ''}</span></span>
          <span className="side num">{Number(o.share_pct)}%</span></div>) : <p className="empty">No owner is recorded for this unit.</p>}
      </div>
      {past.length > 0 && <details><summary>Earlier owners ({past.length})</summary><div className="rows">{past.map((o: any) =>
        <div key={o.id} className="row"><span>{o.full_name}</span><span className="side quiet">{shortDate(o.starts_on)} to {shortDate(o.ends_on)}</span></div>)}</div></details>}
    </section>

    <section>
      <header><h2>Living here</h2>{data.canManagePeople && <button onClick={() => setSheet('occupant')}>Add a resident</button>}</header>
      <div className="rows">
        {occupants.filter((o: any) => !o.ends_on).length ? occupants.filter((o: any) => !o.ends_on).map((o: any) => <div key={o.id} className="row">
          <span><span className="title">{o.full_name}</span><br /><span className="meta">{o.relation[0].toUpperCase() + o.relation.slice(1)}{o.is_primary_contact ? ', main contact' : ''}</span></span>
          {data.canManagePeople && <button className="quiet-btn" onClick={async () => { await api.post(`/api/occupancies/${o.id}/end`); reload(); }}>Moved out</button>}
        </div>) : <p className="empty">Nobody is recorded as living here.</p>}
      </div>
    </section>

    {(parking.length > 0 || meters.length > 0) && <section>
      <header><h2>Parking and meters</h2></header>
      <div className="rows">
        {parking.map((p: any) => <div key={p.id} className="row"><span>Parking {p.label}</span><span className="side quiet">{p.kind.replace('_', ' ')}</span></div>)}
        {meters.map((m: any) => <div key={m.id} className="row"><span>{m.kind[0].toUpperCase() + m.kind.slice(1).replace('_', ' ')} meter {m.meter_no}</span><span className="side quiet">{m.provider}</span></div>)}
      </div>
    </section>}

    <OwnerSheet open={sheet === 'owner'} unitId={id} onClose={() => setSheet(null)} onDone={reload} />
    <SaleSheet open={sheet === 'sale'} unitId={id} onClose={() => setSheet(null)} onDone={reload} />
    <OccupantSheet open={sheet === 'occupant'} unitId={id} onClose={() => setSheet(null)} onDone={reload} />
  </>;
}

function PersonFields({ v, set }: { v: { name: string; phone: string }; set: (x: { name: string; phone: string }) => void }) {
  return <div className="two">
    <label className="field">Full name<input required value={v.name} onChange={e => set({ ...v, name: e.target.value })} /></label>
    <label className="field">Mobile number<input inputMode="tel" value={v.phone} onChange={e => set({ ...v, phone: e.target.value })} placeholder="98400 12345" />
      <span className="hint">Needed to sign in. An existing number is matched to that person.</span></label>
  </div>;
}

function OwnerSheet({ open, unitId, onClose, onDone }: { open: boolean; unitId: string; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState({ name: '', phone: '' });
  const [share, setShare] = useState('100');
  const { busy, error, run } = useAction();
  const save = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    await api.post(`/api/units/${unitId}/owners`, { newPerson: { name: p.name, phone: p.phone || null }, sharePct: Number(share) });
    setP({ name: '', phone: '' }); onDone(); onClose();
  }); };
  return <Sheet open={open} onClose={onClose} title="Add an owner">
    <form className="form" onSubmit={save}><PersonFields v={p} set={setP} />
      <label className="field">Share of ownership, %<input inputMode="decimal" value={share} onChange={e => setShare(e.target.value)} />
        <span className="hint">Joint owners' shares must not add up to more than 100%.</span></label>
      <ErrorNote error={error} /><button className="primary" disabled={busy}>Add owner</button></form>
  </Sheet>;
}

function SaleSheet({ open, unitId, onClose, onDone }: { open: boolean; unitId: string; onClose: () => void; onDone: () => void }) {
  const [buyers, setBuyers] = useState([{ name: '', phone: '', share: '100' }]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const { busy, error, run } = useAction();
  const total = buyers.reduce((s, b) => s + (Number(b.share) || 0), 0);
  const save = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    await api.post(`/api/units/${unitId}/sale`, { date, buyers: buyers.map(b => ({ newPerson: { name: b.name, phone: b.phone || null }, sharePct: Number(b.share) })) });
    onDone(); onClose();
  }); };
  return <Sheet open={open} onClose={onClose} title="Record a sale">
    <form className="form" onSubmit={save}>
      <p className="quiet">The current owners are moved to the unit's history on the sale date, and the buyers become the owners.</p>
      <label className="field">Date of sale<input type="date" value={date} onChange={e => setDate(e.target.value)} required /></label>
      {buyers.map((b, i) => <div key={i} className="panel pad form">
        <PersonFields v={b} set={x => setBuyers(buyers.map((y, j) => j === i ? { ...y, ...x } : y))} />
        <label className="field">Share, %<input inputMode="decimal" value={b.share} onChange={e => setBuyers(buyers.map((y, j) => j === i ? { ...y, share: e.target.value } : y))} /></label>
      </div>)}
      <button type="button" onClick={() => setBuyers([...buyers, { name: '', phone: '', share: '' }])}>Add another buyer</button>
      {total !== 100 && <p className="note">Buyers' shares add up to {total}%; they must total 100%.</p>}
      <ErrorNote error={error} /><button className="primary" disabled={busy || total !== 100}>Record sale</button>
    </form>
  </Sheet>;
}

function OccupantSheet({ open, unitId, onClose, onDone }: { open: boolean; unitId: string; onClose: () => void; onDone: () => void }) {
  const [p, setP] = useState({ name: '', phone: '' });
  const [relation, setRelation] = useState('tenant');
  const { busy, error, run } = useAction();
  const save = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    await api.post(`/api/units/${unitId}/occupants`, { newPerson: { name: p.name, phone: p.phone || null }, relation, isPrimaryContact: relation === 'tenant' });
    setP({ name: '', phone: '' }); onDone(); onClose();
  }); };
  return <Sheet open={open} onClose={onClose} title="Add a resident">
    <form className="form" onSubmit={save}><PersonFields v={p} set={setP} />
      <label className="field">Lives here as<select value={relation} onChange={e => setRelation(e.target.value)}>
        <option value="tenant">Tenant</option><option value="family">Family member</option><option value="caretaker">Caretaker</option><option value="owner">Owner</option></select></label>
      <ErrorNote error={error} /><button className="primary" disabled={busy}>Add resident</button></form>
  </Sheet>;
}
