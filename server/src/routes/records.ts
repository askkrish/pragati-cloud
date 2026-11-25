import type { FastifyInstance } from 'fastify';
import type { Runner, Services } from '../app.ts';
import { many, one } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import { saveUpload } from '../services/files.ts';
import { idParam, z } from './z.ts';

const PURPOSES = ['approval_letter', 'ownership_document', 'other'] as const;

export async function recordRoutes(app: FastifyInstance, run: Runner, svc: Services) {
  app.post('/api/files', async req => run.auth(req, async c => {
    c.actor.require('files.upload', null);
    const purpose = z.enum(PURPOSES).parse((req.query as Record<string, string>).purpose);
    const part = await req.file() ?? fail(400, 'Choose a file.', 'invalid');
    return saveUpload(c, svc.storage, part!, purpose);
  }));

  // Downloads always pass through here, so access is checked on every file.
  app.get('/api/files/:id', async (req, reply) => {
    const f = await run.auth(req, async ({ tx, actor }) => {
      const f = await one(tx, `select * from app.files where id = $1`, [idParam.parse(req.params).id]) ?? notFound('That file');
      const allowed = f.uploaded_by === actor.personId || f.purpose === 'logo'
        || (f.purpose === 'approval_letter' && actor.canAnywhere('approvals.view'))
        || (f.purpose === 'ownership_document' && actor.canAnywhere('people.view'))
        || (f.purpose === 'other' && actor.canAnywhere('audit.view'));
      if (!allowed) notFound('That file');
      return f;
    });
    const body = await svc.storage.get(f.storage_key);
    return reply.header('content-type', f.content_type).header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="${f.file_name.replace(/"/g, '')}"`)
      .header('cache-control', 'private, no-store').send(body);
  });

  app.get('/api/audit', async req => run.auth(req, async ({ tx, actor }) => {
    actor.require('audit.view', null);
    const q = z.object({ entityType: z.string().max(40).optional(), entityId: z.string().max(60).optional(),
      before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return many(tx, `select a.id, a.at, a.action, a.entity_type, a.entity_id, a.summary, p.full_name as actor
      from app.audit_events a left join app.people p on p.tenant_id = a.tenant_id and p.id = a.actor_person_id
      where ($1::text is null or a.entity_type = $1) and ($2::text is null or a.entity_id = $2) and ($3::bigint is null or a.id < $3)
      order by a.id desc limit $4`, [q.entityType ?? null, q.entityId ?? null, q.before ?? null, q.limit]);
  }));

  // A complete copy of the community's records: for the association's own archive, for a move to
  // its own cloud, and for data-principal requests under the DPDP Act. File bytes are listed, not
  // embedded; they are exported separately from storage.
  const EXPORT_TABLES = ['tenants', 'property_nodes', 'unit_types', 'units', 'parking_slots', 'meters', 'facilities', 'people',
    'ownerships', 'occupancies', 'roles', 'memberships', 'committees', 'committee_seats', 'approval_rules',
    'approval_rule_stages', 'approval_requests', 'approval_stages', 'approval_stage_voters', 'approval_votes', 'files', 'audit_events'];

  app.get('/api/export', async (req, reply) => {
    const data = await run.auth(req, async ({ tx, actor, audit, tenant }) => {
      if (!actor.can('data.export', null)) forbidden();
      const out: Record<string, unknown> = { format: 'pragati-cloud-export', version: 1, exportedAt: new Date().toISOString(),
        platformName: tenant.platform_name };
      for (const t of EXPORT_TABLES) out[t] = await many(tx, `select * from app.${t}`);
      await audit('data.exported', 'tenant', null, `${actor.name} downloaded a full export`);
      return out;
    });
    const name = `${req.tenant!.slug}-export-${new Date().toISOString().slice(0, 10)}.json`;
    return reply.header('content-type', 'application/json').header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'private, no-store').send(JSON.stringify(data));
  });
}
