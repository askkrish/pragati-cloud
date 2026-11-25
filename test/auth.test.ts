import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildCommunity, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let C: Awaited<ReturnType<typeof buildCommunity>>;
before(async () => {
  h = await startHarness();
  C = await buildCommunity(h, 'otp');
});
after(() => h.close());

async function start(phone: string, ip = '10.0.0.1') {
  return h.client(C.host).call('POST', '/api/auth/otp/start', { phone }, { 'x-forwarded-for': ip });
}

test('a registered number gets a code and signs in; the cookie works only here', async () => {
  const s = await start(C.adminPhone.replace('+91', '0'));
  assert.equal(s.status, 200);
  assert.match(s.body.devCode, /^\d{6}$/);
  const v = await h.client(C.host).post('/api/auth/otp/verify', { challengeId: s.body.challengeId, code: s.body.devCode });
  assert.equal(v.status, 200);
  const cookie = String(v.raw.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const token = /pragati_session=([^;]+)/.exec(cookie)![1];
  assert.equal((await h.client(C.host, token).get('/api/me')).body.person.name, 'Admin of OTP');
  // used once only
  const again = await h.client(C.host).post('/api/auth/otp/verify', { challengeId: s.body.challengeId, code: s.body.devCode });
  assert.equal(again.body.code, 'used');
  // sign out revokes the session on the server, not just the cookie
  await h.client(C.host, token).post('/api/auth/signout');
  assert.equal((await h.client(C.host, token).get('/api/me')).status, 401);
});

test('an unknown number gets the same reply and no code is sent', async () => {
  const s = await start('9000099999');
  assert.equal(s.status, 200);
  assert.equal(s.body.message, 'If this number has access, a 6-digit code is on its way.');
  assert.equal(s.body.devCode, undefined);
  const v = await h.client(C.host).post('/api/auth/otp/verify', { challengeId: s.body.challengeId, code: '123456' });
  assert.equal(v.body.code, 'invalid');
});

test('five wrong codes lock the challenge; codes expire', async () => {
  const p = await C.person('Locked Out', '+919000033333');
  const role = (await C.admin.get('/api/roles')).body.find((r: any) => r.key === 'owner');
  await C.admin.post('/api/members', { personId: p.id, roleId: role.id });
  const s = await start('+919000033333');
  for (let i = 0; i < 5; i++) {
    const v = await h.client(C.host).post('/api/auth/otp/verify', { challengeId: s.body.challengeId, code: '000000' });
    assert.equal(v.body.code, s.body.devCode === '000000' ? 'ok' : 'invalid');
  }
  const locked = await h.client(C.host).post('/api/auth/otp/verify', { challengeId: s.body.challengeId, code: s.body.devCode });
  assert.equal(locked.body.code, 'locked');

  const s2 = await start('+919000033333');
  await h.asOwner(null, `update auth_private.otp_challenges set expires_at = now() - interval '1 second' where id = $1`, [s2.body.challengeId]);
  const expired = await h.client(C.host).post('/api/auth/otp/verify', { challengeId: s2.body.challengeId, code: s2.body.devCode });
  assert.equal(expired.body.code, 'expired');
});

test('a fourth code within 15 minutes is refused', async () => {
  const p = await C.person('Busy Phone', '+919000044444');
  const role = (await C.admin.get('/api/roles')).body.find((r: any) => r.key === 'owner');
  await C.admin.post('/api/members', { personId: p.id, roleId: role.id });
  for (let i = 0; i < 3; i++) assert.equal((await start('+919000044444', `10.0.1.${i}`)).status, 200);
  assert.equal((await start('+919000044444', '10.0.1.9')).status, 429);
});

test('a code issued for one community does not sign in to another', async () => {
  const other = await buildCommunity(h, 'otp-two');
  const s = await start(C.adminPhone);
  const v = await h.client(other.host).post('/api/auth/otp/verify', { challengeId: s.body.challengeId, code: s.body.devCode });
  assert.equal(v.body.code, 'invalid');
});

test('idle sessions lapse, and removed access ends access at once', async () => {
  const p = await C.person('Idle Person', '+919000055555');
  const role = (await C.admin.get('/api/roles')).body.find((r: any) => r.key === 'resident');
  const m = (await C.admin.post('/api/members', { personId: p.id, roleId: role.id })).body;
  const token = await h.sessionFor(C.id, '+919000055555');
  const me = h.client(C.host, token);
  assert.equal((await me.get('/api/me')).status, 200);
  await C.admin.post(`/api/members/${m.id}/disable`);
  assert.equal((await me.get('/api/me')).status, 403);
  await C.admin.post(`/api/members/${m.id}/enable`);
  assert.equal((await me.get('/api/me')).status, 200);
  await h.asOwner(null, `update auth_private.sessions set last_seen_at = now() - interval '8 days'
    where user_id = (select id from auth_private.users where phone_e164 = '+919000055555')`);
  assert.equal((await me.get('/api/me')).status, 401);
});

test('codes and session tokens are stored only as hashes', async () => {
  const rows = await h.asOwner(null, `select code_hash from auth_private.otp_challenges where code_hash is not null limit 5`);
  for (const r of rows) assert.match(r.code_hash, /^[0-9a-f]{64}$/);
  const s = await h.asOwner(null, `select octet_length(token_hash) as n from auth_private.sessions limit 1`);
  assert.equal(s[0].n, 32);
});
