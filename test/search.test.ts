// Search shows only what the person may see, and a reference goes straight to its record.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
const ok = (r: { status: number; body: any }, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'srch');
});
after(() => h.close());

test('search finds records by words and references, within what each person may see', async () => {
  ok(await C.admin.post(`/api/units/${C.unitA.id}/owners`, { newPerson: { name: 'Meera Owner', phone: '+919000900001' }, sharePct: 100 }));
  const owner = h.client(C.host, await h.sessionFor(C.id, '+919000900001'));
  const mine = ok(await owner.post('/api/work', { kind: 'request', title: 'Kitchen tap leaking', unitId: C.unitA.id, category: 'plumbing' }));
  const other = ok(await C.admin.post('/api/work', { kind: 'maintenance', title: 'Leaking valve in the pump room', nodeId: C.blockB.id }));
  ok(await C.admin.post('/api/notices', { title: 'Committee only: leaking roof budget', body: 'Discussion', category: 'meeting', audience: 'committee' }));

  const admin = ok(await C.admin.get('/api/search?q=leaking'));
  assert.equal(admin.groups.Work.length, 2);
  assert.equal(admin.groups.Notices.length, 1);
  const o = ok(await owner.get('/api/search?q=leaking'));
  assert.deepEqual(o.groups.Work.map((x: any) => x.title), ['Kitchen tap leaking'], 'an owner finds only their own request');
  assert.equal(o.groups.Notices, undefined, 'and not the committee notice');
  assert.equal(o.groups.People, undefined);

  const wref = ok(await C.admin.get(`/api/work/${other.id}`)).ref;
  assert.equal(ok(await C.admin.get(`/api/search?q=${wref}`)).exact[0].path, `/work/orders/${other.id}`);
  assert.equal(ok(await owner.get(`/api/search?q=${wref}`)).exact.length, 0, 'a reference you cannot open is not found');
  assert.equal(ok(await owner.get(`/api/search?q=${ok(await owner.get(`/api/work/${mine.id}`)).ref}`)).exact.length, 1);
  assert.ok(ok(await C.admin.get('/api/search?q=Meera')).groups.People.some((p: any) => p.title === 'Meera Owner'));
  ok(await C.admin.get('/api/search?q=x'), 400);
  ok(await h.client(C.host).get('/api/search?q=leaking'), 401);
});

test('the installable app has a manifest and icon in the community\'s name and colour', async () => {
  const m = await h.client(C.host).get('/manifest.webmanifest');
  assert.equal(m.status, 200);
  assert.equal(m.body.name, 'SRCH Pragati');
  const icon = await h.client(C.host).get('/app-icon.svg');
  assert.equal(icon.status, 200);
  assert.match(icon.raw.body, /<svg[\s\S]*>S<\/text>/);
});
