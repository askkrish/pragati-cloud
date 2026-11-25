import type { FastifyInstance } from 'fastify';
import { getNode } from '../actor.ts';
import type { Runner, Services } from '../app.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, notFound } from '../errors.ts';
import * as engine from '../services/approvals.ts';
import { inScopeSql } from './property.ts';
import { idParam, rupeesToPaise, text, uuid, z } from './z.ts';

const SUBJECTS = ['expense', 'project', 'vendor_selection', 'work_order', 'work_order_change', 'policy', 'other'] as const;

const stageBody = z.object({
  label: text(60), committeeSelector: z.enum(['fixed', 'nearest', 'apex']), committeeId: uuid.nullable().optional(),
  mode: z.enum(['unanimous', 'majority', 'count', 'any']), requiredCount: z.number().int().min(1).max(50).nullable().optional(),
});
const ruleBody = z.object({
  name: text(120), subjectType: z.enum(['*', ...SUBJECTS]).default('*'), scopeNodeId: uuid.nullable().optional(),
  minAmount: rupeesToPaise, maxAmount: rupeesToPaise, priority: z.number().int().min(-100).max(100).default(0),
  proposerAutoApprove: z.boolean().default(true), allowLetterOverride: z.boolean().default(true),
  stages: z.array(stageBody).min(1).max(5),
});

async function saveStages(tx: Tx, ruleId: string, stages: z.infer<typeof stageBody>[]) {
  await tx.query(`delete from app.approval_rule_stages where rule_id = $1`, [ruleId]);
  for (const [i, s] of stages.entries()) {
    if (s.committeeSelector === 'fixed' && !s.committeeId) fail(400, `Stage ${i + 1}: choose the committee.`);
    if (s.mode === 'count' && !s.requiredCount) fail(400, `Stage ${i + 1}: say how many approvals are needed.`);
    await tx.query(`insert into app.approval_rule_stages (rule_id, stage_no, label, committee_selector, committee_id, mode, required_count)
      values ($1, $2, $3, $4, $5, $6, $7)`, [ruleId, i + 1, s.label, s.committeeSelector,
      s.committeeSelector === 'fixed' ? s.committeeId : null, s.mode, s.mode === 'count' ? s.requiredCount : null]);
  }
}

