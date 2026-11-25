import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import type { Runner, Services } from '../app.ts';
import { clearTenantCache } from '../app.ts';
import { many, one } from '../db.ts';
import { fail, forbidden } from '../errors.ts';
import { saveUpload } from '../services/files.ts';
import { z } from './z.ts';

const LANGS = ['en', 'ta', 'hi', 'te', 'kn', 'ml'] as const;

export async function communityRoutes(app: FastifyInstance, run: Runner, svc: Services) {
  // The installable app: a manifest and an icon in the community's own name and colour.
  app.get('/manifest.webmanifest', async (req, reply) => {
    const t = req.tenant;
    if (!t) return reply.code(404).send('Not found');
    return reply.header('content-type', 'application/manifest+json').header('cache-control', 'no-cache').send({
      name: t.platform_name, short_name: t.brand_name.length <= 12 ? t.brand_name : 'Pragati', start_url: '/', scope: '/', display: 'standalone',
      background_color: '#f3f4f2', theme_color: t.primary_color, lang: 'en-IN',
      icons: [{ src: '/app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: '/app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }],
    });
  });
  app.get('/app-icon.svg', async (req, reply) => {
    const t = req.tenant;
    const letter = (t?.brand_name ?? 'P').trim().charAt(0).toUpperCase().replace(/[<>&"']/g, '') || 'P';
    const colour = /^#[0-9a-f]{6}$/i.test(t?.primary_color ?? '') ? t!.primary_color : '#1f4d7a';
    return reply.header('content-type', 'image/svg+xml').header('cache-control', 'public, max-age=86400').send(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="${colour}"/>` +
      `<text x="256" y="338" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="260" fill="#fff">${letter}</text></svg>`);
  });

  // Help and feedback from any screen to the platform team.
  app.post('/api/feedback', async req => run.auth(req, async ({ tx, actor }) => {
    const b = z.object({ kind: z.enum(['problem', 'idea', 'question', 'praise']), body: z.string().trim().min(3, 'Write a few words').max(3000),
      page: z.string().trim().max(200).optional() }).parse(req.body);
    const recent = await one(tx, `select count(*)::int as n from app.feedback where person_id = $1 and created_at > now() - interval '1 hour'`, [actor.personId]);
    if ((recent?.n ?? 0) >= 10) fail(429, 'Thank you: that is a lot of feedback in an hour. Please try again later.', 'limit');
    await tx.query(`insert into app.feedback (person_id, kind, body, page) values ($1, $2, $3, $4)`, [actor.personId, b.kind, b.body, b.page ?? null]);
    return { ok: true };
  }));

  app.get('/api/public/community', async req => {
    const t = req.tenant!;
    return { platformName: t.platform_name, brandName: t.brand_name, primaryColor: t.primary_color,
      languages: t.languages, assistantName: t.assistant_name, assistantOn: !!config.ask.apiKey && t.assistant_enabled, hasLogo: !!t.logo_file_id, isDemo: t.is_demo };
  });

  app.get('/api/public/logo', async (req, reply) => {
    const t = req.tenant!;
    if (!t.logo_file_id) return reply.code(404).send({ error: 'No logo.' });
    const f = await run.open(req, tx => one(tx, `select storage_key, content_type from app.files where id = $1 and purpose = 'logo'`, [t.logo_file_id]));
    if (!f) return reply.code(404).send({ error: 'No logo.' });
    return reply.header('content-type', f.content_type).header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff').send(await svc.storage.get(f.storage_key));
  });

  app.get('/api/me', async req => run.auth(req, async ({ tx, actor }) => {
    const homes = await many(tx, `
      select u.id, u.label, ut.name as type,
             (select string_agg(a.name, ', ' order by a.depth) from app.property_nodes a
               where a.id = any (n.ancestor_ids || n.id) and a.depth > 0) as location, 'owner' as relation, o.share_pct
        from app.ownerships o join app.units u on u.tenant_id = o.tenant_id and u.id = o.unit_id
        join app.unit_types ut on ut.tenant_id = u.tenant_id and ut.id = u.unit_type_id
        join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
       where o.person_id = $1 and o.ends_on is null
      union all
      select u.id, u.label, ut.name, (select string_agg(a.name, ', ' order by a.depth) from app.property_nodes a
               where a.id = any (n.ancestor_ids || n.id) and a.depth > 0), oc.relation, null
        from app.occupancies oc join app.units u on u.tenant_id = oc.tenant_id and u.id = oc.unit_id
        join app.unit_types ut on ut.tenant_id = u.tenant_id and ut.id = u.unit_type_id
        join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
       where oc.person_id = $1 and oc.ends_on is null and oc.relation <> 'owner'
      order by 2`, [actor.personId]);
    const seats = await many(tx, `select c.id, c.name, s.position from app.committee_seats s
      join app.committees c on c.tenant_id = s.tenant_id and c.id = s.committee_id
      where s.person_id = $1 and s.ends_on is null and c.archived_at is null order by c.name`, [actor.personId]);
    const waiting = await one(tx, `select count(*)::int as n from app.approval_requests r
      join app.approval_stage_voters v on v.tenant_id = r.tenant_id and v.request_id = r.id and v.stage_no = r.current_stage
      left join app.approval_votes x on x.tenant_id = v.tenant_id and x.request_id = v.request_id and x.stage_no = v.stage_no and x.person_id = v.person_id
      where r.status = 'pending' and v.person_id = $1 and x.vote is null`, [actor.personId]);
    return {
      person: { id: actor.personId, name: actor.name, phone: actor.phone },
      roles: actor.grants.map(g => ({ key: g.roleKey, name: g.roleName, scope: g.scopeName })),
      permissions: actor.permissions(), homes, committees: seats, waitingForMyVote: waiting?.n ?? 0,
    };
  }));

  app.get('/api/dashboard', async req => run.auth(req, async ({ tx, actor }) => {
    const canUnits = actor.canAnywhere('units.view');
    const scopes = canUnits ? actor.scopes('units.view') : [];
    const inScope = `($1::uuid[] is null or n.id = any ($1) or n.ancestor_ids && $1)`;
    const units = canUnits ? await many(tx, `select ut.category, ut.name, u.occupancy, count(*)::int as n
        from app.units u join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
        join app.unit_types ut on ut.tenant_id = u.tenant_id and ut.id = u.unit_type_id
       where u.archived_at is null and ${inScope}
       group by 1, 2, 3, ut.sort_order order by ut.sort_order`, [scopes]) : [];
    const places = actor.canAnywhere('property.view') ? await many(tx, `select n.kind, count(*)::int as n
        from app.property_nodes n where n.archived_at is null and ${inScope} group by 1 order by 2 desc`,
      [actor.scopes('property.view')]) : [];
    const approvals = actor.canAnywhere('approvals.view') ? await one(tx, `select
        count(*) filter (where r.status = 'pending')::int as pending,
        count(*) filter (where r.status = 'approved' and r.decided_at > now() - interval '30 days')::int as approved_30d
        from app.approval_requests r join app.property_nodes n on n.tenant_id = r.tenant_id and n.id = r.scope_node_id
       where ${inScope}`, [actor.scopes('approvals.view')]) : null;
    const people = actor.canAnywhere('people.view')
      ? (await one(tx, `select count(*)::int as n from app.people where archived_at is null`))!.n : null;
    const facilities = actor.canAnywhere('property.view') ? await many(tx, `select f.id, f.name, f.kind, n.name as location
        from app.facilities f join app.property_nodes n on n.tenant_id = f.tenant_id and n.id = f.node_id
       where f.archived_at is null and ${inScope} order by f.name limit 30`, [actor.scopes('property.view')]) : [];
    return { units, places, approvals, people, facilities };
  }));

  app.get('/api/settings', async req => run.auth(req, async ({ tx, actor }) => {
    if (!actor.canAnywhere('settings.manage') && !actor.canAnywhere('roles.manage')) forbidden();
    return one(tx, `select brand_name, platform_name, legal_name, registration_no, state, city, timezone, languages,
      primary_color, assistant_name, logo_file_id, hosting_tier, slug, escalation_days from app.tenants`);
  }));

  app.patch('/api/settings', async req => run.auth(req, async ({ tx, actor, audit }) => {
    actor.require('settings.manage');
    const b = z.object({
      brandName: z.string().trim().min(1).max(40).regex(/^[^<>{}]+$/, 'has characters that are not allowed').optional(),
      legalName: z.string().trim().min(3).max(200).optional(),
      registrationNo: z.string().trim().max(80).nullable().optional(),
      city: z.string().trim().max(80).nullable().optional(),
      languages: z.array(z.enum(LANGS)).min(1).max(6).optional(),
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      assistantName: z.string().trim().min(2).max(40).optional(),
      escalationDays: z.coerce.number().int().min(1).max(90).optional(),
    }).parse(req.body);
    if (b.brandName && /\bpragath?i\s*$/i.test(b.brandName))
      fail(400, 'Leave out "Pragati": the platform name adds it, as in "JAOA Pragati".', 'invalid');
    const before = await one(tx, `select brand_name, platform_name, primary_color, languages from app.tenants`);
    const after = await one(tx, `update app.tenants set
        brand_name = coalesce($1, brand_name), legal_name = coalesce($2, legal_name),
        registration_no = case when $3::boolean then $4 else registration_no end,
        city = case when $5::boolean then $6 else city end, languages = coalesce($7, languages),
        primary_color = coalesce($8, primary_color), assistant_name = coalesce($9, assistant_name),
        escalation_days = coalesce($10, escalation_days)
      returning brand_name, platform_name, primary_color, languages`,
      [b.brandName ?? null, b.legalName ?? null, b.registrationNo !== undefined, b.registrationNo ?? null,
        b.city !== undefined, b.city ?? null, b.languages ?? null, b.primaryColor ?? null, b.assistantName ?? null, b.escalationDays ?? null]);
    clearTenantCache();
    await audit('settings.updated', 'tenant', null,
      before!.platform_name !== after!.platform_name ? `Renamed the platform to ${after!.platform_name}` : 'Updated community settings',
      { before, after });
    return after;
  }));

  app.post('/api/settings/logo', async req => run.auth(req, async c => {
    c.actor.require('settings.manage');
    const part = await req.file() ?? fail(400, 'Choose an image.', 'invalid');
    const f = await saveUpload(c, svc.storage, part!, 'logo');
    await c.tx.query('update app.tenants set logo_file_id = $1', [f.id]);
    clearTenantCache();
    await c.audit('settings.logo', 'tenant', null, 'Changed the logo', { fileId: f.id });
    return f;
  }));
}
