import { rupees } from '../api.ts';
import { t } from '../i18n.ts';
import { can, useApp } from '../main.tsx';
import { KIND_LABEL, Link, Loading, useApi } from '../ui.tsx';
import { OperationsPanel } from './Work.tsx';
import { MoneyPanel } from './Money.tsx';

export type TreeNode = { id: string; parent_id: string | null; kind: string; name: string; code: string | null; depth: number;
  sort_order: number; in_scope: boolean; units_here: number; units_total: number };

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

// The community's shape at a glance: each place below the current one is drawn as a plot whose
// width follows its number of units, with the places inside it as smaller plots.
export function SitePlan({ nodes, focusId }: { nodes: TreeNode[]; focusId: string | null }) {
  const focus = focusId ? nodes.find(n => n.id === focusId) : nodes.find(n => n.parent_id === null);
  if (!focus) return null;
  const children = nodes.filter(n => n.parent_id === focus.id).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  if (!children.length) return null;
  return <div className="plan" role="list" aria-label={`Places in ${focus.name}`}>
    {children.map(c => {
      const inner = nodes.filter(n => n.parent_id === c.id).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
      const shown = inner.slice(0, inner.every(i => i.kind === 'floor') ? 20 : 12);
      const lot = <>
        <span className="lot-name">{c.name}</span>
        <span className="lot-count">{KIND_LABEL[c.kind]}{c.units_total ? `, ${plural(c.units_total, 'unit')}` : ''}</span>
        {shown.length > 0 && <span className="inner" aria-hidden="true">
          {shown.map(i => <span key={i.id} style={{ ['--w' as any]: Math.max(1, i.units_total) }} title={`${i.name}: ${i.units_total} units`}>
            {i.code || shortName(i.name)}</span>)}
          {inner.length > shown.length && <span style={{ ['--w' as any]: 1 }}>+{inner.length - shown.length}</span>}
        </span>}
      </>;
      const cls = `lot kind-${c.kind}${c.units_total ? '' : ' empty-lot'}`;
      return c.in_scope
        ? <Link key={c.id} to={`/places/${c.id}`} className={cls} role="listitem" style={{ ['--w' as any]: Math.max(1, c.units_total) }}>{lot}</Link>
        : <div key={c.id} className={cls} role="listitem" style={{ ['--w' as any]: Math.max(1, c.units_total), opacity: 0.55 }}>{lot}</div>;
    })}
  </div>;
}
// Floors are many and numbered, so their plots show just the number; other places keep their name.
const shortName = (s: string) => (/^floor\s+\S+$/i.test(s) ? s.replace(/^floor\s+/i, '') : s.length > 16 ? s.slice(0, 15) + '…' : s);

export function Home() {
  const { me, community } = useApp();
  const dash = useApi('/api/dashboard');
  const tree = useApi<{ nodes: TreeNode[] }>(can(me, 'property.view') ? '/api/property/tree' : null);
  const waiting = useApi<any[]>('/api/approvals?mine=1');
  const root = tree.data?.nodes.find(n => n.parent_id === null);
  const units = (dash.data?.units ?? []) as { category: string; name: string; occupancy: string; n: number }[];
  const byType = Object.entries(units.reduce<Record<string, number>>((m, u) => ({ ...m, [u.name]: (m[u.name] ?? 0) + u.n }), {}));
  const total = units.reduce((s, u) => s + u.n, 0);
  const occ = (k: string) => units.filter(u => u.occupancy === k).reduce((s, u) => s + u.n, 0);

  return <>
    <div className="page-head">
      <h1>{greeting()}, {me.person.name.split(' ')[0]}</h1>
      <p className="quiet">{me.roles.map(r => r.scope ? `${r.name}, ${r.scope}` : r.name).join('; ')}</p>
    </div>

    {(waiting.data?.length ?? 0) > 0 && <section>
      <header><h2>{t('Waiting for your vote')}</h2><Link to="/approvals">All approvals</Link></header>
      <div className="rows">
        {waiting.data!.map(a => <Link key={a.id} to={`/approvals/${a.id}`} className="row">
          <span><span className="title">{a.title}</span><br /><span className="meta">{a.ref}, {a.scope}, raised by {a.proposer}</span></span>
          <span className="side num">{rupees(a.amount_paise)}</span>
        </Link>)}
      </div>
    </section>}

    <OperationsPanel />

    <MoneyPanel />

    {me.homes.length > 0 && <section>
      <header><h2>{t('Your homes')}</h2></header>
      <div className="rows">
        {me.homes.map(h => <Link key={h.id + h.relation} to={`/units/${h.id}`} className="row">
          <span><span className="title">{h.label}</span><br /><span className="meta">{h.type}, {h.location}</span></span>
          <span className="side quiet">{h.relation === 'owner' ? (Number(h.share_pct) < 100 ? `Owner, ${Number(h.share_pct)}%` : 'Owner') : h.relation}</span>
        </Link>)}
      </div>
    </section>}

    {root && <section>
      <header><h2>{root.name}</h2><Link to="/places">{t('Places')}</Link></header>
      {tree.loading ? <Loading /> : <SitePlan nodes={tree.data!.nodes} focusId={null} />}
      {total > 0 && <dl className="facts">
        <div><dt>{t('Units')}</dt><dd>{total.toLocaleString('en-IN')}</dd></div>
        <div><dt>Lived in by owners</dt><dd>{occ('owner_occupied').toLocaleString('en-IN')}</dd></div>
        <div><dt>Let out</dt><dd>{occ('let_out').toLocaleString('en-IN')}</dd></div>
        <div><dt>Vacant</dt><dd>{occ('vacant').toLocaleString('en-IN')}</dd></div>
        {dash.data?.approvals && <div><dt>Open approvals</dt><dd>{dash.data.approvals.pending}</dd></div>}
      </dl>}
    </section>}

    {byType.length > 0 && <section>
      <header><h2>Kinds of home</h2></header>
      <div className="rows">
        {byType.map(([name, n]) => <div key={name} className="row">
          <span className="title">{name}</span>
          <span className="side num">{n.toLocaleString('en-IN')}<span className="progress" style={{ width: 120, display: 'inline-block', marginLeft: 12, verticalAlign: 'middle' }}>
            <i style={{ width: `${(n / total) * 100}%`, background: 'var(--brand)' }} /></span></span>
        </div>)}
      </div>
    </section>}

    {(dash.data?.facilities?.length ?? 0) > 0 && <section>
      <header><h2>Shared facilities</h2></header>
      <div className="rows">
        {dash.data.facilities.map((f: any) => <div key={f.id} className="row">
          <span className="title">{f.name}</span><span className="side quiet">{f.location === root?.name ? 'Whole community' : f.location}</span>
        </div>)}
      </div>
    </section>}

    {!can(me, 'property.view') && me.homes.length === 0 && <p className="note">You're signed in to {community.platformName}. Your association office will add your home details.</p>}
  </>;
}
