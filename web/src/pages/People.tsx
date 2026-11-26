import { useState } from 'react';
import { api, phoneDisplay, shortDate } from '../api.ts';
import { PhotoPicker } from './Account.tsx';
import { t } from '../i18n.ts';
import { can, useApp } from '../main.tsx';
import { ErrorNote, Initials, Link, Loading, PageHead, POSITION_LABEL, Sheet, useAction, useApi } from '../ui.tsx';
import type { TreeNode } from './Home.tsx';

export function PeopleList() {
  const { me } = useApp();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const { data, loading, error, reload } = useApi(can(me, 'people.view') ? `/api/people?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}` : null);
  if (!can(me, 'people.view')) return <><PageHead title={t('People')} /><p className="quiet">The people directory is for the committee and office.</p>
    {can(me, 'committees.view') && <Link to="/committees">See the committees</Link>}</>;
  return <>
    <PageHead title={t('People')}><div className="actions">
      <Link to="/committees" className="button">{t('Committees')}</Link>
      {can(me, 'people.manage') && <button className="primary" onClick={() => setAdding(true)}>Add a person</button>}</div></PageHead>
    <input className="search" type="search" placeholder="Name or mobile number" aria-label={t('Search')} value={q} onChange={e => setQ(e.target.value)} />
    <ErrorNote error={error} />
    {loading && !data ? <Loading /> : <div className="rows">
      {data?.people.length ? data.people.map((p: any) => <Link key={p.id} to={`/people/${p.id}`} className="row">
        <span><span className="title">{p.full_name}</span><br /><span className="meta">{[p.owns && `Owns ${p.owns}`, p.roles].filter(Boolean).join('. ')}</span></span>
        <span className="side quiet num">{phoneDisplay(p.phone_e164)}</span>
      </Link>) : <p className="empty">Nobody matches that search.</p>}
      {data && data.total > data.people.length && <p className="empty">Showing {data.people.length} of {data.total.toLocaleString('en-IN')}. Search to find someone.</p>}
    </div>}
    <AddPerson open={adding} onClose={() => setAdding(false)} onDone={reload} />
  </>;
}

function AddPerson({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ fullName: '', phone: '', email: '' });
  const { busy, error, run } = useAction();
  return <Sheet open={open} onClose={onClose} title="Add a person">
    <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
      await api.post('/api/people', { fullName: f.fullName, phone: f.phone || null, email: f.email || null });
      setF({ fullName: '', phone: '', email: '' }); onDone(); onClose(); }); }}>
      <label className="field">Full name<input required value={f.fullName} onChange={e => setF({ ...f, fullName: e.target.value })} /></label>
      <label className="field">Mobile number<input inputMode="tel" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></label>
      <label className="field">Email<input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></label>
      <ErrorNote error={error} /><button className="primary" disabled={busy}>Add person</button>
    </form>
  </Sheet>;
}

export function PersonView({ id }: { id: string }) {
  const { me } = useApp();
  const { data, loading, error, reload } = useApi(`/api/people/${id}`);
  const [granting, setGranting] = useState(false);
  const act = useAction();
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const { person, homes, memberships, seats } = data;
  return <>
    <PageHead title={person.full_name} crumbs={[{ to: '/people', label: t('People') }]} />
    {can(me, 'people.manage') ? <PhotoPicker name={person.full_name} photo={person.photo_file_id}
        onSave={async fid => { await api.put(`/api/people/${id}/photo`, { fileId: fid }); reload(); }}
        onRemove={async () => { await api.put(`/api/people/${id}/photo`, { fileId: null }); reload(); }} />
      : person.photo_file_id && <Initials name={person.full_name} photo={person.photo_file_id} size={96} />}
    <dl className="facts">
      <div><dt>{t('Mobile number')}</dt><dd>{phoneDisplay(person.phone_e164) || 'Not recorded'}</dd></div>
      {person.email && <div><dt>Email</dt><dd>{person.email}</dd></div>}
      <div><dt>Has signed in</dt><dd>{person.has_signed_in ? 'Yes' : 'Not yet'}</dd></div>
    </dl>
    <section><header><h2>Homes</h2></header><div className="rows">
      {homes.length ? homes.map((h: any) => <Link key={h.id} to={`/units/${h.unit_id}`} className="row">
        <span><span className="title">{h.label}</span><br /><span className="meta">{h.relation === 'owner' ? `Owner, ${Number(h.share_pct)}%` : h.relation}</span></span>
        <span className="side quiet">{h.ends_on ? `Until ${shortDate(h.ends_on)}` : `Since ${shortDate(h.starts_on)}`}</span></Link>)
        : <p className="empty">No home is linked to this person.</p>}</div></section>
    {seats.length > 0 && <section><header><h2>{t('Committees')}</h2></header><div className="rows">
      {seats.map((s: any) => <div key={s.id} className="row"><span>{POSITION_LABEL[s.position]}, {s.committee}</span>
        <span className="side quiet">{s.ends_on ? `Until ${shortDate(s.ends_on)}` : `Since ${shortDate(s.starts_on)}`}</span></div>)}</div></section>}
    <section><header><h2>Access</h2>{can(me, 'members.manage') && <button onClick={() => setGranting(true)}>Give access</button>}</header>
      <ErrorNote error={act.error} />
      <div className="rows">{memberships.length ? memberships.map((m: any) => <div key={m.id} className="row">
        <span className={m.status === 'disabled' ? 'faint' : ''}>{m.role}{m.scope ? `, for ${m.scope}` : ''}{m.status === 'disabled' ? ' (removed)' : ''}</span>
        {can(me, 'members.manage') && <button className="quiet-btn" disabled={act.busy} onClick={() => act.run(async () => {
          await api.post(`/api/members/${m.id}/${m.status === 'active' ? 'disable' : 'enable'}`); reload(); })}>
          {m.status === 'active' ? 'Remove' : 'Restore'}</button>}
      </div>) : <p className="empty">This person cannot sign in yet.</p>}</div></section>
    <GrantAccess open={granting} personId={id} onClose={() => setGranting(false)} onDone={reload} />
  </>;
}

