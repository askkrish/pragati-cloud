import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { clientIp, SESSION_COOKIE, type Runner, type Services } from '../app.ts';
import { newOtp, newSessionToken, normalisePhone, otpHash, tokenHash } from '../auth/crypto.ts';
import { config } from '../config.ts';
import { one } from '../db.ts';
import { fail } from '../errors.ts';
import { writeAudit } from '../services/audit.ts';
import { z, uuid } from './z.ts';

export async function authRoutes(app: FastifyInstance, run: Runner, svc: Services) {
  const strict = { config: { rateLimit: { max: config.authRatePerMinute, timeWindow: '1 minute' } } };

  // The reply is the same whether or not the number has access, so the sign-in page cannot be used
  // to find out who lives in the community.
  app.post('/api/auth/otp/start', strict, async req => {
    const body = z.object({ phone: z.string().max(30) }).parse(req.body);
    const phone = normalisePhone(body.phone) ?? fail(400, 'Enter a valid mobile number.', 'invalid_phone');
    const challengeId = randomUUID();
    const code = newOtp();
    const res = await run.open(req, async (tx, tenant) => {
      const r = await one(tx, 'select * from auth_api.otp_start($1, $2, $3, $4, $5, $6)',
        [tenant.id, challengeId, phone, otpHash(challengeId, code), config.otpTtlSeconds, clientIp(req)]);
      if (r.status === 'rate_limited') fail(429, 'Too many codes were requested. Please wait 15 minutes.', 'rate_limited');
      return { ...r, platform: tenant.platform_name, demo: tenant.is_demo };
    });
    // Demo communities (made-up data only) show the code on screen instead of sending an SMS.
    if (res.deliver && !res.demo) await svc.sms.sendOtp(phone, code, res.platform);
    return { challengeId, message: 'If this number has access, a 6-digit code is on its way.',
      ...((config.showOtpInResponse || res.demo) && res.deliver ? { devCode: code } : {}) };
  });

  app.post('/api/auth/otp/verify', strict, async (req, reply) => {
    const body = z.object({ challengeId: uuid, code: z.string().regex(/^\d{6}$/, 'must be 6 digits') }).parse(req.body);
    const token = newSessionToken();
    const r = await run.open(req, async (tx, tenant, meta) => {
      const v = await one(tx, 'select * from auth_api.otp_verify($1, $2, $3, $4, $5, $6, $7)',
        [tenant.id, body.challengeId, otpHash(body.challengeId, body.code), tokenHash(token), config.sessionDays,
          clientIp(req), String(req.headers['user-agent'] ?? '')]);
      if (v.status === 'ok') {
        const person = await one(tx, 'select id from app.people where user_id = $1 and archived_at is null limit 1', [v.user_id]);
        await tx.query(`insert into app.audit_events (actor_person_id, actor_user_id, action, entity_type, entity_id, summary, request_id, ip)
          values ($1::uuid, $2, 'auth.signed_in', 'person', $1::text, 'Signed in', $3, $4)`, [person?.id ?? null, v.user_id, meta.requestId, meta.ip]);
      }
      return v;
    });
    const messages: Record<string, string> = {
      invalid: 'That code is not right. Check the SMS and try again.', expired: 'That code has expired. Ask for a new one.',
      used: 'That code was already used. Ask for a new one.', locked: 'Too many wrong attempts. Ask for a new code.',
      disabled: 'This number has been blocked. Contact your association office.',
    };
    if (r.status !== 'ok') fail(400, messages[r.status] ?? 'Sign-in failed.', r.status);
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/',
      expires: new Date(r.expires_at) });
    return { ok: true };
  });

  app.post('/api/auth/signout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await run.open(req, async (tx, _t, meta) => {
      await tx.query('select auth_api.session_revoke($1)', [tokenHash(token)]);
      await writeAudit(tx, null, meta, 'auth.signed_out', 'session', null, 'Signed out');
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
