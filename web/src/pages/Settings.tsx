import { useEffect, useState } from 'react';
import { api, rupees } from '../api.ts';
import { LANG_NAMES, t } from '../i18n.ts';
import { can, signOut, useApp } from '../main.tsx';
import { ErrorNote, Link, Loading, MODE_LABEL, PageHead, Sheet, useAction, useApi } from '../ui.tsx';
import type { TreeNode } from './Home.tsx';

export function MoreMenu() {
  const { me, community } = useApp();
  const items = [
    can(me, 'property.view') && { to: '/places', label: t('Places'), meta: 'Blocks, homes and shared facilities' },
    can(me, 'people.view') && { to: '/people', label: t('People'), meta: 'Owners, residents, staff and their access' },
    can(me, 'committees.view') && { to: '/committees', label: t('Committees'), meta: 'Managing, block and phase committees' },
    can(me, 'settings.manage') && { to: '/settings', label: 'Platform name and look', meta: `${community.platformName}, colours, logo, languages` },
    (can(me, 'roles.manage') || can(me, 'members.manage')) && { to: '/settings/roles', label: 'Roles', meta: 'What each role can see and do' },
    can(me, 'approval_rules.view') && { to: '/settings/rules', label: 'Approval rules', meta: 'Which committee decides, and how many must agree' },
    can(me, 'audit.view') && { to: '/settings/activity', label: 'Activity', meta: 'Every change, who made it and when' },
  ].filter(Boolean) as { to: string; label: string; meta: string }[];
  return <>
    <PageHead title={t('More')} />
    <div className="rows">{items.map(i => <Link key={i.to} to={i.to} className="row">
      <span><span className="title">{i.label}</span><br /><span className="meta">{i.meta}</span></span><span className="side" aria-hidden="true">›</span></Link>)}
      {can(me, 'data.export') && <a className="row" href="/api/export"><span><span className="title">Download all data</span><br />
        <span className="meta">A complete copy of {community.brandName}'s records as one file</span></span></a>}
    </div>
    <div className="actions"><button onClick={() => signOut()}>{t('Sign out')} ({me.person.name})</button></div>
    <p className="faint">{community.platformName} runs on Pragati Cloud.</p>
  </>;
}

const SWATCHES = ['#1f4d7a', '#1f5f8b', '#2f5d50', '#3d6b2f', '#6b4f1d', '#7a2f3b', '#5a3d7a', '#2e4a5e', '#8a4b16', '#264653'];

export function SettingsPage() {
  const { refreshCommunity } = useApp();
  const { data, loading, reload } = useApi('/api/settings');
  const [f, setF] = useState<any>(null);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data) setF({ brandName: data.brand_name, legalName: data.legal_name, registrationNo: data.registration_no ?? '',
    city: data.city ?? '', primaryColor: data.primary_color, languages: data.languages, assistantName: data.assistant_name }); }, [data]);
  if (loading || !f) return <Loading />;
  const preview = (c: string) => document.documentElement.style.setProperty('--brand', c);
  const save = (e: React.FormEvent) => { e.preventDefault(); setSaved(false); run(async () => {
    await api.patch('/api/settings', { ...f, registrationNo: f.registrationNo || null, city: f.city || null });
    setSaved(true); reload(); refreshCommunity();
  }); };
  return <>
    <PageHead title="Platform name and look" crumbs={[{ to: '/more', label: t('More') }]} />
    <form className="form" onSubmit={save} style={{ maxWidth: 640 }}>
      <section className="panel pad">
        <label className="field">Your community's name for the platform
          <input value={f.brandName} maxLength={40} onChange={e => setF({ ...f, brandName: e.target.value })} />
          <span className="hint">Short is best. Everyone sees it on the sign-in page and at the top of every screen.</span></label>
        <p className="name-preview" aria-live="polite">{(f.brandName || '…').trim()} Pragati</p>
      </section>
      <fieldset className="form" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 500, marginBottom: 8 }}>Colour</legend>
        <div className="swatches">{SWATCHES.map(c => <button type="button" key={c} aria-label={c} aria-pressed={f.primaryColor === c}
          style={{ background: c }} onClick={() => { setF({ ...f, primaryColor: c }); preview(c); }} />)}</div>
        <label className="field">Or a colour code<input value={f.primaryColor} pattern="#[0-9a-fA-F]{6}" style={{ maxWidth: 160 }}
          onChange={e => { setF({ ...f, primaryColor: e.target.value }); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) preview(e.target.value); }} /></label>
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="form">
        <legend style={{ fontWeight: 500, marginBottom: 8 }}>Languages people can choose</legend>
        {Object.entries(LANG_NAMES).map(([k, v]) => <label key={k} className="check"><input type="checkbox" checked={f.languages.includes(k)}
          disabled={k === 'en'} onChange={e => setF({ ...f, languages: e.target.checked ? [...f.languages, k] : f.languages.filter((x: string) => x !== k) })} />{v}</label>)}
        <span className="hint quiet">English and Tamil screens are ready; other languages show English until translated.</span>
      </fieldset>
      <div className="two">
        <label className="field">Registered name<input value={f.legalName} onChange={e => setF({ ...f, legalName: e.target.value })} /></label>
        <label className="field">Registration number<input value={f.registrationNo} onChange={e => setF({ ...f, registrationNo: e.target.value })} /></label>
        <label className="field">City<input value={f.city} onChange={e => setF({ ...f, city: e.target.value })} /></label>
        <label className="field">Assistant's name<input value={f.assistantName} onChange={e => setF({ ...f, assistantName: e.target.value })} /></label>
      </div>
      <label className="field">Logo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => {
        const file = e.target.files?.[0]; if (file) run(async () => { await api.upload('/api/settings/logo', file); refreshCommunity(); }); }} />
        <span className="hint">A square PNG or JPG looks best.</span></label>
      <ErrorNote error={error} />
      {saved && <p className="note ok">Saved. Everyone now sees {f.brandName.trim()} Pragati.</p>}
      <div className="actions"><button className="primary" disabled={busy}>Save changes</button></div>
    </form>
  </>;
}

