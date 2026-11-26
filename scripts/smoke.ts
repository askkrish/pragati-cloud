// After each deploy: signs in to the demo community the way a visitor does (the demo shows its
// code on screen) and checks that each area answers. Demo data only; nothing is changed.
//   npx tsx scripts/smoke.ts https://<app address>
const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) throw new Error('Pass the app address.');
const phone = process.env.SMOKE_PHONE ?? '+919000030001'; // the demo secretary
let cookie = '';

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-pragati': '1', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, type: res.headers.get('content-type') ?? '' };
}

const results: [string, boolean, string][] = [];
async function check(name: string, fn: () => Promise<string | true>) {
  try { const r = await fn(); results.push([name, r === true, r === true ? '' : r]); }
  catch (e) { results.push([name, false, (e as Error).message]); }
}

const pub = await call('GET', '/api/public/community');
if (!pub.json?.isDemo) { console.log('Not a demo community at this address; skipping the signed-in checks.'); process.exit(0); }
const start = await call('POST', '/api/auth/otp/start', { phone });
if (!start.json?.devCode) { console.log(`Could not get a demo code (${start.status}: ${start.json?.error ?? start.text.slice(0, 120)}); skipping.`); process.exit(0); }
const verify = await call('POST', '/api/auth/otp/verify', { challengeId: start.json.challengeId, code: start.json.devCode });
if (verify.status !== 200) throw new Error(`Sign-in failed: ${verify.status}`);

const ok = (r: { status: number }) => r.status === 200 ? true as const : `HTTP ${r.status}`;
const list = (r: any, min = 1) => r.status !== 200 ? `HTTP ${r.status}` : (Array.isArray(r.json) ? r.json.length : 0) >= min ? true as const : 'empty';
await check('Home and me', async () => ok(await call('GET', '/api/me')));
await check('Today\'s checks', async () => { const r = await call('GET', '/api/ops/today'); return r.status === 200 && r.json.rows.length ? true : `HTTP ${r.status}`; });
await check('Work orders', async () => list(await call('GET', '/api/work?view=open')));
await check('Approvals', async () => list(await call('GET', '/api/approvals?status=all')));
await check('Vendors', async () => list(await call('GET', '/api/vendors')));
await check('Money overview', async () => ok(await call('GET', '/api/finance/overview')));
await check('Trial balance balances', async () => { const r = await call('GET', '/api/finance/reports/trial'); return r.status === 200 && r.json.totals.debit === r.json.totals.credit ? true : 'out of balance'; });
await check('Vouchers', async () => list(await call('GET', '/api/finance/vouchers?state=all')));
await check('Notices', async () => list(await call('GET', '/api/notices')));
await check('Records library', async () => list(await call('GET', '/api/documents')));
await check('Weekly pack', async () => ok(await call('GET', '/api/packs/weekly')));
await check('End-of-day summary', async () => { const r = await call('GET', '/api/packs/weekly?days=1'); return r.status === 200 && r.json.days === 1 ? true : `HTTP ${r.status}`; });
await check('AGM pack', async () => { const r = await call('GET', '/api/packs/annual'); return r.status === 200 && r.json.label ? true : `HTTP ${r.status}`; });
await check('Owners\' update', async () => ok(await call('GET', '/api/packs/owners')));
await check('Search', async () => { const r = await call('GET', '/api/search?q=lift'); return r.status === 200 && Object.keys(r.json.groups).length ? true : `HTTP ${r.status}`; });
await check('Project delivery', async () => {
  const w = await call('GET', '/api/work?view=open&q=Rainwater');
  if (!w.json?.length) return 'no demo project';
  const d = await call('GET', `/api/work/${w.json[0].id}/delivery`);
  return d.status === 200 && d.json.contract?.committed_paise > 0 ? true : `HTTP ${d.status}`;
});
await check('Asset service log', async () => {
  const a = (await call('GET', '/api/assets')).json?.find((x: any) => /Sky B lifts/.test(x.name));
  if (!a) return 'no demo asset';
  const r = await call('GET', `/api/assets/${a.id}`);
  return r.status === 200 && r.json.services.length ? true : 'no services';
});
await check('Handovers waiting', async () => list(await call('GET', '/api/handovers/mine')));
await check('Notice templates', async () => list(await call('GET', '/api/notice-templates')));
await check('Assistant status', async () => { const r = await call('GET', '/api/ask/status'); return r.status === 200 ? true : `HTTP ${r.status}`; });
await check('Document reading status', async () => ok(await call('GET', '/api/read/status')));
await check('Paper registers', async () => ok(await call('GET', '/api/register-imports')));
await check('Home screen settings', async () => { const r = await call('GET', '/api/me/settings'); return r.status === 200 && Array.isArray(r.json.homeLayout) ? true : `HTTP ${r.status}`; });
await check('Profile photo field', async () => { const r = await call('GET', '/api/me'); return r.status === 200 && 'photo' in r.json.person ? true : 'missing'; });
await check('App manifest', async () => { const r = await call('GET', '/manifest.webmanifest'); return r.status === 200 && r.json?.name ? true : `HTTP ${r.status}`; });
await check('Service worker', async () => { const r = await call('GET', '/sw.js'); return r.status === 200 && /pragati-shell/.test(r.text) ? true : `HTTP ${r.status}`; });
await check('Signed out cannot read', async () => { const c = cookie; cookie = ''; const r = await call('GET', '/api/me'); cookie = c; return r.status === 401 ? true : `HTTP ${r.status}`; });
await call('POST', '/api/auth/signout', {}).catch(() => null);

for (const [name, pass, note] of results) console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${note ? `: ${note}` : ''}`);
const failed = results.filter(r => !r[1]).length;
console.log(`${results.length - failed} of ${results.length} areas answered.`);
process.exit(failed ? 1 : 0);
