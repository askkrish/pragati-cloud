import type { FastifyInstance } from 'fastify';
import type { Ctx, Runner, Services } from '../app.ts';
import { getNode, type NodeRef } from '../actor.ts';
import { normalisePhone } from '../auth/crypto.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, notFound } from '../errors.ts';
import { importUnits } from '../services/import-units.ts';
import { date, idParam, optText, text, uuid, z } from './z.ts';

const NODE_KINDS = ['phase', 'zone', 'block', 'tower', 'wing', 'sub_block', 'floor', 'street', 'cluster', 'other'] as const;
const area = z.number().positive().max(1e7).nullable().optional();

export const inScopeSql = (alias: string, param: string) =>
  `(${param}::uuid[] is null or ${alias}.id = any (${param}) or ${alias}.ancestor_ids && ${param})`;

async function unitNode(tx: Tx, unitId: string): Promise<NodeRef & { label: string }> {
  return (await one(tx, `select n.id, n.ancestor_ids, u.label from app.units u
    join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id where u.id = $1`, [unitId])) ?? notFound('That unit');
}

const personInput = z.object({
  personId: uuid.optional(),
  newPerson: z.object({ name: text(120), phone: z.string().max(30).optional().nullable() }).optional(),
}).refine(v => !!v.personId !== !!v.newPerson, 'choose an existing person or add a new one');

// Finds or adds the person named in a form. A new person with a mobile number that already exists
// in this community is matched to the existing record instead of creating a duplicate.
export async function resolvePerson(c: Ctx, input: z.infer<typeof personInput>, node: NodeRef | null) {
  if (input.personId) {
    return (await one(c.tx, `select id, full_name, phone_e164 from app.people where id = $1 and archived_at is null`,
      [input.personId])) ?? notFound('That person');
  }
  c.actor.require('people.manage', node);
  const phone = input.newPerson!.phone ? normalisePhone(input.newPerson!.phone) ?? fail(400, 'Enter a valid mobile number.') : null;
  if (phone) {
    const existing = await one(c.tx, `select id, full_name, phone_e164 from app.people where phone_e164 = $1 and archived_at is null`, [phone]);
    if (existing) return existing;
  }
  const p = await one(c.tx, `insert into app.people (full_name, phone_e164) values ($1, $2) returning id, full_name, phone_e164`,
    [input.newPerson!.name, phone]);
  await c.audit('person.created', 'person', p.id, `Added ${p.full_name}`);
  return p;
}

async function grantRole(c: Ctx, personId: string, roleKey: string) {
  const role = await one(c.tx, `select id from app.roles where key = $1 and archived_at is null`, [roleKey]);
  if (role) await c.tx.query(`insert into app.memberships (person_id, role_id) values ($1, $2) on conflict do nothing`, [personId, role.id]);
}

