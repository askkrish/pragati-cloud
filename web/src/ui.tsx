import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api, ApiError } from './api.ts';
import { t } from './i18n.ts';

// ---------- routing ----------
const routeListeners = new Set<() => void>();
export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, '', to);
  routeListeners.forEach(f => f());
  window.scrollTo({ top: 0 });
}
window.addEventListener('popstate', () => routeListeners.forEach(f => f()));
export function usePath() {
  return useSyncExternalStore(f => { routeListeners.add(f); return () => routeListeners.delete(f); }, () => location.pathname + location.search);
}
export function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string; [k: string]: unknown }) {
  return <a href={to} className={className} {...rest} onClick={e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); navigate(to);
  }}>{children}</a>;
}

// ---------- data ----------
export function useApi<T = any>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState(s => ({ ...s, loading: true, error: null }));
    api.get<T>(path).then(d => live && setState({ data: d, error: null, loading: false }))
      .catch((e: ApiError) => live && setState({ data: null, error: e.message, loading: false }));
    return () => { live = false; };
  }, [path, tick]);
  const reload = useCallback(() => setTick(x => x + 1), []);
  return { ...state, reload };
}

// Runs a change, shows its error in place, and reports success.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError((e as Error).message); return undefined; } finally { setBusy(false); }
  }, []);
  return { busy, error, run, setError };
}

// ---------- pieces ----------
export function Loading({ what = '' }: { what?: string }) {
  return <p className="quiet" role="status">Loading{what ? ` ${what}` : ''}…</p>;
}
export function ErrorNote({ error }: { error: string | null }) {
  return error ? <p className="note error" role="alert">{error}</p> : null;
}
export function Initials({ name }: { name: string }) {
  const parts = name.replace(/\(.*\)/, '').trim().split(/\s+/);
  return <span className="ini" aria-hidden="true">{(parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')}</span>;
}
export function StatusTag({ status }: { status: string }) {
  const label: Record<string, string> = { pending: t('Pending'), approved: t('Approved'), rejected: t('Rejected'), withdrawn: t('Withdrawn') };
  return <span className={`tag ${status}`}>{label[status] ?? status}</span>;
}
export function PageHead({ title, crumbs, children }: { title: ReactNode; crumbs?: { to?: string; label: string }[]; children?: ReactNode }) {
  return <div className="page-head">
    {crumbs?.length ? <nav className="crumbs" aria-label="You are here">{crumbs.map((c, i) => <span key={i} style={{ display: 'contents' }}>
      {i > 0 && <span aria-hidden="true">›</span>}{c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}</span>)}</nav> : null}
    <div className="head-row"><h1>{title}</h1>{children}</div>
  </div>;
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return <dialog ref={ref} className="sheet" onClose={onClose} aria-label={title}
    onClick={e => { if (e.target === ref.current) onClose(); }}>
    {open && <div className="sheet-inner">
      <div className="head-row"><h2>{title}</h2><button className="quiet-btn" onClick={onClose}>Close</button></div>
      {children}
    </div>}
  </dialog>;
}

export const KIND_LABEL: Record<string, string> = {
  federation: 'Federation', community: 'Community', phase: 'Phase', zone: 'Zone', block: 'Block', tower: 'Tower', wing: 'Wing',
  sub_block: 'Sub-block', floor: 'Floor', street: 'Street', cluster: 'Cluster', other: 'Area',
};
export const POSITION_LABEL: Record<string, string> = {
  president: 'President', vice_president: 'Vice-president', secretary: 'Secretary', joint_secretary: 'Joint secretary',
  treasurer: 'Treasurer', member: 'Member',
};
// How many must approve, as a phrase: "a majority must approve (2 of 3)".
export const MODE_LABEL = (mode: string, required: number | null, of?: number) => {
  const n = required && of !== undefined ? ` (${required} of ${of})` : '';
  switch (mode) {
    case 'unanimous': return `every member must approve${of !== undefined ? ` (${of})` : ''}`;
    case 'majority': return `a majority must approve${n}`;
    case 'count': return `${required ?? '?'} members must approve${of !== undefined ? ` (of ${of})` : ''}`;
    default: return 'any one member can approve';
  }
};
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- icons (drawn for this app: plan, gavel-free tick, people, more) ----------
const svg = (d: ReactNode) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
export const Icon = {
  home: svg(<><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9.5h13V10" /><path d="M10 19.5v-5h4v5" /></>),
  plan: svg(<><rect x="3" y="3" width="8" height="10" rx="1" /><rect x="13" y="3" width="8" height="6" rx="1" /><rect x="13" y="11" width="8" height="10" rx="1" /><rect x="3" y="15" width="8" height="6" rx="1" /></>),
  approve: svg(<><path d="M4 12.5 9 17.5 20 6.5" /></>),
  people: svg(<><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" /><circle cx="17" cy="9" r="2.4" /><path d="M16 14.2c2.4.1 4 1.6 4.5 4.3" /></>),
  more: svg(<><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>),
  money: svg(<><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6.5 9.5v5M17.5 9.5v5" /></>),
  search: svg(<><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5.5 5.5" /></>),
  ask: svg(<><path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z" /><path d="M9.5 9.2a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.6" /><path d="M12 14.6v.1" /></>),
  work: svg(<><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V2.8h6V4" /><path d="m8.5 12 2.2 2.2L15.5 9.5" /><path d="M8.5 17.5h7" /></>),
};