export function Roles() {
  const { me } = useApp();
  const roles = useApi<any[]>('/api/roles');
  const perms = useApi<any[]>('/api/permissions');
  const [edit, setEdit] = useState<any>(null);
  if (roles.loading || perms.loading) return <Loading />;
  const label = new Map(perms.data!.map(p => [p.key, p.label]));
  return <>
    <PageHead title="Roles" crumbs={[{ to: '/more', label: t('More') }]}>
      {can(me, 'roles.manage') && <button className="primary" onClick={() => setEdit({ key: '', name: '', description: '', permissions: [] })}>Create a role</button>}</PageHead>
    <p className="quiet" style={{ maxWidth: '64ch' }}>A role can be given for the whole community or for one block or phase. Nobody can give access they don't have themselves.</p>
    <div className="rows">{roles.data!.map(r => <button key={r.id} className="row" style={{ width: '100%', border: 0, borderRadius: 0, textAlign: 'left', minHeight: 0 }}
      onClick={() => can(me, 'roles.manage') && setEdit(r)}>
      <span><span className="title">{r.name}</span><br /><span className="meta">{r.description || r.permissions.map((p: string) => label.get(p)).join('; ') || 'Sees their own home'}</span></span>
      <span className="side quiet num">{r.members} {r.members === 1 ? 'person' : 'people'}</span></button>)}</div>
    <RoleSheet role={edit} perms={perms.data!} onClose={() => setEdit(null)} onDone={roles.reload} />
  </>;
}

function RoleSheet({ role, perms, onClose, onDone }: { role: any; perms: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { setF(role ? { ...role } : null); }, [role]);
  const areas = [...new Set(perms.map(p => p.area))];
  return <Sheet open={!!role} onClose={onClose} title={role?.id ? `Edit ${role.name}` : 'Create a role'}>
    {f && <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
      if (f.id) await api.patch(`/api/roles/${f.id}`, { name: f.name, description: f.description, permissions: f.permissions });
      else await api.post('/api/roles', { key: f.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'role',
        name: f.name, description: f.description, permissions: f.permissions });
      onDone(); onClose(); }); }}>
      <label className="field">Name<input required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
      <label className="field">What it is for<input value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
      {areas.map(a => <div key={a} className="perm-group"><h3>{a}</h3>{perms.filter(p => p.area === a).map(p =>
        <label key={p.key} className="check"><input type="checkbox" checked={f.permissions.includes(p.key)}
          onChange={e => setF({ ...f, permissions: e.target.checked ? [...f.permissions, p.key] : f.permissions.filter((x: string) => x !== p.key) })} />{p.label}</label>)}</div>)}
      <ErrorNote error={error} /><button className="primary" disabled={busy}>{f.id ? 'Save role' : 'Create role'}</button>
    </form>}
  </Sheet>;
}

