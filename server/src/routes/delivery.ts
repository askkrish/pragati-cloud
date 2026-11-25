// Project delivery, carried over from JAOA Pragati: after a vendor is chosen, the contract with its
// signed copy, milestones, change orders decided through the approval rules, and the handover that
// the receiving person accepts or returns. Requests for quotation come before the quotations.
//
// Who: those who manage procurement or operations for the place run delivery; those who may view
// procurement there see it; the person a handover is addressed to sees and answers it.
import type { FastifyInstance } from 'fastify';
import type { Actor, NodeRef } from '../actor.ts';
import type { Runner, Services } from '../app.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import * as engine from '../services/approvals.ts';
import { localNow } from '../services/schedule.ts';
import { compare, quotesFor, selectionsFor } from './procurement.ts';
import { loadWork } from './work.ts';
import { date, idParam, rupeesToPaise, text, uuid, z } from './z.ts';

const rupee = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const manages = (a: Actor, node: NodeRef) => a.can('procurement.manage', node) || a.can('operations.manage', node);
const views = (a: Actor, node: NodeRef) => manages(a, node) || a.can('procurement.view', node);
const CLOSED = ['closed', 'cancelled'];

async function today(tx: Tx) {
  return localNow((await one(tx, `select timezone from app.tenants`))!.timezone).day;
}

// Whether another person holds one of these permissions for the place (for choosing a handover recipient).
export async function personHolds(tx: Tx, personId: string, perms: string[], node: NodeRef) {
  return !!await one(tx, `select 1 from app.memberships m join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id
    join app.people p on p.tenant_id = m.tenant_id and p.id = m.person_id and p.archived_at is null
    where m.person_id = $1 and m.status = 'active' and r.archived_at is null and r.permissions && $2::text[]
      and (m.scope_node_id is null or m.scope_node_id = $3 or m.scope_node_id = any ($4::uuid[]))`, [personId, perms, node.id, node.ancestor_ids]);
}

