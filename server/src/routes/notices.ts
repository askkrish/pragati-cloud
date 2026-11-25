// Notices, the records library, and the committee's and owners' report packs.
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../actor.ts';
import type { Runner, Services } from '../app.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import { balances, duesByUnit, financeToday } from '../services/ledger.ts';
import { IN_SCOPE, isStaff, nodeRef, routineDays, seeScopes, visibleRoutines } from '../services/operations.ts';
import { addDays, localNow } from '../services/schedule.ts';
import { getAs } from '../services/internal.ts';
import { date, idParam, text, uuid, z } from './z.ts';

type Who = { homes: string[][]; owner: boolean; committee: boolean; staff: boolean; finance: boolean; actor: Actor };

// What the person is to the community: their homes (each with the places it sits in), and their roles.
async function who(tx: Tx, actor: Actor): Promise<Who> {
  const homes = await many(tx, `select n.ancestor_ids || n.id as places, exists (select 1 from app.ownerships o where o.unit_id = u.id and o.person_id = $1 and o.ends_on is null) as owns
    from app.units u join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
    where u.id in (select unit_id from app.ownerships where person_id = $1 and ends_on is null
                   union select unit_id from app.occupancies where person_id = $1 and ends_on is null)`, [actor.personId]);
  return { homes: homes.map(h => h.places), owner: homes.some(h => h.owns), committee: actor.canAnywhere('committees.view'), staff: isStaff(actor),
    finance: actor.can('finance.view') || actor.can('finance.manage'), actor };
}
// A record for one place reaches the homes in that place, and the people whose roles cover it.
function reaches(w: Who, node: { id: string; ancestor_ids: string[] } | null) {
  if (!node) return true;
  // Roles count only when they carry permissions: the Owner and Resident roles reach no further than the person's own home.
  return w.homes.some(p => p.includes(node.id))
    || w.actor.grants.some(g => g.perms.size > 0 && (g.scope === null || g.scope === node.id || node.ancestor_ids.includes(g.scope)));
}
function seesNotice(w: Who, n: any) {
  const node = n.scope_node_id ? { id: n.scope_node_id, ancestor_ids: n.ancestor_ids ?? [] } : null;
  if (w.actor.can('notices.publish', node ?? undefined)) return true;
  const audience = n.audience === 'everyone' || (n.audience === 'owners' && (w.owner || w.committee)) || (n.audience === 'committee' && w.committee)
    || (n.audience === 'staff' && (w.staff || w.committee));
  return audience && reaches(w, node);
}
function seesDocument(w: Who, d: any) {
  if (w.actor.canAnywhere('documents.manage')) return true;
  const node = d.node_id ? { id: d.node_id, ancestor_ids: d.ancestor_ids ?? [] } : null;
  const ok = d.visibility === 'everyone' || (d.visibility === 'owners' && (w.owner || w.committee)) || (d.visibility === 'committee' && w.committee)
    || (d.visibility === 'finance' && (w.finance || w.committee && d.category === 'audit'));
  return ok && reaches(w, node);
}
export { who as audienceOf, seesNotice, seesDocument };

const NOTICE_SQL = `select n.*, s.ancestor_ids, s.name as place, p.full_name as by,
    (select count(*) from app.notice_reads r where r.notice_id = n.id)::int as reads
  from app.notices n left join app.property_nodes s on s.tenant_id = n.tenant_id and s.id = n.scope_node_id
  join app.people p on p.tenant_id = n.tenant_id and p.id = n.created_by`;
const DOC_SQL = `select d.*, s.ancestor_ids, s.name as place, p.full_name as by, f.file_name, f.content_type, f.size_bytes
  from app.documents d left join app.property_nodes s on s.tenant_id = d.tenant_id and s.id = d.node_id
  join app.people p on p.tenant_id = d.tenant_id and p.id = d.uploaded_by join app.files f on f.tenant_id = d.tenant_id and f.id = d.file_id`;

