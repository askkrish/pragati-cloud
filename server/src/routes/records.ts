import type { FastifyInstance } from 'fastify';
import type { Runner, Services } from '../app.ts';
import { many, one } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import { saveUpload } from '../services/files.ts';
import { idParam, z } from './z.ts';
import { audienceOf, seesDocument, seesNotice } from './notices.ts';

const PURPOSES = ['approval_letter', 'ownership_document', 'other', 'work_photo', 'contract', 'quotation', 'invoice', 'payment_proof', 'document', 'notice'] as const;
const OPS = ['operations.view', 'operations.update', 'operations.manage'];

export async function recordRoutes(app: FastifyInstance, run: Runner, svc: Services) {
  app.post('/api/files', async req => run.auth(req, async c => {
    const purpose = z.enum(PURPOSES).parse((req.query as Record<string, string>).purpose);
    // Photos of work, and proof of a payment: staff, and owners or residents for their own home.
    if (purpose === 'work_photo' || purpose === 'payment_proof') {
      const home = await one(c.tx, `select 1 from app.ownerships where person_id = $1 and ends_on is null
        union select 1 from app.occupancies where person_id = $1 and ends_on is null`, [c.actor.personId]);
      if (!home && !OPS.some(p => c.actor.canAnywhere(p))) forbidden();
    } else if (purpose === 'contract') {
      if (!c.actor.canAnywhere('operations.manage')) forbidden();
    } else if (purpose === 'quotation') {
      if (!c.actor.canAnywhere('procurement.manage')) forbidden();
    } else if (purpose === 'document') {
      if (!c.actor.canAnywhere('documents.manage')) forbidden();
    } else if (purpose === 'notice') {
      if (!c.actor.canAnywhere('notices.publish')) forbidden();
    } else if (purpose === 'invoice') {
      if (!c.actor.canAnywhere('finance.prepare') && !c.actor.can('finance.manage')) forbidden();
    } else c.actor.require('files.upload', null);
    const part = await req.file() ?? fail(400, 'Choose a file.', 'invalid');
    return saveUpload(c, svc.storage, part!, purpose);
  }));

  // Downloads always pass through here, so access is checked on every file.
  app.get('/api/files/:id', async (req, reply) => {
    const f = await run.auth(req, async ({ tx, actor }) => {
      const f = await one(tx, `select * from app.files where id = $1`, [idParam.parse(req.params).id]) ?? notFound('That file');
      const staff = actor.canAnywhere('operations.view') || actor.canAnywhere('operations.manage');
      const allowed = f.uploaded_by === actor.personId || f.purpose === 'logo'
        || (f.purpose === 'approval_letter' && actor.canAnywhere('approvals.view'))
        || (f.purpose === 'ownership_document' && actor.canAnywhere('people.view'))
        || (f.purpose === 'other' && actor.canAnywhere('audit.view'))
        || (f.purpose === 'contract' && staff)
        || (f.purpose === 'quotation' && (actor.canAnywhere('procurement.view') || actor.canAnywhere('procurement.manage')))
        || (['invoice', 'payment_proof'].includes(f.purpose) && (actor.can('finance.view') || actor.can('finance.manage')))
        || (f.purpose === 'invoice' && actor.canAnywhere('finance.prepare'))
        || (f.purpose === 'work_photo' && (staff || !!await one(tx, `select 1 from app.work_updates u
              join app.work_orders w on w.tenant_id = u.tenant_id and w.id = u.work_order_id
             where u.file_id = $1 and (w.assignee_person_id = $2 or (w.raised_by = $2 and not u.staff_only))
            union select 1 from app.routine_checks c join app.routines r on r.tenant_id = c.tenant_id and r.id = c.routine_id
             where c.photo_file_id = $1 and $2 in (r.assignee_person_id, r.backup_person_id)`, [f.id, actor.personId])));
      let shared = false;
      if (!allowed && (f.purpose === 'document' || f.purpose === 'notice')) {
        const w = await audienceOf(tx, actor);
        shared = f.purpose === 'document'
          ? (await many(tx, `select d.*, n.ancestor_ids from app.documents d left join app.property_nodes n on n.tenant_id = d.tenant_id and n.id = d.node_id
              where d.file_id = $1`, [f.id])).some(d => seesDocument(w, d))
          : (await many(tx, `select x.*, n.ancestor_ids from app.notices x left join app.property_nodes n on n.tenant_id = x.tenant_id and n.id = x.scope_node_id
              where x.file_id = $1 and x.withdrawn_at is null and x.publish_at <= now()`, [f.id])).some(x => seesNotice(w, x));
      }
      if (!allowed && !shared) notFound('That file');
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
    'approval_rule_stages', 'approval_requests', 'approval_stages', 'approval_stage_voters', 'approval_votes', 'assets', 'asset_contracts',
    'routines', 'routine_schedules', 'routine_checks', 'work_orders', 'work_updates', 'vendors', 'quotes', 'vendor_selections', 'vendor_reviews',
    'finance_settings', 'ledger_accounts', 'journals', 'journal_lines', 'charge_plans', 'billing_runs', 'billing_run_lines', 'payment_claims',
    'vouchers', 'bank_statements', 'bank_statement_lines', 'budgets', 'notices', 'notice_reads', 'documents', 'ask_questions', 'files', 'audit_events'];

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
