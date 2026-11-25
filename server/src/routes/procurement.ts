// Procurement: vendors, quotations on a work order, the comparison, choosing a vendor, and reviews.
import type { FastifyInstance } from 'fastify';
import type { Actor, NodeRef } from '../actor.ts';
import type { Runner, Services } from '../app.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import * as engine from '../services/approvals.ts';
import { localNow } from '../services/schedule.ts';
import { loadWork } from './work.ts';
import { date, idParam, optText, rupeesToPaise, text, uuid, z } from './z.ts';

const VENDOR_CATEGORIES = ['security', 'housekeeping', 'garden', 'electrical', 'plumbing', 'lifts', 'water', 'fire_safety', 'pool', 'waste',
  'general', 'civil', 'painting', 'pest_control', 'supplies', 'professional'] as const;

const canView = (a: Actor, node?: NodeRef) => node ? a.can('procurement.view', node) || a.can('procurement.manage', node)
  : a.canAnywhere('procurement.view') || a.canAnywhere('procurement.manage');
const canManage = (a: Actor, node?: NodeRef) => node ? a.can('procurement.manage', node) : a.canAnywhere('procurement.manage');
const rupee = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

async function today(tx: Tx) {
  return localNow((await one(tx, `select timezone from app.tenants`))!.timezone).day;
}

// Like-for-like checks, carried over from JAOA: the total with GST where it can be known, and the
// terms each quotation leaves out, so the committee asks before it compares amounts.
export function compare(quotes: any[], day: string) {
  const total = (q: any) => q.tax === 'included' ? Number(q.amount_paise)
    : q.tax === 'excluded' && q.gst_paise !== null ? Number(q.amount_paise) + Number(q.gst_paise) : null;
  const rows = quotes.map(q => {
    const t = total(q);
    const missing = [t === null && 'the amount with GST', !q.timeline && 'the delivery time', !q.warranty && 'the warranty',
      !q.valid_until ? 'how long the price holds' : q.valid_until < day ? 'a fresh validity (this quotation has lapsed)' : null,
      !q.payment_terms && 'the payment terms', !q.exclusions && 'what is not included'].filter(Boolean) as string[];
    return { ...q, total_paise: t, missing, lapsed: !!q.valid_until && q.valid_until < day };
  });
  const known = rows.filter(r => r.total_paise !== null).sort((a, b) => a.total_paise! - b.total_paise!);
  const lowest = known.length === rows.length && known.length > 1 ? known[0].id : null;
  for (const r of rows) r.lowest = r.id === lowest;
  const summary = !rows.length ? 'No quotations yet.'
    : rows.length === 1 ? 'Only one quotation is on record. Choosing it needs a reason why a second one could not be obtained.'
    : known.length === rows.length ? `Totals with GST range from ${rupee(known[0].total_paise!)} to ${rupee(known[known.length - 1].total_paise!)}. Check the scopes match before relying on the difference.`
    : 'At least one quotation does not show its amount with GST. Get the same GST basis from every vendor before comparing amounts.';
  return { rows, summary, checks: rows.filter(r => r.missing.length).map(r => `${r.vendor}: confirm ${r.missing.join(', ')}.`) };
}

export async function quotesFor(tx: Tx, workId: string) {
  return many(tx, `select q.*, v.name as vendor, v.status as vendor_status, p.full_name as entered_by_name
    from app.quotes q join app.vendors v on v.tenant_id = q.tenant_id and v.id = q.vendor_id
    join app.people p on p.tenant_id = q.tenant_id and p.id = q.entered_by
    where q.work_order_id = $1 order by q.created_at`, [workId]);
}
export async function selectionsFor(tx: Tx, workId: string) {
  return many(tx, `select s.id, s.reason, s.single_quote_reason, s.created_at, s.quote_id, q.ref as quote_ref, v.id as vendor_id, v.name as vendor,
      q.amount_paise, q.tax, q.gst_paise, r.id as approval_id, r.ref as approval_ref, r.status, p.full_name as chosen_by
    from app.vendor_selections s join app.quotes q on q.tenant_id = s.tenant_id and q.id = s.quote_id
    join app.vendors v on v.tenant_id = q.tenant_id and v.id = q.vendor_id
    join app.approval_requests r on r.tenant_id = s.tenant_id and r.id = s.approval_request_id
    join app.people p on p.tenant_id = s.tenant_id and p.id = s.chosen_by
    where s.work_order_id = $1 order by s.created_at desc`, [workId]);
}

