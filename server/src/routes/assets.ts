// The asset register and renewals: AMCs, warranties, insurance, licences and inspections.
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../actor.ts';
import type { Runner, Services } from '../app.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import { IN_SCOPE, manages, nodeRef, PLACE, sees, seeScopes } from '../services/operations.ts';
import { localNow } from '../services/schedule.ts';
import { date, idParam, optText, rupeesToPaise, text, uuid, z } from './z.ts';

const ASSET_KINDS = ['lift', 'generator', 'pump', 'transformer', 'electrical', 'water_treatment', 'sewage_treatment', 'fire_safety', 'cctv',
  'access_control', 'pool', 'hvac', 'solar', 'gym', 'garden', 'vehicle', 'other'] as const;
const CONTRACT_KINDS = ['amc', 'warranty', 'insurance', 'licence', 'inspection', 'other'] as const;

async function today(tx: Tx) {
  return localNow((await one(tx, `select timezone from app.tenants`))!.timezone).day;
}

const CONTRACT_SQL = `select c.*, ${PLACE()} as place, n.ancestor_ids, a.name as asset, a.ref as asset_ref,
    (c.ends_on - $1::date) as days_left,
    case when c.renewed_by is not null then 'renewed' when c.ends_on < $1::date then 'overdue'
         when c.ends_on <= $1::date + c.remind_days then 'due' else 'active' end as state
  from app.asset_contracts c join app.property_nodes n on n.tenant_id = c.tenant_id and n.id = c.node_id
  left join app.assets a on a.tenant_id = c.tenant_id and a.id = c.asset_id`;

async function loadAsset(tx: Tx, actor: Actor, id: string) {
  const a = await one(tx, `select a.*, n.ancestor_ids, ${PLACE()} as place, f.name as facility from app.assets a
    join app.property_nodes n on n.tenant_id = a.tenant_id and n.id = a.node_id
    left join app.facilities f on f.tenant_id = a.tenant_id and f.id = a.facility_id where a.id = $1`, [id]) ?? notFound('That asset');
  if (!sees(actor, { id: a.node_id, ancestor_ids: a.ancestor_ids })) notFound('That asset');
  return a;
}

