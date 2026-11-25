// Sample procurement for the demo communities. Every vendor, person, number and amount is invented.
import { Actor } from '../server/src/actor.ts';
import { many, one, type Tx } from '../server/src/db.ts';
import * as engine from '../server/src/services/approvals.ts';
import { addDays, localNow } from '../server/src/services/schedule.ts';

type V = [name: string, categories: string[], contact: string, phone: string, city: string];
type Q = [vendor: string, rupees: number, tax: 'included' | 'excluded' | 'unclear', gstRupees: number | null, scope: string, exclusions: string,
  timeline: string, warranty: string, validDays: number | null, terms: string];

const VENDORS: Record<string, V[]> = {
  'palm-meadows': [
    ['Velan Lifts & Escalators', ['lifts'], 'Senthil Kumar', '+919000040101', 'Chennai'],
    ['Kaveri Power Systems', ['electrical'], 'Ramesh Babu', '+919000040102', 'Chennai'],
    ['Neervalam Water Engineers', ['water', 'plumbing'], 'Dhanalakshmi R', '+919000040103', 'Chengalpattu'],
    ['Agni Suraksha Services', ['fire_safety'], 'Abdul Rahim', '+919000040104', 'Chennai'],
    ['BlueWave Pools', ['pool'], 'Kiran Joseph', '+919000040105', 'Chennai'],
    ['Netra Secure Systems', ['security', 'electrical'], 'Vignesh P', '+919000040106', 'Chennai'],
    ['Suryan Energy', ['electrical'], 'Malathi S', '+919000040107', 'Coimbatore'],
    ['Green Fairway Turf Care', ['garden'], 'Arul Doss', '+919000040108', 'Kanchipuram'],
    ['Mazhai Shield Waterproofing', ['civil'], 'Prabhu G', '+919000040109', 'Chennai'],
    ['Dakshin Coatings', ['civil', 'painting'], 'Hema Nair', '+919000040110', 'Chennai'],
    ['RoofGuard Systems', ['civil'], 'Sathish M', '+919000040111', 'Tiruvallur'],
    ['ChargeGrid EV', ['electrical'], 'Nikhil Varma', '+919000040112', 'Bengaluru'],
    ['Volt Point Chargers', ['electrical'], 'Ayesha Banu', '+919000040113', 'Chennai'],
    ['Kosu Pest Control', ['pest_control'], 'Murali K', '+919000040114', 'Chennai'],
  ],
  'riverside-greens': [
    ['Velan Lifts & Escalators', ['lifts'], 'Senthil Kumar', '+919000040101', 'Chennai'],
    ['Kaveri Power Systems', ['electrical'], 'Ramesh Babu', '+919000040102', 'Chennai'],
    ['Thunder Gensets', ['electrical'], 'Gopal Krishnan', '+919000040201', 'Chennai'],
    ['Power Assure Services', ['electrical'], 'Leela Mohan', '+919000040202', 'Chennai'],
  ],
  'maple-court': [
    ['Velan Lifts & Escalators', ['lifts'], 'Senthil Kumar', '+919000040101', 'Chennai'],
    ['Kaveri Power Systems', ['electrical'], 'Ramesh Babu', '+919000040102', 'Chennai'],
  ],
};

// Quotations recorded against existing sample work orders, by title.
const QUOTES: Record<string, Record<string, Q[]>> = {
  'palm-meadows': {
    'Clubhouse roof waterproofing': [
      ['Mazhai Shield Waterproofing', 385000, 'excluded', 69300, 'Polyurethane coating, two coats with primer, 6,800 sq ft; crack filling and corner grouting',
        'Shifting the AC units on the roof', '3 weeks', '7 years', 45, '30% advance, 60% on completion, 10% after the first monsoon'],
      ['Dakshin Coatings', 420000, 'included', null, 'Acrylic elastomeric membrane, three coats, 6,800 sq ft', 'Scaffolding', '2 weeks', '5 years', 30,
        '50% advance, balance on completion'],
      ['RoofGuard Systems', 360000, 'unclear', null, 'Bituminous membrane over the banquet hall only, about 4,500 sq ft', '', '4 weeks', '', null, ''],
    ],
    'EV charging points for Sky Towers parking': [
      ['ChargeGrid EV', 720000, 'excluded', 129600, 'Twelve 7.4 kW smart chargers, metering per user, app billing, cabling from the tower panels',
        'Electricity board load increase fees', '6 weeks', '3 years on chargers', 60, '40% on order, 50% on installation, 10% after 30 days'],
      ['Volt Point Chargers', 765000, 'included', null, 'Twelve 7.4 kW chargers, RFID cards per user, cabling and civil work',
        'Software subscription after the first year', '5 weeks', '2 years', 21, '50% advance'],
    ],
    'Mosquito fogging needed on Areca Row': [
      ['Kosu Pest Control', 6500, 'included', null, 'Thermal fogging along Areca Row and the storm drain, two evening rounds a week apart',
        'Indoor treatment', '2 days', '', 15, 'On completion'],
    ],
  },
  'riverside-greens': {
    'DG set AMC renewal: get quotes': [
      ['Kaveri Power Systems', 82000, 'excluded', 14760, 'Comprehensive AMC, quarterly service, 4-hour response', 'Major overhaul parts', '12 months', '', 30, 'Quarterly in advance'],
      ['Thunder Gensets', 74000, 'excluded', 13320, 'Non-comprehensive AMC, quarterly service', 'All spare parts', '12 months', '', 30, 'Annual in advance'],
    ],
  },
};