const SUBJECT_LABEL: Record<string, string> = { '*': 'Any decision', expense: 'Spending', project: 'Projects', vendor_selection: 'Choosing a vendor',
  work_order: 'Work orders', work_order_change: 'Work order changes', policy: 'Policies and bye-laws', other: 'Other' };
const SELECTOR_LABEL: Record<string, string> = { nearest: "The place's own committee", apex: 'The managing committee or federation', fixed: 'A named committee' };

export function Rules() {
  const { me } = useApp();
  const rules = useApi<any[]>('/api/approval-rules');
  const [edit, setEdit] = useState<any>(null);
  if (rules.loading && !rules.data) return <Loading />;
  const band = (r: any) => r.max_amount_paise ? (Number(r.min_amount_paise) ? `${rupees(r.min_amount_paise)} to ${rupees(r.max_amount_paise)}` : `Under ${rupees(r.max_amount_paise)}`)
    : Number(r.min_amount_paise) ? `${rupees(r.min_amount_paise)} and over` : 'Any amount';
  return <>
    <PageHead title="Approval rules" crumbs={[{ to: '/more', label: t('More') }]}>
      {can(me, 'approval_rules.manage') && <button className="primary" onClick={() => setEdit({})}>Add a rule</button>}</PageHead>
    <p className="quiet" style={{ maxWidth: '64ch' }}>When a request is raised, the most specific rule for its place, kind and amount decides who approves it.
      Changing a rule affects new requests only.</p>
    {rules.data!.map(r => <section key={r.id} className="panel pad" style={{ opacity: r.active ? 1 : 0.6 }}>
      <header><h3>{r.name}</h3>{can(me, 'approval_rules.manage') && <button className="quiet-btn" onClick={() => setEdit(r)}>Edit</button>}</header>
      <p className="quiet">{SUBJECT_LABEL[r.subject_type]}, {band(r).toLowerCase()}{r.scope ? `, in ${r.scope}` : ''}{r.active ? '' : '. Switched off'}.</p>
      <div className="stages">{r.stages.map((s: any) => <div key={s.id} className="stage"><div className="body">
        <p><strong>{s.committee ?? SELECTOR_LABEL[s.committee_selector]}</strong>: {MODE_LABEL(s.mode, s.required_count)}.</p></div></div>)}</div>
    </section>)}
    <RuleSheet rule={edit} onClose={() => setEdit(null)} onDone={rules.reload} />
  </>;
}

