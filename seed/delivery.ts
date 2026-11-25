// Sample project delivery, service logs, GST checks and permits for the Palm Meadows demo.
// Every name, number and amount is invented; the documents are one-page samples.
import { createHash, randomUUID } from 'node:crypto';
import { Actor } from '../server/src/actor.ts';
import { many, one, type Tx } from '../server/src/db.ts';
import * as engine from '../server/src/services/approvals.ts';
import { addDays, localNow } from '../server/src/services/schedule.ts';
import type { Storage } from '../server/src/services/storage.ts';
import { samplePdf } from './notices.ts';

export async function seedDelivery(tx: Tx, slug: string, storage: Storage) {
  if (slug !== 'palm-meadows' || await one(tx, `select 1 from app.contracts limit 1`)) return;
  const today = localNow('Asia/Kolkata').day;
  const tenant = (await one(tx, `select id, brand_name from app.tenants`))!;
  const person = async (n: string) => (await one(tx, `select p.id from app.people p where p.full_name = $1
    order by (p.user_id is not null or exists (select 1 from app.memberships m where m.person_id = p.id and m.status = 'active')) desc, p.created_at limit 1`, [n]))!.id as string;
  const fm = await person('Prakash Menon'), secretary = await person('Vasanthi Murthy'), treasurer = await person('Rajesh Sharma');
  const root = (await one(tx, `select id from app.property_nodes where parent_id is null`))!.id;
  const villas = (await one(tx, `select id from app.property_nodes where name = 'Phase 2: Palm Villas'`))?.id ?? root;
  const at = (daysAgo: number, hour = 11) => new Date(Date.parse(addDays(today, -daysAgo) + `T${String(hour).padStart(2, '0')}:00:00+05:30`));
  const ref = async (key: string, prefix: string) => (await one(tx, `select app.next_ref($1, $2) as ref`, [key, prefix]))!.ref as string;
  const update = (workId: string, who: string, body: string, daysAgo: number, staffOnly = true) => tx.query(
    `insert into app.work_updates (work_order_id, person_id, kind, body, staff_only, at) values ($1, $2, 'note', $3, $4, $5)`, [workId, who, body, staffOnly, at(daysAgo)]);
  const file = async (purpose: string, title: string, lines: string[]) => {
    const body = samplePdf(title, [`${tenant.brand_name} (demo community)`, '', ...lines, '', 'Sample document. Not a real record.']);
    const id = randomUUID(), key = `${tenant.id}/${purpose}/${id}`;
    await storage.put(key, body, 'application/pdf');
    await tx.query(`insert into app.files (id, purpose, storage_key, file_name, content_type, size_bytes, sha256, uploaded_by) values ($1, $2, $3, $4, 'application/pdf', $5, $6, $7)`,
      [id, purpose, key, `${title.replace(/[^\w -]+/g, '').slice(0, 60)}.pdf`, body.length, createHash('sha256').update(body).digest('hex'), fm]);
    return id;
  };
  const actor = (id: string) => new Actor('', id, '', '', [{ roleKey: 'administrator', roleName: 'Administrator',
    perms: new Set(['approvals.propose', 'approvals.view']), scope: null, scopeName: null }]);
  const approveAll = async (id: string) => {
    for (let i = 0; i < 6; i++) {
      const r = (await one(tx, `select status, current_stage from app.approval_requests where id = $1`, [id]))!;
      if (r.status !== 'pending') return;
      for (const v of await many(tx, `select v.person_id from app.approval_stage_voters v
          left join app.approval_votes x on x.tenant_id = v.tenant_id and x.request_id = v.request_id and x.stage_no = v.stage_no and x.person_id = v.person_id
          where v.request_id = $1 and v.stage_no = $2 and x.vote is null`, [id, r.current_stage])) {
        if ((await one(tx, `select status from app.approval_requests where id = $1`, [id]))!.status !== 'pending') return;
        await engine.vote(tx, actor(v.person_id), id, 'approve', '');
      }
    }
  };

  // ---------------------------------------------------------------- a project through delivery
  const vendorId = async (name: string, cats: string[], contact: string, phone: string) =>
    (await one(tx, `select id from app.vendors where name = $1`, [name]))?.id
      ?? (await one(tx, `insert into app.vendors (ref, name, categories, contact_name, phone, city, created_by) values ($1, $2, $3, $4, $5, 'Chennai', $6) returning id`,
        [await ref('vendor', 'VN'), name, cats, contact, phone, fm]))!.id;
  const neer = await vendorId('Neervalam Water Engineers', ['water', 'plumbing'], 'Dhanalakshmi R', '+919000040103');
  const bhoomi = await vendorId('Bhoomi Aqua Works', ['water', 'civil'], 'Suresh V', '+919000040115');

  const woRef = await ref('work', 'WO');
  const wo = (await one(tx, `insert into app.work_orders (ref, kind, title, details, category, priority, status, node_id, raised_by, assignee_person_id,
      estimate_paise, created_at, started_at) values ($1, 'project', 'Rainwater recharge wells for Palm Villas', $2, 'water', 'normal', 'in_progress', $3, $4, $4, $5, $6, $7) returning id`,
    [woRef, 'Six recharge wells along the villa avenues to take roof and road run-off, with silt traps and gratings. Approved in principle at the AGM.',
      villas, fm, 288000_00, at(48), at(20)]))!.id;
  const rfq = await ref('rfq', 'RQ');
  await tx.query(`insert into app.rfqs (ref, work_order_id, scope, reply_by, vendor_ids, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7)`,
    [rfq, wo, 'Six recharge wells, 1.2 m diameter, 6 m deep, with RCC rings, filter media, silt trap chambers and ductile iron gratings. Includes excavation and disposal of spoil. Excludes road resurfacing beyond 1 m around each well.',
      addDays(today, -38), [neer, bhoomi], fm, at(45)]);
  const quote = async (v: string, amount: number, gst: number, scope: string, timeline: string, warranty: string, terms: string, daysAgo: number) =>
    (await one(tx, `insert into app.quotes (ref, work_order_id, vendor_id, received_on, amount_paise, tax, gst_paise, scope, exclusions, timeline, warranty, valid_until, payment_terms, entered_by)
      values ($1, $2, $3, $4, $5, 'excluded', $6, $7, 'Road resurfacing beyond 1 m', $8, $9, $10, $11, $12) returning id`,
      [await ref('quote', 'QT'), wo, v, addDays(today, -daysAgo), amount * 100, gst * 100, scope, timeline, warranty, addDays(today, 30), terms, fm]))!.id;
  const q1 = await quote(neer, 236000, 42480, 'Six wells as specified, RCC rings, graded filter media, silt traps, DI gratings', '5 weeks', '2 years', '30% advance, 60% on completion of wells, 10% after the monsoon', 40);
  const q2 = await quote(bhoomi, 252000, 45360, 'Six wells as specified; brick lining in place of RCC rings', '6 weeks', '1 year', '50% advance', 39);
  const sel = await engine.propose(tx, actor(fm), { subjectType: 'vendor_selection', subjectId: wo, title: `${woRef}: award Rainwater recharge wells to Neervalam Water Engineers`,
    details: 'Recommended: Neervalam Water Engineers. Lower total with GST, RCC rings and a longer warranty.', amountPaise: String(278480_00), scopeNodeId: villas });
  await approveAll(sel!.id);
  await tx.query(`update app.approval_requests set created_at = $2, decided_at = $3 where id = $1`, [sel!.id, at(36), at(33)]);
  const selection = (await one(tx, `insert into app.vendor_selections (work_order_id, quote_id, reason, compared_quote_ids, approval_request_id, chosen_by, created_at)
    values ($1, $2, 'Lower total with GST, RCC rings instead of brick, and a two-year warranty', $3, $4, $5, $6) returning id`, [wo, q1, [q1, q2], sel!.id, fm, at(36)]))!.id;
  const signed = await file('contract', 'Work order NWE-2026-031', ['Six rainwater recharge wells, Palm Villas', 'Contract value Rs 2,70,000 including GST']);
  const ctRef = await ref('contract', 'CT');
  const contract = (await one(tx, `insert into app.contracts (ref, work_order_id, vendor_id, quote_id, selection_id, amount_paise, starts_on, finish_by, terms, signed_on,
      signed_reference, signed_file_id, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
    [ctRef, wo, neer, q1, selection, 270000_00, addDays(today, -22), addDays(today, 14), '30% advance, 60% on completion of the wells, 10% after the first monsoon. Negotiated down from Rs 2,78,480.',
      addDays(today, -30), 'NWE-2026-031', signed, fm, at(31)]))!.id;
  await update(wo, fm, `Contract ${ctRef} signed with Neervalam Water Engineers for ₹2,70,000`, 30);
  const coRef = await ref('change', 'CO');
  const coId = randomUUID();
  const co = await engine.propose(tx, actor(fm), { subjectType: 'work_order_change', subjectId: coId, title: `${woRef}: change ${coRef} to ${ctRef} (+₹38,000)`,
    details: `Contract ${ctRef}: ₹2,70,000 now; adds ₹38,000, making ₹3,08,000.\nTime: adds 7 days.\nChange: a seventh well at the Coconut Lane low point.\nReason: water stood there for two days after the October rain.`,
    amountPaise: '3800000', scopeNodeId: villas });
  await approveAll(co!.id);
  await tx.query(`update app.approval_requests set created_at = $2, decided_at = $3 where id = $1`, [co!.id, at(12), at(10)]);
  await tx.query(`insert into app.contract_changes (id, ref, contract_id, scope, reason, delta_paise, days_delta, approval_request_id, proposed_by, created_at)
    values ($1, $2, $3, 'A seventh well at the Coconut Lane low point', 'Water stood there for two days after the October rain', 3800000, 7, $4, $5, $6)`, [coId, coRef, contract, co!.id, fm, at(12)]);
  const ms = [['Excavation and RCC rings for six wells', -15, 81000, -14, 'Rings placed; depth checked at 6.1 m average'],
    ['Filter media, silt traps and gratings', -3, 162000, -2, 'All six wells finished; flow test with a water tanker passed'],
    ['Seventh well at Coconut Lane', 6, 38000, null, null], ['Clean-up and handover', 12, null, null, null]] as const;
  for (const [title, due, amount, doneAgo, note] of ms)
    await tx.query(`insert into app.milestones (work_order_id, title, due_on, amount_paise, done_on, done_note, done_by, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [wo, title, addDays(today, due), amount ? amount * 100 : null, doneAgo === null ? null : addDays(today, doneAgo), note, doneAgo === null ? null : fm, fm, at(30)]);

  // A finished project waiting for the secretary to check and accept the handover.
  const club = (await one(tx, `select id from app.property_nodes where name = 'Palm Meadows Township'`))?.id ?? root;
  const gymRef = await ref('work', 'WO');
  const gym = (await one(tx, `insert into app.work_orders (ref, kind, title, details, category, priority, status, node_id, raised_by, assignee_person_id,
      estimate_paise, created_at, started_at) values ($1, 'project', 'Clubhouse gym flooring replacement', $2, 'general', 'normal', 'in_progress', $3, $4, $4, $5, $6, $7) returning id`,
    [gymRef, 'Replace the worn rubber flooring in the clubhouse gym with 15 mm interlocking tiles.', club, fm, 145000_00, at(40), at(12)]))!.id;
  const gymVendor = await vendorId('Fitfloor Interiors', ['civil'], 'Ganesh R', '+919000040116');
  await tx.query(`insert into app.contracts (ref, work_order_id, vendor_id, earlier_note, amount_paise, starts_on, finish_by, signed_on, signed_reference, signed_file_id, created_by, created_at)
    values ($1, $2, $3, 'Agreed at the council meeting before the platform was used', $4, $5, $6, $5, 'Council minute 14/2026', $7, $8, $9)`,
    [await ref('contract', 'CT'), gym, gymVendor, 145000_00, addDays(today, -14), addDays(today, -1), await file('contract', 'Council minute 14 of 2026', ['Clubhouse gym flooring']), fm, at(15)]);
  const report = await file('evidence', `Completion report ${gymRef}`, ['Clubhouse gym flooring replacement', 'Tile joints, edges and level checked']);
  await tx.query(`insert into app.handovers (ref, work_order_id, tests, defects, warranty, file_id, recipient_id, submitted_by, created_at)
    values ($1, $2, $3, 'None', '3 years on the tiles, 1 year on workmanship', $4, $5, $6, $7)`,
    [await ref('handover', 'HO'), gym, 'Joints and edges checked; level within 2 mm over 3 m; equipment moved back and anchored.', report, secretary, fm, at(1)]);
  await update(gym, fm, 'Submitted for handover to Vasanthi Murthy', 1);

  // ---------------------------------------------------------------- asset service log
  const services: [asset: string, daysAgo: number, kind: string, provider: string, outcome: string, notes: string, next: number | null][] = [
    ['Sky A lifts (4)', 32, 'service', 'Velan Lifts & Escalators', 'passed', 'Quarterly AMC visit; ropes and brakes checked', 60],
    ['Sky B lifts (4)', 30, 'inspection', 'Lift inspectorate', 'follow_up', 'Lift 3 door operator worn; replacement advised before renewal of the licence', 25],
    ['DG set 1 (750 kVA)', 20, 'service', 'Kaveri Power Systems', 'passed', 'Oil, filters and coolant changed; load test at 80% for 30 minutes', 70],
    ['DG set 2 (320 kVA)', 95, 'service', 'Kaveri Power Systems', 'passed', 'Oil and filters changed', -5],
    ['Fire pump set (main and jockey)', 12, 'statutory', 'Agni Suraksha Services', 'passed', 'Hydrant pressure 7 kg/cm2 at the farthest point', 170],
    ['Sewage treatment plant (450 KLD)', 8, 'inspection', 'Neervalam Water Engineers', 'passed', 'Treated water BOD within limits', 22],
    ['Solar rooftop (120 kWp)', 40, 'service', 'Suryan Energy', 'passed', 'Panels cleaned; inverter logs normal', 50],
  ];
  for (const [name, ago, kind, provider, outcome, notes, next] of services) {
    const asset = await one(tx, `select id from app.assets where name = $1`, [name]);
    if (!asset) continue;
    await tx.query(`insert into app.asset_services (ref, asset_id, serviced_on, kind, provider, outcome, notes, next_due_on, recorded_by, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [await ref('service', 'SV'), asset.id, addDays(today, -ago), kind, provider, outcome, notes, next === null ? null : addDays(today, next), fm, at(ago)]);
  }

  // ---------------------------------------------------------------- GST on vouchers
  const paid = await many(tx, `select v.id, v.vendor_id from app.vouchers v where v.status = 'paid' and v.vendor_id is not null order by v.created_at desc limit 6`);
  for (const [i, v] of paid.entries())
    await tx.query(`update app.vouchers set gst_status = 'verified', gstin = $2, gst_checked_by = $3, gst_checked_at = now(), gst_note = 'Active on the GST portal'
      where id = $1`, [v.id, `33AAB${'CDEFGHIJ'[i]}K${String(4321 + i)}L1Z${i}`, treasurer]);
  const waiting = await one(tx, `select id from app.vouchers where status = 'submitted' and vendor_id is not null order by created_at limit 1`);
  if (waiting) await tx.query(`update app.vouchers set gst_status = 'pending', gstin = '33AACFG7766Q1Z2', gst_note = 'Invoice shows CGST and SGST at 9% each' where id = $1`, [waiting.id]);

  // ---------------------------------------------------------------- permits
  const owner = await one(tx, `select o.person_id, u.id as unit_id, u.label, u.node_id from app.ownerships o join app.units u on u.tenant_id = o.tenant_id and u.id = o.unit_id
    join app.people p on p.tenant_id = o.tenant_id and p.id = o.person_id and p.phone_e164 is not null
    join app.property_nodes n on n.tenant_id = u.tenant_id and n.id = u.node_id
    where o.ends_on is null and n.name ilike '%floor 1_%' order by u.label limit 1`)
    ?? await one(tx, `select o.person_id, u.id as unit_id, u.label, u.node_id from app.ownerships o join app.units u on u.tenant_id = o.tenant_id and u.id = o.unit_id
      where o.ends_on is null order by u.label limit 1`);
  if (owner) {
    const req = async (title: string, details: string, kind: string, status: string, daysAgo: number) => {
      const r = await ref('work', 'WO');
      const id = (await one(tx, `insert into app.work_orders (ref, kind, title, details, category, status, node_id, unit_id, raised_by, permit_kind, created_at)
        values ($1, 'request', $2, $3, 'general', $4, $5, $6, $7, $8, $9) returning id`, [r, title, details, status, owner.node_id, owner.unit_id, owner.person_id, kind, at(daysAgo)]))!.id;
      await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, to_status, at) values ($1, $2, 'created', $3, 'new', $4)`,
        [id, owner.person_id, 'Request raised; needs the committee\'s permission', at(daysAgo)]);
      return id;
    };
    await req('Solar water heater panel on the terrace', `For ${owner.label}: one 200-litre panel, pipes through the service shaft.`, 'terrace_work', 'new', 2);
    const reno = await req('Kitchen remodelling', `${owner.label}: new counter and tiles; no change to walls or plumbing lines. Contractor: Sri Murugan Interiors.`, 'renovation', 'open', 9);
    await tx.query(`insert into app.work_permits (work_order_id, status, note, conditions, valid_until, decided_by, decided_at) values ($1, 'approved', $2, $3, $4, $5, $6)`,
      [reno, 'Approved by the Sky Towers phase committee', 'Work between 10 am and 6 pm on weekdays; debris to the service lift only; refundable deposit of ₹10,000 paid',
        addDays(today, 40), secretary, at(7)]);
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, at) values ($1, $2, 'note', 'Permit granted: work 10 am to 6 pm on weekdays', $3)`, [reno, secretary, at(7)]);
  }
  console.log(`${slug}: project delivery, service logs, GST checks and permits`);
}