export async function noticeRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  // ================================================================ notices
  app.get('/api/notices', async req => run.auth(req, async ({ tx, actor }) => {
    const q = z.object({ all: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const w = await who(tx, actor);
    const today = await financeToday(tx);
    const rows = await many(tx, `${NOTICE_SQL} where n.withdrawn_at is null or $1 order by n.pinned desc, n.publish_at desc limit 400`, [q.all]);
    const read = new Set((await many(tx, `select notice_id from app.notice_reads where person_id = $1`, [actor.personId])).map(r => r.notice_id));
    const now = Date.now();
    return rows.filter(n => seesNotice(w, n)).map(n => {
      const publisher = actor.can('notices.publish', n.scope_node_id ? { id: n.scope_node_id, ancestor_ids: n.ancestor_ids } : undefined);
      const live = !n.withdrawn_at && new Date(n.publish_at).getTime() <= now && (!n.expires_on || n.expires_on >= today);
      return { ...n, ancestor_ids: undefined, read: read.has(n.id) || n.created_by === actor.personId, live, scheduled: new Date(n.publish_at).getTime() > now, publisher, reads: publisher ? n.reads : undefined };
    }).filter(n => n.live || (q.all && n.publisher)).slice(0, q.limit);
  }));

  app.get('/api/notices/:id', async req => run.auth(req, async ({ tx, actor }) => {
    const n = await one(tx, `${NOTICE_SQL} where n.id = $1`, [idParam.parse(req.params).id]) ?? notFound('That notice');
    if (!seesNotice(await who(tx, actor), n)) notFound('That notice');
    const publisher = actor.can('notices.publish', n.scope_node_id ? { id: n.scope_node_id, ancestor_ids: n.ancestor_ids } : undefined);
    if (!publisher && (n.withdrawn_at || new Date(n.publish_at).getTime() > Date.now())) notFound('That notice');
    const first = (await tx.query(`insert into app.notice_reads (notice_id, person_id) values ($1, $2) on conflict do nothing`, [n.id, actor.personId])).rowCount ?? 0;
    return { ...n, ancestor_ids: undefined, publisher, reads: publisher ? n.reads + first : undefined };
  }));

  app.post('/api/notices', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = z.object({ title: text(160), body: z.string().trim().min(3).max(8000), category: z.enum(['general', 'maintenance', 'meeting', 'finance', 'security', 'event', 'emergency']),
      audience: z.enum(['everyone', 'owners', 'committee', 'staff']).default('everyone'), scopeNodeId: uuid.nullable().optional(),
      publishAt: z.string().datetime({ offset: true }).optional(), expiresOn: date.nullable().optional(), pinned: z.boolean().default(false),
      fileId: uuid.nullable().optional() }).parse(req.body);
    const node = b.scopeNodeId ? await nodeRef(tx, b.scopeNodeId) : null;
    if (!actor.can('notices.publish', node ?? undefined)) forbidden();
    if (b.expiresOn && b.expiresOn < localNow('Asia/Kolkata').day) fail(400, 'The end date has already passed.', 'invalid');
    if (b.fileId && !await one(tx, `select 1 from app.files where id = $1 and purpose = 'notice' and uploaded_by = $2`, [b.fileId, actor.personId]))
      fail(400, 'Upload the attachment again.', 'invalid');
    const ref = (await one(tx, `select app.next_ref('notice', 'NT') as ref`))!.ref;
    const n = await one(tx, `insert into app.notices (ref, title, body, category, audience, scope_node_id, publish_at, expires_on, pinned, file_id, created_by)
      values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), $8, $9, $10, $11) returning id`,
      [ref, b.title, b.body, b.category, b.audience, node?.id ?? null, b.publishAt ?? null, b.expiresOn ?? null, b.pinned, b.fileId ?? null, actor.personId]);
    await audit('notice.published', 'notice', n!.id, `${ref} ${b.publishAt ? 'scheduled' : 'published'}: ${b.title}`, { audience: b.audience, place: node?.name ?? null });
    return { id: n!.id, ref };
  }));

  app.post('/api/notices/:id/withdraw', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const n = await one(tx, `${NOTICE_SQL} where n.id = $1`, [idParam.parse(req.params).id]) ?? notFound('That notice');
    if (!actor.can('notices.publish', n.scope_node_id ? { id: n.scope_node_id, ancestor_ids: n.ancestor_ids } : undefined)) forbidden();
    if (n.withdrawn_at) fail(409, 'Already withdrawn.', 'closed');
    const b = z.object({ note: text(300) }).parse(req.body);
    await tx.query(`update app.notices set withdrawn_at = now(), withdrawn_note = $2 where id = $1`, [n.id, b.note]);
    await audit('notice.withdrawn', 'notice', n.id, `${n.ref} withdrawn: ${b.note}`);
    return { ok: true };
  }));

  // ================================================================ records library
  app.get('/api/documents', async req => run.auth(req, async ({ tx, actor }) => {
    const q = z.object({ category: z.string().max(20).optional(), q: z.string().trim().max(80).optional() }).parse(req.query);
    const w = await who(tx, actor);
    const rows = await many(tx, `${DOC_SQL} where d.replaced_by is null and d.archived_at is null and ($1::text is null or d.category = $1)
      and ($2::text is null or d.title ilike '%' || $2 || '%' or d.description ilike '%' || $2 || '%' or d.ref ilike $2 || '%')
      order by coalesce(d.dated_on, d.created_at::date) desc limit 500`, [q.category ?? null, q.q || null]);
    const today = localNow('Asia/Kolkata').day;
    return rows.filter(d => seesDocument(w, d)).map(d => ({ ...d, ancestor_ids: undefined, reviewDue: !!d.review_on && d.review_on <= addDays(today, 30),
      reviewOverdue: !!d.review_on && d.review_on < today }));
  }));

  app.get('/api/documents/:id', async req => run.auth(req, async ({ tx, actor }) => {
    const d = await one(tx, `${DOC_SQL} where d.id = $1`, [idParam.parse(req.params).id]) ?? notFound('That document');
    if (!seesDocument(await who(tx, actor), d)) notFound('That document');
    const versions = await many(tx, `with recursive chain as (select * from app.documents where replaced_by = $1
        union all select x.* from app.documents x join chain c on x.replaced_by = c.id)
      select c.id, c.version, c.created_at, c.file_id, f.file_name, p.full_name as by from chain c join app.files f on f.tenant_id = c.tenant_id and f.id = c.file_id
      join app.people p on p.tenant_id = c.tenant_id and p.id = c.uploaded_by order by c.version desc`, [d.id]);
    return { ...d, ancestor_ids: undefined, versions, canManage: actor.canAnywhere('documents.manage') };
  }));

  app.post('/api/documents', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!actor.canAnywhere('documents.manage')) forbidden();
    const b = z.object({ title: text(160), category: z.enum(['bye_laws', 'minutes', 'agm', 'financial', 'audit', 'legal', 'contracts', 'insurance', 'statutory', 'circulars', 'plans', 'other']),
      description: z.string().trim().max(2000).default(''), fileId: uuid, visibility: z.enum(['everyone', 'owners', 'committee', 'finance']),
      nodeId: uuid.nullable().optional(), datedOn: date.nullable().optional(), reviewOn: date.nullable().optional(), replacesId: uuid.nullable().optional() }).parse(req.body);
    if (!await one(tx, `select 1 from app.files where id = $1 and purpose = 'document' and uploaded_by = $2`, [b.fileId, actor.personId])) fail(400, 'Upload the file again.', 'invalid');
    let version = 1, old: any = null;
    if (b.replacesId) {
      old = await one(tx, `select * from app.documents where id = $1`, [b.replacesId]) ?? notFound('That document');
      if (old.replaced_by || old.archived_at) fail(409, 'That document already has a newer version.', 'closed');
      version = old.version + 1;
    }
    const node = b.nodeId ? await nodeRef(tx, b.nodeId) : null;
    const ref = (await one(tx, `select app.next_ref('document', 'DC') as ref`))!.ref;
    const d = await one(tx, `insert into app.documents (ref, title, category, description, file_id, visibility, node_id, dated_on, review_on, version, uploaded_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [ref, b.title, b.category, b.description, b.fileId, b.visibility, node?.id ?? null, b.datedOn ?? null, b.reviewOn ?? null, version, actor.personId]);
    if (old) await tx.query(`update app.documents set replaced_by = $2 where id = $1`, [old.id, d!.id]);
    await audit('document.added', 'document', d!.id, `${ref} ${old ? `version ${version} of ${old.ref}` : 'added'}: ${b.title}`, { visibility: b.visibility });
    return { id: d!.id, ref, version };
  }));

  app.post('/api/documents/:id/archive', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!actor.canAnywhere('documents.manage')) forbidden();
    const d = await one(tx, `select * from app.documents where id = $1`, [idParam.parse(req.params).id]) ?? notFound('That document');
    const b = z.object({ note: text(300) }).parse(req.body);
    await tx.query(`update app.documents set archived_at = now() where id = $1`, [d.id]);
    await audit('document.archived', 'document', d.id, `${d.ref} taken out of the library: ${b.note}`);
    return { ok: true };
  }));

  // ================================================================ report packs
  // The committee's weekly pack: each section only for those who may see it.
  app.get('/api/packs/weekly', async req => run.auth(req, async ({ tx, actor }) => {
    const w = await who(tx, actor);
    if (!w.committee && !w.staff && !w.finance) forbidden();
    const today = await financeToday(tx);
    const q = z.object({ end: date.optional(), days: z.coerce.number().int().min(1).max(31).default(7) }).parse(req.query);
    const end = q.end ?? today;
    // One day is the end-of-day summary; seven the weekly pack.
    const start = addDays(end, -(q.days - 1));
    const out: Record<string, unknown> = { start, end, days: q.days, community: (await one(tx, `select platform_name, legal_name, escalation_days from app.tenants`)) };
    if (isStaff(actor)) {
      const tz = (await one(tx, `select timezone from app.tenants`))!.timezone;
      const now = localNow(tz);
      const days = (await routineDays(tx, await visibleRoutines(tx, actor), start, end, now)).filter(d => !['upcoming', 'due'].includes(d.status));
      const byCat = new Map<string, { due: number; done: number; missed: number; late: number }>();
      for (const d of days) {
        const c = byCat.get(d.category) ?? { due: 0, done: 0, missed: 0, late: 0 };
        c.due++; if (d.status === 'done') c.done++; if (d.status === 'missed') c.missed++; if (d.late) c.late++;
        byCat.set(d.category, c);
      }
      out.checks = { total: { due: days.length, done: days.filter(d => d.status === 'done').length, missed: days.filter(d => d.status === 'missed').length,
        late: days.filter(d => d.late).length }, byCategory: [...byCat].map(([category, c]) => ({ category, ...c })).sort((a, b) => b.missed - a.missed),
        missed: days.filter(d => d.status === 'missed').slice(0, 12).map(d => ({ day: d.day, title: d.title, place: d.place, assignee: d.assignee })) };
      const scopes = seeScopes(actor);
      out.work = await one(tx, `select count(*) filter (where w.created_at::date between $2 and $3)::int as opened,
          count(*) filter (where w.closed_at::date between $2 and $3 and w.status = 'closed')::int as closed,
          count(*) filter (where w.status in ('new', 'open', 'in_progress', 'on_hold'))::int as open,
          count(*) filter (where w.status in ('new', 'open', 'in_progress', 'on_hold') and w.due_on < $3)::int as overdue,
          count(*) filter (where w.kind = 'request' and w.created_at::date between $2 and $3)::int as requests
        from app.work_orders w join app.property_nodes n on n.tenant_id = w.tenant_id and n.id = w.node_id where ${IN_SCOPE(1)}`, [scopes, start, end]);
      out.oldest = await many(tx, `select w.ref, w.title, w.kind, w.status, w.priority, (current_date - w.created_at::date) as age, ap.full_name as assignee
        from app.work_orders w join app.property_nodes n on n.tenant_id = w.tenant_id and n.id = w.node_id
        left join app.people ap on ap.tenant_id = w.tenant_id and ap.id = w.assignee_person_id
        where ${IN_SCOPE(1)} and w.status in ('new', 'open', 'in_progress', 'on_hold') order by w.created_at limit 8`, [scopes]);
      out.renewals = await many(tx, `select c.ref, c.title, c.kind, c.ends_on, c.provider from app.asset_contracts c join app.property_nodes n on n.tenant_id = c.tenant_id and n.id = c.node_id
        where c.renewed_by is null and c.archived_at is null and c.ends_on <= $2::date + 30 and ${IN_SCOPE(1)} order by c.ends_on`, [scopes, end]);
      out.services = await many(tx, `select a.ref, a.name, s.next_due_on, s.outcome from app.assets a join app.property_nodes n on n.tenant_id = a.tenant_id and n.id = a.node_id
        join lateral (select next_due_on, outcome from app.asset_services x where x.asset_id = a.id order by x.serviced_on desc, x.created_at desc limit 1) s on true
        where a.archived_at is null and ((s.next_due_on is not null and s.next_due_on <= $2::date + 30) or s.outcome <> 'passed') and ${IN_SCOPE(1)} order by s.next_due_on nulls first`, [scopes, end]);
      out.incidents = await many(tx, `select w.ref, w.title, w.priority, w.status, w.created_at from app.work_orders w join app.property_nodes n on n.tenant_id = w.tenant_id and n.id = w.node_id
        where w.kind = 'incident' and w.created_at::date between $2 and $3 and ${IN_SCOPE(1)} order by w.created_at`, [scopes, start, end]);
      out.milestones = await many(tx, `select w.ref, w.title as work, m.title, m.due_on from app.milestones m join app.work_orders w on w.tenant_id = m.tenant_id and w.id = m.work_order_id
        join app.property_nodes n on n.tenant_id = w.tenant_id and n.id = w.node_id
        where m.done_on is null and m.due_on <= $2::date + 7 and w.status not in ('closed', 'cancelled') and ${IN_SCOPE(1)} order by m.due_on limit 15`, [scopes, end]);
      out.handovers = await many(tx, `select h.ref, w.ref as work_ref, w.title, p.full_name as recipient, h.created_at from app.handovers h
        join app.work_orders w on w.tenant_id = h.tenant_id and w.id = h.work_order_id join app.people p on p.tenant_id = h.tenant_id and p.id = h.recipient_id
        where h.status = 'submitted' order by h.created_at`);
    }
    if (actor.canAnywhere('approvals.view')) {
      out.approvals = await many(tx, `select r.ref, r.title, r.amount_paise, r.subject_type, (current_date - r.created_at::date) as age,
          (now() - r.created_at > make_interval(days => (select escalation_days from app.tenants))) as escalated from app.approval_requests r
        where r.status = 'pending' order by r.created_at limit 15`);
      out.decided = await many(tx, `select r.ref, r.title, r.status, r.amount_paise from app.approval_requests r where r.decided_at::date between $1 and $2 order by r.decided_at`, [start, end]);
    }
    if (w.finance) {
      const bal = await balances(tx, end, start);
      out.cash = bal.filter(a => a.cash_kind).map(a => ({ name: a.name, opening: Number(a.opening), received: Number(a.period_debit), paid: Number(a.period_credit), closing: Number(a.balance) }));
      const dues = [...(await duesByUnit(tx, end)).values()];
      out.dues = { outstanding: dues.reduce((s, d) => s + Math.max(0, d.balance), 0), homes: dues.filter(d => d.balance > 0).length,
        over90: dues.reduce((s, d) => s + d.buckets.over90, 0), over90Homes: dues.filter(d => d.buckets.over90 > 0).length };
      out.payments = await many(tx, `select j.txn_date, j.ref, j.narration, sum(l.credit_paise)::bigint as amount from app.journals j
        join app.journal_lines l on l.tenant_id = j.tenant_id and l.journal_id = j.id join app.ledger_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id and a.cash_kind is not null
        where j.kind = 'payment' and j.txn_date between $1 and $2 group by j.id order by j.txn_date`, [start, end]);
    }
    out.notices = await many(tx, `select ref, title, audience, publish_at from app.notices where withdrawn_at is null and publish_at::date between $1 and $2 order by publish_at`, [start, end]);
    return out;
  }));

  // Notice templates with fill-in fields such as {{date}}, carried over from JAOA's report templates.
  const STARTERS = [
    { id: 'starter-water', title: 'Water supply off on {{day}}', category: 'maintenance', audience: 'everyone',
      body: 'Water supply will be off on {{day}} from {{from_time}} to {{to_time}} for {{reason}}.\n\nPlease store water the night before. For help, call the facility office.' },
    { id: 'starter-power', title: 'Power shutdown on {{day}}', category: 'maintenance', audience: 'everyone',
      body: 'Power will be off in {{place}} on {{day}} from {{from_time}} to {{to_time}} for {{reason}}. Lifts will not run during this time; the generator will cover common lighting.' },
    { id: 'starter-lift', title: '{{lift}} out of service', category: 'maintenance', audience: 'everyone',
      body: '{{lift}} will be out of service from {{from_day}} to {{to_day}} for {{reason}}. Other lifts will run as usual. Residents needing help with heavy items may ask the security desk.' },
    { id: 'starter-pest', title: 'Pest control on {{day}}', category: 'general', audience: 'everyone',
      body: 'Pest control will be done in {{place}} on {{day}} from {{from_time}}. Please keep food covered and children and pets away from treated areas for two hours.' },
    { id: 'starter-dues', title: 'Maintenance for {{month}} due by {{due_day}}', category: 'finance', audience: 'owners',
      body: 'Maintenance bills for {{month}} are in the app under Dues. Please pay by {{due_day}}. Pay by UPI from the app and tap "I have paid" with the UTR so the treasurer can match it.' },
    { id: 'starter-agm', title: 'Annual general meeting on {{day}}', category: 'meeting', audience: 'owners',
      body: 'The annual general meeting will be held at {{venue}} on {{day}} at {{time}}.\n\nAgenda:\n{{agenda}}\n\nOwners who cannot attend may appoint a proxy in writing by {{proxy_by}}.' },
  ];
  app.get('/api/notice-templates', async req => run.auth(req, async ({ tx, actor }) => {
    if (!actor.canAnywhere('notices.publish')) forbidden();
    const own = await many(tx, `select id, title, body, category, audience from app.notice_templates where archived_at is null order by title`);
    return [...own.map(t => ({ ...t, own: true })), ...STARTERS.map(t => ({ ...t, own: false }))];
  }));
  app.post('/api/notice-templates', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!actor.canAnywhere('notices.publish')) forbidden();
    const b = z.object({ title: text(160), body: z.string().trim().min(3).max(8000),
      category: z.enum(['general', 'maintenance', 'meeting', 'finance', 'security', 'event', 'emergency']).default('general'),
      audience: z.enum(['everyone', 'owners', 'committee', 'staff']).default('everyone') }).parse(req.body);
    const fields = [...new Set([...`${b.title} ${b.body}`.matchAll(/\{\{(\w{1,30})\}\}/g)].map(m => m[1]))];
    if (fields.length > 18) fail(400, 'Use at most 18 fill-in fields.', 'invalid');
    if (/\{\{|\}\}/.test(`${b.title} ${b.body}`.replace(/\{\{\w{1,30}\}\}/g, ''))) fail(400, 'Write fill-in fields as {{name}}, using letters, numbers and underscores.', 'invalid');
    const t = await one(tx, `insert into app.notice_templates (title, body, category, audience, created_by) values ($1, $2, $3, $4, $5) returning id`,
      [b.title, b.body, b.category, b.audience, actor.personId]);
    await audit('notice_template.created', 'notice_template', t!.id, `Notice template "${b.title}" saved`);
    return { id: t!.id, fields };
  }));
  app.post('/api/notice-templates/:id/archive', async req => run.auth(req, async ({ tx, actor }) => {
    if (!actor.canAnywhere('notices.publish')) forbidden();
    const r = await tx.query(`update app.notice_templates set archived_at = now() where id = $1 and archived_at is null`, [idParam.parse(req.params).id]);
    if (!r.rowCount) notFound('That template');
    return { ok: true };
  }));

  // The annual pack for the AGM: the year's work, decisions and accounts, for the committee to review
  // before it is published. Each part comes only to those allowed to see it.
  app.get('/api/packs/annual', async req => {
    const base = await run.auth(req, async ({ tx, actor }) => {
      const w = await who(tx, actor);
      if (!w.committee && !w.finance) forbidden();
      const today = await financeToday(tx);
      const s = await one(tx, `select fy_start_month from app.finance_settings`);
      const startMonth = Number(s?.fy_start_month ?? 4);
      const cur = Number(today.slice(5, 7)) >= startMonth ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
      const fy = z.object({ fy: z.coerce.number().int().min(2000).max(cur).optional() }).parse(req.query).fy ?? cur - 1;
      const start = `${fy}-${String(startMonth).padStart(2, '0')}-01`;
      const endFull = addDays(`${fy + 1}-${String(startMonth).padStart(2, '0')}-01`, -1);
      const end = endFull < today ? endFull : today;
      const out: Record<string, any> = { fy, start, end, complete: endFull < today, label: `${fy}–${String(fy + 1).slice(2)}`,
        community: await one(tx, `select platform_name, legal_name, registration_no from app.tenants`) };
      if (isStaff(actor) || w.committee) {
        const scopes = seeScopes(actor);
        out.work = await many(tx, `select w.kind, count(*) filter (where w.created_at::date between $2 and $3)::int as opened,
            count(*) filter (where w.status in ('done', 'closed') and coalesce(w.completed_at, w.closed_at)::date between $2 and $3)::int as completed
          from app.work_orders w join app.property_nodes n on n.tenant_id = w.tenant_id and n.id = w.node_id
          where ${IN_SCOPE(1)} group by w.kind order by w.kind`, [scopes, start, end]);
        out.requestDays = (await one(tx, `select round(avg(extract(epoch from (coalesce(w.completed_at, w.closed_at) - w.created_at)) / 86400)::numeric, 1) as days
          from app.work_orders w where w.kind = 'request' and w.status in ('done', 'closed') and coalesce(w.completed_at, w.closed_at)::date between $1 and $2`, [start, end]))?.days ?? null;
        out.projects = await many(tx, `select w.ref, w.title, w.status, c.ref as contract_ref, v.name as vendor,
            c.amount_paise + coalesce((select sum(ch.delta_paise) from app.contract_changes ch join app.approval_requests r on r.tenant_id = ch.tenant_id and r.id = ch.approval_request_id
              where ch.contract_id = c.id and r.status = 'approved'), 0) as committed_paise,
            (select coalesce(sum(x.amount_paise), 0) from app.vouchers x where x.work_order_id = w.id and x.status = 'paid') as paid_paise
          from app.work_orders w left join app.contracts c on c.tenant_id = w.tenant_id and c.work_order_id = w.id
          left join app.vendors v on v.tenant_id = c.tenant_id and v.id = c.vendor_id
          where w.kind = 'project' and (w.created_at::date between $1 and $2 or coalesce(w.completed_at, w.closed_at)::date between $1 and $2
            or w.status in ('open', 'in_progress', 'on_hold')) order by w.created_at`, [start, end]);
        out.services = (await one(tx, `select count(*)::int as n, count(*) filter (where outcome <> 'passed')::int as issues from app.asset_services
          where serviced_on between $1 and $2`, [start, end]));
      }
      if (actor.canAnywhere('approvals.view')) {
        out.approvals = await many(tx, `select r.status, count(*)::int as n, coalesce(sum(r.amount_paise), 0)::bigint as amount from app.approval_requests r
          where r.decided_at::date between $1 and $2 group by r.status order by r.status`, [start, end]);
      }
      out.notices = (await one(tx, `select count(*)::int as n from app.notices where withdrawn_at is null and publish_at::date between $1 and $2`, [start, end]))!.n;
      out.documents = (await one(tx, `select count(*)::int as n from app.documents where created_at::date between $1 and $2`, [start, end]))!.n;
      out.finance = w.finance;
      return out;
    });
    if (base.finance) {
      const get = async (p: string) => { const r = await getAs(app, req, p); return r.status === 200 ? r.body : null; };
      const [income, balance, budget, collection] = await Promise.all([
        get(`/api/finance/reports/income?from=${base.start}&to=${base.end}`), get(`/api/finance/reports/balance?asOf=${base.end}`),
        get(`/api/finance/reports/budget?fy=${base.fy}`), get(`/api/finance/reports/collection?from=${base.start}&to=${base.end}`)]);
      Object.assign(base, { income, balance, budget, collection });
    }
    return base;
  });

  // The owners' monthly update: how the community is being looked after, in counts only.
  app.get('/api/packs/owners', async req => run.auth(req, async ({ tx }) => {
    const today = await financeToday(tx);
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
    const month = q.month ?? addDays(today.slice(0, 8) + '01', -1).slice(0, 7);
    const start = `${month}-01`, end = addDays(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10), -1);
    if (start > today) fail(400, 'Choose a month that has started.', 'invalid');
    const tz = (await one(tx, `select timezone from app.tenants`))!.timezone;
    const routines = await many(tx, `select r.*, '' as place from app.routines r where r.archived_at is null`);
    const days = (await routineDays(tx, routines, start, end < today ? end : today, localNow(tz))).filter(d => !['upcoming', 'due'].includes(d.status));
    const work = await one(tx, `select count(*) filter (where kind = 'request' and created_at::date between $1 and $2)::int as requests,
        count(*) filter (where kind = 'request' and status in ('done', 'closed') and completed_at::date between $1 and $2)::int as resolved,
        round(avg(extract(epoch from completed_at - created_at) / 86400) filter (where kind = 'request' and completed_at::date between $1 and $2)::numeric, 1) as days_to_fix,
        count(*) filter (where kind in ('maintenance', 'project', 'incident') and completed_at::date between $1 and $2)::int as completed,
        count(*) filter (where kind = 'project' and status in ('open', 'in_progress', 'on_hold'))::int as projects
      from app.work_orders`, [start, end]);
    const coll = await one(tx, `select coalesce(sum(l.debit_paise) filter (where j.kind = 'charge'), 0)::bigint as billed,
        coalesce(sum(l.credit_paise) filter (where j.kind = 'receipt'), 0)::bigint as collected
      from app.journal_lines l join app.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
      join app.ledger_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id and a.system_key = 'receivables' where j.txn_date between $1 and $2`, [start, end]);
    const notices = await one(tx, `select count(*)::int as n from app.notices where withdrawn_at is null and audience in ('everyone', 'owners') and publish_at::date between $1 and $2`, [start, end]);
    return { month, start, end, community: (await one(tx, `select platform_name, legal_name from app.tenants`)),
      checks: { due: days.length, done: days.filter(d => d.status === 'done').length }, work,
      collection: Number(coll!.billed) ? Math.round(Number(coll!.collected) / Number(coll!.billed) * 100) : null, notices: notices!.n };
  }));

}