function RuleSheet({ rule, onClose, onDone }: { rule: any; onClose: () => void; onDone: () => void }) {
  const committees = useApi<any[]>(rule ? '/api/committees' : null);
  const tree = useApi<{ nodes: TreeNode[] }>(rule ? '/api/property/tree' : null);
  const [f, setF] = useState<any>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (!rule) return setF(null);
    setF({ name: rule.name ?? '', subjectType: rule.subject_type ?? 'expense', scopeNodeId: rule.scope_node_id ?? '',
      minAmount: rule.min_amount_paise && Number(rule.min_amount_paise) ? String(Number(rule.min_amount_paise) / 100) : '',
      maxAmount: rule.max_amount_paise ? String(Number(rule.max_amount_paise) / 100) : '', active: rule.active ?? true,
      allowLetterOverride: rule.allow_letter_override ?? true,
      stages: rule.stages?.map((s: any) => ({ label: s.label, committeeSelector: s.committee_selector, committeeId: s.committee_id ?? '', mode: s.mode,
        requiredCount: s.required_count ?? '' })) ?? [{ label: 'Committee', committeeSelector: 'nearest', committeeId: '', mode: 'majority', requiredCount: '' }] });
  }, [rule]);
  const setStage = (i: number, k: string, v: string) => setF({ ...f, stages: f.stages.map((s: any, j: number) => j === i ? { ...s, [k]: v } : s) });
  return <Sheet open={!!rule} onClose={onClose} title={rule?.id ? 'Edit approval rule' : 'Add an approval rule'}>
    {f && <form className="form" onSubmit={e => { e.preventDefault(); run(async () => {
      const body = { name: f.name, subjectType: f.subjectType, scopeNodeId: f.scopeNodeId || null, minAmount: f.minAmount || null,
        maxAmount: f.maxAmount || null, allowLetterOverride: f.allowLetterOverride, active: f.active,
        stages: f.stages.map((s: any) => ({ label: s.label || 'Committee', committeeSelector: s.committeeSelector,
          committeeId: s.committeeSelector === 'fixed' ? s.committeeId : null, mode: s.mode, requiredCount: s.mode === 'count' ? Number(s.requiredCount) : null })) };
      if (rule.id) await api.put(`/api/approval-rules/${rule.id}`, body); else await api.post('/api/approval-rules', body);
      onDone(); onClose(); }); }}>
      <label className="field">Name<input required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Block costs under ₹2 lakh" /></label>
      <div className="two">
        <label className="field">Applies to<select value={f.subjectType} onChange={e => setF({ ...f, subjectType: e.target.value })}>
          {Object.entries(SUBJECT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">In<select value={f.scopeNodeId} onChange={e => setF({ ...f, scopeNodeId: e.target.value })}>
          <option value="">Anywhere in the community</option>
          {tree.data?.nodes.filter(n => n.parent_id && n.kind !== 'floor').map(n => <option key={n.id} value={n.id}>{' '.repeat(n.depth - 1)}{n.name}</option>)}</select></label>
        <label className="field">From ₹<input inputMode="decimal" value={f.minAmount} onChange={e => setF({ ...f, minAmount: e.target.value })} placeholder="0" /></label>
        <label className="field">Up to, not including ₹<input inputMode="decimal" value={f.maxAmount} onChange={e => setF({ ...f, maxAmount: e.target.value })} placeholder="No limit" /></label>
      </div>
      {f.stages.map((s: any, i: number) => <div key={i} className="panel pad form">
        <div className="head-row"><h3>{f.stages.length > 1 ? `Stage ${i + 1}` : 'Who decides'}</h3>
          {f.stages.length > 1 && <button type="button" className="quiet-btn" onClick={() => setF({ ...f, stages: f.stages.filter((_: any, j: number) => j !== i) })}>Remove</button>}</div>
        <label className="field">Committee<select value={s.committeeSelector} onChange={e => setStage(i, 'committeeSelector', e.target.value)}>
          {Object.entries(SELECTOR_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {s.committeeSelector === 'fixed' && <label className="field">Which committee<select required value={s.committeeId} onChange={e => setStage(i, 'committeeId', e.target.value)}>
          <option value="">Choose</option>{committees.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <div className="two">
          <label className="field">How many must approve<select value={s.mode} onChange={e => setStage(i, 'mode', e.target.value)}>
            <option value="unanimous">Every member</option><option value="majority">A majority</option><option value="count">A set number</option><option value="any">Any one member</option></select></label>
          {s.mode === 'count' && <label className="field">Number<input inputMode="numeric" required value={s.requiredCount} onChange={e => setStage(i, 'requiredCount', e.target.value)} /></label>}
        </div>
      </div>)}
      {f.stages.length < 5 && <button type="button" onClick={() => setF({ ...f, stages: [...f.stages, { label: 'Managing committee', committeeSelector: 'apex', committeeId: '', mode: 'majority', requiredCount: '' }] })}>
        Add a further stage</button>}
      <label className="check"><input type="checkbox" checked={f.allowLetterOverride} onChange={e => setF({ ...f, allowLetterOverride: e.target.checked })} />
        Office bearers may approve with a letter signed by the committee</label>
      {rule.id && <label className="check"><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} />Rule is switched on</label>}
      <ErrorNote error={error} /><button className="primary" disabled={busy}>Save rule</button>
    </form>}
  </Sheet>;
}

export function Activity() {
  const [rows, setRows] = useState<any[]>([]);
  const [more, setMore] = useState(true);
  const { busy, error, run } = useAction();
  const load = (before?: number) => run(async () => {
    const r = await api.get<any[]>(`/api/audit?limit=50${before ? `&before=${before}` : ''}`);
    setRows(x => before ? [...x, ...r] : r); setMore(r.length === 50);
  });
  useEffect(() => { load(); }, []);
  return <>
    <PageHead title="Activity" crumbs={[{ to: '/more', label: t('More') }]} />
    <p className="quiet">Every change is recorded here and cannot be edited or deleted.</p>
    <ErrorNote error={error} />
    <div className="rows">{rows.map(a => <div key={a.id} className="row">
      <span><span className="title">{a.summary}</span><br /><span className="meta">{a.actor ?? 'Pragati'}</span></span>
      <span className="side quiet num">{new Date(a.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
    </div>)}</div>
    {more && <button disabled={busy} onClick={() => load(rows[rows.length - 1]?.id)}>Show earlier</button>}
  </>;
}
