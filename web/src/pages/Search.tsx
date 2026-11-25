// Search across what the person may see; a reference like WO-0012 goes straight to its record.
// QR labels for places: scanning one opens that place's checks.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api.ts';
import { useApp } from '../main.tsx';
import { clearFailed, useOffline } from '../offline.ts';
import { ErrorNote, Link, Loading, navigate, PageHead, useApi } from '../ui.tsx';
import type { TreeNode } from './Home.tsx';

export function SearchPage() {
  const initial = new URLSearchParams(location.search).get('q') ?? '';
  const [q, setQ] = useState(initial);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (text: string) => {
    if (text.trim().length < 2) return;
    setBusy(true); setError(null);
    try {
      const r = await api.get(`/api/search?q=${encodeURIComponent(text.trim())}`);
      history.replaceState(null, '', `/search?q=${encodeURIComponent(text.trim())}`);
      if (r.exact.length === 1 && /^[A-Z]{2}-\d+$/i.test(text.trim())) { navigate(r.exact[0].path); return; }
      setData(r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { if (initial) void go(initial); }, []);
  const groups = Object.entries(data?.groups ?? {}) as [string, any[]][];
  return <>
    <PageHead title="Search" />
    <form className="search-form" onSubmit={e => { e.preventDefault(); void go(q); }} role="search">
      <input type="search" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="A name, a home, a reference like WO-0012, or words in a title" aria-label="Search" />
      <button className="primary" disabled={busy || q.trim().length < 2}>Search</button>
    </form>
    <ErrorNote error={error} />
    {busy && <Loading />}
    {data && !busy && (groups.length ? groups.map(([type, hits]) => <section key={type}>
      <header><h2>{type}</h2></header>
      <div className="rows">{hits.map(h => <Link key={h.path} to={h.path} className="row">
        <span><span className="title">{h.title}</span>{h.meta && <><br /><span className="meta">{h.meta}</span></>}</span>
        {h.ref && <span className="side quiet">{h.ref}</span>}</Link>)}</div>
    </section>) : <p className="empty">Nothing found for “{data.q}” among what you can see.</p>)}
  </>;
}

// A link target for references in Ask Pragathi's answers: /go/WO-0012 opens the record.
export function GoToRef({ refText }: { refText: string }) {
  const [miss, setMiss] = useState(false);
  useEffect(() => {
    api.get(`/api/search?q=${encodeURIComponent(refText)}`).then(r => r.exact[0] ? navigate(r.exact[0].path) : setMiss(true)).catch(() => setMiss(true));
  }, [refText]);
  return miss ? <p className="empty">{refText} is not something you can open. <Link to="/search">Search</Link></p> : <Loading />;
}

// ------------------------------------------------------------------ QR labels for places
function QrImage({ text, size = 160 }: { text: string; size?: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => { QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg).catch(() => setSvg('')); }, [text]);
  return <span className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function QrLabels() {
  const { community } = useApp();
  const tree = useApi<{ nodes: TreeNode[] }>('/api/property/tree');
  const routines = useApi<any[]>('/api/routines');
  const [chosen, setChosen] = useState<string[] | null>(null);
  if (!tree.data || !routines.data) return <Loading />;
  // Places that have checks, at their own level or inside them.
  const withChecks = new Set<string>();
  for (const r of routines.data) { withChecks.add(r.node_id); for (const a of r.ancestor_ids ?? []) withChecks.add(a); }
  const places = tree.data.nodes.filter(n => withChecks.has(n.id) && n.kind !== 'floor');
  const picked = chosen ?? places.filter(p => p.depth >= 1).map(p => p.id);
  const url = (id: string) => `${location.origin}/work?place=${id}`;
  return <>
    <div className="no-print">
      <PageHead title="QR labels for places"><button className="primary" onClick={() => print()}>Print labels</button></PageHead>
      <p className="quiet" style={{ maxWidth: '68ch' }}>Stick a label at each place. Staff scan it with the phone camera to open that place's checks for the day, already signed in.
        Choose the places to print:</p>
      <div className="pick-list">{places.map(p => <label key={p.id} className="check"><input type="checkbox" checked={picked.includes(p.id)}
        onChange={e => setChosen(e.target.checked ? [...picked, p.id] : picked.filter(x => x !== p.id))} />{' '.repeat(Math.max(0, p.depth - 1) * 2)}{p.name}</label>)}</div>
    </div>
    <div className="qr-sheet">{places.filter(p => picked.includes(p.id)).map(p => <div key={p.id} className="qr-label">
      <QrImage text={url(p.id)} />
      <div><b>{p.name}</b><span>{community.platformName}</span><span>Scan to see and record today's checks here</span></div>
    </div>)}</div>
  </>;
}

// ------------------------------------------------------------------ offline banner
export function OfflineBanner() {
  const { queued, failed } = useOffline();
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  if (online && !queued.length && !failed.length) return null;
  return <div className="offline-note" role="status">
    {!online && <p>You are offline. Checks you record are kept on this phone and sent when the network is back.</p>}
    {queued.length > 0 && <p>{queued.length} {queued.length === 1 ? 'check is' : 'checks are'} waiting to be sent{online ? '; sending now' : ''}: {queued.map(q => q.title).join(', ')}.</p>}
    {failed.length > 0 && <p>Could not save: {failed.map(f => `${f.title} (${f.error})`).join('; ')}. Please record {failed.length === 1 ? 'it' : 'them'} again.
      <button type="button" className="link" onClick={clearFailed}>Dismiss</button></p>}
  </div>;
}
