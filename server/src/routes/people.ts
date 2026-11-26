import type { FastifyInstance } from 'fastify';
import type { Actor } from '../actor.ts';
import { getNode, type NodeRef } from '../actor.ts';
import type { Runner, Services } from '../app.ts';
import { normalisePhone } from '../auth/crypto.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import { idParam, optText, text, uuid, z } from './z.ts';

// Nobody can hand out more access than they have: every permission in the role must be one the
// person granting it holds over the same location.
function assertCanGrant(actor: Actor, permissions: string[], node: NodeRef | null) {
  const missing = permissions.filter(p => !actor.can(p, node));
  if (missing.length) forbidden(`You can only give access you have yourself. Missing: ${missing.join(', ')}.`);
}

// Someone must always be able to manage access, so a community can never lock itself out.
async function ensureAdministratorRemains(tx: Tx) {
  const r = await one(tx, `select count(*)::int as n from app.memberships m
      join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id and r.archived_at is null
      join app.people p on p.tenant_id = m.tenant_id and p.id = m.person_id and p.archived_at is null
     where m.status = 'active' and m.scope_node_id is null
       and 'members.manage' = any (r.permissions) and 'roles.manage' = any (r.permissions)`);
  if (!r.n) fail(409, 'This would leave nobody able to manage access. Give someone else the Administrator role first.', 'last_admin');
}