export async function seedProcurement(tx: Tx, slug: string) {
  if (!VENDORS[slug] || await one(tx, `select 1 from app.vendors limit 1`)) return;
  const today = localNow('Asia/Kolkata').day;
  const byName = async (n: string) => (await one(tx, `select id from app.people where full_name = $1 order by created_at limit 1`, [n]))?.id ?? fail(`no person ${n}`);
  const admin = (await one(tx, `select p.id from app.people p join app.memberships m on m.tenant_id = p.tenant_id and m.person_id = p.id
    join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id where r.key = 'administrator' order by p.created_at limit 1`))!.id;
  const fm = (await one(tx, `select p.id from app.people p join app.memberships m on m.tenant_id = p.tenant_id and m.person_id = p.id
    join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id where r.key = 'facility_manager' and m.scope_node_id is null order by p.created_at limit 1`))?.id ?? admin;

  const vendor: Record<string, string> = {};
  for (const [name, cats, contact, phone, city] of VENDORS[slug]) {
    const ref = (await one(tx, `select app.next_ref('vendor', 'VN') as ref`))!.ref;
    vendor[name] = (await one(tx, `insert into app.vendors (ref, name, categories, contact_name, phone, city, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [ref, name, cats, contact, phone, city, admin]))!.id;
  }

  const addQuote = async (workId: string, q: Q, ageDays: number) => {
    const [v, amount, tax, gst, scope, exclusions, timeline, warranty, validDays, terms] = q;
    const ref = (await one(tx, `select app.next_ref('quote', 'QT') as ref`))!.ref;
    return (await one(tx, `insert into app.quotes (ref, work_order_id, vendor_id, received_on, amount_paise, tax, gst_paise, scope, exclusions, timeline, warranty,
        valid_until, payment_terms, entered_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [ref, workId, vendor[v], addDays(today, -ageDays), amount * 100, tax, gst === null ? null : gst * 100, scope, exclusions, timeline, warranty,
        validDays === null ? null : addDays(today, validDays - ageDays), terms, fm]))!.id;
  };
  const actor = (id: string, name = '') => new Actor('', id, name, '', [{ roleKey: 'administrator', roleName: 'Administrator',
    perms: new Set(['approvals.propose', 'approvals.view', 'procurement.view']), scope: null, scopeName: null }]);
  // Every member asked at each stage approves, stage by stage, as the community's rules require.
  const approveAll = async (id: string) => {
    for (let i = 0; i < 6; i++) {
      const r = (await one(tx, `select status, current_stage from app.approval_requests where id = $1`, [id]))!;
      if (r.status !== 'pending') return;
      const waiting = await many(tx, `select v.person_id from app.approval_stage_voters v
        left join app.approval_votes x on x.tenant_id = v.tenant_id and x.request_id = v.request_id and x.stage_no = v.stage_no and x.person_id = v.person_id
        where v.request_id = $1 and v.stage_no = $2 and x.vote is null`, [id, r.current_stage]);
      for (const v of waiting) {
        if ((await one(tx, `select status from app.approval_requests where id = $1`, [id]))!.status !== 'pending') return;
        await engine.vote(tx, actor(v.person_id), id, 'approve', '');
      }
    }
  };
  const select = async (workId: string, quoteId: string, quoteIds: string[], by: string, reason: string, single: string | null, voters: string[]) => {
    const w = (await one(tx, `select ref, title, node_id from app.work_orders where id = $1`, [workId]))!;
    const q = (await one(tx, `select q.*, v.name from app.quotes q join app.vendors v on v.id = q.vendor_id where q.id = $1`, [quoteId]))!;
    const total = q.tax === 'excluded' && q.gst_paise ? Number(q.amount_paise) + Number(q.gst_paise) : Number(q.amount_paise);
    const proposer = await byName(by);
    const res = await engine.propose(tx, actor(proposer, by), { subjectType: 'vendor_selection', subjectId: workId, title: `${w.ref}: award ${w.title} to ${q.name}`,
      details: `Recommended: ${q.name}, ${q.ref}.\nReason: ${reason}${single ? `\nOnly one quotation: ${single}` : ''}`, amountPaise: String(total), scopeNodeId: w.node_id });
    if (voters.length) await approveAll(res!.id);
    await tx.query(`insert into app.vendor_selections (work_order_id, quote_id, reason, single_quote_reason, compared_quote_ids, approval_request_id, chosen_by)
      values ($1, $2, $3, $4, $5, $6, $7)`, [workId, quoteId, reason, single, quoteIds, res!.id, proposer]);
    return res!;
  };

  for (const [title, quotes] of Object.entries(QUOTES[slug] ?? {})) {
    const w = await one(tx, `select id from app.work_orders where title = $1`, [title]);
    if (!w) continue;
    const ids: string[] = [];
    for (const [i, q] of quotes.entries()) ids.push(await addQuote(w.id, q, 6 - i));
    if (slug === 'palm-meadows' && title.startsWith('Mosquito')) {
      await select(w.id, ids[0], ids, 'Prakash Menon', 'Our annual pest control vendor; the price matches their contract rate.',
        'Fogging is covered by the annual pest control arrangement; a second vendor would not come for one street.',
        ['Sridhar Natarajan', 'Vasanthi Murthy', 'Rajesh Sharma', 'Anitha Pillai', 'Karthik Rao', 'Nandini Bose', 'Aarav Mehta']);
    }
  }

  if (slug === 'palm-meadows') {
    // A finished project, chosen from two quotations and reviewed afterwards.
    const node = (await one(tx, `select id from app.property_nodes where name = 'Sky A'`))!.id;
    const ref = (await one(tx, `select app.next_ref('work', 'WO') as ref`))!.ref;
    const created = new Date(Date.now() - 70 * 86_400_000);
    const w = (await one(tx, `insert into app.work_orders (ref, kind, title, details, category, priority, status, node_id, raised_by, assignee_person_id,
        estimate_paise, created_at, started_at, completed_at, closed_at)
      values ($1, 'project', 'Sky A lobby and corridor repainting', 'Lobby, lift lobbies on all floors and the main corridor; washable emulsion.',
        'general', 'normal', 'closed', $2, $3, $3, 31000000, $4, $4::timestamptz + interval '20 days', $4::timestamptz + interval '41 days',
        $4::timestamptz + interval '44 days') returning id`, [ref, node, fm, created]))!.id;
    await tx.query(`insert into app.work_updates (work_order_id, person_id, kind, body, to_status, at) values ($1, $2, 'created', 'Work order raised', 'open', $3),
      ($1, $2, 'status', 'Painting finished; snag list cleared.', 'done', $3::timestamptz + interval '41 days'),
      ($1, $2, 'status', 'Checked every floor with the tower committee.', 'closed', $3::timestamptz + interval '44 days')`, [w, fm, created]);
    const a = await addQuote(w, ['Dakshin Coatings', 298000, 'included', null, 'Two coats washable emulsion over one coat primer; putty touch-up', 'Doors and grills',
      '3 weeks', '2 years on finish', 30, '30% advance, balance on completion'], 66);
    const b = await addQuote(w, ['Mazhai Shield Waterproofing', 276000, 'excluded', 49680, 'Two coats emulsion', 'Putty work', '4 weeks', '1 year', 30, '50% advance'], 65);
    await select(w, a, [a, b], 'Raghav Subramanian', 'Lower once GST is added, includes putty work, and a longer warranty on the finish.', null,
      ['Indira Menon', 'Vijay Singh', 'Sridhar Natarajan', 'Vasanthi Murthy', 'Rajesh Sharma', 'Anitha Pillai', 'Karthik Rao', 'Nandini Bose', 'Aarav Mehta']);
    for (const [by, qy, t, v, again, comment] of [
      ['Prakash Menon', 4, 5, 4, true, 'Finished two days early; tidy site every evening.'],
      ['Raghav Subramanian', 4, 4, 3, true, 'Good finish. Took a week to fix two patchy walls on floor 9.'],
    ] as const) await tx.query(`insert into app.vendor_reviews (vendor_id, work_order_id, quality, timeliness, value, would_rehire, comment, reviewed_by, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz + interval '45 days')`, [vendor['Dakshin Coatings'], w, qy, t, v, again, comment, await byName(by), created]);
    for (const [by, qy, t, v, comment] of [
      ['Joseph D\'Souza', 3, 2, 3, 'Breakdown response is slow at weekends; weekday service is fine.'],
      ['Prakash Menon', 4, 3, 4, 'Reliable on scheduled maintenance.'],
    ] as const) await tx.query(`insert into app.vendor_reviews (vendor_id, quality, timeliness, value, would_rehire, comment, reviewed_by)
      values ($1, $2, $3, $4, true, $5, $6)`, [vendor['Velan Lifts & Escalators'], qy, t, v, comment, await byName(by)]);
  }
  const n = (await many(tx, `select 1 from app.quotes`)).length;
  console.log(`${slug}: ${Object.keys(vendor).length} vendors, ${n} quotations`);
}
function fail(m: string): never { throw new Error(m); }
