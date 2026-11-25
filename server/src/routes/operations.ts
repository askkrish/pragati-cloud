// Routines and the daily checklist.
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../actor.ts';
import type { Runner, Services } from '../app.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';
import { IN_SCOPE, isStaff, manages, myHomes, nodeRef, personExists, routineDays, scheduleSummary, seeScopes,
  visibleRoutines } from '../services/operations.ts';
import { addDays, daysBetween, isLate, localNow, normalise, occursOn, versionOn, zonedInstant } from '../services/schedule.ts';
import { date, idParam, text, uuid, z } from './z.ts';

export const CATEGORIES = ['security', 'housekeeping', 'garden', 'electrical', 'plumbing', 'lifts', 'water', 'fire_safety', 'pool',
  'waste', 'general'] as const;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');

const scheduleInput = z.object({
  frequency: z.enum(['once', 'daily', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'annually']),
  every: z.coerce.number().int().min(1).max(366).default(1),
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).max(7).default([]),
  monthDays: z.array(z.coerce.number().int().min(1).max(31)).max(31).default([]),
  startsOn: date,
  endsOn: date.nullable().optional(),
  startTime: time.nullable().optional(),
  endTime: time.nullable().optional(),
  paused: z.boolean().default(false),
  remarks: z.enum(['optional', 'required', 'exception']).default('exception'),
  readingLabel: z.string().trim().max(50).nullable().optional().transform(v => v || null),
  readingUnit: z.string().trim().max(16).nullable().optional().transform(v => v || null),
  photoRequired: z.boolean().default(false),
  referenceRequired: z.boolean().default(false),
  effectiveFrom: date.optional(),
}).superRefine((s, ctx) => {
  const err = (message: string) => ctx.addIssue({ code: 'custom', message });
  const maxEvery = ({ daily: 366, weekly: 52, monthly: 12 } as Record<string, number>)[s.frequency] ?? 1;
  if (s.every > maxEvery) err(`can repeat at most every ${maxEvery} for this frequency`);
  if (s.frequency === 'weekly' && !s.weekdays.length) err('choose at least one day of the week');
  if (['monthly', 'quarterly', 'half_yearly', 'annually'].includes(s.frequency) && !s.monthDays.length) err('choose the days of the month');
  if (s.endsOn && s.endsOn < s.startsOn) err('the end date must be on or after the start date');
  if (s.endTime && (!s.startTime || s.endTime <= s.startTime)) err('the closing time must be after the start time');
  if (s.readingUnit && !s.readingLabel) err('name the reading before giving its unit');
});
type ScheduleInput = z.infer<typeof scheduleInput>;

async function communityNow(tx: Tx) {
  const t = await one(tx, `select timezone from app.tenants`);
  return { tz: t!.timezone as string, ...localNow(t!.timezone) };
}

async function saveSchedule(tx: Tx, routineId: string, s: ScheduleInput, effectiveFrom: string, personId: string) {
  const weekly = s.frequency === 'weekly', monthly = ['monthly', 'quarterly', 'half_yearly', 'annually'].includes(s.frequency);
  await tx.query(`insert into app.routine_schedules (routine_id, effective_from, frequency, every, weekdays, month_days, starts_on, ends_on,
      start_time, end_time, paused, remarks, reading_label, reading_unit, photo_required, reference_required, created_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    on conflict (tenant_id, routine_id, effective_from) do update set frequency = excluded.frequency, every = excluded.every,
      weekdays = excluded.weekdays, month_days = excluded.month_days, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
      start_time = excluded.start_time, end_time = excluded.end_time, paused = excluded.paused, remarks = excluded.remarks,
      reading_label = excluded.reading_label, reading_unit = excluded.reading_unit, photo_required = excluded.photo_required,
      reference_required = excluded.reference_required, created_by = excluded.created_by, created_at = now()`,
    [routineId, effectiveFrom, s.frequency, ['daily', 'weekly', 'monthly'].includes(s.frequency) ? s.every : 1,
      weekly ? [...new Set(s.weekdays)] : [], monthly ? [...new Set(s.monthDays)] : [], s.startsOn, s.endsOn ?? null,
      s.startTime ?? null, s.endTime ?? null, s.paused, s.remarks, s.readingLabel, s.readingUnit, s.photoRequired, s.referenceRequired, personId]);
}

