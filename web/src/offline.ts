// Checks recorded without a network wait on this phone and are sent when it is back. Only the
// check itself is kept (no photos), in this browser's storage, and removed once sent.
import { useSyncExternalStore } from 'react';
import { api, ApiError } from './api.ts';

export type Queued = { key: string; routineId: string; day: string; title: string; body: Record<string, unknown>; at: string };
const KEY = 'pragati.offline.checks';
const listeners = new Set<() => void>();
let failed: { title: string; error: string }[] = [];

const read = (): Queued[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; } };
const write = (q: Queued[]) => { try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* storage full or blocked */ } snapshot = null; listeners.forEach(f => f()); };
let snapshot: { queued: Queued[]; failed: typeof failed } | null = null;
const get = () => snapshot ??= { queued: read(), failed };

export const isNetworkError = (e: unknown) => !(e instanceof ApiError) && (e instanceof TypeError || !navigator.onLine);

export function queueCheck(item: Omit<Queued, 'key' | 'at'>) {
  const key = `${item.routineId}:${item.day}`;
  write([...read().filter(q => q.key !== key), { ...item, key, at: new Date().toISOString() }]);
}

let flushing = false;
export async function flushChecks() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (const q of read()) {
      try {
        await api.put(`/api/routines/${q.routineId}/checks/${q.day}`, q.body);
        write(read().filter(x => x.key !== q.key));
      } catch (e) {
        if (isNetworkError(e)) break;
        // The server refused it (for example, the routine changed): keep the reason to show, drop the item.
        failed = [...failed, { title: q.title, error: (e as Error).message }];
        write(read().filter(x => x.key !== q.key));
      }
    }
  } finally { flushing = false; }
}

export function useOffline() {
  return useSyncExternalStore(f => { listeners.add(f); return () => listeners.delete(f); }, get);
}
export function clearFailed() { failed = []; snapshot = null; listeners.forEach(f => f()); }

export function startOffline() {
  window.addEventListener('online', () => { void flushChecks(); });
  void flushChecks();
  setInterval(() => { void flushChecks(); }, 60_000);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => { /* optional */ });
}