export async function peopleRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  // ---------------------------------------------------------------- people
  app.get('/api/people', async req => run.auth(req, async ({ tx, actor }) => {
    actor.require('people.view', null);
    const q = z.object({ q: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const rows = await many(tx, `select p.id, p.full_name, p.phone_e164, p.email, p.photo_file_id, p.user_id is not null as has_signed_in,
        (select string_agg(distinct u.label, ', ') from app.ownerships o join app.units u on u.tenant_id = o.tenant_id and u.id = o.unit_id
          where o.person_id = p.id and o.ends_on is null) as owns,
        (select string_agg(distinct r.name, ', ') from app.memberships m join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id
          where m.person_id = p.id and m.status = 'active') as roles,
        count(*) over ()::int as total
      from app.people p where p.archived_at is null
        and ($1::text is null or p.full_name ilike '%' || $1 || '%'
             or (length(regexp_replace($1, '\\D', '', 'g')) >= 3 and p.phone_e164 like '%' || regexp_replace($1, '\\D', '', 'g') || '%'))
      order by lower(p.full_name) limit $2 offset $3`, [q.q?.trim() || null, q.limit, q.offset]);
    return { total: rows[0]?.total ?? 0, people: rows.map(({ total, ...r }) => r) };
  }));

  app.get('/api/people/:id', async req => run.auth(req, async ({ tx, actor }) => {
    const { id } = idParam.parse(req.params);
    if (id !== actor.personId) actor.require('people.view', null);
    const person = await one(tx, `select id, full_name, phone_e164, email, language, photo_file_id, user_id is not null as has_signed_in, created_at
      from app.people where id = $1 and archived_at is null`, [id]) ?? notFound('That person');
    const homes = await many(tx, `select o.id, u.id as unit_id, u.label, o.share_pct, o.starts_on, o.ends_on, 'owner' as relation
        from app.ownerships o join app.units u on u.tenant_id = o.tenant_id and u.id = o.unit_id where o.person_id = $1
      union all select o.id, u.id, u.label, null, o.starts_on, o.ends_on, o.relation
        from app.occupancies o join app.units u on u.tenant_id = o.tenant_id and u.id = o.unit_id where o.person_id = $1 and o.relation <> 'owner'
      order by 6 nulls first, 3`, [id]);
    const memberships = await many(tx, `select m.id, m.status, r.id as role_id, r.name as role, n.name as scope
      from app.memberships m join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id
      left join app.property_nodes n on n.tenant_id = m.tenant_id and n.id = m.scope_node_id
      where m.person_id = $1 order by m.status, r.name`, [id]);
    const seats = await many(tx, `select s.id, c.name as committee, s.position, s.starts_on, s.ends_on from app.committee_seats s
      join app.committees c on c.tenant_id = s.tenant_id and c.id = s.committee_id where s.person_id = $1 order by s.ends_on nulls first`, [id]);
    return { person, homes, memberships, seats };
  }));

  app.post('/api/people', async req => run.auth(req, async ({ tx, actor, audit }) => {
    actor.require('people.manage', null);
    const b = z.object({ fullName: text(120), phone: z.string().max(30).optional().nullable(), email: optText(200),
      language: z.enum(['en', 'ta', 'hi', 'te', 'kn', 'ml']).default('en') }).parse(req.body);
    const phone = b.phone ? normalisePhone(b.phone) ?? fail(400, 'Enter a valid mobile number.') : null;
    const p = await one(tx, `insert into app.people (full_name, phone_e164, email, language) values ($1, $2, $3, $4) returning *`,
      [b.fullName, phone, b.email, b.language]);
    await audit('person.created', 'person', p.id, `Added ${p.full_name}`);
    return p;
  }));

  app.patch('/api/people/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    actor.require('people.manage', null);
    const b = z.object({ fullName: text(120).optional(), phone: z.string().max(30).nullable().optional(), email: optText(200),
      language: z.enum(['en', 'ta', 'hi', 'te', 'kn', 'ml']).optional() }).parse(req.body);
    const before = await one(tx, `select * from app.people where id = $1 and archived_at is null`, [id]) ?? notFound('That person');
    const phone = b.phone === undefined ? before.phone_e164 : b.phone ? normalisePhone(b.phone) ?? fail(400, 'Enter a valid mobile number.') : null;
    // A changed number must sign in again before it is linked to this person.
    const p = await one(tx, `update app.people set full_name = coalesce($2, full_name), phone_e164 = $3,
        email = case when $4::boolean then $5 else email end, language = coalesce($6, language),
        user_id = case when $3 is distinct from phone_e164 then null else user_id end
      where id = $1 returning *`, [id, b.fullName ?? null, phone, b.email !== undefined, b.email ?? null, b.language ?? null]);
    await audit('person.updated', 'person', id, `Updated ${p.full_name}`,
      { phoneChanged: phone !== before.phone_e164, nameChanged: !!b.fullName && b.fullName !== before.full_name });
    return p;
  }));

  app.post('/api/people/:id/archive', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    actor.require('people.manage', null);
    const p = await one(tx, `select * from app.people where id = $1 and archived_at is null`, [id]) ?? notFound('That person');
    const busy = await one(tx, `select
      (select count(*) from app.ownerships where person_id = $1 and ends_on is null)::int as owns,
      (select count(*) from app.committee_seats where person_id = $1 and ends_on is null)::int as seats`, [id]);
    if (busy.owns || busy.seats) fail(409, `End ${p.full_name}'s ownerships and committee seats first.`);
    await tx.query(`update app.memberships set status = 'disabled', disabled_at = now() where person_id = $1 and status = 'active'`, [id]);
    await tx.query(`update app.people set archived_at = now(), user_id = null where id = $1`, [id]);
    await ensureAdministratorRemains(tx);
    await audit('person.archived', 'person', id, `Archived ${p.full_name}`);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- roles
  app.get('/api/permissions', async req => run.auth(req, async ({ tx }) =>
    many(tx, `select key, area, label from app.permission_catalog order by area, key`)));

  app.get('/api/roles', async req => run.auth(req, async ({ tx, actor }) => {
    if (!actor.canAnywhere('roles.manage') && !actor.canAnywhere('members.manage')) forbidden();
    return many(tx, `select r.*, (select count(*)::int from app.memberships m where m.role_id = r.id and m.status = 'active') as members
      from app.roles r where r.archived_at is null order by r.is_template desc, r.name`);
  }));

  const roleBody = z.object({ key: z.string().regex(/^[a-z0-9_]{2,40}$/), name: text(60), description: z.string().max(300).default(''),
    permissions: z.array(z.string().max(60)).max(60) });

  app.post('/api/roles', async req => run.auth(req, async ({ tx, actor, audit }) => {
    actor.require('roles.manage');
    const b = roleBody.parse(req.body);
    assertCanGrant(actor, b.permissions, null);
    const r = await one(tx, `insert into app.roles (key, name, description, permissions) values ($1, $2, $3, $4) returning *`,
      [b.key, b.name, b.description, [...new Set(b.permissions)]]);
    await audit('role.created', 'role', r.id, `Created role ${r.name}`, { permissions: r.permissions });
    return r;
  }));

  app.patch('/api/roles/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    actor.require('roles.manage');
    const b = roleBody.omit({ key: true }).partial().parse(req.body);
    const before = await one(tx, `select * from app.roles where id = $1 and archived_at is null`, [id]) ?? notFound('That role');
    if (b.permissions) {
      const added = b.permissions.filter(p => !before.permissions.includes(p));
      assertCanGrant(actor, added, null);
    }
    const r = await one(tx, `update app.roles set name = coalesce($2, name), description = coalesce($3, description),
      permissions = coalesce($4, permissions) where id = $1 returning *`,
      [id, b.name ?? null, b.description ?? null, b.permissions ? [...new Set(b.permissions)] : null]);
    await ensureAdministratorRemains(tx);
    await audit('role.updated', 'role', id, `Updated role ${r.name}`, { before: before.permissions, after: r.permissions });
    return r;
  }));

  // ---------------------------------------------------------------- access (memberships)
  app.get('/api/members', async req => run.auth(req, async ({ tx, actor }) => {
    actor.require('members.manage');
    const q = z.object({ status: z.enum(['active', 'disabled', 'all']).default('active'), role: uuid.optional() }).parse(req.query);
    return many(tx, `select m.id, m.status, m.created_at, m.disabled_at, p.id as person_id, p.full_name, p.phone_e164,
        p.user_id is not null as has_signed_in, r.id as role_id, r.name as role, n.id as scope_id, n.name as scope
      from app.memberships m join app.people p on p.tenant_id = m.tenant_id and p.id = m.person_id
      join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id
      left join app.property_nodes n on n.tenant_id = m.tenant_id and n.id = m.scope_node_id
      where ($1 = 'all' or m.status = $1) and ($2::uuid is null or m.role_id = $2) and p.archived_at is null
      order by r.name, lower(p.full_name)`, [q.status, q.role ?? null]);
  }));

  app.post('/api/members', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = z.object({ personId: uuid, roleId: uuid, scopeNodeId: uuid.nullable().optional() }).parse(req.body);
    const node = b.scopeNodeId ? await getNode(tx, b.scopeNodeId) : null;
    actor.require('members.manage', node);
    const role = await one(tx, `select * from app.roles where id = $1 and archived_at is null`, [b.roleId]) ?? notFound('That role');
    assertCanGrant(actor, role.permissions, node);
    const person = await one(tx, `select id, full_name, phone_e164 from app.people where id = $1 and archived_at is null`, [b.personId])
      ?? notFound('That person');
    if (!person.phone_e164) fail(400, `Add a mobile number for ${person.full_name} first; it is how they sign in.`);
    const m = await one(tx, `insert into app.memberships (person_id, role_id, scope_node_id) values ($1, $2, $3)
      on conflict (tenant_id, person_id, role_id, scope_node_id) do update set status = 'active', disabled_at = null
      returning *`, [person.id, role.id, node?.id ?? null]);
    await audit('member.granted', 'membership', m.id,
      `${person.full_name} given ${role.name}${node ? ` for ${node.name}` : ''}`, { roleId: role.id, scope: node?.id ?? null });
    return m;
  }));

  for (const action of ['disable', 'enable'] as const) {
    app.post(`/api/members/:id/${action}`, async req => run.auth(req, async ({ tx, actor, audit }) => {
      const { id } = idParam.parse(req.params);
      const m = await one(tx, `select m.*, p.full_name, r.name as role, r.permissions, n.ancestor_ids
        from app.memberships m join app.people p on p.tenant_id = m.tenant_id and p.id = m.person_id
        join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id
        left join app.property_nodes n on n.tenant_id = m.tenant_id and n.id = m.scope_node_id where m.id = $1`, [id])
        ?? notFound('That access');
      const node = m.scope_node_id ? { id: m.scope_node_id, ancestor_ids: m.ancestor_ids } : null;
      actor.require('members.manage', node);
      assertCanGrant(actor, m.permissions, node);
      await tx.query(`update app.memberships set status = $2, disabled_at = case when $2 = 'disabled' then now() end where id = $1`,
        [id, action === 'disable' ? 'disabled' : 'active']);
      if (action === 'disable') await ensureAdministratorRemains(tx);
      await audit(`member.${action}d`, 'membership', id, `${action === 'disable' ? 'Removed' : 'Restored'} ${m.role} for ${m.full_name}`);
      return { ok: true };
    }));
  }

  // Profile photos: people add or change their own; those who manage people can change or remove one.
  async function setPhoto(tx: any, actor: any, audit: any, personId: string, fileId: string | null) {
    if (fileId && !await one(tx, `select 1 from app.files where id = $1 and purpose = 'avatar' and uploaded_by = $2`, [fileId, actor.personId]))
      fail(400, 'Upload the photo again.', 'invalid');
    const p = await one(tx, `update app.people set photo_file_id = $2 where id = $1 and archived_at is null returning full_name`, [personId, fileId]) ?? notFound('That person');
    await audit(fileId ? 'person.photo_set' : 'person.photo_removed', 'person', personId, `${fileId ? 'Photo added for' : 'Photo removed for'} ${p.full_name}`);
    return { ok: true, photo: fileId };
  }
  app.put('/api/me/photo', async req => run.auth(req, async ({ tx, actor, audit }) =>
    setPhoto(tx, actor, audit, actor.personId, z.object({ fileId: uuid.nullable() }).parse(req.body).fileId)));
  app.put('/api/people/:id/photo', async req => run.auth(req, async ({ tx, actor, audit }) => {
    actor.require('people.manage', null);
    return setPhoto(tx, actor, audit, idParam.parse(req.params).id, z.object({ fileId: uuid.nullable() }).parse(req.body).fileId);
  }));

  // Each person's own settings, kept with their account so they follow them to any phone.
  const PANEL = z.object({ id: z.string().regex(/^[a-z_]{2,30}$/), hidden: z.boolean().default(false) });
  app.get('/api/me/settings', async req => run.auth(req, async ({ tx, actor }) => {
    const s = await one(tx, `select home_layout from app.person_settings where person_id = $1`, [actor.personId]);
    return { homeLayout: s?.home_layout ?? [] };
  }));
  app.put('/api/me/settings', async req => run.auth(req, async ({ tx, actor }) => {
    const b = z.object({ homeLayout: z.array(PANEL).max(30) }).parse(req.body);
    const ids = b.homeLayout.map(x => x.id);
    if (new Set(ids).size !== ids.length) fail(400, 'Each panel can appear once.', 'invalid');
    await tx.query(`insert into app.person_settings (person_id, home_layout) values ($1, $2)
      on conflict (tenant_id, person_id) do update set home_layout = excluded.home_layout, updated_at = now()`, [actor.personId, JSON.stringify(b.homeLayout)]);
    return { homeLayout: b.homeLayout };
  }));
}