export async function approvalRoutes(app: FastifyInstance, run: Runner, _svc: Services) {
  // ---------------------------------------------------------------- rules
  app.get('/api/approval-rules', async req => run.auth(req, async ({ tx, actor }) => {
    actor.require('approval_rules.view', null);
    const rules = await many(tx, `select r.*, n.name as scope from app.approval_rules r
      left join app.property_nodes n on n.tenant_id = r.tenant_id and n.id = r.scope_node_id
      order by r.active desc, n.depth nulls first, r.subject_type, r.min_amount_paise`);
    const stages = await many(tx, `select s.*, c.name as committee from app.approval_rule_stages s
      left join app.committees c on c.tenant_id = s.tenant_id and c.id = s.committee_id order by s.stage_no`);
    return rules.map(r => ({ ...r, stages: stages.filter(s => s.rule_id === r.id) }));
  }));

  app.post('/api/approval-rules', async req => run.auth(req, async ({ tx, actor, audit }) => {
    actor.require('approval_rules.manage');
    const b = ruleBody.parse(req.body);
    if (b.scopeNodeId) await getNode(tx, b.scopeNodeId);
    const r = await one(tx, `insert into app.approval_rules (name, subject_type, scope_node_id, min_amount_paise, max_amount_paise,
        priority, proposer_auto_approve, allow_letter_override) values ($1,$2,$3,coalesce($4::bigint,0),$5,$6,$7,$8) returning *`,
      [b.name, b.subjectType, b.scopeNodeId ?? null, b.minAmount, b.maxAmount, b.priority, b.proposerAutoApprove, b.allowLetterOverride]);
    await saveStages(tx, r.id, b.stages);
    await audit('approval_rule.created', 'approval_rule', r.id, `Created approval rule "${r.name}"`, { rule: b });
    return r;
  }));

  // Editing a rule changes future requests only; open requests keep the rule they started with.
  app.put('/api/approval-rules/:id', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    actor.require('approval_rules.manage');
    const b = ruleBody.extend({ active: z.boolean().default(true) }).parse(req.body);
    const before = await one(tx, `select * from app.approval_rules where id = $1`, [id]) ?? notFound('That rule');
    const r = await one(tx, `update app.approval_rules set name = $2, subject_type = $3, scope_node_id = $4,
        min_amount_paise = coalesce($5::bigint, 0), max_amount_paise = $6, priority = $7, proposer_auto_approve = $8,
        allow_letter_override = $9, active = $10, version = version + 1 where id = $1 returning *`,
      [id, b.name, b.subjectType, b.scopeNodeId ?? null, b.minAmount, b.maxAmount, b.priority, b.proposerAutoApprove,
        b.allowLetterOverride, b.active]);
    await saveStages(tx, id, b.stages);
    await audit('approval_rule.updated', 'approval_rule', id, `Changed approval rule "${r.name}" (version ${r.version})`,
      { before, after: b });
    return r;
  }));

  app.post('/api/approval-rules/preview', async req => run.auth(req, async ({ tx, actor }) => {
    const b = z.object({ subjectType: z.enum(SUBJECTS), amount: rupeesToPaise, scopeNodeId: uuid.nullable().optional() }).parse(req.body);
    const node = await getNode(tx, b.scopeNodeId);
    if (!actor.can('approvals.view', node) && !actor.can('approvals.propose', node)) actor.require('approvals.view', node);
    return engine.previewRoute(tx, b.subjectType, b.amount, b.scopeNodeId ?? null);
  }));

  // ---------------------------------------------------------------- requests
  app.get('/api/approvals', async req => run.auth(req, async ({ tx, actor }) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'all']).default('pending'),
      mine: z.enum(['0', '1']).default('0'), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const scopes = actor.canAnywhere('approvals.view') ? actor.scopes('approvals.view') : [];
    return many(tx, `
      select r.id, r.ref, r.subject_type, r.title, r.amount_paise, r.status, r.current_stage, r.created_at, r.decided_at,
             n.name as scope, p.full_name as proposer, s.label as stage_label, c.name as committee,
             (select count(*)::int from app.approval_stages x where x.request_id = r.id) as stages,
             mv.vote as my_vote, mv.person_id is not null as i_vote,
             (now()::date - r.created_at::date) as waiting_days,
             -- Decisions waiting longer than the community allows are flagged, as JAOA escalated them.
             (r.status = 'pending' and now() - r.created_at > make_interval(days => (select escalation_days from app.tenants))) as escalated
        from app.approval_requests r
        join app.property_nodes n on n.tenant_id = r.tenant_id and n.id = r.scope_node_id
        join app.people p on p.tenant_id = r.tenant_id and p.id = r.proposer_person_id
        join app.approval_stages s on s.tenant_id = r.tenant_id and s.request_id = r.id and s.stage_no = r.current_stage
        join app.committees c on c.tenant_id = s.tenant_id and c.id = s.committee_id
        left join lateral (select v.person_id, x.vote from app.approval_stage_voters v
            left join app.approval_votes x on x.tenant_id = v.tenant_id and x.request_id = v.request_id
                                          and x.stage_no = v.stage_no and x.person_id = v.person_id
           where v.request_id = r.id and v.stage_no = r.current_stage and v.person_id = $2) mv on true
       where ($1 = 'all' or r.status = $1)
         and (${inScopeSql('n', '$3')} or r.proposer_person_id = $2 or mv.person_id is not null)
         and ($4 = '0' or (r.status = 'pending' and mv.person_id is not null and mv.vote is null))
       order by r.created_at desc limit $5`, [q.status, actor.personId, scopes, q.mine, q.limit]);
  }));

  app.get('/api/approvals/:id', async req => run.auth(req, async ({ tx, actor }) =>
    engine.requestView(tx, actor, idParam.parse(req.params).id)));

  app.post('/api/approvals', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const b = z.object({ subjectType: z.enum(SUBJECTS), subjectId: uuid.nullable().optional(), title: text(200),
      details: z.string().max(4000).default(''), amount: rupeesToPaise, scopeNodeId: uuid.nullable().optional() }).parse(req.body);
    const r = await engine.propose(tx, actor, { ...b, amountPaise: b.amount });
    const view = await engine.requestView(tx, actor, r!.id);
    await audit('approval.proposed', 'approval_request', r!.id, `${r!.ref} raised: ${b.title}`,
      { rule: view.rule, amountPaise: b.amount, status: view.status });
    if (view.status === 'approved') await audit('approval.approved', 'approval_request', r!.id, `${r!.ref} approved`);
    return view;
  }));

  app.post('/api/approvals/:id/vote', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ vote: z.enum(['approve', 'object']), note: z.string().max(600).default('') }).parse(req.body);
    const r = await engine.vote(tx, actor, id, b.vote, b.note);
    await audit(`approval.${b.vote === 'approve' ? 'approved_by' : 'objected_by'}`, 'approval_request', id,
      `${actor.name} ${b.vote === 'approve' ? 'approved' : 'objected to'} ${r.ref}`, { note: b.note });
    if (r.status === 'approved') await audit('approval.approved', 'approval_request', id, `${r.ref} approved`);
    return engine.requestView(tx, actor, id);
  }));

  app.post('/api/approvals/:id/withdraw', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ note: z.string().max(600).default('') }).parse(req.body ?? {});
    const r = await engine.withdraw(tx, actor, id, b.note);
    await audit('approval.withdrawn', 'approval_request', id, `${r.ref} withdrawn by ${actor.name}`, { note: b.note });
    return engine.requestView(tx, actor, id);
  }));

  app.post('/api/approvals/:id/reject', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ note: text(600) }).parse(req.body);
    const r = await engine.reject(tx, actor, id, b.note);
    await audit('approval.rejected', 'approval_request', id, `${r.ref} closed as rejected by ${actor.name}`, { note: b.note });
    return engine.requestView(tx, actor, id);
  }));

  app.post('/api/approvals/:id/override', async req => run.auth(req, async ({ tx, actor, audit }) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ note: text(600), fileId: uuid }).parse(req.body);
    const r = await engine.overrideWithLetter(tx, actor, id, b.note, b.fileId);
    await audit('approval.approved_by_letter', 'approval_request', id, `${r.ref} approved by signed letter, recorded by ${actor.name}`,
      { note: b.note, fileId: b.fileId });
    return engine.requestView(tx, actor, id);
  }));
}