export async function assetRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  app.get('/api/assets', async req => run.auth(req, async ({ tx, actor }) => {
    const scopes = seeScopes(actor);
    if (scopes !== null && !scopes.length) forbidden();
    const day = await today(tx);
    return many(tx, `select a.id, a.ref, a.name, a.kind, a.service_by, ${PLACE()} as place, f.name as facility,
        (select min(c.ends_on) from app.asset_contracts c where c.asset_id = a.id and c.renewed_by is null and c.archived_at is null) as next_renewal,
        (select count(*) from app.work_orders w where w.asset_id = a.id and w.status in ('new', 'open', 'in_progress', 'on_hold'))::int as open_work,
        (select count(*) from app.routines r where r.asset_id = a.id and r.archived_at is null)::int as routines,
        exists (select 1 from app.asset_contracts c where c.asset_id = a.id and c.renewed_by is null and c.archived_at is null and c.ends_on < $2::date) as overdue
      from app.assets a join app.property_nodes n on n.tenant_id = a.tenant_id and n.id = a.node_id
      left join app.facilities f on f.tenant_id = a.tenant_id and f.id = a.facility_id
      where a.archived_at is null and ${IN_SCOPE(1)} order by n.depth, ${PLACE()}, a.name`, [scopes, day]);
  }));

  app.get('/api/assets/:id', async req => run.auth(req, async ({ tx, actor }) => {
    const a = await loadAsset(tx, actor, idParam.parse(req.params).id);
    const day = await today(tx);
    const contracts = await many(tx, `${CONTRACT_SQL} where c.asset_id = $2 and c.archived_at is null order by c.ends_on desc`, [day, a.id]);
    const routines = await many(tx, `select id, ref, title from app.routines where asset_id = $1 and archived_at is null order by title`, [a.id]);
    const work = await many(tx, `select id, ref, kind, title, status, created_at, completed_at from app.work_orders where asset_id = $1
      order by created_at desc limit 30`, [a.id]);
    return { ...a, contracts, routines, work, canManage: manages(actor, { id: a.node_id, ancestor_ids: a.ancestor_ids }) };
  }));

  const assetBody = z.object({ name: text(120), kind: z.enum(ASSET_KINDS), nodeId: uuid, facilityId: uuid.nullable().optional(),
    make: optText(80), model: optText(80), serialNo: optText(80), installedOn: date.nullable().optional(), serviceBy: optText(120),
    notes: z.string().trim().max(4000).default('') });

  app.post('/api/assets', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = assetBody.parse(req.body);
    const node = await nodeRef(tx, b.nodeId);
    if (!manages(actor, node)) forbidden();
    const ref = (await one(tx, `select app.next_ref('asset', 'AS') as ref`))!.ref;
    const a = await one(tx, `insert into app.assets (ref, node_id, facility_id, name, kind, make, model, serial_no, installed_on, service_by, notes)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [ref, node.id, b.facilityId ?? null, b.name, b.kind, b.make, b.model, b.serialNo, b.installedOn ?? null, b.serviceBy, b.notes]);
    await audit('asset.created', 'asset', a!.id, `${ref} added to the register: ${b.name}`);
    return { id: a!.id, ref };
  }));

  app.patch('/api/assets/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadAsset(tx, actor, idParam.parse(req.params).id);
    if (!manages(actor, { id: a.node_id, ancestor_ids: a.ancestor_ids })) forbidden();
    const b = assetBody.partial().parse(req.body);
    if (b.nodeId && b.nodeId !== a.node_id && !manages(actor, await nodeRef(tx, b.nodeId))) forbidden();
    const has = (k: string) => (req.body as any)?.[k] !== undefined;
    await tx.query(`update app.assets set name = coalesce($2, name), kind = coalesce($3, kind), node_id = coalesce($4, node_id),
        facility_id = case when $5 then $6 else facility_id end, make = case when $7 then $8 else make end,
        model = case when $9 then $10 else model end, serial_no = case when $11 then $12 else serial_no end,
        installed_on = case when $13 then $14::date else installed_on end, service_by = case when $15 then $16 else service_by end,
        notes = coalesce($17, notes) where id = $1`,
      [a.id, b.name ?? null, b.kind ?? null, b.nodeId ?? null, has('facilityId'), b.facilityId ?? null, has('make'), b.make ?? null,
        has('model'), b.model ?? null, has('serialNo'), b.serialNo ?? null, has('installedOn'), b.installedOn ?? null,
        has('serviceBy'), b.serviceBy ?? null, b.notes ?? null]);
    await audit('asset.updated', 'asset', a.id, `${a.ref} updated`, { changed: Object.keys(b) });
    return { ok: true };
  }));

  app.post('/api/assets/:id/archive', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const a = await loadAsset(tx, actor, idParam.parse(req.params).id);
    if (!manages(actor, { id: a.node_id, ancestor_ids: a.ancestor_ids })) forbidden();
    await tx.query(`update app.assets set archived_at = now() where id = $1`, [a.id]);
    await audit('asset.archived', 'asset', a.id, `${a.ref} taken off the register`);
    return { ok: true };
  }));

  // Renewals due within the next days, and any overdue ones.
  app.get('/api/renewals', async req => run.auth(req, async ({ tx, actor }) => {
    const q = z.object({ within: z.coerce.number().int().min(0).max(3650).default(90) }).parse(req.query);
    const scopes = seeScopes(actor);
    if (scopes !== null && !scopes.length) forbidden();
    const day = await today(tx);
    return many(tx, `${CONTRACT_SQL} where c.renewed_by is null and c.archived_at is null and ${IN_SCOPE(2)} and c.ends_on <= $1::date + $3::int
      order by c.ends_on`, [day, scopes, q.within]);
  }));

  const contractBody = z.object({ assetId: uuid.nullable().optional(), nodeId: uuid.optional(), kind: z.enum(CONTRACT_KINDS), title: text(160),
    provider: optText(120), reference: optText(80), startsOn: date.nullable().optional(), endsOn: date,
    remindDays: z.coerce.number().int().min(0).max(365).default(30), amount: rupeesToPaise, fileId: uuid.nullable().optional(),
    notes: z.string().trim().max(2000).default('') });

  async function checkFile(tx: Tx, fileId: string | null | undefined) {
    if (!fileId) return null;
    const f = await one(tx, `select id from app.files where id = $1 and purpose = 'contract'`, [fileId]);
    return f ? fileId : fail(400, 'Upload the document again.', 'invalid');
  }

  app.post('/api/renewals', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = contractBody.parse(req.body);
    let nodeId = b.nodeId ?? null;
    if (b.assetId) nodeId = (await loadAsset(tx, actor, b.assetId)).node_id;
    if (!nodeId) fail(400, 'Choose the asset or place this is for.', 'invalid');
    const node = await nodeRef(tx, nodeId!);
    if (!manages(actor, node)) forbidden();
    if (b.startsOn && b.endsOn < b.startsOn) fail(400, 'The end date must be on or after the start date.', 'invalid');
    const ref = (await one(tx, `select app.next_ref('renewal', 'RN') as ref`))!.ref;
    const c = await one(tx, `insert into app.asset_contracts (ref, asset_id, node_id, kind, title, provider, reference, starts_on, ends_on, remind_days,
        amount_paise, file_id, notes, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [ref, b.assetId ?? null, node.id, b.kind, b.title, b.provider, b.reference, b.startsOn ?? null, b.endsOn, b.remindDays, b.amount,
        await checkFile(tx, b.fileId), b.notes, actor.personId]);
    await audit('renewal.created', 'asset_contract', c!.id, `${ref} recorded: ${b.title}, ends ${b.endsOn}`);
    return { id: c!.id, ref };
  }));

  // Renewing keeps the old record and links it to the new one.
  app.post('/api/renewals/:id/renew', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const day = await today(tx);
    const old = await one(tx, `${CONTRACT_SQL} where c.id = $2`, [day, id]) ?? notFound('That renewal');
    if (!manages(actor, { id: old.node_id, ancestor_ids: old.ancestor_ids })) forbidden();
    if (old.renewed_by) fail(409, 'This has already been renewed.', 'closed');
    const b = z.object({ startsOn: date.nullable().optional(), endsOn: date, provider: optText(120), reference: optText(80),
      amount: rupeesToPaise, fileId: uuid.nullable().optional(), notes: z.string().trim().max(2000).default('') }).parse(req.body);
    if (b.endsOn <= old.ends_on) fail(400, 'The new end date must be after the current one.', 'invalid');
    const ref = (await one(tx, `select app.next_ref('renewal', 'RN') as ref`))!.ref;
    const c = await one(tx, `insert into app.asset_contracts (ref, asset_id, node_id, kind, title, provider, reference, starts_on, ends_on, remind_days,
        amount_paise, file_id, notes, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [ref, old.asset_id, old.node_id, old.kind, old.title, b.provider ?? old.provider, b.reference ?? old.reference,
        b.startsOn ?? old.ends_on, b.endsOn, old.remind_days, b.amount, await checkFile(tx, b.fileId), b.notes, actor.personId]);
    await tx.query(`update app.asset_contracts set renewed_by = $2 where id = $1`, [id, c!.id]);
    await audit('renewal.renewed', 'asset_contract', c!.id, `${old.ref} renewed as ${ref} until ${b.endsOn}`);
    return { id: c!.id, ref };
  }));

  app.post('/api/renewals/:id/archive', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const c = await one(tx, `${CONTRACT_SQL} where c.id = $2`, [await today(tx), id]) ?? notFound('That renewal');
    if (!manages(actor, { id: c.node_id, ancestor_ids: c.ancestor_ids })) forbidden();
    const b = z.object({ reason: text(300) }).parse(req.body);
    await tx.query(`update app.asset_contracts set archived_at = now() where id = $1`, [id]);
    await audit('renewal.archived', 'asset_contract', id, `${c.ref} no longer needed: ${b.reason}`);
    return { ok: true };
  }));
}
