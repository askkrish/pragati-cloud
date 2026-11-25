import type { Actor } from '../actor.ts';
import type { Tx } from '../db.ts';

export type RequestMeta = { requestId: string; ip: string | null };

export async function writeAudit(tx: Tx, actor: Actor | null, meta: RequestMeta, action: string,
  entityType: string, entityId: string | null, summary: string, data: Record<string, unknown> = {}) {
  await tx.query(
    `insert into app.audit_events (actor_person_id, actor_user_id, action, entity_type, entity_id, summary, data, request_id, ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actor?.personId || null, actor?.userId || null, action, entityType, entityId, summary.slice(0, 500), data,
      meta.requestId, meta.ip]);
}