export async function procurementRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  // ------------------------------------------------------------------ vendors
  app.get('/api/vendors', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canView(actor)) forbidden();
    const q = z.object({ q: z.string().trim().max(80).optional(), category: z.enum(VENDOR_CATEGORIES).optional() }).parse(req.query);
    return many(tx, `select v.id, v.ref, v.name, v.categories, v.city, v.status, v.contact_name, v.phone,
        (select round(avg((r.quality + r.timeliness + r.value) / 3.0), 1) from app.vendor_reviews r where r.vendor_id = v.id) as rating,
        (select count(*) from app.vendor_reviews r where r.vendor_id = v.id)::int as reviews,
        (select count(*) from app.quotes q where q.vendor_id = v.id)::int as quotes,
        (select count(*) from app.vendor_selections s join app.quotes q on q.tenant_id = s.tenant_id and q.id = s.quote_id
           join app.approval_requests a on a.tenant_id = s.tenant_id and a.id = s.approval_request_id
          where q.vendor_id = v.id and a.status = 'approved')::int as awards
      from app.vendors v
      where ($1::text is null or v.name ilike '%' || $1 || '%' or v.city ilike $1 || '%') and ($2::text is null or $2 = any (v.categories))
      order by v.status = 'blocked', v.name`, [q.q || null, q.category ?? null]);
  }));

  app.get('/api/vendors/:id', async req => run.auth(req, async ({ tx, actor }) => {
    if (!canView(actor)) forbidden();
    const v = await one(tx, `select * from app.vendors where id = $1`, [idParam.parse(req.params).id]) ?? notFound('That vendor');
    const reviews = await many(tx, `select r.*, p.full_name as by, w.ref as work_ref, w.title as work_title from app.vendor_reviews r
      join app.people p on p.tenant_id = r.tenant_id and p.id = r.reviewed_by
      left join app.work_orders w on w.tenant_id = r.tenant_id and w.id = r.work_order_id where r.vendor_id = $1 order by r.created_at desc`, [v.id]);
    const quotes = await many(tx, `select q.id, q.ref, q.amount_paise, q.tax, q.gst_paise, q.received_on, q.replaced_by, q.withdrawn_at,
        w.id as work_id, w.ref as work_ref, w.title as work_title,
        (select a.status from app.vendor_selections s join app.approval_requests a on a.tenant_id = s.tenant_id and a.id = s.approval_request_id
          where s.quote_id = q.id order by s.created_at desc limit 1) as chosen,
        exists (select 1 from app.vendor_selections s join app.approval_requests a on a.tenant_id = s.tenant_id and a.id = s.approval_request_id
          where s.work_order_id = q.work_order_id and s.quote_id <> q.id and a.status = 'approved') as other_awarded
      from app.quotes q join app.work_orders w on w.tenant_id = q.tenant_id and w.id = q.work_order_id
      where q.vendor_id = $1 order by q.received_on desc`, [v.id]);
    const contracts = await many(tx, `select c.id, c.ref, c.title, c.kind, c.ends_on, c.renewed_by from app.asset_contracts c
      where lower(c.provider) = lower($1) and c.archived_at is null order by c.ends_on desc limit 20`, [v.name]);
    const avg = (k: string) => reviews.length ? Math.round(reviews.reduce((s, r) => s + r[k], 0) / reviews.length * 10) / 10 : null;
    return { ...v, reviews, quotes, contracts, canManage: canManage(actor),
      scores: { quality: avg('quality'), timeliness: avg('timeliness'), value: avg('value'),
        rehire: reviews.length ? reviews.filter(r => r.would_rehire).length : null, count: reviews.length } };
  }));

  const vendorBody = z.object({ name: text(120), categories: z.array(z.enum(VENDOR_CATEGORIES)).max(16).default([]), contactName: optText(120),
    phone: optText(30), email: z.string().trim().email().max(160).nullable().optional().or(z.literal('').transform(() => null)),
    gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'is not a valid GSTIN').nullable().optional().or(z.literal('').transform(() => null)),
    city: optText(80), address: optText(400), website: optText(200), notes: z.string().trim().max(4000).default('') });

  app.post('/api/vendors', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canManage(actor)) forbidden();
    const b = vendorBody.parse(req.body);
    const ref = (await one(tx, `select app.next_ref('vendor', 'VN') as ref`))!.ref;
    const v = await one(tx, `insert into app.vendors (ref, name, categories, contact_name, phone, email, gstin, city, address, website, notes, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [ref, b.name, b.categories, b.contactName, b.phone, b.email ?? null, b.gstin ?? null, b.city, b.address, b.website, b.notes, actor.personId]);
    await audit('vendor.created', 'vendor', v!.id, `${ref} added: ${b.name}`);
    return { id: v!.id, ref };
  }));

  app.patch('/api/vendors/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canManage(actor)) forbidden();
    const { id } = idParam.parse(req.params);
    const v = await one(tx, `select * from app.vendors where id = $1`, [id]) ?? notFound('That vendor');
    const b = vendorBody.partial().extend({ status: z.enum(['active', 'on_hold', 'blocked']).optional(), statusNote: z.string().trim().max(500).optional() }).parse(req.body);
    if (b.status && b.status !== 'active' && !b.statusNote) fail(400, 'Say why this vendor is on hold or blocked.', 'invalid');
    const has = (k: string) => (req.body as any)?.[k] !== undefined;
    await tx.query(`update app.vendors set name = coalesce($2, name), categories = coalesce($3, categories),
        contact_name = case when $4 then $5 else contact_name end, phone = case when $6 then $7 else phone end,
        email = case when $8 then $9 else email end, gstin = case when $10 then $11 else gstin end, city = case when $12 then $13 else city end,
        address = case when $14 then $15 else address end, website = case when $16 then $17 else website end, notes = coalesce($18, notes),
        status = coalesce($19, status), status_note = case when $19::text is null then status_note when $19 = 'active' then '' else $20 end
      where id = $1`,
      [id, b.name ?? null, b.categories ?? null, has('contactName'), b.contactName ?? null, has('phone'), b.phone ?? null, has('email'), b.email ?? null,
        has('gstin'), b.gstin ?? null, has('city'), b.city ?? null, has('address'), b.address ?? null, has('website'), b.website ?? null, b.notes ?? null,
        b.status ?? null, b.statusNote ?? '']);
    await audit(b.status && b.status !== v.status ? `vendor.${b.status}` : 'vendor.updated', 'vendor', id,
      b.status && b.status !== v.status ? `${v.ref} ${b.status.replace('_', ' ')}${b.statusNote ? `: ${b.statusNote}` : ''}` : `${v.ref} updated`);
    return { ok: true };
  }));

  app.post('/api/vendors/:id/reviews', async req => run.auth(req, async ({ tx, actor, audit }) => {
    if (!canView(actor) && !actor.canAnywhere('operations.manage')) forbidden();
    const { id } = idParam.parse(req.params);
    const v = await one(tx, `select id, ref, name from app.vendors where id = $1`, [id]) ?? notFound('That vendor');
    const score = z.coerce.number().int().min(1).max(5);
    const b = z.object({ workOrderId: uuid.nullable().optional(), quality: score, timeliness: score, value: score, wouldRehire: z.boolean(),
      comment: z.string().trim().max(2000).default('') }).parse(req.body);
    if (b.workOrderId) {
      const awarded = await one(tx, `select 1 from app.vendor_selections s join app.quotes q on q.tenant_id = s.tenant_id and q.id = s.quote_id
          join app.approval_requests a on a.tenant_id = s.tenant_id and a.id = s.approval_request_id
          join app.work_orders w on w.tenant_id = s.tenant_id and w.id = s.work_order_id
        where s.work_order_id = $1 and q.vendor_id = $2 and a.status = 'approved' and w.status in ('done', 'closed')`, [b.workOrderId, id]);
      if (!awarded) fail(400, 'Review the vendor once the work given to them is done.', 'invalid');
    }
    if ((b.quality <= 2 || b.timeliness <= 2 || b.value <= 2 || !b.wouldRehire) && !b.comment)
      fail(400, 'Add a comment explaining the low score, so the committee can act on it.', 'invalid');
    await tx.query(`insert into app.vendor_reviews (vendor_id, work_order_id, quality, timeliness, value, would_rehire, comment, reviewed_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (tenant_id, vendor_id, work_order_id, reviewed_by) do update set quality = excluded.quality, timeliness = excluded.timeliness,
        value = excluded.value, would_rehire = excluded.would_rehire, comment = excluded.comment, created_at = now()`,
      [id, b.workOrderId ?? null, b.quality, b.timeliness, b.value, b.wouldRehire, b.comment, actor.personId]);
    await audit('vendor.reviewed', 'vendor', id, `${v.ref} ${v.name} reviewed: ${b.quality}/${b.timeliness}/${b.value}`);
    return { ok: true };
  }));

  // ------------------------------------------------------------------ quotations on a work order
  app.get('/api/work/:id/quotes', async req => run.auth(req, async ({ tx, actor }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    if (!canView(actor, a.node)) forbidden();
    const day = await today(tx);
    const all = await quotesFor(tx, a.w.id);
    const current = all.filter(q => !q.replaced_by && !q.withdrawn_at);
    const selections = await selectionsFor(tx, a.w.id);
    const award = selections.find(s => s.status === 'approved') ?? null;
    const pending = selections.find(s => s.status === 'pending') ?? null;
    return { ...compare(current, day), earlier: all.filter(q => q.replaced_by || q.withdrawn_at), selections, award, pending,
      actions: { add: canManage(actor, a.node) && !award && !['closed', 'cancelled'].includes(a.w.status),
        select: actor.can('approvals.propose', a.node) && !award && !pending && current.length > 0 && !['closed', 'cancelled'].includes(a.w.status),
        review: !!award && ['done', 'closed'].includes(a.w.status) } };
  }));

  app.post('/api/work/:id/quotes', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    if (!canManage(actor, a.node)) forbidden();
    if (['closed', 'cancelled'].includes(a.w.status)) fail(409, 'This work order is closed.', 'closed');
    const b = z.object({ vendorId: uuid.optional(), newVendor: z.object({ name: text(120), phone: optText(30) }).optional(),
      amount: rupeesToPaise, tax: z.enum(['included', 'excluded', 'unclear']), gst: rupeesToPaise,
      scope: z.string().trim().min(3).max(2000), exclusions: z.string().trim().max(1000).default(''), timeline: z.string().trim().max(200).default(''),
      warranty: z.string().trim().max(200).default(''), validUntil: date.nullable().optional(), paymentTerms: z.string().trim().max(500).default(''),
      reference: optText(80), receivedOn: date.optional(), fileId: uuid.nullable().optional(), replacesId: uuid.nullable().optional() })
      .refine(v => !!v.vendorId !== !!v.newVendor, 'choose a vendor or add a new one').parse(req.body);
    if (!b.amount || b.amount === '0') fail(400, 'Enter the quoted amount.', 'invalid');
    if (await one(tx, `select 1 from app.vendor_selections s join app.approval_requests r on r.tenant_id = s.tenant_id and r.id = s.approval_request_id
        where s.work_order_id = $1 and r.status = 'approved'`, [a.w.id])) fail(409, 'A vendor has already been chosen for this work.', 'closed');
    let vendorId = b.vendorId;
    if (b.newVendor) {
      const existing = await one(tx, `select id from app.vendors where lower(btrim(name)) = lower(btrim($1))`, [b.newVendor.name]);
      if (existing) vendorId = existing.id;
      else {
        const ref = (await one(tx, `select app.next_ref('vendor', 'VN') as ref`))!.ref;
        vendorId = (await one(tx, `insert into app.vendors (ref, name, phone, categories, created_by) values ($1, $2, $3, array[$4], $5) returning id`,
          [ref, b.newVendor.name, b.newVendor.phone, a.w.category, actor.personId]))!.id;
        await audit('vendor.created', 'vendor', vendorId!, `${ref} added: ${b.newVendor.name}`);
      }
    }
    const vendor = await one(tx, `select id, name, status, status_note from app.vendors where id = $1`, [vendorId]) ?? notFound('That vendor');
    if (vendor.status === 'blocked') fail(400, `${vendor.name} is blocked: ${vendor.status_note}`, 'invalid');
    if (b.fileId && !await one(tx, `select 1 from app.files where id = $1 and purpose = 'quotation'`, [b.fileId])) fail(400, 'Upload the quotation again.', 'invalid');
    let replaces: any = null;
    if (b.replacesId) {
      replaces = await one(tx, `select * from app.quotes where id = $1 and work_order_id = $2`, [b.replacesId, a.w.id]) ?? notFound('That quotation');
      if (replaces.replaced_by || replaces.withdrawn_at) fail(409, 'That quotation has already been replaced or withdrawn.', 'closed');
      if (replaces.vendor_id !== vendorId) fail(400, 'A revised quotation must come from the same vendor.', 'invalid');
    }
    const ref = (await one(tx, `select app.next_ref('quote', 'QT') as ref`))!.ref;
    const q = await one(tx, `insert into app.quotes (ref, work_order_id, vendor_id, received_on, amount_paise, tax, gst_paise, scope, exclusions, timeline, warranty,
        valid_until, payment_terms, reference, file_id, entered_by) values ($1, $2, $3, coalesce($4::date, current_date), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      returning id`, [ref, a.w.id, vendorId, b.receivedOn ?? null, b.amount, b.tax, b.tax === 'excluded' ? b.gst : null, b.scope, b.exclusions, b.timeline,
        b.warranty, b.validUntil ?? null, b.paymentTerms, b.reference, b.fileId ?? null, actor.personId]);
    if (replaces) await tx.query(`update app.quotes set replaced_by = $2 where id = $1`, [replaces.id, q!.id]);
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'note', $3, true)`,
      [a.w.id, actor.personId, `${replaces ? `Revised quotation ${ref} replaces ${replaces.ref}` : `Quotation ${ref}`} from ${vendor.name}: ${rupee(Number(b.amount))}${b.tax === 'included' ? ' with GST' : b.tax === 'excluded' ? ' plus GST' : ''}`]);
    await audit('quote.recorded', 'work_order', a.w.id, `${ref} from ${vendor.name} recorded on ${a.w.ref}`, { quoteId: q!.id, replaces: replaces?.ref ?? null });
    return { id: q!.id, ref, vendorId };
  }));

  app.post('/api/quotes/:id/withdraw', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const q = await one(tx, `select * from app.quotes where id = $1`, [id]) ?? notFound('That quotation');
    const a = await loadWork(tx, actor, q.work_order_id);
    if (!canManage(actor, a.node)) forbidden();
    if (q.replaced_by || q.withdrawn_at) fail(409, 'That quotation is no longer current.', 'closed');
    const b = z.object({ note: text(500) }).parse(req.body);
    if (await one(tx, `select 1 from app.vendor_selections s join app.approval_requests r on r.tenant_id = s.tenant_id and r.id = s.approval_request_id
        where s.quote_id = $1 and r.status in ('pending', 'approved')`, [id])) fail(409, 'This quotation has been chosen; it cannot be withdrawn now.', 'closed');
    await tx.query(`update app.quotes set withdrawn_at = now(), withdrawn_note = $2 where id = $1`, [id, b.note]);
    await audit('quote.withdrawn', 'work_order', q.work_order_id, `${q.ref} set aside: ${b.note}`);
    return { ok: true };
  }));

  // Choosing a vendor sends the choice through the approval rules, with every current quotation in view.
  app.post('/api/work/:id/select', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadWork(tx, actor, idParam.parse(req.params).id);
    if (!canView(actor, a.node)) forbidden();
    const b = z.object({ quoteId: uuid, reason: z.string().trim().min(3, 'Give the reason for this choice').max(1500),
      singleQuoteReason: z.string().trim().max(500).optional() }).parse(req.body);
    const day = await today(tx);
    const current = (await quotesFor(tx, a.w.id)).filter(q => !q.replaced_by && !q.withdrawn_at);
    const chosen = current.find(q => q.id === b.quoteId) ?? fail(400, 'Choose one of the current quotations.', 'invalid');
    if (current.length === 1 && !b.singleQuoteReason) fail(400, 'Explain why a second quotation could not be obtained.', 'invalid');
    if (chosen!.valid_until && chosen!.valid_until < day) fail(400, 'This quotation has lapsed. Ask the vendor to confirm or revise it first.', 'invalid');
    if (chosen!.vendor_status !== 'active') fail(400, `${chosen!.vendor} is ${chosen!.vendor_status.replace('_', ' ')}.`, 'invalid');
    const cmp = compare(current, day);
    const row = cmp.rows.find(r => r.id === chosen!.id)!;
    const amount = row.total_paise ?? Number(chosen!.amount_paise);
    const details = [`Recommended: ${chosen!.vendor}, ${chosen!.ref}, ${rupee(amount)}${row.total_paise === null ? ' (GST basis to confirm)' : ' with GST'}.`,
      `Reason: ${b.reason}`, b.singleQuoteReason ? `Only one quotation: ${b.singleQuoteReason}` : '', '',
      'Quotations compared:', ...cmp.rows.map(r => `- ${r.vendor} (${r.ref}): ${r.total_paise !== null ? rupee(r.total_paise) + ' with GST' : rupee(Number(r.amount_paise)) + ', GST unclear'}`
        + `${r.timeline ? `; ${r.timeline}` : ''}${r.warranty ? `; warranty ${r.warranty}` : ''}`), '', cmp.summary, ...cmp.checks].filter(s => s !== undefined).join('\n');
    const res = await engine.propose(tx, actor, { subjectType: 'vendor_selection', subjectId: a.w.id,
      title: `${a.w.ref}: award ${a.w.title} to ${chosen!.vendor}`.slice(0, 200), details, amountPaise: String(amount), scopeNodeId: a.w.node_id });
    await tx.query(`insert into app.vendor_selections (work_order_id, quote_id, reason, single_quote_reason, compared_quote_ids, approval_request_id, chosen_by)
      values ($1, $2, $3, $4, $5, $6, $7)`, [a.w.id, chosen!.id, b.reason, b.singleQuoteReason || null, current.map(q => q.id), res!.id, actor.personId]);
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, staff_only) values ($1, $2, 'approval', $3, true)`,
      [a.w.id, actor.personId, `${chosen!.vendor} recommended; sent for approval as ${res!.ref}`]);
    await audit('vendor.selected', 'work_order', a.w.id, `${chosen!.vendor} recommended for ${a.w.ref}; ${res!.ref} raised`, { quoteId: chosen!.id });
    return { approvalId: res!.id, ref: res!.ref };
  }));
}