function GrantAccess({ open, personId, onClose, onDone }: { open: boolean; personId: string; onClose: () => void; onDone: () => void }) {
  const roles = useApi<any[]>(open ? '/api/roles' : null);
  const tree = useApi<{ nodes: TreeNode[] }>(open ? '/api/property/tree' : null);
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState('');
  const { busy, error, run } = useAction();
  return <Sheet open={open} onClose={onClose} title="Give access">
    <label className="field">Role<select value={roleId} onChange={e => setRoleId(e.target.value)}>
      <option value="">Choose a role</option>{roles.data?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <span className="hint">{roles.data?.find(r => r.id === roleId)?.description}</span></label>
    <label className="field">For<select value={scope} onChange={e => setScope(e.target.value)}>
      <option value="">The whole community</option>
      {tree.data?.nodes.filter(n => n.parent_id && n.kind !== 'floor').map(n => <option key={n.id} value={n.id}>{' '.repeat(n.depth - 1)}{n.name}</option>)}</select>
      <span className="hint">Choose a block or phase to limit the role to that place.</span></label>
    <ErrorNote error={error} />
    <button className="primary" disabled={!roleId || busy} onClick={() => run(async () => {
      await api.post('/api/members', { personId, roleId, scopeNodeId: scope || null }); onDone(); onClose(); })}>Give access</button>
  </Sheet>;
}

export function Committees() {
  const { me } = useApp();
  const { data, loading, error, reload } = useApi<any[]>('/api/committees');
  const [adding, setAdding] = useState<any>(null);
  const act = useAction();
  if (loading && !data) return <Loading />;
  return <>
    <PageHead title={t('Committees')} crumbs={[{ to: '/people', label: t('People') }]} />
    <ErrorNote error={error ?? act.error} />
    {data?.map(c => <section key={c.id}>
      <header><div><h2>{c.name}</h2><p className="quiet">{c.kind === 'apex' || c.kind === 'federation' ? 'Decides for the whole community' : `Looks after ${c.scope}`}</p></div>
        {can(me, 'committees.manage') && <button onClick={() => setAdding(c)}>Add a member</button>}</header>
      <div className="rows">{c.seats.length ? c.seats.map((s: any) => <div key={s.id} className="row">
        <span className="voter" style={{ border: 0, padding: 0, background: 'none' }}><Initials name={s.full_name} photo={s.photo_file_id} />
          <span><Link to={`/people/${s.person_id}`}>{s.full_name}</Link><br /><span className="meta">{POSITION_LABEL[s.position]}</span></span></span>
        {can(me, 'committees.manage') && <button className="quiet-btn" onClick={() => act.run(async () => {
          await api.post(`/api/seats/${s.id}/end`, { reason: '' }); reload(); })}>Leaves committee</button>}
      </div>) : <p className="empty">No members yet.</p>}</div>
    </section>)}
    <AddSeat committee={adding} onClose={() => setAdding(null)} onDone={reload} />
  </>;
}

function AddSeat({ committee, onClose, onDone }: { committee: any; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [position, setPosition] = useState('member');
  const people = useApi(committee && q.length > 1 ? `/api/people?q=${encodeURIComponent(q)}&limit=8` : null);
  const { busy, error, run } = useAction();
  return <Sheet open={!!committee} onClose={onClose} title={`Add a member to ${committee?.name ?? ''}`}>
    <label className="field">Position<select value={position} onChange={e => setPosition(e.target.value)}>
      {Object.entries(POSITION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
    <label className="field">Find the person<input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Name or mobile number" /></label>
    <ErrorNote error={error} />
    <div className="rows">{people.data?.people.map((p: any) => <button key={p.id} className="row" style={{ width: '100%', border: 0, borderRadius: 0, textAlign: 'left' }}
      disabled={busy} onClick={() => run(async () => {
        await api.post(`/api/committees/${committee.id}/seats`, { personId: p.id, position }); onDone(); onClose(); setQ(''); })}>
      <span>{p.full_name}<br /><span className="meta">{p.owns ? `Owns ${p.owns}` : ''}</span></span><span className="side">Add</span></button>)}</div>
  </Sheet>;
}
