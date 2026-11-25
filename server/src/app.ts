import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { ZodError } from 'zod';
import { Actor, loadActor } from './actor.ts';
import { tokenHash } from './auth/crypto.ts';
import { createSms, type SmsSender } from './auth/sms.ts';
import { config } from './config.ts';
import { one, withTenant, type Tx } from './db.ts';
import { AppError, fail, fromDatabase } from './errors.ts';
import { registerRoutes } from './routes/index.ts';
import { writeAudit, type RequestMeta } from './services/audit.ts';
import { createStorage, type Storage } from './services/storage.ts';

export const SESSION_COOKIE = 'pragati_session';

export type Tenant = { id: string; slug: string; brand_name: string; platform_name: string; primary_color: string;
  logo_file_id: string | null; languages: string[]; assistant_name: string; status: string; is_demo: boolean };

export type Ctx = {
  tx: Tx;
  tenant: Tenant;
  actor: Actor;
  meta: RequestMeta;
  audit: (action: string, entityType: string, entityId: string | null, summary: string, data?: Record<string, unknown>) => Promise<void>;
};

declare module 'fastify' {
  interface FastifyRequest { tenant: Tenant | null }
}

export type Services = { pool: pg.Pool; sms: SmsSender; storage: Storage };

export type Runner = {
  // Runs fn in one community-bound transaction with the signed-in person loaded.
  auth: <T>(req: FastifyRequest, fn: (c: Ctx) => Promise<T>) => Promise<T>;
  // For sign-in and public pages: a community-bound transaction with no person.
  open: <T>(req: FastifyRequest, fn: (tx: Tx, tenant: Tenant, meta: RequestMeta) => Promise<T>) => Promise<T>;
};

// The web address the visitor used. Behind Front Door the original address arrives in
// X-Forwarded-Host (and requests without Front Door's id are refused, so it cannot be forged);
// otherwise the Host header is used as sent, never a forwarded header a visitor could add.
export function requestHost(req: FastifyRequest): string {
  const raw = config.frontDoorId ? String(req.headers['x-forwarded-host'] ?? '') : String(req.headers.host ?? '');
  return raw.split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

// The visitor's address. Behind Azure Front Door, X-Azure-ClientIP is set by Front Door itself and
// cannot be supplied by the visitor, unlike the left-most X-Forwarded-For entry.
export function clientIp(req: FastifyRequest): string {
  if (config.frontDoorId) return String(req.headers['x-azure-clientip'] ?? req.ip);
  return req.ip;
}

const tenantCache = new Map<string, { at: number; tenant: Tenant | null }>();

async function resolveTenant(pool: pg.Pool, host: string): Promise<Tenant | null> {
  const hit = tenantCache.get(host);
  if (hit && Date.now() - hit.at < 30_000) return hit.tenant;
  const client = await pool.connect();
  try {
    const tenant = (await client.query('select * from app.resolve_tenant($1, $2)', [host, config.baseDomain])).rows[0] ?? null;
    tenantCache.set(host, { at: Date.now(), tenant });
    return tenant;
  } finally {
    client.release();
  }
}
export const clearTenantCache = () => tenantCache.clear();

export async function buildApp(services: Partial<Services> & { pool: pg.Pool }) {
  const svc: Services = { sms: createSms(), storage: createStorage(), ...services };
  const app = Fastify({
    logger: config.isProd ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
    // Trust exactly the proxies we run behind (by hop count), never addresses a visitor adds.
    trustProxy: config.trustProxyHops > 0 ? (_addr: string, hop: number) => hop < config.trustProxyHops : false,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"],
        objectSrc: ["'none'"], baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', keyGenerator: clientIp });

  app.decorateRequest('tenant', null);
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    if (config.frontDoorId && req.headers['x-azure-fdid'] !== config.frontDoorId)
      return reply.code(403).send({ error: 'Please use the community\'s web address.', code: 'direct_access' });
    req.tenant = await resolveTenant(svc.pool, requestHost(req));
    if (!req.url.startsWith('/api/')) return;
    if (!req.tenant) return reply.code(404).send({ error: 'No community is set up at this address.', code: 'no_community' });
    if (req.tenant.status !== 'active') return reply.code(403).send({ error: 'This community\'s platform is not active.', code: 'inactive' });
    // Changes must come from our own pages: browsers will not send this header cross-site without
    // a CORS pre-flight, which this API never grants.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-pragati'] !== '1')
      return reply.code(403).send({ error: 'Request blocked.', code: 'csrf' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: `${first.path.join('.') || 'Input'}: ${first.message}`, code: 'invalid' });
    }
    const db = fromDatabase(err);
    if (db) return reply.code(db.status).send({ error: db.message, code: db.code });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message, code: 'request' });
    req.log.error(err);
    if (!config.isProd) console.error(err);
    return reply.code(500).send({ error: 'Something went wrong. Please try again.', code: 'server' });
  });

  const meta = (req: FastifyRequest): RequestMeta => ({ requestId: String(req.id), ip: clientIp(req) || null });

  const run: Runner = {
    open: (req, fn) => withTenant(svc.pool, req.tenant!.id, tx => fn(tx, req.tenant!, meta(req))),
    auth: (req, fn) => withTenant(svc.pool, req.tenant!.id, async tx => {
      const token = req.cookies[SESSION_COOKIE];
      if (!token) fail(401, 'Please sign in.', 'signed_out');
      const session = await one(tx, 'select * from auth_api.session_resolve($1, $2, $3)', [req.tenant!.id, tokenHash(token!), config.idleDays]);
      if (!session) fail(401, 'Your session has ended. Please sign in again.', 'signed_out');
      const actor = await loadActor(tx, session.user_id, session.phone_e164)
        ?? fail(403, 'Your access to this community has been removed.', 'no_access');
      const m = meta(req);
      return fn({ tx, tenant: req.tenant!, actor, meta: m,
        audit: (action, type, id, summary, data) => writeAudit(tx, actor, m, action, type, id, summary, data) });
    }),
  };

  app.get('/healthz', async () => {
    await svc.pool.query('select 1');
    return { ok: true };
  });

  await registerRoutes(app, run, svc);

  const webDir = join(process.cwd(), config.webDir);
  if (existsSync(join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, index: false, wildcard: false, maxAge: '1h' });
    const sendIndex = (_req: FastifyRequest, reply: FastifyReply) =>
      reply.header('cache-control', 'no-store').sendFile('index.html', webDir);
    app.get('/', sendIndex);
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.code(404).send({ error: 'Not found.', code: 'not_found' });
      if (/\.[a-z0-9]{2,5}$/i.test(req.url.split('?')[0])) return reply.code(404).send('Not found');
      return sendIndex(req, reply);
    });
  }
  return app;
}
