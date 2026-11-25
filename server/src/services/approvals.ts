// The approval engine. Which committee decides, and how many of its members must agree, comes from
// the community's approval rules (settings), never from code.
//
// Carried over from JAOA Pragati:
//   * the proposer's own approval counts when they sit on the deciding committee
//   * the people asked to vote are frozen when a stage opens; anyone who leaves the committee
//     afterwards stops counting, so a departure never leaves a request stuck
//   * an objection needs a reason, and a member can change their vote while the request is open
//   * an office bearer can record approval by uploading a letter signed by the committee
//   * only one open request per subject
// New for large communities:
//   * rules are matched by subject, amount band and location, so a block's own costs go to that
//     block's committee and larger amounts add a second stage at the apex committee
//   * modes: unanimous, majority, a fixed count, or any one member
import type { Actor, NodeRef } from '../actor.ts';
import { getNode } from '../actor.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, forbidden, notFound } from '../errors.ts';

export type Mode = 'unanimous' | 'majority' | 'count' | 'any';
export type Selector = 'fixed' | 'nearest' | 'apex';

export function requiredVotes(mode: Mode, activeVoters: number, requiredCount: number | null): number {
  if (activeVoters === 0) return Infinity;
  switch (mode) {
    case 'unanimous': return activeVoters;
    case 'majority': return Math.floor(activeVoters / 2) + 1;
    case 'count': return Math.min(requiredCount ?? 1, activeVoters);
    case 'any': return 1;
  }
}

const STRICTNESS: Record<Mode, number> = { any: 1, count: 2, majority: 2, unanimous: 3 };

const path = (node: NodeRef) => [...node.ancestor_ids, node.id];

export async function findRule(tx: Tx, subjectType: string, amountPaise: string | null, node: NodeRef) {
  const rule = await one(tx,
    `select r.* from app.approval_rules r
      where r.active and (r.subject_type = $1 or r.subject_type = '*')
        and r.min_amount_paise <= $2::bigint and (r.max_amount_paise is null or $2::bigint < r.max_amount_paise)
        and (r.scope_node_id is null or r.scope_node_id = any ($3::uuid[]))
      order by array_position($3::uuid[], r.scope_node_id) desc nulls last,
               (r.subject_type = '*'), r.priority desc, r.min_amount_paise desc, r.created_at
      limit 1`,
    [subjectType, amountPaise ?? '0', path(node)]);
  if (!rule) return null;
  const stages = await many(tx,
    `select stage_no, label, committee_selector, committee_id, mode, required_count
       from app.approval_rule_stages where rule_id = $1 order by stage_no`, [rule.id]);
  return { ...rule, stages };
}

export async function resolveCommittee(tx: Tx, selector: Selector, committeeId: string | null, node: NodeRef) {
  if (selector === 'fixed') {
    return one(tx, `select id, name, kind, scope_node_id from app.committees where id = $1 and archived_at is null`, [committeeId]);
  }
  const kinds = selector === 'apex' ? ['apex', 'federation'] : ['apex', 'federation', 'block'];
  return one(tx,
    `select c.id, c.name, c.kind, c.scope_node_id from app.committees c
      where c.archived_at is null and c.kind = any ($2::text[]) and c.scope_node_id = any ($1::uuid[])
      order by array_position($1::uuid[], c.scope_node_id) desc, c.created_at limit 1`,
    [path(node), kinds]);
}

async function seatedPeople(tx: Tx, committeeId: string): Promise<string[]> {
  const rows = await many(tx,
    `select s.person_id from app.committee_seats s
       join app.people p on p.tenant_id = s.tenant_id and p.id = s.person_id and p.archived_at is null
      where s.committee_id = $1 and s.ends_on is null and s.starts_on <= current_date`, [committeeId]);
  return rows.map(r => r.person_id);
}

// Resolves each stage's committee. When two stages in a row land on the same committee (a request
// raised for the whole community, say, where "nearest" and "apex" are the same body), it decides
// once, under the stricter of the two requirements.
async function planStages(tx: Tx, rule: any, node: NodeRef, strict: boolean) {
  const plan: { stage: any; committee: any }[] = [];
  for (const s of rule.stages) {
    const c = await resolveCommittee(tx, s.committee_selector, s.committee_id, node);
    if (!c) {
      if (strict) fail(400, `Stage ${s.stage_no} of "${rule.name}" has no committee for this location.`, 'no_committee');
      plan.push({ stage: s, committee: null });
      continue;
    }
    const prev = plan[plan.length - 1];
    if (prev?.committee && prev.committee.id === c.id) {
      if (STRICTNESS[s.mode as Mode] > STRICTNESS[prev.stage.mode as Mode]) prev.stage = { ...s, stage_no: prev.stage.stage_no };
      continue;
    }
    plan.push({ stage: s, committee: c });
  }
  return plan;
}

