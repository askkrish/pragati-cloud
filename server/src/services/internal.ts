// Calls this app's own API as the person making the request, so search and the assistant see
// exactly what that person's screens show: the same permission checks and row-level security.
import type { FastifyInstance, FastifyRequest } from 'fastify';

const PASS = ['host', 'cookie', 'x-forwarded-host', 'x-azure-fdid', 'x-azure-clientip', 'x-forwarded-for', 'user-agent'];

export async function getAs(app: FastifyInstance, req: FastifyRequest, path: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'x-pragati': '1' };
  for (const h of PASS) if (req.headers[h]) headers[h] = String(req.headers[h]);
  const res = await app.inject({ method: 'GET', url: path, headers });
  let body: any = null;
  try { body = res.json(); } catch { /* not json */ }
  return { status: res.statusCode, body };
}