async function loadRoutine(tx: Tx, actor: Actor, id: string) {
  const [r] = await visibleRoutines(tx, actor, { id, includeArchived: true });
  return r ?? notFound('That routine');
}
const canRecord = (actor: Actor, r: any) => {
  const node = { id: r.node_id, ancestor_ids: r.ancestor_ids };
  return manages(actor, node) || r.assignee_person_id === actor.personId || r.backup_person_id === actor.personId
    || actor.can('operations.update', node);
};

export async function operationsRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  // The checklist for one day: every routine due that day, with its status.
  app.get('/api/ops/today', async req => run.auth(req, async ({ tx, actor }) => {
    if (!isStaff(actor)) forbidden();
    const now = await communityNow(tx);
    const q = z.object({ date: date.optional(), place: uuid.optional() }).parse(req.query);
    const day = q.date ?? now.day;
    if (Math.abs(daysBetween(now.day, day)) > 400) fail(400, 'Choose a date within a year.', 'invalid');
    // A place's QR code opens the checks for that place and the places inside it.
    const routines = (await visibleRoutines(tx, actor)).filter(r => !q.place || r.node_id === q.place || (r.ancestor_ids ?? []).includes(q.place));
    const placeName = q.place ? (await one(tx, `select name from app.property_nodes where id = $1`, [q.place]))?.name ?? null : null;
    const rows = await routineDays(tx, routines, day, day, now);
    const count = (s: string) => rows.filter(r => r.status === s).length;
    return { date: day, today: now.day, minute: now.minute, place: q.place ? { id: q.place, name: placeName } : null,
      counts: { scheduled: rows.length, done: count('done'), missed: count('missed'), due: count('due'), skipped: count('skipped'),
        blocked: count('blocked'), late: rows.filter(r => r.late).length },
      rows: rows.map(r => ({ ...r, canRecord: canRecord(actor, routines.find(x => x.id === r.routine_id)) && day <= now.day })) };
  }));

  app.get('/api/routines', async req => run.auth(req, async ({ tx, actor }) => {
    if (!isStaff(actor)) forbidden();
    const now = await communityNow(tx);
    const routines = await visibleRoutines(tx, actor);
    const versions = await many(tx, `select * from app.routine_schedules where routine_id = any ($1)`, [routines.map(r => r.id)]);
    const days = await routineDays(tx, routines, addDays(now.day, -29), now.day, now);
    return routines.map(r => {
      const mine = days.filter(d => d.routine_id === r.id && d.status !== 'upcoming' && d.status !== 'due');
      return { id: r.id, ref: r.ref, title: r.title, category: r.category, place: r.place, node_id: r.node_id, ancestor_ids: r.ancestor_ids, asset: r.asset, assignee: r.assignee,
        backup: r.backup, schedule: scheduleSummary(versions.filter(v => v.routine_id === r.id), now.day),
        last30: { due: mine.length, done: mine.filter(d => d.status === 'done').length, missed: mine.filter(d => d.status === 'missed').length,
          late: mine.filter(d => d.late).length } };
    });
  }));

  app.get('/api/routines/:id', async req => run.auth(req, async ({ tx, actor }) => {
    const { id } = idParam.parse(req.params);
    const r = await loadRoutine(tx, actor, id);
    const now = await communityNow(tx);
    const versions = await many(tx, `select s.*, p.full_name as by from app.routine_schedules s
      left join app.people p on p.tenant_id = s.tenant_id and p.id = s.created_by where s.routine_id = $1 order by s.effective_from desc`, [id]);
    const days = await routineDays(tx, [r], addDays(now.day, -29), addDays(now.day, 14), now);
    const node = { id: r.node_id, ancestor_ids: r.ancestor_ids };
    return { id: r.id, ref: r.ref, title: r.title, instructions: r.instructions, category: r.category, nodeId: r.node_id, place: r.place,
      assetId: r.asset_id, asset: r.asset, assigneeId: r.assignee_person_id, assignee: r.assignee, backupId: r.backup_person_id, backup: r.backup,
      archivedAt: r.archived_at, today: now.day,
      schedule: scheduleSummary(versions, now.day),
      current: versionOn(versions.map(normalise), now.day) ?? normalise(versions[versions.length - 1]),
      versions: versions.map(v => ({ ...normalise(v), by: v.by, summary: scheduleSummary([v], normalise(v).effective_from) })),
      days, canManage: manages(actor, node), canRecord: canRecord(actor, r) };
  }));

  const routineBody = z.object({
    title: text(120), instructions: z.string().trim().max(4000).default(''), category: z.enum(CATEGORIES).default('general'),
    nodeId: uuid, assetId: uuid.nullable().optional(), assigneeId: uuid.nullable().optional(), backupId: uuid.nullable().optional(),
    schedule: scheduleInput,
  });

  app.post('/api/routines', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = routineBody.parse(req.body);
    const node = await nodeRef(tx, b.nodeId);
    if (!manages(actor, node)) forbidden();
    await personExists(tx, b.assigneeId); await personExists(tx, b.backupId);
    if (b.assigneeId && b.assigneeId === b.backupId) fail(400, 'Choose a different backup person.', 'invalid');
    const ref = (await one(tx, `select app.next_ref('routine', 'RT') as ref`))!.ref;
    const r = await one(tx, `insert into app.routines (ref, title, instructions, category, node_id, asset_id, assignee_person_id, backup_person_id, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [ref, b.title, b.instructions, b.category, node.id, b.assetId ?? null, b.assigneeId ?? null, b.backupId ?? null, actor.personId]);
    await saveSchedule(tx, r.id, b.schedule, b.schedule.startsOn, actor.personId);
    await audit('routine.created', 'routine', r.id, `${ref} set up: ${b.title}`, { nodeId: node.id });
    return { id: r.id, ref };
  }));

  app.patch('/api/routines/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const r = await loadRoutine(tx, actor, id);
    if (!manages(actor, { id: r.node_id, ancestor_ids: r.ancestor_ids })) forbidden();
    const b = routineBody.partial().parse(req.body);
    if (b.nodeId && b.nodeId !== r.node_id && !manages(actor, await nodeRef(tx, b.nodeId))) forbidden();
    if (b.assigneeId !== undefined) await personExists(tx, b.assigneeId);
    if (b.backupId !== undefined) await personExists(tx, b.backupId);
    const now = await communityNow(tx);
    await tx.query(`update app.routines set title = coalesce($2, title), instructions = coalesce($3, instructions), category = coalesce($4, category),
        node_id = coalesce($5, node_id),
        asset_id = case when $6 then $7 else asset_id end, assignee_person_id = case when $8 then $9 else assignee_person_id end,
        backup_person_id = case when $10 then $11 else backup_person_id end where id = $1`,
      [id, b.title ?? null, b.instructions ?? null, b.category ?? null, b.nodeId ?? null, b.assetId !== undefined, b.assetId ?? null,
        b.assigneeId !== undefined, b.assigneeId ?? null, b.backupId !== undefined, b.backupId ?? null]);
    if (b.schedule) {
      // A schedule change applies from a day that has not passed, so days already judged stay as they were.
      const from = b.schedule.effectiveFrom ?? now.day;
      if (from < now.day) fail(400, 'A schedule change can start today or later, not in the past.', 'invalid');
      await saveSchedule(tx, id, b.schedule, from, actor.personId);
    }
    await audit('routine.updated', 'routine', id, `${r.ref} changed${b.schedule ? `; new schedule from ${b.schedule.effectiveFrom ?? now.day}` : ''}`,
      { changed: Object.keys(b) });
    return { ok: true };
  }));

  app.post('/api/routines/:id/archive', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const r = await loadRoutine(tx, actor, id);
    if (!manages(actor, { id: r.node_id, ancestor_ids: r.ancestor_ids })) forbidden();
    const b = z.object({ reason: z.string().trim().max(300).default('') }).parse(req.body ?? {});
    await tx.query(`update app.routines set archived_at = case when archived_at is null then now() else null end where id = $1`, [id]);
    await audit(r.archived_at ? 'routine.restored' : 'routine.archived', 'routine', id, `${r.ref} ${r.archived_at ? 'restored' : 'stopped'}`, { reason: b.reason });
    return { ok: true };
  }));

  // Record what happened on one scheduled day.
  app.put('/api/routines/:id/checks/:day', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id, day } = z.object({ id: uuid, day: date }).parse(req.params);
    const b = z.object({
      status: z.enum(['done', 'skipped', 'blocked', 'in_progress']),
      performedAt: time.nullable().optional(),
      note: z.string().trim().max(2400).default(''),
      reading: z.union([z.number(), z.string()]).nullable().optional(),
      reference: z.string().trim().max(120).nullable().optional().transform(v => v || null),
      photoFileId: uuid.nullable().optional(),
      raiseWorkOrder: z.boolean().default(false),
    }).parse(req.body);
    const r = await loadRoutine(tx, actor, id);
    if (r.archived_at) fail(409, 'This routine has been stopped.', 'closed');
    if (!canRecord(actor, r)) forbidden();
    const now = await communityNow(tx);
    const node = { id: r.node_id, ancestor_ids: r.ancestor_ids };
    if (day > now.day) fail(400, 'You can record a check on its day or afterwards, not before.', 'invalid');
    const back = daysBetween(day, now.day);
    if (back > (manages(actor, node) ? 400 : 30)) fail(400, 'That day is too far back to record. Ask the facility manager.', 'invalid');

    const versions = (await many(tx, `select * from app.routine_schedules where routine_id = $1`, [id])).map(normalise);
    const s = versionOn(versions, day);
    const previous = await one(tx, `select * from app.routine_checks where routine_id = $1 and occurrence_on = $2`, [id, day]);
    if (!s || (!previous && !occursOn(s, day))) fail(400, 'This routine is not scheduled on that day.', 'invalid');

    if (['skipped', 'blocked'].includes(b.status) && !b.note) fail(400, b.status === 'skipped' ? 'Give the reason for skipping.' : 'Say what is blocking the work.', 'invalid');
    let performedAt: Date | null = null, late = false;
    let reading: string | null = previous?.reading ?? null;
    if (b.reading !== undefined && b.reading !== null && String(b.reading).trim() !== '') {
      const v = String(b.reading).trim();
      if (!/^-?\d{1,12}(\.\d{1,6})?$/.test(v)) fail(400, 'Enter the reading as a number.', 'invalid');
      reading = v;
    }
    const reference = b.reference ?? previous?.reference ?? null;
    let photo = previous?.photo_file_id ?? null;
    if (b.photoFileId) {
      const f = await one(tx, `select id from app.files where id = $1 and purpose = 'work_photo' and uploaded_by = $2`, [b.photoFileId, actor.personId]);
      if (!f) fail(400, 'Upload the photo again.', 'invalid');
      photo = b.photoFileId;
    }
    if (b.status === 'done' && s) {
      const minute = b.performedAt ?? (day === now.day ? now.minute : null);
      if (!minute) fail(400, 'Enter the time the work was done.', 'invalid');
      if (day === now.day && minute! > now.minute) fail(400, 'The time the work was done cannot be later than now.', 'invalid');
      performedAt = zonedInstant(day, minute!, now.tz);
      late = isLate(s, day, { day, minute: minute! });
      if (s.remarks === 'required' && !b.note && !previous?.note) fail(400, 'Add the completion remarks this routine asks for.', 'invalid');
      if (s.reading_label && reading === null) fail(400, `Enter the ${s.reading_label.toLowerCase()} reading.`, 'invalid');
      if (s.reference_required && !reference) fail(400, 'Enter the reference number this routine asks for.', 'invalid');
      if (s.photo_required && !photo) fail(400, 'Attach the photo this routine asks for.', 'invalid');
    }

    let workOrderId = previous?.work_order_id ?? null;
    if (b.raiseWorkOrder && b.status === 'blocked' && !workOrderId) {
      const ref = (await one(tx, `select app.next_ref('work', 'WO') as ref`))!.ref;
      const wo = await one(tx, `insert into app.work_orders (ref, kind, title, details, category, priority, node_id, asset_id, routine_id, occurrence_on, raised_by)
        values ($1, 'maintenance', $2, $3, $4, 'high', $5, $6, $7, $8, $9) returning id`,
        [ref, `${r.title}: could not be done`.slice(0, 200), b.note, r.category, r.node_id, r.asset_id, id, day, actor.personId]);
      await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, to_status) values ($1, $2, 'created', $3, 'open')`,
        [wo!.id, actor.personId, `Raised from ${r.ref} on ${day}`]);
      workOrderId = wo!.id;
      await audit('work.created', 'work_order', wo!.id, `${ref} raised from a blocked check of ${r.ref}`);
    }

    const note = b.note || (previous && b.status === previous.status ? previous.note : '');
    await tx.query(`insert into app.routine_checks (routine_id, occurrence_on, status, performed_at, note, reading, reference, photo_file_id, late, work_order_id, recorded_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      on conflict (tenant_id, routine_id, occurrence_on) do update set status = excluded.status, performed_at = excluded.performed_at,
        note = excluded.note, reading = excluded.reading, reference = excluded.reference, photo_file_id = excluded.photo_file_id,
        late = excluded.late, work_order_id = excluded.work_order_id, recorded_by = excluded.recorded_by, recorded_at = now()`,
      [id, day, b.status, performedAt, note, reading, reference, photo, late, workOrderId, actor.personId]);
    const label = { done: late ? 'done late' : 'done', skipped: 'skipped', blocked: 'blocked', in_progress: 'started' }[b.status];
    await audit('routine.checked', 'routine', id, `${r.ref} on ${day}: ${label}`,
      { day, status: b.status, late, previous: previous ? { status: previous.status, note: previous.note } : null });
    return { ok: true, late, workOrderId };
  }));

  // What the home page shows about operations.
  app.get('/api/ops/summary', async req => run.auth(req, async ({ tx, actor }) => {
    const out: Record<string, unknown> = {};
    const requests = await many(tx, `select w.id, w.ref, w.title, w.status, w.created_at from app.work_orders w
      where w.raised_by = $1 and w.kind = 'request' and (w.status not in ('closed', 'cancelled') or w.closed_at > now() - interval '14 days')
      order by w.created_at desc limit 5`, [actor.personId]);
    out.myRequests = requests;
    out.canRaiseRequest = (await myHomes(tx, actor.personId)).length > 0;
    if (!isStaff(actor)) return out;
    const now = await communityNow(tx);
    const routines = await visibleRoutines(tx, actor);
    const week = await routineDays(tx, routines, addDays(now.day, -6), now.day, now);
    const today = week.filter(d => d.day === now.day);
    out.checks = { scheduled: today.length, done: today.filter(d => d.status === 'done').length,
      due: today.filter(d => d.status === 'due').length, missed: today.filter(d => d.status === 'missed').length,
      missed7: week.filter(d => d.status === 'missed').length, late7: week.filter(d => d.late).length };
    const scopes = seeScopes(actor);
    out.work = await one(tx, `select count(*) filter (where w.status not in ('done', 'closed', 'cancelled'))::int as open,
        count(*) filter (where w.status not in ('done', 'closed', 'cancelled') and w.due_on < $3::date)::int as overdue,
        count(*) filter (where w.status = 'new')::int as new_requests,
        count(*) filter (where w.status not in ('done', 'closed', 'cancelled') and w.assignee_person_id = $2)::int as mine,
        count(*) filter (where w.status = 'done')::int as to_verify
      from app.work_orders w join app.property_nodes n on n.tenant_id = w.tenant_id and n.id = w.node_id
      where ${IN_SCOPE(1)} or w.assignee_person_id = $2`, [scopes, actor.personId, now.day]);
    if (scopes === null || scopes.length) {
      out.renewals = await one(tx, `select count(*) filter (where c.ends_on < $2::date)::int as overdue,
          count(*) filter (where c.ends_on >= $2::date and c.ends_on <= $2::date + c.remind_days)::int as due_soon
        from app.asset_contracts c join app.property_nodes n on n.tenant_id = c.tenant_id and n.id = c.node_id
        where c.renewed_by is null and c.archived_at is null and ${IN_SCOPE(1)}`, [scopes, now.day]);
    }
    return out;
  }));

  // People who can be given routines and work: anyone with an operations permission.
  app.get('/api/ops/people', async req => run.auth(req, async ({ tx, actor }) => {
    if (!isStaff(actor)) forbidden();
    return many(tx, `select p.id, p.full_name, string_agg(distinct r.name, ', ') as role from app.people p
      join app.memberships m on m.tenant_id = p.tenant_id and m.person_id = p.id and m.status = 'active'
      join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id and r.archived_at is null
      where p.archived_at is null and r.permissions && array['operations.update', 'operations.manage']
      group by p.id, p.full_name order by p.full_name`);
  }));
}