async function contractFor(tx: Tx, workId: string) {
  const c = await one(tx, `select c.*, v.name as vendor, q.ref as quote_ref, p.full_name as created_by_name
    from app.contracts c join app.vendors v on v.tenant_id = c.tenant_id and v.id = c.vendor_id
    left join app.quotes q on q.tenant_id = c.tenant_id and q.id = c.quote_id
    join app.people p on p.tenant_id = c.tenant_id and p.id = c.created_by
    where c.work_order_id = $1`, [workId]);
  if (!c) return null;
  const changes = await many(tx, `select ch.*, r.ref as approval_ref, r.status, r.id as approval_id, p.full_name as proposed_by_name
    from app.contract_changes ch join app.approval_requests r on r.tenant_id = ch.tenant_id and r.id = ch.approval_request_id
    join app.people p on p.tenant_id = ch.tenant_id and p.id = ch.proposed_by
    where ch.contract_id = $1 order by ch.created_at desc`, [c.id]);
  const approved = changes.filter(x => x.status === 'approved');
  const committed = Number(c.amount_paise) + approved.reduce((s, x) => s + Number(x.delta_paise), 0);
  const days = approved.reduce((s, x) => s + x.days_delta, 0);
  const finishBy = c.finish_by && days ? new Date(Date.parse(c.finish_by + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10) : c.finish_by;
  return { ...c, changes, committed_paise: committed, finish_by_now: finishBy };
}

export async function deliveryRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  // Everything about delivering one piece of work, for those who may see it.
  app.get('/api/work/:id/delivery', async req => run.auth(req, async ({ tx, actor }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    const handovers = await many(tx, `select h.*, s.full_name as submitted_by_name, r.full_name as recipient,
        f.file_name, rf.file_name as response_file_name,
        (select coalesce(array_agg(x.name order by x.name), '{}') from app.assets x where x.id = any (h.asset_ids)) as assets
      from app.handovers h join app.people s on s.tenant_id = h.tenant_id and s.id = h.submitted_by
      join app.people r on r.tenant_id = h.tenant_id and r.id = h.recipient_id
      left join app.files f on f.tenant_id = h.tenant_id and f.id = h.file_id
      left join app.files rf on rf.tenant_id = h.tenant_id and rf.id = h.response_file_id
      where h.work_order_id = $1 order by h.created_at desc`, [a.w.id]);
    const full = views(actor, a.node);
    const mine = handovers.filter(h => h.recipient_id === actor.personId);
    if (!full && !mine.length) forbidden();
    const day = await today(tx);
    const mark = (h: any) => ({ ...h, canRespond: h.status === 'submitted' && h.recipient_id === actor.personId });
    if (!full) return { limited: true, handovers: mine.map(mark) };

    const selections = await selectionsFor(tx, a.w.id);
    const award = selections.find(s => s.status === 'approved') ?? null;
    let awardTotal: number | null = null;
    if (award) {
      const row = compare((await quotesFor(tx, a.w.id)).filter(q => q.id === award.quote_id), day).rows[0];
      awardTotal = row?.total_paise ?? Number(award.amount_paise);
    }
    const rfqs = await many(tx, `select r.*, p.full_name as created_by_name,
        (select coalesce(json_agg(json_build_object('id', v.id, 'name', v.name,
           'quoted', exists (select 1 from app.quotes q where q.work_order_id = r.work_order_id and q.vendor_id = v.id and q.created_at >= r.created_at))
           order by v.name), '[]') from app.vendors v where v.id = any (r.vendor_ids)) as vendors
      from app.rfqs r join app.people p on p.tenant_id = r.tenant_id and p.id = r.created_by
      where r.work_order_id = $1 order by r.created_at desc`, [a.w.id]);
    const contract = await contractFor(tx, a.w.id);
    const milestones = await many(tx, `select m.*, d.full_name as done_by_name from app.milestones m
      left join app.people d on d.tenant_id = m.tenant_id and d.id = m.done_by where m.work_order_id = $1 order by m.due_on, m.created_at`, [a.w.id]);
    const paid = await one(tx, `select coalesce(sum(amount_paise) filter (where status = 'paid'), 0)::bigint as paid,
        coalesce(sum(amount_paise) filter (where status = 'submitted'), 0)::bigint as pending from app.vouchers where work_order_id = $1`, [a.w.id]);
    const can = manages(actor, a.node) && !CLOSED.includes(a.w.status);
    const open = handovers.find(h => h.status === 'submitted');
    return {
      limited: false, today: day, award: award ? { ...award, total_paise: awardTotal } : null, rfqs, contract, milestones,
      handovers: handovers.map(mark), paid_paise: Number(paid!.paid), vouchers_pending_paise: Number(paid!.pending),
      actions: {
        rfq: can && !award && !contract, contract: can && !contract, sign: can && !!contract && !contract.signed_on,
        change: can && !!contract && actor.can('approvals.propose', a.node) && !contract.changes.some((x: any) => x.status === 'pending'),
        milestone: can, handover: can && !open && !(handovers[0]?.status === 'accepted'),
      },
    };
  }));

  // ------------------------------------------------------------------ requests for quotation
  app.post('/api/work/:id/rfqs', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    if (!manages(actor, a.node)) forbidden();
    if (CLOSED.includes(a.w.status)) fail(409, 'This work order is closed.', 'closed');
    const b = z.object({ scope: z.string().trim().min(10, 'Describe the work, quantities and what is excluded').max(4000), replyBy: date,
      vendorIds: z.array(uuid).max(12).default([]) }).parse(req.body);
    if (b.replyBy < await today(tx)) fail(400, 'Choose a reply-by date from today on.', 'invalid');
    if (b.vendorIds.length) {
      const ok = await many(tx, `select id from app.vendors where id = any ($1::uuid[]) and status <> 'blocked'`, [b.vendorIds]);
      if (ok.length !== new Set(b.vendorIds).size) fail(400, 'Choose vendors who are not blocked.', 'invalid');
    }
    const ref = (await one(tx, `select app.next_ref('rfq', 'RQ') as ref`))!.ref;
    const r = await one(tx, `insert into app.rfqs (ref, work_order_id, scope, reply_by, vendor_ids, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [ref, a.w.id, b.scope, b.replyBy, [...new Set(b.vendorIds)], actor.personId]);
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'note', $3, true)`,
      [a.w.id, actor.personId, `Request for quotation ${ref} sent to ${b.vendorIds.length || 'no'} vendor${b.vendorIds.length === 1 ? '' : 's'}, replies by ${b.replyBy}`]);
    await audit('rfq.created', 'work_order', a.w.id, `${ref} for ${a.w.ref}`, { vendors: b.vendorIds.length });
    return { id: r!.id, ref };
  }));

  // ------------------------------------------------------------------ contract
  app.post('/api/work/:id/contract', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    if (!manages(actor, a.node)) forbidden();
    if (CLOSED.includes(a.w.status)) fail(409, 'This work order is closed.', 'closed');
    if (await one(tx, `select 1 from app.contracts where work_order_id = $1`, [a.w.id]))
      fail(409, 'This work already has a contract. Record later changes as change orders.', 'duplicate');
    const b = z.object({ amount: rupeesToPaise.optional(), startsOn: date.nullable().optional(), finishBy: date.nullable().optional(),
      terms: z.string().trim().max(6000).default(''),
      // Only for an agreement made before the platform was used:
      earlierNote: z.string().trim().max(500).optional(), vendorId: uuid.optional() }).parse(req.body);
    if (b.startsOn && b.finishBy && b.finishBy < b.startsOn) fail(400, 'The finish date must come after the start.', 'invalid');
    const award = (await selectionsFor(tx, a.w.id)).find(s => s.status === 'approved');
    let vendorId: string, quoteId: string | null = null, selectionId: string | null = null, amount: number;
    if (award) {
      vendorId = award.vendor_id; quoteId = award.quote_id; selectionId = award.id;
      const row = compare((await quotesFor(tx, a.w.id)).filter(q => q.id === award.quote_id), await today(tx)).rows[0];
      amount = row?.total_paise ?? Number(award.amount_paise);
      // A contract may be for less than the approved quotation after negotiation, never for more.
      if (b.amount && b.amount !== '0') {
        if (Number(b.amount) > amount) fail(400, `The contract cannot exceed the approved ${rupee(amount)}. Propose a change order after signing for anything more.`, 'invalid');
        amount = Number(b.amount);
      }
    } else {
      if (!b.earlierNote || b.earlierNote.length < 3 || !b.vendorId)
        fail(409, 'Choose a vendor through the approval rules first. Only an agreement made before using the platform can be recorded without one, with a note.', 'no_award');
      if (!b.amount || b.amount === '0') fail(400, 'Enter the contract amount.', 'invalid');
      vendorId = b.vendorId!; amount = Number(b.amount);
      if (!await one(tx, `select 1 from app.vendors where id = $1`, [vendorId])) notFound('That vendor');
    }
    const ref = (await one(tx, `select app.next_ref('contract', 'CT') as ref`))!.ref;
    const c = await one(tx, `insert into app.contracts (ref, work_order_id, vendor_id, quote_id, selection_id, earlier_note, amount_paise, starts_on, finish_by, terms, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [ref, a.w.id, vendorId, quoteId, selectionId, award ? null : b.earlierNote, amount, b.startsOn ?? null, b.finishBy ?? null, b.terms, actor.personId]);
    if (a.w.estimate_paise === null) await tx.query(`update app.work_orders set estimate_paise = $2 where id = $1`, [a.w.id, amount]);
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'note', $3, true)`,
      [a.w.id, actor.personId, `Contract ${ref} recorded for ${rupee(amount)}; to be signed`]);
    await audit('contract.created', 'work_order', a.w.id, `${ref} for ${a.w.ref}: ${rupee(amount)}`, { vendorId, earlier: !award });
    return { id: c!.id, ref };
  }));

  app.post('/api/contracts/:id/sign', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const c = await one(tx, `select * from app.contracts where id = $1`, [idParam.parse(req.params).id]) ?? notFound('That contract');
    const a = await loadWork(tx, actor, c.work_order_id);
    if (!manages(actor, a.node)) forbidden();
    if (c.signed_on) fail(409, 'This contract is already signed.', 'closed');
    const b = z.object({ signedOn: date, reference: text(120), fileId: uuid }).parse(req.body);
    if (b.signedOn > await today(tx)) fail(400, 'The signing date cannot be in the future.', 'invalid');
    if (!await one(tx, `select 1 from app.files where id = $1 and purpose = 'contract'`, [b.fileId])) fail(400, 'Upload the signed copy again.', 'invalid');
    await tx.query(`update app.contracts set signed_on = $2, signed_reference = $3, signed_file_id = $4 where id = $1`, [c.id, b.signedOn, b.reference, b.fileId]);
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'note', $3, true)`,
      [c.work_order_id, actor.personId, `Contract ${c.ref} signed on ${b.signedOn} (${b.reference})`]);
    await audit('contract.signed', 'work_order', c.work_order_id, `${c.ref} signed`, { reference: b.reference });
    return { ok: true };
  }));

  // A change to the scope, price or time goes through the approval rules as a work order change.
  app.post('/api/contracts/:id/changes', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const c = await contractFor(tx, (await one(tx, `select work_order_id from app.contracts where id = $1`, [idParam.parse(req.params).id]) ?? notFound('That contract')).work_order_id);
    const a = await loadWork(tx, actor, c!.work_order_id);
    if (!manages(actor, a.node)) forbidden();
    if (CLOSED.includes(a.w.status)) fail(409, 'This work order is closed.', 'closed');
    if (!c!.signed_on) fail(409, 'Record the signed contract before changing it.', 'unsigned');
    if (c!.changes.some((x: any) => x.status === 'pending')) fail(409, 'A change is already waiting for approval.', 'duplicate');
    const b = z.object({ scope: z.string().trim().min(5).max(3000), reason: z.string().trim().min(3).max(1500),
      delta: z.union([z.string(), z.number()]).transform(v => Math.round(Number(String(v).replace(/[₹,\s]/g, '')) * 100))
        .refine(v => Number.isFinite(v) && Math.abs(v) <= 1e13, 'enter the change in rupees, negative for a reduction'),
      daysDelta: z.coerce.number().int().min(-365).max(365).default(0) }).parse(req.body);
    if (!b.delta && !b.daysDelta && b.scope.length < 5) fail(400, 'Describe the change.', 'invalid');
    const after = c!.committed_paise + b.delta;
    if (after <= 0) fail(400, 'The contract value cannot fall to zero or below.', 'invalid');
    const id = (await one(tx, `select gen_random_uuid() as id`))!.id;
    const ref = (await one(tx, `select app.next_ref('change', 'CO') as ref`))!.ref;
    const details = [`Contract ${c!.ref} with ${c!.vendor}: ${rupee(c!.committed_paise)} now; ${b.delta >= 0 ? 'adds' : 'reduces by'} ${rupee(Math.abs(b.delta))}, making ${rupee(after)}.`,
      b.daysDelta ? `Time: ${b.daysDelta > 0 ? 'adds' : 'saves'} ${Math.abs(b.daysDelta)} days.` : '', `Change: ${b.scope}`, `Reason: ${b.reason}`].filter(Boolean).join('\n');
    const res = await engine.propose(tx, actor, { subjectType: 'work_order_change', subjectId: id,
      title: `${a.w.ref}: change ${ref} to ${c!.ref} (${b.delta >= 0 ? '+' : '−'}${rupee(Math.abs(b.delta))})`.slice(0, 200), details,
      amountPaise: String(Math.abs(b.delta)), scopeNodeId: a.w.node_id });
    await tx.query(`insert into app.contract_changes (id, ref, contract_id, scope, reason, delta_paise, days_delta, approval_request_id, proposed_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, ref, c!.id, b.scope, b.reason, b.delta, b.daysDelta, res!.id, actor.personId]);
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'approval', $3, true)`,
      [a.w.id, actor.personId, `Change order ${ref} proposed; sent for approval as ${res!.ref}`]);
    await audit('contract.change_proposed', 'work_order', a.w.id, `${ref} on ${c!.ref}: ${rupee(b.delta)}`, { approval: res!.ref });
    return { id, ref, approvalId: res!.id, approvalRef: res!.ref };
  }));

  // ------------------------------------------------------------------ milestones
  app.post('/api/work/:id/milestones', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    if (!manages(actor, a.node)) forbidden();
    if (CLOSED.includes(a.w.status)) fail(409, 'This work order is closed.', 'closed');
    const b = z.object({ title: text(200), dueOn: date, amount: rupeesToPaise.optional() }).parse(req.body);
    const m = await one(tx, `insert into app.milestones (work_order_id, title, due_on, amount_paise, created_by) values ($1, $2, $3, $4, $5) returning id`,
      [a.w.id, b.title, b.dueOn, b.amount && b.amount !== '0' ? b.amount : null, actor.personId]);
    await audit('milestone.added', 'work_order', a.w.id, `${a.w.ref}: milestone "${b.title}" by ${b.dueOn}`);
    return { id: m!.id };
  }));

  app.patch('/api/milestones/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const m = await one(tx, `select * from app.milestones where id = $1`, [idParam.parse(req.params).id]) ?? notFound('That milestone');
    const a = await loadWork(tx, actor, m.work_order_id);
    const b = z.object({ done: z.boolean().optional(), note: z.string().trim().max(1000).default(''), dueOn: date.optional(), title: text(200).optional() }).parse(req.body);
    if (b.dueOn || b.title) {
      if (!manages(actor, a.node)) forbidden();
      if (m.done_on) fail(409, 'This milestone is done.', 'closed');
      await tx.query(`update app.milestones set due_on = coalesce($2, due_on), title = coalesce($3, title) where id = $1`, [m.id, b.dueOn ?? null, b.title ?? null]);
      if (b.dueOn && b.dueOn !== m.due_on) await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'note', $3, true)`,
        [m.work_order_id, actor.personId, `Milestone "${m.title}" moved from ${m.due_on} to ${b.dueOn}${b.note ? `: ${b.note}` : ''}`]);
    }
    if (b.done !== undefined) {
      if (!manages(actor, a.node) && !a.worker) forbidden();
      if (b.done && m.done_on) fail(409, 'Already marked done.', 'closed');
      if (b.done && !b.note) fail(400, 'Say what was completed.', 'invalid');
      if (!b.done && !manages(actor, a.node)) forbidden();
      await tx.query(b.done ? `update app.milestones set done_on = $2, done_note = $3, done_by = $4 where id = $1`
        : `update app.milestones set done_on = null, done_note = null, done_by = null where id = $1`,
        b.done ? [m.id, await today(tx), b.note, actor.personId] : [m.id]);
      await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'note', $3, true)`,
        [m.work_order_id, actor.personId, b.done ? `Milestone done: ${m.title}. ${b.note}` : `Milestone reopened: ${m.title}`]);
    }
    await audit('milestone.updated', 'work_order', m.work_order_id, `${a.w.ref}: milestone "${m.title}" updated`, b);
    return { ok: true };
  }));

  // ------------------------------------------------------------------ handover
  app.post('/api/work/:id/handover', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    if (!manages(actor, a.node)) forbidden();
    if (CLOSED.includes(a.w.status)) fail(409, 'This work order is closed.', 'closed');
    const b = z.object({ tests: z.string().trim().min(3, 'Describe the tests done and their results').max(3000),
      defects: z.string().trim().min(2, 'List open defects, or write "None"').max(2000), warranty: z.string().trim().max(1000).default(''),
      assetIds: z.array(uuid).max(20).default([]), fileId: uuid.nullable().optional(), recipientId: uuid }).parse(req.body);
    if (b.recipientId === actor.personId) fail(400, 'Hand over to someone else, who checks the work and accepts it.', 'invalid');
    if (!await personHolds(tx, b.recipientId, ['operations.manage', 'operations.view'], a.node) && b.recipientId !== a.w.assignee_person_id)
      fail(400, 'Hand over to someone who looks after operations at this place.', 'invalid');
    if (await one(tx, `select 1 from app.handovers where work_order_id = $1 and status = 'submitted'`, [a.w.id])) fail(409, 'A handover is already waiting for an answer.', 'duplicate');
    if (await one(tx, `select 1 from app.handovers where work_order_id = $1 and status = 'accepted'`, [a.w.id])) fail(409, 'The handover has been accepted.', 'closed');
    if (b.assetIds.length && (await many(tx, `select id from app.assets where id = any ($1::uuid[])`, [b.assetIds])).length !== new Set(b.assetIds).size)
      fail(400, 'Choose assets from the register.', 'invalid');
    if (b.fileId && !await one(tx, `select 1 from app.files where id = $1 and purpose = 'evidence'`, [b.fileId])) fail(400, 'Upload the document again.', 'invalid');
    const open = await many(tx, `select title from app.milestones where work_order_id = $1 and done_on is null`, [a.w.id]);
    const ref = (await one(tx, `select app.next_ref('handover', 'HO') as ref`))!.ref;
    const h = await one(tx, `insert into app.handovers (ref, work_order_id, tests, defects, warranty, asset_ids, file_id, recipient_id, submitted_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [ref, a.w.id, b.tests, b.defects, b.warranty, [...new Set(b.assetIds)], b.fileId ?? null, b.recipientId, actor.personId]);
    const to = (await one(tx, `select full_name from app.people where id = $1`, [b.recipientId]))!.full_name;
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'note', $3, true)`,
      [a.w.id, actor.personId, `Handover ${ref} submitted to ${to}${open.length ? `; ${open.length} milestone${open.length === 1 ? '' : 's'} still open` : ''}`]);
    await audit('handover.submitted', 'work_order', a.w.id, `${ref} for ${a.w.ref} to ${to}`);
    return { id: h!.id, ref, openMilestones: open.map(m => m.title) };
  }));

  app.post('/api/handovers/:id/respond', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const h = await one(tx, `select h.*, w.ref as work_ref, w.status as work_status from app.handovers h
      join app.work_orders w on w.tenant_id = h.tenant_id and w.id = h.work_order_id where h.id = $1`, [idParam.parse(req.params).id]) ?? notFound('That handover');
    if (h.recipient_id !== actor.personId) notFound('That handover');
    if (h.status !== 'submitted') fail(409, 'This handover has already been answered.', 'closed');
    const b = z.object({ decision: z.enum(['accepted', 'returned']), note: z.string().trim().min(3, 'Say what you checked, or what must be fixed').max(2000),
      fileId: uuid.nullable().optional() }).parse(req.body);
    if (b.fileId && !await one(tx, `select 1 from app.files where id = $1 and purpose = 'evidence'`, [b.fileId])) fail(400, 'Upload the document again.', 'invalid');
    await tx.query(`update app.handovers set status = $2, response_note = $3, response_file_id = $4, responded_at = now() where id = $1`,
      [h.id, b.decision, b.note, b.fileId ?? null]);
    // Accepting completes the work; returning sends it back for the defects to be fixed.
    if (b.decision === 'accepted' && ['open', 'in_progress', 'on_hold'].includes(h.work_status)) {
      await tx.query(`update app.work_orders set status = 'done', completed_at = now() where id = $1`, [h.work_order_id]);
      await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, from_status, to_status) values ($1, $2, 'status', $3, $4, 'done')`,
        [h.work_order_id, actor.personId, `Handover ${h.ref} accepted: ${b.note}`, h.work_status]);
    } else if (b.decision === 'returned' && ['open', 'on_hold', 'done'].includes(h.work_status)) {
      await tx.query(`update app.work_orders set status = 'in_progress', completed_at = null where id = $1`, [h.work_order_id]);
      await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, from_status, to_status) values ($1, $2, 'status', $3, $4, 'in_progress')`,
        [h.work_order_id, actor.personId, `Handover ${h.ref} returned: ${b.note}`, h.work_status]);
    } else {
      await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'note', $3, true)`,
        [h.work_order_id, actor.personId, `Handover ${h.ref} ${b.decision}: ${b.note}`]);
    }
    await audit(`handover.${b.decision}`, 'work_order', h.work_order_id, `${h.ref} ${b.decision} for ${h.work_ref}`, { note: b.note });
    return { ok: true };
  }));

  // People who may receive a handover here: those who look after operations at the place, and the assignee.
  app.get('/api/work/:id/handover-people', async req => run.auth(req, async ({ tx, actor }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    if (!manages(actor, a.node)) forbidden();
    return many(tx, `select distinct p.id, p.full_name from app.people p
      left join app.memberships m on m.tenant_id = p.tenant_id and m.person_id = p.id and m.status = 'active'
      left join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id and r.archived_at is null
      where p.archived_at is null and p.id <> $1 and (p.id = $2 or (r.permissions && array['operations.view', 'operations.manage']
        and (m.scope_node_id is null or m.scope_node_id = $3 or m.scope_node_id = any ($4::uuid[]))))
      order by p.full_name`, [actor.personId, a.w.assignee_person_id, a.node.id, a.node.ancestor_ids]);
  }));

  // Handovers waiting for this person, for the home screen.
  app.get('/api/handovers/mine', async req => run.auth(req, async ({ tx, actor }) =>
    many(tx, `select h.id, h.ref, h.created_at, w.id as work_id, w.ref as work_ref, w.title, s.full_name as submitted_by
      from app.handovers h join app.work_orders w on w.tenant_id = h.tenant_id and w.id = h.work_order_id
      join app.people s on s.tenant_id = h.tenant_id and s.id = h.submitted_by
      where h.recipient_id = $1 and h.status = 'submitted' order by h.created_at`, [actor.personId])));
}
