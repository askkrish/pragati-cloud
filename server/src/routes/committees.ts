import type { FastifyInstance } from 'fastify';
import { getNode } from '../actor.ts';
import type { Runner, Services } from '../app.ts';
import { many, one } from '../db.ts';
import { fail, notFound } from '../errors.ts';
import { reevaluateCommittee } from '../services/approvals.ts';
import { date, idParam, text, uuid, z } from './z.ts';

const POSITIONS = ['president', 'vice_president', 'secretary', 'joint_secretary', 'treasurer', 'member'] as const;

export async function committeeRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  app.get('/api/committees', async req => run.auth(req, async ({ tx, actor }) => {
    actor.require('committees.view', null);
    const committees = await many(tx, `select c.id, c.name, c.kind, c.scope_node_id, n.name as scope, c.parent_committee_id
      from app.committees c join app.property_nodes n on n.tenant_id = c.tenant_id and n.id = c.scope_node_id
      where c.archived_at is null order by n.depth, c.kind, c.name`);
    const seats = await many(tx, `select s.id, s.committee_id, s.position, s.starts_on, p.id as person_id, p.full_name, p.photo_file_id
      from app.committee_seats s join app.people p on p.tenant_id = s.tenant_id and p.id = s.person_id
      where s.ends_on is null order by array_position(array['president','vice_president','secretary','joint_secretary','treasurer','member'], s.position), p.full_name`);
    return committees.map(c => ({ ...c, seats: seats.filter(s => s.committee_id === c.id) }));
  }));

  app.post('/api/committees', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = z.object({ name: text(80), kind: z.enum(['apex', 'federation', 'block', 'sub_committee']), scopeNodeId: uuid,
      parentCommitteeId: uuid.nullable().optional() }).parse(req.body);
    const node = await getNode(tx, b.scopeNodeId);
    actor.require('committees.manage', node);
    const c = await one(tx, `insert into app.committees (name, kind, scope_node_id, parent_committee_id) values ($1, $2, $3, $4) returning *`,
      [b.name, b.kind, node.id, b.parentCommitteeId ?? null]);
    await audit('committee.created', 'committee', c.id, `Created ${c.name} for ${node.name}`);
    return c;
  }));

  app.post('/api/committees/:id/seats', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ personId: uuid, position: z.enum(POSITIONS).default('member'), startsOn: date.optional() }).parse(req.body);
    const c = await one(tx, `select c.*, n.ancestor_ids from app.committees c join app.property_nodes n
      on n.tenant_id = c.tenant_id and n.id = c.scope_node_id where c.id = $1 and c.archived_at is null`, [id]) ?? notFound('That committee');
    actor.require('committees.manage', { id: c.scope_node_id, ancestor_ids: c.ancestor_ids });
    const p = await one(tx, `select id, full_name from app.people where id = $1 and archived_at is null`, [b.personId]) ?? notFound('That person');
    const s = await one(tx, `insert into app.committee_seats (committee_id, person_id, position, starts_on)
      values ($1, $2, $3, coalesce($4::date, current_date)) returning *`, [id, p.id, b.position, b.startsOn ?? null]);
    await audit('committee.seat_added', 'committee', id, `${p.full_name} joined ${c.name} as ${b.position.replace('_', ' ')}`);
    return s;
  }));

  // Ending a seat can settle requests that were waiting only on that member.
  app.post('/api/seats/:id/end', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ reason: z.string().max(300).default('') }).parse(req.body ?? {});
    const s = await one(tx, `select s.*, c.name, c.scope_node_id, n.ancestor_ids, p.full_name from app.committee_seats s
      join app.committees c on c.tenant_id = s.tenant_id and c.id = s.committee_id
      join app.property_nodes n on n.tenant_id = c.tenant_id and n.id = c.scope_node_id
      join app.people p on p.tenant_id = s.tenant_id and p.id = s.person_id where s.id = $1`, [id]) ?? notFound('That seat');
    if (s.ends_on) fail(409, 'That seat has already ended.');
    actor.require('committees.manage', { id: s.scope_node_id, ancestor_ids: s.ancestor_ids });
    await tx.query(`update app.committee_seats set ends_on = greatest(current_date, starts_on) where id = $1`, [id]);
    const settled = await reevaluateCommittee(tx, s.committee_id);
    await audit('committee.seat_ended', 'committee', s.committee_id, `${s.full_name} left ${s.name}`, { reason: b.reason, rechecked: settled });
    return { ok: true, rechecked: settled };
  }));
}
