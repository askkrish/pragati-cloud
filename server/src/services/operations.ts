// Shared rules for the operations modules: who sees what, and how a routine's days are laid out.
import type { Actor, NodeRef } from '../actor.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, notFound } from '../errors.ts';
import { addDays, dayStatus, describe, normalise, occursOn, versionOn, type Schedule } from './schedule.ts';

// "Sky A › East wing › Floor 3" for a node aliased as n; the community itself for the root.
export const PLACE = (n = 'n') => `coalesce(nullif((select string_agg(a.name, ' › ' order by a.depth) from app.property_nodes a
  where a.tenant_id = ${n}.tenant_id and a.id = any (${n}.ancestor_ids || ${n}.id) and a.depth > 0), ''), ${n}.name)`;

// Locations where the person sees all operations: null = everywhere, [] = nowhere (they then see
// only what is given to them or raised by them).
export function seeScopes(actor: Actor): string[] | null {
  const gs = actor.grants.filter(g => g.perms.has('operations.view') || g.perms.has('operations.manage'));
  if (gs.some(g => g.scope === null)) return null;
  return [...new Set(gs.map(g => g.scope as string))];
}
// SQL for "this node is inside one of $p's locations" where $p comes from seeScopes.
export const IN_SCOPE = (p: number, n = 'n') => `($${p}::uuid[] is null or ${n}.id = any ($${p}) or ${n}.ancestor_ids && $${p})`;

export const sees = (actor: Actor, node: NodeRef) => actor.can('operations.view', node) || actor.can('operations.manage', node);
export const manages = (actor: Actor, node: NodeRef) => actor.can('operations.manage', node);
export const isStaff = (actor: Actor) => ['operations.view', 'operations.update', 'operations.manage'].some(p => actor.canAnywhere(p));

export async function personExists(tx: Tx, id: string | null | undefined) {
  if (!id) return null;
  const p = await one(tx, `select id, full_name from app.people where id = $1 and archived_at is null`, [id]);
  return p ?? fail(400, 'Choose a person from the directory.', 'invalid');
}

export async function nodeRef(tx: Tx, id: string) {
  return await one<NodeRef & { name: string }>(tx, `select id, ancestor_ids, name from app.property_nodes where id = $1 and archived_at is null`, [id])
    ?? notFound('That location');
}

// Homes the person owns or lives in now.
export async function myHomes(tx: Tx, personId: string) {
  return many(tx, `select u.id, u.label, u.node_id from app.units u where u.archived_at is null and u.id in (
      select unit_id from app.ownerships where person_id = $1 and ends_on is null
      union select unit_id from app.occupancies where person_id = $1 and ends_on is null)`, [personId]);
}

export type RoutineRow = { routine_id: string; ref: string; title: string; category: string; place: string; node_id: string;
  asset: string | null; assignee: string | null; assignee_id: string | null; backup_id: string | null; day: string;
  start_time: string | null; end_time: string | null; status: string; late: boolean; check: any | null; needs: any };

// Every scheduled day of the given routines between two days, newest first, with its status.
export async function routineDays(tx: Tx, routines: any[], from: string, to: string, now: { day: string; minute: string }): Promise<RoutineRow[]> {
  if (!routines.length) return [];
  const ids = routines.map(r => r.id);
  const versions = (await many(tx, `select * from app.routine_schedules where routine_id = any ($1)`, [ids])).map(normalise);
  const checks = await many(tx, `select c.*, p.full_name as recorded_by_name from app.routine_checks c
      join app.people p on p.tenant_id = c.tenant_id and p.id = c.recorded_by
     where c.routine_id = any ($1) and c.occurrence_on between $2 and $3`, [ids, from, to]);
  const byKey = new Map(checks.map(c => [`${c.routine_id}/${c.occurrence_on}`, c]));
  const vs = new Map<string, Schedule[]>();
  for (const v of versions) vs.set((v as any).routine_id, [...(vs.get((v as any).routine_id) ?? []), v]);
  const out: RoutineRow[] = [];
  for (let day = to; day >= from; day = addDays(day, -1)) {
    for (const r of routines) {
      const check = byKey.get(`${r.id}/${day}`) ?? null;
      const s = versionOn(vs.get(r.id) ?? [], day);
      if (!s || (!check && !occursOn(s, day))) continue;
      out.push({ routine_id: r.id, ref: r.ref, title: r.title, category: r.category, place: r.place, node_id: r.node_id,
        asset: r.asset ?? null, assignee: r.assignee ?? null, assignee_id: r.assignee_person_id, backup_id: r.backup_person_id, day,
        start_time: s.start_time, end_time: s.end_time, status: dayStatus(s, day, check, now), late: !!check?.late,
        check: check && { status: check.status, note: check.note, reading: check.reading, reference: check.reference,
          performed_at: check.performed_at, recorded_by: check.recorded_by_name, recorded_at: check.recorded_at,
          photo_file_id: check.photo_file_id, work_order_id: check.work_order_id },
        needs: { remarks: s.remarks, reading: s.reading_label ? { label: s.reading_label, unit: s.reading_unit } : null,
          photo: s.photo_required, reference: s.reference_required } });
    }
  }
  return out.sort((a, b) => b.day.localeCompare(a.day) || (a.start_time ?? '99').localeCompare(b.start_time ?? '99') || a.title.localeCompare(b.title));
}

// Routines the person may see, as rows ready for routineDays.
export async function visibleRoutines(tx: Tx, actor: Actor, opts: { id?: string; includeArchived?: boolean } = {}) {
  return many(tx, `select r.*, ${PLACE()} as place, n.ancestor_ids, a.name as asset, p.full_name as assignee, b.full_name as backup
      from app.routines r join app.property_nodes n on n.tenant_id = r.tenant_id and n.id = r.node_id
      left join app.assets a on a.tenant_id = r.tenant_id and a.id = r.asset_id
      left join app.people p on p.tenant_id = r.tenant_id and p.id = r.assignee_person_id
      left join app.people b on b.tenant_id = r.tenant_id and b.id = r.backup_person_id
     where ($1::uuid is null or r.id = $1) and ($2::boolean or r.archived_at is null)
       and (${IN_SCOPE(3)} or r.assignee_person_id = $4 or r.backup_person_id = $4)
     order by r.title`, [opts.id ?? null, !!opts.includeArchived, seeScopes(actor), actor.personId]);
}

export const scheduleSummary = (versions: any[], day: string) => {
  const s = versionOn(versions.map(normalise), day) ?? versions.map(normalise).sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
  return s ? describe(s) : 'No schedule';
};