// Shows which rule, committees and voters a request would get, before anyone raises it.
export async function previewRoute(tx: Tx, subjectType: string, amountPaise: string | null, nodeId: string | null) {
  const node = await getNode(tx, nodeId);
  const rule = await findRule(tx, subjectType, amountPaise, node);
  if (!rule) return { rule: null, stages: [] };
  const stages = [];
  for (const [i, { stage: s, committee }] of (await planStages(tx, rule, node, false)).entries()) {
    const voters = committee ? await seatedPeople(tx, committee.id) : [];
    stages.push({ stageNo: i + 1, label: s.label, mode: s.mode, requiredCount: s.required_count,
      committee: committee ? { id: committee.id, name: committee.name } : null, voters: voters.length,
      required: committee ? requiredVotes(s.mode, voters.length, s.required_count) : null });
  }
  return { rule: { id: rule.id, name: rule.name }, stages };
}

type ProposeInput = { subjectType: string; subjectId?: string | null; title: string; details?: string;
  amountPaise?: string | null; scopeNodeId?: string | null };

export async function propose(tx: Tx, actor: Actor, input: ProposeInput) {
  const node = await getNode(tx, input.scopeNodeId);
  actor.require('approvals.propose', node);
  if (input.subjectId) {
    const open = await one(tx, `select ref from app.approval_requests
      where subject_type = $1 and subject_id = $2 and status = 'pending'`, [input.subjectType, input.subjectId]);
    if (open) fail(409, `This is already waiting for approval as ${open.ref}.`, 'duplicate');
  }
  const rule = await findRule(tx, input.subjectType, input.amountPaise ?? null, node)
    ?? fail(400, 'No approval rule covers this request. Ask your administrator to add one under Approval rules.', 'no_rule');
  if (!rule.stages.length) fail(400, `The rule "${rule.name}" has no stages.`, 'no_rule');

  const plan = await planStages(tx, rule, node, true);

  const ref = (await one(tx, `select app.next_ref('approval', 'AP') as ref`))!.ref;
  const snapshot = { id: rule.id, name: rule.name, version: rule.version, proposer_auto_approve: rule.proposer_auto_approve,
    allow_letter_override: rule.allow_letter_override, stages: rule.stages };
  const req = await one(tx,
    `insert into app.approval_requests (ref, subject_type, subject_id, title, details, amount_paise, scope_node_id,
        rule_id, rule_snapshot, proposer_person_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [ref, input.subjectType, input.subjectId ?? null, input.title.trim(), (input.details ?? '').trim(),
      input.amountPaise ?? null, node.id, rule.id, snapshot, actor.personId]);

  for (const [i, { stage: s, committee }] of plan.entries()) {
    await tx.query(
      `insert into app.approval_stages (request_id, stage_no, label, committee_id, mode, required_count)
       values ($1, $2, $3, $4, $5, $6)`, [req.id, i + 1, s.label, committee.id, s.mode, s.required_count]);
  }
  await openStage(tx, req.id, 1);
  return one(tx, `select id, ref, status from app.approval_requests where id = $1`, [req.id]);
}

async function openStage(tx: Tx, requestId: string, stageNo: number) {
  const stage = (await one(tx, `update app.approval_stages set status = 'open', opened_at = now()
     where request_id = $1 and stage_no = $2 returning *`, [requestId, stageNo]))!;
  await tx.query(`update app.approval_requests set current_stage = $2 where id = $1`, [requestId, stageNo]);
  const voters = await seatedPeople(tx, stage.committee_id);
  if (!voters.length) {
    const c = await one(tx, `select name from app.committees where id = $1`, [stage.committee_id]);
    fail(400, `${c?.name ?? 'The committee'} has no members, so nobody could approve this.`, 'no_voters');
  }
  for (const p of voters) {
    await tx.query(`insert into app.approval_stage_voters (request_id, stage_no, person_id) values ($1, $2, $3)`,
      [requestId, stageNo, p]);
  }
  const req = (await one(tx, `select proposer_person_id, rule_snapshot from app.approval_requests where id = $1`, [requestId]))!;
  if (req.rule_snapshot.proposer_auto_approve && voters.includes(req.proposer_person_id)) {
    await tx.query(`insert into app.approval_votes (request_id, stage_no, person_id, vote, note)
      values ($1, $2, $3, 'approve', 'Proposed this request')`, [requestId, stageNo, req.proposer_person_id]);
  }
  await evaluate(tx, requestId);
}

async function stageTally(tx: Tx, requestId: string, stageNo: number) {
  const stage = (await one(tx, `select * from app.approval_stages where request_id = $1 and stage_no = $2`, [requestId, stageNo]))!;
  const seated = new Set(await seatedPeople(tx, stage.committee_id));
  const voters = await many(tx,
    `select v.person_id, p.full_name, x.vote, x.note, x.voted_at
       from app.approval_stage_voters v
       join app.people p on p.tenant_id = v.tenant_id and p.id = v.person_id
       left join app.approval_votes x on x.tenant_id = v.tenant_id and x.request_id = v.request_id
                                     and x.stage_no = v.stage_no and x.person_id = v.person_id
      where v.request_id = $1 and v.stage_no = $2 order by p.full_name`, [requestId, stageNo]);
  const rows = voters.map(v => ({ personId: v.person_id, name: v.full_name, vote: v.vote ?? null, note: v.note ?? '',
    votedAt: v.voted_at ?? null, active: seated.has(v.person_id) }));
  const active = rows.filter(r => r.active);
  const approvals = active.filter(r => r.vote === 'approve').length;
  const objections = active.filter(r => r.vote === 'object').length;
  const required = requiredVotes(stage.mode, active.length, stage.required_count);
  return { stage, voters: rows, approvals, objections, required: Number.isFinite(required) ? required : null,
    activeCount: active.length };
}

// Settles a request as far as its votes allow: approves the open stage when enough active members
// agree, then opens the next stage or approves the request.
export async function evaluate(tx: Tx, requestId: string) {
  const req = await one(tx, `select id, status, current_stage from app.approval_requests where id = $1 for update`, [requestId]);
  if (!req || req.status !== 'pending') return;
  const t = await stageTally(tx, requestId, req.current_stage);
  if (t.stage.status !== 'open' || t.required === null || t.approvals < t.required) return;
  await tx.query(`update app.approval_stages set status = 'approved', decided_at = now()
    where request_id = $1 and stage_no = $2`, [requestId, req.current_stage]);
  const next = await one(tx, `select stage_no from app.approval_stages
    where request_id = $1 and stage_no > $2 order by stage_no limit 1`, [requestId, req.current_stage]);
  if (next) return openStage(tx, requestId, next.stage_no);
  await tx.query(`update app.approval_requests set status = 'approved', decided_at = now() where id = $1`, [requestId]);
}

// After someone leaves a committee, requests waiting on that committee may now be settled.
export async function reevaluateCommittee(tx: Tx, committeeId: string) {
  const open = await many(tx, `select s.request_id from app.approval_stages s
      join app.approval_requests r on r.tenant_id = s.tenant_id and r.id = s.request_id and r.status = 'pending'
     where s.committee_id = $1 and s.status = 'open'`, [committeeId]);
  for (const o of open) await evaluate(tx, o.request_id);
  return open.length;
}

async function loadRequest(tx: Tx, id: string) {
  return (await one(tx, `select r.*, n.ancestor_ids, n.name as scope_name, p.full_name as proposer_name
      from app.approval_requests r
      join app.property_nodes n on n.tenant_id = r.tenant_id and n.id = r.scope_node_id
      join app.people p on p.tenant_id = r.tenant_id and p.id = r.proposer_person_id
     where r.id = $1`, [id])) ?? notFound('That approval request');
}

const nodeOf = (r: { scope_node_id: string; ancestor_ids: string[] }): NodeRef => ({ id: r.scope_node_id, ancestor_ids: r.ancestor_ids });

async function isVoter(tx: Tx, requestId: string, personId: string) {
  return !!(await one(tx, `select 1 from app.approval_stage_voters where request_id = $1 and person_id = $2 limit 1`,
    [requestId, personId]));
}

export async function canSee(tx: Tx, actor: Actor, r: any) {
  return actor.can('approvals.view', nodeOf(r)) || r.proposer_person_id === actor.personId || isVoter(tx, r.id, actor.personId);
}

export async function vote(tx: Tx, actor: Actor, requestId: string, choice: 'approve' | 'object', note: string) {
  const r = await loadRequest(tx, requestId);
  if (r.status !== 'pending') fail(409, `${r.ref} has already been ${r.status}.`, 'closed');
  const t = await stageTally(tx, requestId, r.current_stage);
  const me = t.voters.find(v => v.personId === actor.personId);
  if (!me || !me.active) forbidden('Only the committee members asked to decide this stage can vote.');
  if (choice === 'object' && !note.trim()) fail(400, 'Please give a reason for the objection.', 'invalid');
  await tx.query(
    `insert into app.approval_votes (request_id, stage_no, person_id, vote, note) values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, request_id, stage_no, person_id)
     do update set vote = excluded.vote, note = excluded.note, voted_at = now()`,
    [requestId, r.current_stage, actor.personId, choice, note.trim().slice(0, 600)]);
  await evaluate(tx, requestId);
  return (await one(tx, `select ref, status, current_stage from app.approval_requests where id = $1`, [requestId]))!;
}

export async function withdraw(tx: Tx, actor: Actor, requestId: string, note: string) {
  const r = await loadRequest(tx, requestId);
  if (r.status !== 'pending') fail(409, `${r.ref} has already been ${r.status}.`, 'closed');
  if (r.proposer_person_id !== actor.personId && !actor.can('approvals.override', nodeOf(r)))
    forbidden('Only the proposer or an office bearer can withdraw this.');
  await tx.query(`update app.approval_requests set status = 'withdrawn', decided_at = now(), outcome_note = $2 where id = $1`,
    [requestId, note.trim().slice(0, 600)]);
  return r;
}

export async function reject(tx: Tx, actor: Actor, requestId: string, note: string) {
  const r = await loadRequest(tx, requestId);
  if (r.status !== 'pending') fail(409, `${r.ref} has already been ${r.status}.`, 'closed');
  actor.require('approvals.override', nodeOf(r));
  if (!note.trim()) fail(400, 'Record the committee\'s reason for rejecting this.', 'invalid');
  await tx.query(`update app.approval_requests set status = 'rejected', decided_at = now(), outcome_note = $2 where id = $1`,
    [requestId, note.trim().slice(0, 600)]);
  return r;
}

export async function overrideWithLetter(tx: Tx, actor: Actor, requestId: string, note: string, fileId: string) {
  const r = await loadRequest(tx, requestId);
  if (r.status !== 'pending') fail(409, `${r.ref} has already been ${r.status}.`, 'closed');
  actor.require('approvals.override', nodeOf(r));
  if (!r.rule_snapshot.allow_letter_override) forbidden(`The rule "${r.rule_snapshot.name}" does not allow approval by letter.`);
  if (!note.trim()) fail(400, 'Describe the signed letter, for example its date and who signed it.', 'invalid');
  const file = await one(tx, `select id from app.files where id = $1 and purpose = 'approval_letter'`, [fileId])
    ?? fail(400, 'Upload the signed letter first.', 'invalid');
  const override = { byPersonId: actor.personId, byName: actor.name, at: new Date().toISOString(), note: note.trim().slice(0, 600), fileId: file.id };
  await tx.query(`update app.approval_requests set status = 'approved', decided_at = now(), override = $2 where id = $1`,
    [requestId, override]);
  await tx.query(`update app.approval_stages set status = 'approved', decided_at = now()
    where request_id = $1 and status <> 'approved'`, [requestId]);
  return r;
}

export async function requestView(tx: Tx, actor: Actor, requestId: string) {
  const r = await loadRequest(tx, requestId);
  if (!(await canSee(tx, actor, r))) notFound('That approval request');
  const stageRows = await many(tx, `select s.stage_no, c.name as committee_name from app.approval_stages s
    join app.committees c on c.tenant_id = s.tenant_id and c.id = s.committee_id
    where s.request_id = $1 order by s.stage_no`, [requestId]);
  const stages = [];
  for (const s of stageRows) {
    const t = await stageTally(tx, requestId, s.stage_no);
    stages.push({ stageNo: s.stage_no, label: t.stage.label, committee: s.committee_name, mode: t.stage.mode,
      status: t.stage.status, approvals: t.approvals, objections: t.objections, required: t.required,
      voters: t.stage.status === 'waiting' ? [] : t.voters });
  }
  const current = stages.find(s => s.stageNo === r.current_stage);
  const myVote = current?.voters.find((v: any) => v.personId === actor.personId);
  const node = nodeOf(r);
  return {
    id: r.id, ref: r.ref, subjectType: r.subject_type, title: r.title, details: r.details,
    amountPaise: r.amount_paise, scope: { id: r.scope_node_id, name: r.scope_name }, status: r.status,
    currentStage: r.current_stage, rule: { name: r.rule_snapshot.name, version: r.rule_snapshot.version },
    proposer: { id: r.proposer_person_id, name: r.proposer_name }, createdAt: r.created_at, decidedAt: r.decided_at,
    outcomeNote: r.outcome_note, override: r.override, stages,
    actions: {
      vote: r.status === 'pending' && !!myVote?.active, myVote: myVote?.vote ?? null,
      withdraw: r.status === 'pending' && (r.proposer_person_id === actor.personId || actor.can('approvals.override', node)),
      reject: r.status === 'pending' && actor.can('approvals.override', node),
      override: r.status === 'pending' && actor.can('approvals.override', node) && !!r.rule_snapshot.allow_letter_override,
    },
  };
}