export async function propertyRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  // ---------------------------------------------------------------- locations
  app.get('/api/property/tree', async req => run.auth(req, async ({ tx, actor }) => {
    const scopes = actor.scopes('property.view');
    // People with a block-level role see their blocks in full, plus the names of the places above.
    const nodes = await many(tx, `
      with visible as (
        select n.* from app.property_nodes n where n.archived_at is null and ${inScopeSql('n', '$1')}),
      context as (
        select distinct a.* from visible v join app.property_nodes a on a.tenant_id = v.tenant_id and a.id = any (v.ancestor_ids))
      select x.id, x.parent_id, x.kind, x.name, x.code, x.depth, x.sort_order, x.attributes, x.in_scope,
             (select count(*)::int from app.units u where u.node_id = x.id and u.archived_at is null) as units_here,
             (select count(*)::int from app.units u join app.property_nodes un on un.tenant_id = u.tenant_id and un.id = u.node_id
               where u.archived_at is null and (un.id = x.id or x.id = any (un.ancestor_ids))) as units_total
        from (select v.*, true as in_scope from visible v
              union select c.*, false from context c where c.id not in (select id from visible)) x
       order by x.depth, x.sort_order, x.name`, [scopes]);
    return { nodes, canManage: actor.canAnywhere('property.manage') };
  }));

  app.post('/api/property/nodes', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = z.object({ parentId: uuid, kind: z.enum(NODE_KINDS), name: text(80), code: optText(20),
      sortOrder: z.number().int().optional(), attributes: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    const parent = await getNode(tx, b.parentId);
    actor.require('property.manage', parent);
    const n = await one(tx, `insert into app.property_nodes (parent_id, kind, name, code, sort_order, attributes)
      values ($1, $2, $3, $4, coalesce($5, (select coalesce(max(sort_order), 0) + 10 from app.property_nodes where parent_id = $1)), $6)
      returning *`, [parent.id, b.kind, b.name, b.code, b.sortOrder ?? null, b.attributes ?? {}]);
    await audit('property.node_created', 'property_node', n.id, `Added ${b.kind.replace('_', '-')} ${b.name} under ${parent.name}`);
    return n;
  }));

  app.patch('/api/property/nodes/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: text(80).optional(), code: optText(20), kind: z.enum(NODE_KINDS).optional(),
      sortOrder: z.number().int().optional(), parentId: uuid.optional() }).parse(req.body);
    const node = await getNode(tx, id);
    actor.require('property.manage', node);
    if (b.parentId && !node.parent_id) fail(400, 'The community itself cannot be moved.');
    if (b.kind && !node.parent_id) fail(400, 'The community itself keeps its kind.');
    if (b.parentId && b.parentId !== node.parent_id) actor.require('property.manage', await getNode(tx, b.parentId));
    const n = await one(tx, `update app.property_nodes set name = coalesce($2, name), code = case when $3::boolean then $4 else code end,
        kind = coalesce($5, kind), sort_order = coalesce($6, sort_order), parent_id = coalesce($7, parent_id)
      where id = $1 returning *`, [id, b.name ?? null, b.code !== undefined, b.code ?? null, b.kind ?? null, b.sortOrder ?? null, b.parentId ?? null]);
    await audit('property.node_updated', 'property_node', id,
      b.parentId && b.parentId !== node.parent_id ? `Moved ${n.name}` : `Updated ${n.name}`, { before: node, changes: b });
    return n;
  }));

  app.post('/api/property/nodes/:id/archive', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const node = await getNode(tx, id);
    actor.require('property.manage', node);
    if (!node.parent_id) fail(400, 'The community itself cannot be archived.');
    const busy = await one(tx, `select
        (select count(*) from app.property_nodes c where c.parent_id = $1 and c.archived_at is null)::int as children,
        (select count(*) from app.units u where u.node_id = $1 and u.archived_at is null)::int as units`, [id]);
    if (busy.children || busy.units) fail(409, `Move or archive what is inside ${node.name} first (${busy.children} places, ${busy.units} units).`);
    await tx.query(`update app.property_nodes set archived_at = now() where id = $1`, [id]);
    await audit('property.node_archived', 'property_node', id, `Archived ${node.name}`);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- shared facilities
  app.get('/api/facilities', async req => run.auth(req, async ({ tx, actor }) => {
    return many(tx, `select f.*, n.name as location from app.facilities f
        join app.property_nodes n on n.tenant_id = f.tenant_id and n.id = f.node_id
       where f.archived_at is null and ${inScopeSql('n', '$1')} order by f.name`, [actor.scopes('property.view')]);
  }));

  app.post('/api/facilities', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = z.object({ nodeId: uuid, name: text(80), kind: z.enum(['clubhouse', 'pool', 'gym', 'court', 'golf_course', 'park',
      'hall', 'play_area', 'parking_area', 'other']), bookable: z.boolean().default(false),
      capacity: z.number().int().positive().nullable().optional(), notes: z.string().max(500).default('') }).parse(req.body);
    const node = await getNode(tx, b.nodeId);
    actor.require('property.manage', node);
    const f = await one(tx, `insert into app.facilities (node_id, name, kind, bookable, capacity, notes)
      values ($1, $2, $3, $4, $5, $6) returning *`, [node.id, b.name, b.kind, b.bookable, b.capacity ?? null, b.notes]);
    await audit('facility.created', 'facility', f.id, `Added ${b.name} for ${node.name}`);
    return f;
  }));

  // ---------------------------------------------------------------- unit types
  app.get('/api/unit-types', async req => run.auth(req, async ({ tx }) =>
    many(tx, `select t.*, (select count(*)::int from app.units u where u.unit_type_id = t.id and u.archived_at is null) as units
      from app.unit_types t order by t.sort_order, t.name`)));

  app.post('/api/unit-types', async req => run.auth(req, async ({ tx, actor, audit }) => {
    actor.require('units.manage');
    const b = z.object({ code: z.string().regex(/^[a-z0-9_.-]{1,24}$/), name: text(40),
      category: z.enum(['apartment', 'villa', 'row_house', 'plot', 'commercial', 'other']),
      bedrooms: z.number().min(0).max(20).nullable().optional() }).parse(req.body);
    const t = await one(tx, `insert into app.unit_types (code, name, category, bedrooms, sort_order)
      values ($1, $2, $3, $4, (select coalesce(max(sort_order), 0) + 10 from app.unit_types)) returning *`,
      [b.code, b.name, b.category, b.bedrooms ?? null]);
    await audit('unit_type.created', 'unit_type', t.id, `Added unit type ${b.name}`);
    return t;
  }));

  // ---------------------------------------------------------------- units
  app.get('/api/units', async req => run.auth(req, async ({ tx, actor }) => {
    const q = z.object({ node: uuid.optional(), q: z.string().max(60).optional(), type: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const scopes = actor.scopes('units.view');
    const rows = await many(tx, `
      select u.id, u.label, u.floor_no, u.carpet_sqft, u.super_sqft, u.uds_sqft, u.plot_sqft, u.occupancy,
             ut.name as type, ut.category, n.name as location, n.id as node_id,
             (select string_agg(p.full_name, ', ' order by o.share_pct desc, p.full_name)
                from app.ownerships o join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id
               where o.unit_id = u.id and o.ends_on is null) as owners,
             count(*) over ()::int as total
        from app.units u
        join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
        join app.unit_types ut on ut.tenant_id = u.tenant_id and ut.id = u.unit_type_id
       where u.archived_at is null and ${inScopeSql('n', '$1')}
         and ($2::uuid is null or n.id = $2 or $2 = any (n.ancestor_ids))
         and ($3::text is null or u.label ilike '%' || $3 || '%' or exists (
               select 1 from app.ownerships o join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id
                where o.unit_id = u.id and o.ends_on is null and p.full_name ilike '%' || $3 || '%'))
         and ($4::uuid is null or u.unit_type_id = $4)
       order by n.ancestor_ids, n.sort_order, u.label
       limit $5 offset $6`, [scopes, q.node ?? null, q.q?.trim() || null, q.type ?? null, q.limit, q.offset]);
    return { total: rows[0]?.total ?? 0, units: rows.map(({ total, ...r }) => r) };
  }));

  app.get('/api/units/:id', async req => run.auth(req, async ({ tx, actor }) => {
    const { id } = idParam.parse(req.params);
    const node = await unitNode(tx, id);
    if (!actor.can('units.view', node)) {
      const mine = await one(tx, `select 1 from app.ownerships where unit_id = $1 and person_id = $2 and ends_on is null
        union select 1 from app.occupancies where unit_id = $1 and person_id = $2 and ends_on is null`, [id, actor.personId]);
      if (!mine) notFound('That unit');
    }
    const unit = await one(tx, `select u.*, ut.name as type, ut.category, n.name as location,
        (select json_agg(json_build_object('id', a.id, 'name', a.name, 'root', a.parent_id is null) order by a.depth)
           from app.property_nodes a where a.id = any (n.ancestor_ids || n.id)) as path
      from app.units u join app.unit_types ut on ut.tenant_id = u.tenant_id and ut.id = u.unit_type_id
      join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id where u.id = $1`, [id]);
    const showPeople = actor.can('people.view', node);
    const owners = await many(tx, `select o.id, o.share_pct, o.starts_on, o.ends_on, p.id as person_id, p.full_name,
        case when $2 then p.phone_e164 end as phone
      from app.ownerships o join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id
      where o.unit_id = $1 order by o.ends_on nulls first, o.share_pct desc`, [id, showPeople]);
    const occupants = await many(tx, `select o.id, o.relation, o.is_primary_contact, o.starts_on, o.ends_on, p.id as person_id,
        p.full_name, case when $2 then p.phone_e164 end as phone
      from app.occupancies o join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id
      where o.unit_id = $1 order by o.ends_on nulls first, o.starts_on desc`, [id, showPeople]);
    const parking = await many(tx, `select id, label, kind from app.parking_slots where unit_id = $1 order by label`, [id]);
    const meters = await many(tx, `select id, kind, meter_no, provider from app.meters where unit_id = $1 order by kind`, [id]);
    return { unit, owners, occupants, parking, meters, canManage: actor.can('units.manage', node),
      canManagePeople: actor.can('people.manage', node) };
  }));

  const unitBody = z.object({ nodeId: uuid, unitTypeId: uuid, label: text(40), floorNo: z.number().int().min(-5).max(200).nullable().optional(),
    carpetSqft: area, builtupSqft: area, superSqft: area, plotSqft: area, udsSqft: area,
    occupancy: z.enum(['owner_occupied', 'let_out', 'vacant', 'under_construction']).optional(),
    attributes: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).optional() });

  app.post('/api/units', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = unitBody.parse(req.body);
    const node = await getNode(tx, b.nodeId);
    actor.require('units.manage', node);
    const u = await one(tx, `insert into app.units (node_id, unit_type_id, label, floor_no, carpet_sqft, builtup_sqft, super_sqft,
        plot_sqft, uds_sqft, occupancy, attributes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,'vacant'),$11) returning *`,
      [node.id, b.unitTypeId, b.label, b.floorNo ?? null, b.carpetSqft ?? null, b.builtupSqft ?? null, b.superSqft ?? null,
        b.plotSqft ?? null, b.udsSqft ?? null, b.occupancy ?? null, b.attributes ?? {}]);
    await audit('unit.created', 'unit', u.id, `Added unit ${u.label} in ${node.name}`);
    return u;
  }));

  app.patch('/api/units/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = unitBody.partial().parse(req.body);
    const before = await one(tx, `select * from app.units where id = $1`, [id]) ?? notFound('That unit');
    actor.require('units.manage', await unitNode(tx, id));
    if (b.nodeId && b.nodeId !== before.node_id) actor.require('units.manage', await getNode(tx, b.nodeId));
    const cols: [string, unknown][] = [['node_id', b.nodeId], ['unit_type_id', b.unitTypeId], ['label', b.label], ['floor_no', b.floorNo],
      ['carpet_sqft', b.carpetSqft], ['builtup_sqft', b.builtupSqft], ['super_sqft', b.superSqft], ['plot_sqft', b.plotSqft],
      ['uds_sqft', b.udsSqft], ['occupancy', b.occupancy], ['attributes', b.attributes]];
    const set = cols.filter(([, v]) => v !== undefined);
    if (!set.length) return before;
    const u = await one(tx, `update app.units set ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`,
      [id, ...set.map(([, v]) => v)]);
    await audit('unit.updated', 'unit', id, `Updated unit ${u.label}`, { before, changes: b });
    return u;
  }));

  app.post('/api/units/import', { bodyLimit: 4 * 1024 * 1024 }, async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = z.object({ csv: z.string().min(10).max(4_000_000), dryRun: z.boolean().default(true),
      grantOwnerAccess: z.boolean().default(true) }).parse(req.body);
    actor.require('units.manage');
    actor.require('property.manage');
    actor.require('people.manage');
    const r = await importUnits(tx, b.csv, b);
    if (r.committed) await audit('unit.imported', 'unit', null,
      `Imported ${r.unitsCreated} units, ${r.locationsCreated.length} places and ${r.peopleCreated} people`, {
        units: r.unitsCreated, locations: r.locationsCreated.length, people: r.peopleCreated });
    return r;
  }));

  // ---------------------------------------------------------------- ownership and occupancy
  app.post('/api/units/:id/owners', async req => run.auth(req, async c => {
    const { id } = idParam.parse(req.params);
    const b = personInput.and(z.object({ sharePct: z.number().positive().max(100), startsOn: date.optional(),
      grantAccess: z.boolean().default(true) })).parse(req.body);
    const node = await unitNode(c.tx, id);
    c.actor.require('people.manage', node);
    const p = await resolvePerson(c, b, node);
    const o = await one(c.tx, `insert into app.ownerships (unit_id, person_id, share_pct, starts_on)
      values ($1, $2, $3, coalesce($4::date, current_date)) returning *`, [id, p.id, b.sharePct, b.startsOn ?? null]);
    await c.tx.query(`set constraints app.ownerships_share_check immediate`);
    if (b.grantAccess && p.phone_e164) await grantRole(c, p.id, 'owner');
    await c.audit('ownership.added', 'unit', id, `${p.full_name} added as owner of ${node.label} (${b.sharePct}%)`);
    return o;
  }));

  app.post('/api/ownerships/:id/end', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ endsOn: date.optional() }).parse(req.body ?? {});
    const o = await one(tx, `select o.*, p.full_name from app.ownerships o join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id
      where o.id = $1 and o.ends_on is null`, [id]) ?? notFound('That ownership');
    const node = await unitNode(tx, o.unit_id);
    actor.require('people.manage', node);
    await tx.query(`update app.ownerships set ends_on = coalesce($2::date, current_date) where id = $1`, [id, b.endsOn ?? null]);
    await audit('ownership.ended', 'unit', o.unit_id, `${o.full_name} is no longer an owner of ${node.label}`);
    return { ok: true };
  }));

  // A sale ends every current owner and records the buyers in one step; shares must still total 100%.
  app.post('/api/units/:id/sale', async req => run.auth(req, async c => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ date: date, buyers: z.array(personInput.and(z.object({ sharePct: z.number().positive().max(100) }))).min(1).max(10),
      grantAccess: z.boolean().default(true) }).parse(req.body);
    const node = await unitNode(c.tx, id);
    c.actor.require('people.manage', node);
    const total = b.buyers.reduce((s, x) => s + x.sharePct, 0);
    if (Math.abs(total - 100) > 0.01) fail(400, `Buyers' shares add up to ${total}%; they must total 100%.`);
    const sellers = await many(c.tx, `update app.ownerships set ends_on = greatest(starts_on, $2::date) where unit_id = $1 and ends_on is null
      returning person_id`, [id, b.date]);
    const names = [];
    for (const buyer of b.buyers) {
      const p = await resolvePerson(c, buyer, node);
      await c.tx.query(`insert into app.ownerships (unit_id, person_id, share_pct, starts_on) values ($1, $2, $3, $4)`,
        [id, p.id, buyer.sharePct, b.date]);
      if (b.grantAccess && p.phone_e164) await grantRole(c, p.id, 'owner');
      names.push(p.full_name);
    }
    await c.tx.query(`set constraints app.ownerships_share_check immediate`);
    await c.audit('ownership.sale', 'unit', id, `${node.label} sold to ${names.join(', ')}`, { date: b.date, sellers: sellers.length });
    return { ok: true };
  }));

  app.post('/api/units/:id/occupants', async req => run.auth(req, async c => {
    const { id } = idParam.parse(req.params);
    const b = personInput.and(z.object({ relation: z.enum(['owner', 'tenant', 'family', 'caretaker']),
      isPrimaryContact: z.boolean().default(false), startsOn: date.optional(), grantAccess: z.boolean().default(true) })).parse(req.body);
    const node = await unitNode(c.tx, id);
    c.actor.require('people.manage', node);
    const p = await resolvePerson(c, b, node);
    const o = await one(c.tx, `insert into app.occupancies (unit_id, person_id, relation, is_primary_contact, starts_on)
      values ($1, $2, $3, $4, coalesce($5::date, current_date)) returning *`, [id, p.id, b.relation, b.isPrimaryContact, b.startsOn ?? null]);
    if (b.relation === 'tenant') await c.tx.query(`update app.units set occupancy = 'let_out' where id = $1`, [id]);
    if (b.grantAccess && p.phone_e164) await grantRole(c, p.id, b.relation === 'owner' ? 'owner' : 'resident');
    await c.audit('occupancy.added', 'unit', id, `${p.full_name} recorded as ${b.relation} at ${node.label}`);
    return o;
  }));

  app.post('/api/occupancies/:id/end', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const o = await one(tx, `select o.*, p.full_name from app.occupancies o join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id
      where o.id = $1 and o.ends_on is null`, [id]) ?? notFound('That record');
    const node = await unitNode(tx, o.unit_id);
    actor.require('people.manage', node);
    await tx.query(`update app.occupancies set ends_on = current_date where id = $1`, [id]);
    await audit('occupancy.ended', 'unit', o.unit_id, `${o.full_name} moved out of ${node.label}`);
    return { ok: true };
  }));

  app.post('/api/units/:id/parking', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ label: text(30), kind: z.enum(['covered', 'open', 'stack', 'two_wheeler', 'visitor']).default('covered'),
      nodeId: uuid.optional() }).parse(req.body);
    const node = await unitNode(tx, id);
    actor.require('units.manage', node);
    const p = await one(tx, `insert into app.parking_slots (node_id, label, kind, unit_id) values ($1, $2, $3, $4) returning *`,
      [b.nodeId ?? node.id, b.label, b.kind, id]);
    await audit('parking.assigned', 'unit', id, `Parking ${b.label} assigned to ${node.label}`);
    return p;
  }));

  app.post('/api/units/:id/meters', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ kind: z.enum(['electricity', 'water', 'gas', 'dg_backup']), meterNo: text(40), provider: optText(80) }).parse(req.body);
    const node = await unitNode(tx, id);
    actor.require('units.manage', node);
    const m = await one(tx, `insert into app.meters (unit_id, kind, meter_no, provider) values ($1, $2, $3, $4) returning *`,
      [id, b.kind, b.meterNo, b.provider]);
    await audit('meter.added', 'unit', id, `${b.kind} meter ${b.meterNo} added to ${node.label}`);
    return m;
  }));

}
