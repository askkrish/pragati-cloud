// Search across everything the person may see. Each source is read through the app's own API as
// that person, so nothing appears in search that their screens would not show. A reference such
// as WO-0012 or PV-0003 goes straight to its record.
import type { FastifyInstance } from 'fastify';
import type { Runner, Services } from '../app.ts';
import { getAs } from '../services/internal.ts';
import { z } from './z.ts';

type Hit = { type: string; title: string; ref?: string | null; meta?: string | null; path: string };
type Source = { type: string; paths: string[]; map: (row: any) => Hit; text: (row: any) => string; filtered?: boolean; list?: string };

// Sources that filter on the server get the longest word; every word is then checked here.
const SOURCES = (q: string): Source[] => {
  const e = encodeURIComponent(q.split(/\s+/).sort((a, b) => b.length - a.length)[0]);
  return [
    { type: 'Work', paths: ['open', 'done', 'closed', 'raised'].map(v => `/api/work?view=${v}&q=${e}`), filtered: true,
      map: w => ({ type: 'Work', title: w.title, ref: w.ref, meta: [w.place, w.status_label ?? w.status].filter(Boolean).join(', '), path: `/work/orders/${w.id}` }),
      text: w => `${w.ref} ${w.title}` },
    { type: 'Approvals', paths: ['/api/approvals?status=all&limit=200'],
      map: a => ({ type: 'Approvals', title: a.title, ref: a.ref, meta: a.status, path: `/approvals/${a.id}` }), text: a => `${a.ref} ${a.title}` },
    { type: 'Notices', paths: ['/api/notices?limit=100'],
      map: n => ({ type: 'Notices', title: n.title, ref: n.ref, meta: n.place, path: `/notices/${n.id}` }), text: n => `${n.ref} ${n.title}` },
    { type: 'Records', paths: [`/api/documents?q=${e}`], filtered: true,
      map: d => ({ type: 'Records', title: d.title, ref: d.ref, meta: d.category, path: `/records/${d.id}` }), text: d => `${d.ref} ${d.title}` },
    { type: 'Homes', paths: [`/api/units?q=${e}&limit=20`], filtered: true, list: 'units',
      map: u => ({ type: 'Homes', title: u.label, meta: [u.type, u.location].filter(Boolean).join(', '), path: `/units/${u.id}` }),
      text: u => `${u.label} ${typeof u.owners === 'string' ? u.owners : Array.isArray(u.owners) ? u.owners.map((o: any) => o?.name ?? o?.full_name ?? o).join(' ') : ''}` },
    { type: 'People', paths: [`/api/people?q=${e}&limit=20`], filtered: true, list: 'people',
      map: p => ({ type: 'People', title: p.full_name, meta: Array.isArray(p.roles) ? p.roles.join(', ') : p.roles ?? null, path: `/people/${p.id}` }), text: p => p.full_name },
    { type: 'Vendors', paths: [`/api/vendors?q=${e}`], filtered: true,
      map: v => ({ type: 'Vendors', title: v.name, ref: v.ref, meta: v.city, path: `/work/vendors/${v.id}` }), text: v => `${v.ref} ${v.name}` },
    { type: 'Assets', paths: ['/api/assets'],
      map: a => ({ type: 'Assets', title: a.name, ref: a.ref, meta: a.place, path: `/work/assets/${a.id}` }), text: a => `${a.ref} ${a.name}` },
    { type: 'Routines', paths: ['/api/routines'],
      map: r => ({ type: 'Routines', title: r.title, ref: r.ref, meta: r.place, path: `/work/routines/${r.id}` }), text: r => `${r.ref} ${r.title}` },
    { type: 'Vouchers', paths: ['/api/finance/vouchers?state=all'],
      map: v => ({ type: 'Vouchers', title: v.payee, ref: v.ref, meta: v.description, path: `/money/vouchers/${v.id}` }), text: v => `${v.ref} ${v.payee} ${v.description}` },
  ];
};

export async function searchRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  app.get('/api/search', async req => {
    // Signed in, as every source checks again.
    await run.auth(req, async () => null);
    const { q } = z.object({ q: z.string().trim().min(2).max(80) }).parse(req.query);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const isRef = /^[A-Z]{2}-\d{1,6}$/i.test(q);
    const results = await Promise.all(SOURCES(q).map(async s => {
      const seen = new Set<string>();
      const hits: Hit[] = [];
      for (const path of s.paths) {
        const r = await getAs(app, req, path);
        const rows = s.list ? r.body?.[s.list] : r.body;
        if (r.status !== 200 || !Array.isArray(rows)) continue;
        for (const row of rows) {
          const hit = s.map(row);
          if (seen.has(hit.path)) continue;
          const t = s.text(row).toLowerCase();
          if (!words.every(w => t.includes(w))) continue;
          seen.add(hit.path); hits.push(hit);
        }
      }
      return hits;
    }));
    const all = results.flat();
    const exact = all.filter(h => h.ref && h.ref.toLowerCase() === q.toLowerCase());
    const groups: Record<string, Hit[]> = {};
    for (const h of all) (groups[h.type] ??= []).length < 8 && groups[h.type].push(h);
    return { q, exact: isRef ? exact : exact.slice(0, 1), groups };
  });
}
