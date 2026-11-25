// Work orders: owners' service requests, incidents, maintenance and projects.
//
// Who sees a work order: anyone with operations.view or .manage over its place, the person it is
// given to, and the person who raised it. The person who raised a service request sees the
// updates meant for them, never the staff-only ones, the estimate or the approval.
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../actor.ts';
import type { Runner, Services } from '../app.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import * as engine from '../services/approvals.ts';
import { IN_SCOPE, manages, myHomes, nodeRef, personExists, PLACE, sees, seeScopes } from '../services/operations.ts';
import { localNow } from '../services/schedule.ts';
import { CATEGORIES } from './operations.ts';
import { date, idParam, rupeesToPaise, text, uuid, z } from './z.ts';

const KINDS = ['request', 'incident', 'maintenance', 'project'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const OPEN = ['new', 'open', 'in_progress', 'on_hold'];
const STATUS_WORDS: Record<string, string> = { new: 'New', open: 'Open', in_progress: 'In progress', on_hold: 'On hold', done: 'Done',
  closed: 'Closed', cancelled: 'Cancelled' };

async function today(tx: Tx) {
  return localNow((await one(tx, `select timezone from app.tenants`))!.timezone).day;
}

async function loadWork(tx: Tx, actor: Actor, id: string) {
  const w = await one(tx, `select w.*, n.ancestor_ids, ${PLACE()} as place, u.label as unit, a.name as asset, rt.ref as routine_ref,
      rp.full_name as raised_by_name, ap.full_name as assignee,
      ar.ref as approval_ref, ar.status as approval_status
    from app.work_orders w join app.property_nodes n on n.tenant_id = w.tenant_id and n.id = w.node_id
    left join app.units u on u.tenant_id = w.tenant_id and u.id = w.unit_id
    left join app.assets a on a.tenant_id = w.tenant_id and a.id = w.asset_id
    left join app.routines rt on rt.tenant_id = w.tenant_id and rt.id = w.routine_id
    left join app.people rp on rp.tenant_id = w.tenant_id and rp.id = w.raised_by
    left join app.people ap on ap.tenant_id = w.tenant_id and ap.id = w.assignee_person_id
    left join app.approval_requests ar on ar.tenant_id = w.tenant_id and ar.id = w.approval_request_id
    where w.id = $1`, [id]) ?? notFound('That work order');
  const node = { id: w.node_id, ancestor_ids: w.ancestor_ids };
  const staff = sees(actor, node) || w.assignee_person_id === actor.personId;
  if (!staff && w.raised_by !== actor.personId) notFound('That work order');
  const assigned = w.assignee_person_id === actor.personId;
  const worker = manages(actor, node) || assigned || (actor.can('operations.update', node) && staff);
  return { w, node, staff, worker, manager: manages(actor, node), requester: w.raised_by === actor.personId };
}

// Which status changes this person may make now. Notes are required where the reason matters.
function moves(a: Awaited<ReturnType<typeof loadWork>>) {
  const { w, worker, manager, requester } = a;
  const out: { to: string; label: string; needsNote: boolean }[] = [];
  const add = (to: string, label: string, needsNote = false) => out.push({ to, label, needsNote });
  if (w.status === 'new' && manager) add('open', 'Accept');
  if (w.status === 'open' && worker) add('in_progress', 'Start work');
  if (w.status === 'in_progress' && worker) add('on_hold', 'Put on hold', true);
  if (w.status === 'on_hold' && worker) add('in_progress', 'Resume');
  if (['open', 'in_progress', 'on_hold'].includes(w.status) && worker) add('done', 'Mark done', true);
  if (w.status === 'done' && (manager || (requester && w.kind === 'request'))) add('closed', requester && !manager ? 'Confirm it is fixed' : 'Verify and close');
  if (w.status === 'done' && (manager || requester)) add('in_progress', 'Not fixed: reopen', true);
  const closedRecently = w.closed_at && Date.now() - new Date(w.closed_at).getTime() < 30 * 86_400_000;
  if (w.status === 'closed' && (manager || (requester && closedRecently))) add('open', 'Reopen', true);
  if (OPEN.includes(w.status) && manager) add('cancelled', 'Cancel', true);
  else if (['new', 'open'].includes(w.status) && requester) add('cancelled', 'Withdraw my request');
  return out;
}

export async function workRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  app.get('/api/work', async req => run.auth(req, async ({ tx, actor }) => {
    const q = z.object({ view: z.enum(['open', 'mine', 'requests', 'overdue', 'done', 'closed', 'raised']).default('open'),
      kind: z.enum(KINDS).optional(), q: z.string().trim().max(80).optional(), assetId: uuid.optional() }).parse(req.query);
    const day = await today(tx);
    const cond: Record<string, string> = {
      open: `w.status in ('new', 'open', 'in_progress', 'on_hold')`,
      mine: `w.status in ('new', 'open', 'in_progress', 'on_hold') and w.assignee_person_id = $2`,
      requests: `w.kind = 'request' and w.status in ('new', 'open', 'in_progress', 'on_hold', 'done')`,
      overdue: `w.status in ('new', 'open', 'in_progress', 'on_hold') and w.due_on < $3::date`,
      done: `w.status = 'done'`,
      closed: `w.status in ('closed', 'cancelled')`,
      raised: `w.raised_by = $2`,
    };
    const rows = await many(tx, `select w.id, w.ref, w.kind, w.title, w.category, w.priority, w.status, w.due_on, w.created_at,
        w.raised_by = $2 as mine_raised, ${PLACE()} as place, u.label as unit, ap.full_name as assignee, rp.full_name as raised_by,
        (w.due_on < $3::date and w.status in ('new', 'open', 'in_progress', 'on_hold')) as overdue
      from app.work_orders w join app.property_nodes n on n.tenant_id = w.tenant_id and n.id = w.node_id
      left join app.units u on u.tenant_id = w.tenant_id and u.id = w.unit_id
      left join app.people ap on ap.tenant_id = w.tenant_id and ap.id = w.assignee_person_id
      left join app.people rp on rp.tenant_id = w.tenant_id and rp.id = w.raised_by
      where (${IN_SCOPE(1)} or w.assignee_person_id = $2 or w.raised_by = $2) and ${cond[q.view]}
        and ($4::text is null or w.kind = $4) and ($6::uuid is null or w.asset_id = $6)
        and ($5::text is null or w.title ilike '%' || $5 || '%' or w.ref ilike $5 || '%' or u.label ilike $5 || '%')
      order by array_position(array['urgent', 'high', 'normal', 'low'], w.priority), w.due_on nulls last, w.created_at desc
      limit 300`, [seeScopes(actor), actor.personId, day, q.kind ?? null, q.q || null, q.assetId ?? null]);
    // People who only raised requests see their own, without staff details.
    return rows.map(r => r.mine_raised && !actor.canAnywhere('operations.view') && !actor.canAnywhere('operations.manage')
      ? { ...r, assignee: r.assignee ? 'Assigned' : null } : r);
  }));

  app.get('/api/work/:id', async req => run.auth(req, async ({ tx, actor }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    const { w, staff } = a;
    const rows = await many(tx, `select u.id, u.at, u.kind, u.body, u.from_status, u.to_status, u.staff_only, u.file_id, u.person_id,
        p.full_name as by, f.content_type as file_type
      from app.work_updates u join app.people p on p.tenant_id = u.tenant_id and p.id = u.person_id
      left join app.files f on f.tenant_id = u.tenant_id and f.id = u.file_id
      where u.work_order_id = $1 and ($2 or not u.staff_only) order by u.at, u.id`, [w.id, staff]);
    // A resident sees "Association staff" rather than the names of the people working on it.
    const updates = rows.map(({ person_id, ...u }) => staff ? u : { ...u, by: person_id === actor.personId ? 'You' : 'Association staff' });
    const canPropose = staff && actor.can('approvals.propose', a.node);
    return {
      id: w.id, ref: w.ref, kind: w.kind, title: w.title, details: w.details, category: w.category, priority: w.priority, status: w.status,
      statusLabel: STATUS_WORDS[w.status], nodeId: w.node_id, place: w.place, unitId: w.unit_id, unit: w.unit,
      assetId: w.asset_id, asset: w.asset, routineId: w.routine_id, routineRef: w.routine_ref, occurrenceOn: w.occurrence_on,
      raisedBy: w.raised_by_name, assigneeId: staff ? w.assignee_person_id : null, assignee: staff ? w.assignee : (w.assignee ? 'Assigned to staff' : null),
      dueOn: w.due_on, createdAt: w.created_at, startedAt: w.started_at, completedAt: w.completed_at, closedAt: w.closed_at,
      estimatePaise: staff ? w.estimate_paise : null,
      approval: staff && w.approval_request_id ? { id: w.approval_request_id, ref: w.approval_ref, status: w.approval_status } : null,
      updates,
      actions: { moves: moves(a), edit: a.manager, note: true, staffNote: staff,
        requestApproval: canPropose && !(w.approval_request_id && w.approval_status === 'pending') && OPEN.includes(w.status) },
    };
  }));

  app.post('/api/work', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = z.object({
      kind: z.enum(KINDS), title: text(200), details: z.string().trim().max(8000).default(''),
      category: z.enum(CATEGORIES).default('general'), priority: z.enum(PRIORITIES).default('normal'),
      nodeId: uuid.optional(), unitId: uuid.nullable().optional(), assetId: uuid.nullable().optional(),
      assigneeId: uuid.nullable().optional(), dueOn: date.nullable().optional(), estimate: rupeesToPaise,
    }).parse(req.body);
    let nodeId = b.nodeId ?? null;
    let unit: any = null;
    if (b.unitId) {
      unit = await one(tx, `select id, label, node_id from app.units where id = $1 and archived_at is null`, [b.unitId]) ?? notFound('That home');
      nodeId = nodeId ?? unit.node_id;
    }
    if (b.assetId && !nodeId) nodeId = (await one(tx, `select node_id from app.assets where id = $1`, [b.assetId]))?.node_id ?? null;
    if (!nodeId) fail(400, 'Choose the place this is about.', 'invalid');
    const node = await nodeRef(tx, nodeId!);
    const staffHere = manages(actor, node) || actor.can('operations.update', node);
    let status = 'open';
    if (b.kind === 'request' && !staffHere) {
      // An owner or resident raising a request for their own home.
      const homes = await myHomes(tx, actor.personId);
      if (!unit || !homes.some(h => h.id === unit.id)) fail(403, 'You can raise requests for your own home.', 'forbidden');
      if (node.id !== unit.node_id) fail(400, 'Raise the request for your home.', 'invalid');
      status = 'new';
    } else if (b.kind === 'project' ? !manages(actor, node) : !staffHere) forbidden();
    const managerFields = manages(actor, node);
    if (managerFields) await personExists(tx, b.assigneeId);
    const ref = (await one(tx, `select app.next_ref('work', 'WO') as ref`))!.ref;
    const w = await one(tx, `insert into app.work_orders (ref, kind, title, details, category, priority, status, node_id, unit_id, asset_id,
        raised_by, assignee_person_id, due_on, estimate_paise)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [ref, b.kind, b.title, b.details, b.category, status === 'new' && !['normal', 'urgent'].includes(b.priority) ? 'normal' : b.priority,
        status, node.id, unit?.id ?? null, staffHere ? b.assetId ?? null : null, actor.personId,
        managerFields ? b.assigneeId ?? null : null, managerFields ? b.dueOn ?? null : null, managerFields ? b.estimate : null]);
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, to_status) values ($1, $2, 'created', $3, $4)`,
      [w!.id, actor.personId, b.kind === 'request' ? 'Request raised' : 'Work order raised', status]);
    await audit('work.created', 'work_order', w!.id, `${ref} raised: ${b.title}`, { kind: b.kind, nodeId: node.id });
    return { id: w!.id, ref };
  }));

  app.patch('/api/work/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    if (!a.manager) forbidden();
    const { w } = a;
    if (!OPEN.includes(w.status) && w.status !== 'done') fail(409, 'Reopen this work order before changing it.', 'closed');
    const b = z.object({ title: text(200).optional(), details: z.string().trim().max(8000).optional(), category: z.enum(CATEGORIES).optional(),
      priority: z.enum(PRIORITIES).optional(), assigneeId: uuid.nullable().optional(), dueOn: date.nullable().optional(),
      estimate: rupeesToPaise, assetId: uuid.nullable().optional() }).parse(req.body);
    const log = async (kind: string, body: string, staffOnly = false) => tx.query(
      `insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, $3, $4, $5)`, [w.id, actor.personId, kind, body, staffOnly]);
    if (b.assigneeId !== undefined && b.assigneeId !== w.assignee_person_id) {
      const p = await personExists(tx, b.assigneeId);
      await log('assigned', p ? `Given to ${p.full_name}` : 'No longer given to anyone', true);
      await log('assigned', p ? 'Assigned to staff' : 'Waiting to be assigned');
    }
    if (b.dueOn !== undefined && (b.dueOn ?? null) !== (w.due_on ?? null)) await log('due', b.dueOn ? `Due by ${b.dueOn}` : 'No due date');
    const changed = (['title', 'details', 'category', 'priority'] as const).filter(k => b[k] !== undefined && b[k] !== w[k]);
    if (changed.length) await log('details', `Changed the ${changed.join(', ')}`);
    if (req.body && (req.body as any).estimate !== undefined && b.estimate !== w.estimate_paise)
      await log('details', b.estimate ? `Estimate set to ₹${(Number(b.estimate) / 100).toLocaleString('en-IN')}` : 'Estimate removed', true);
    await tx.query(`update app.work_orders set title = coalesce($2, title), details = coalesce($3, details), category = coalesce($4, category),
        priority = coalesce($5, priority), assignee_person_id = case when $6 then $7 else assignee_person_id end,
        due_on = case when $8 then $9::date else due_on end, estimate_paise = case when $10 then $11::bigint else estimate_paise end,
        asset_id = case when $12 then $13 else asset_id end where id = $1`,
      [w.id, b.title ?? null, b.details ?? null, b.category ?? null, b.priority ?? null, b.assigneeId !== undefined, b.assigneeId ?? null,
        b.dueOn !== undefined, b.dueOn ?? null, (req.body as any)?.estimate !== undefined, b.estimate, b.assetId !== undefined, b.assetId ?? null]);
    await audit('work.updated', 'work_order', w.id, `${w.ref} changed`, { changed: Object.keys(b) });
    return { ok: true };
  }));

  app.post('/api/work/:id/status', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    const b = z.object({ to: z.enum(['open', 'in_progress', 'on_hold', 'done', 'closed', 'cancelled']), note: z.string().trim().max(4000).default('') }).parse(req.body);
    const move = moves(a).find(m => m.to === b.to) ?? fail(403, `This work order cannot be moved to "${STATUS_WORDS[b.to]}" by you now.`, 'forbidden');
    if (move!.needsNote && !b.note) fail(400, b.to === 'done' ? 'Say what was done.' : 'Give the reason.', 'invalid');
    const { w } = a;
    await tx.query(`update app.work_orders set status = $2,
        started_at = case when $2 = 'in_progress' then coalesce(started_at, now()) else started_at end,
        completed_at = case when $2 = 'done' then now() when $2 in ('open', 'in_progress') then null else completed_at end,
        closed_at = case when $2 in ('closed', 'cancelled') then now() when $2 in ('open', 'in_progress') then null else closed_at end
      where id = $1`, [w.id, b.to]);
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, from_status, to_status) values ($1, $2, 'status', $3, $4, $5)`,
      [w.id, actor.personId, b.note, w.status, b.to]);
    await audit('work.status', 'work_order', w.id, `${w.ref}: ${STATUS_WORDS[w.status]} → ${STATUS_WORDS[b.to]}`, { note: b.note });
    return { ok: true };
  }));

  app.post('/api/work/:id/updates', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    const b = z.object({ body: z.string().trim().max(4000).default(''), staffOnly: z.boolean().default(false), fileId: uuid.nullable().optional() }).parse(req.body);
    if (!b.body && !b.fileId) fail(400, 'Write a note or attach a photo.', 'invalid');
    if (b.staffOnly && !a.staff) forbidden();
    if (b.fileId) {
      const f = await one(tx, `select id from app.files where id = $1 and purpose = 'work_photo' and uploaded_by = $2`, [b.fileId, actor.personId]);
      if (!f) fail(400, 'Upload the photo again.', 'invalid');
    }
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only, file_id) values ($1, $2, $3, $4, $5, $6)`,
      [a.w.id, actor.personId, b.fileId ? 'photo' : 'note', b.body, b.staffOnly, b.fileId ?? null]);
    await audit('work.note', 'work_order', a.w.id, `${a.w.ref}: ${b.fileId ? 'photo' : 'note'} added${b.staffOnly ? ' (staff only)' : ''}`);
    return { ok: true };
  }));

  // Spending on a work order goes through the community's approval rules like any other.
  app.post('/api/work/:id/approval', async req => run.auth(req, async ({ tx, actor, audit, meta }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    if (!a.staff) forbidden();
    const { w } = a;
    if (!OPEN.includes(w.status)) fail(409, 'Only open work can be sent for approval.', 'closed');
    const b = z.object({ details: z.string().trim().max(4000).default('') }).parse(req.body ?? {});
    const res = await engine.propose(tx, actor, { subjectType: w.kind === 'project' ? 'project' : 'work_order', subjectId: w.id,
      title: `${w.ref}: ${w.title}`.slice(0, 200), details: b.details || w.details, amountPaise: w.estimate_paise, scopeNodeId: w.node_id });
    await tx.query(`update app.work_orders set approval_request_id = $2 where id = $1`, [w.id, res!.id]);
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'approval', $3, true)`,
      [w.id, actor.personId, `Sent for approval as ${res!.ref}`]);
    await audit('approval.proposed', 'approval_request', res!.id, `${res!.ref} raised for ${w.ref}`, { workOrderId: w.id });
    void meta;
    return { id: res!.id, ref: res!.ref };
  }));
}
