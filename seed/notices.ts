// Sample notices and records for the demo communities. The documents are one-page PDFs that say
// they are samples; nothing here is a real document of any association.
import { createHash, randomUUID } from 'node:crypto';
import { many, one, type Tx } from '../server/src/db.ts';
import type { Storage } from '../server/src/services/storage.ts';
import { addDays, localNow } from '../server/src/services/schedule.ts';

// A minimal one-page PDF with a title and a few lines, in Helvetica.
export function samplePdf(title: string, lines: string[]) {
  const esc = (s: string) => s.replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '-');
  const text = [`BT /F1 20 Tf 60 770 Td (${esc(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 11 Tf 60 ${730 - i * 18} Td (${esc(l)}) Tj ET`)].join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

type N = { title: string; body: string; category: string; audience?: string; place?: string; ageDays: number; pinned?: boolean; until?: number; attach?: string };
type D = { title: string; category: string; visibility: string; dated: number; review?: number; lines: string[] };

const NOTICES: Record<string, N[]> = {
  'palm-meadows': [
    { title: 'Annual general meeting on 14 December', category: 'meeting', audience: 'owners', ageDays: 5, pinned: true, until: 20, attach: 'AGM notice and agenda',
      body: 'The annual general meeting of the federation will be held at the Grand Clubhouse on Sunday, 14 December at 10 am.\n\nAgenda: adoption of the audited accounts for 2025–26, the budget for 2027–28, election of the federation council, and the clubhouse roof waterproofing project.\n\nOwners who cannot attend may appoint a proxy in writing by 12 December.' },
    { title: 'Water supply off on Sunday morning', category: 'maintenance', ageDays: 2, until: 5,
      body: 'Overhead tanks in Sky Towers will be cleaned this Sunday. Water will be off from 9 am to 1 pm. Please store water the night before.\n\nFor help, call the facility office.' },
    { title: 'Sky B lift 3: modernisation work from 1 December', category: 'maintenance', place: 'Sky B', ageDays: 3,
      body: 'Lift 3 in Sky B will be out of service for about three weeks from 1 December while the controller and door operator are replaced. Lifts 1, 2 and 4 will run as usual.\n\nResidents needing help with heavy items may ask the security desk.' },
    { title: 'Maintenance bills for December', category: 'finance', ageDays: 0,
      body: 'December maintenance bills are now in the app under Dues. Please pay by 15 December. You can pay by UPI from the app, and tap "I have paid" with the UTR so the treasurer can match it.\n\nThis is a demo community: please do not pay anything.' },
    { title: 'Christmas and New Year celebrations', category: 'event', ageDays: 1, until: 40,
      body: 'Carols on 24 December at the Grand Clubhouse lawn from 7 pm, and the New Year party on 31 December from 8 pm. Children\'s games and a potluck dinner. Volunteers, please sign up at the clubhouse desk.' },
    { title: 'Mosquito fogging schedule for December', category: 'general', ageDays: -2,
      body: 'Fogging will be done every Tuesday and Friday evening in December, from 6 pm to 7 pm, across all phases. Please keep windows closed during fogging.' },
    { title: 'Council meeting on Saturday: agenda', category: 'meeting', audience: 'committee', ageDays: 1,
      body: '1. Clubhouse roof waterproofing: vendor recommendation.\n2. Dues over 90 days: follow-up with 12 homes.\n3. EV charging points: third quotation.\n4. AGM arrangements.' },
  ],
  'riverside-greens': [
    { title: 'Swimming pool closed for maintenance', category: 'maintenance', ageDays: 2, until: 10, body: 'The pool will be closed from Monday to Wednesday for filter maintenance.' },
    { title: 'Kaveri Block: parking repainting on Friday', category: 'general', place: 'Kaveri Block', ageDays: 1, body: 'Please move cars from the basement by 8 am on Friday.' },
  ],
  'maple-court': [
    { title: 'Generator test run every Saturday', category: 'maintenance', ageDays: 6, pinned: true, body: 'The generator is tested every Saturday between 11 am and noon. Lifts may stop briefly during the switch-over.' },
  ],
};

const DOCS: Record<string, D[]> = {
  'palm-meadows': [
    { title: 'Bye-laws of the township federation', category: 'bye_laws', visibility: 'everyone', dated: -2650, review: 630, lines: ['Sample bye-laws for a demo community.', 'Not a real document.'] },
    { title: 'AGM 2026: notice and agenda', category: 'agm', visibility: 'owners', dated: -5, lines: ['Annual general meeting, 14 December, Grand Clubhouse, 10 am.', 'Sample document for a demo community.'] },
    { title: 'Minutes of the federation council, October', category: 'minutes', visibility: 'committee', dated: -32, lines: ['Present: seven members.', 'Sample minutes for a demo community.'] },
    { title: 'Audited accounts 2025-26', category: 'audit', visibility: 'owners', dated: -150, lines: ['Income and expenditure account and balance sheet.', 'Sample document for a demo community; not real accounts.'] },
    { title: 'Common property insurance policy', category: 'insurance', visibility: 'committee', dated: -290, review: 60, lines: ['Sample policy schedule.', 'Not a real policy.'] },
    { title: 'Fire safety certificate (NOC)', category: 'statutory', visibility: 'everyone', dated: -305, review: 45, lines: ['Sample certificate for a demo community.', 'Not a real certificate.'] },
    { title: 'Sky A lift operating licences', category: 'statutory', visibility: 'committee', dated: -370, review: -5, lines: ['Sample licence for a demo community.', 'Not a real licence.'] },
    { title: 'Approved layout plan', category: 'plans', visibility: 'owners', dated: -3300, lines: ['Sample layout plan.', 'Not a real plan.'] },
  ],
  'riverside-greens': [{ title: 'Bye-laws', category: 'bye_laws', visibility: 'everyone', dated: -2000, lines: ['Sample bye-laws.', 'Not a real document.'] }],
  'maple-court': [{ title: 'Bye-laws', category: 'bye_laws', visibility: 'everyone', dated: -1500, lines: ['Sample bye-laws.', 'Not a real document.'] }],
};

export async function seedNotices(tx: Tx, slug: string, storage: Storage) {
  if (!NOTICES[slug] || await one(tx, `select 1 from app.notices limit 1`)) return;
  const today = localNow('Asia/Kolkata').day;
  const tenant = (await one(tx, `select id, brand_name from app.tenants`))!;
  const admin = (await one(tx, `select p.id from app.people p join app.memberships m on m.tenant_id = p.tenant_id and m.person_id = p.id
    join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id where r.key = 'administrator' order by p.created_at limit 1`))!.id;
  const file = async (purpose: string, title: string, lines: string[]) => {
    const body = samplePdf(title, [`${tenant.brand_name} (demo community)`, '', ...lines]);
    const id = randomUUID(), key = `${tenant.id}/${purpose}/${id}`;
    await storage.put(key, body, 'application/pdf');
    await tx.query(`insert into app.files (id, purpose, storage_key, file_name, content_type, size_bytes, sha256, uploaded_by) values ($1, $2, $3, $4, 'application/pdf', $5, $6, $7)`,
      [id, purpose, key, `${title.replace(/[^\w -]+/g, '').slice(0, 60)}.pdf`, body.length, createHash('sha256').update(body).digest('hex'), admin]);
    return id;
  };
  const people = (await many(tx, `select id from app.people where user_id is null and archived_at is null order by md5(id::text) limit 160`)).map(p => p.id);
  for (const [i, n] of NOTICES[slug].entries()) {
    const node = n.place ? (await one(tx, `select id from app.property_nodes where name = $1`, [n.place]))?.id ?? null : null;
    const at = new Date(Date.now() - n.ageDays * 86_400_000 - 3 * 3_600_000);
    const fileId = n.attach ? await file('notice', n.attach, ['Sample attachment for a demo notice.']) : null;
    const row = await one(tx, `insert into app.notices (ref, title, body, category, audience, scope_node_id, publish_at, expires_on, pinned, file_id, created_by, created_at)
      values (app.next_ref('notice', 'NT'), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $6) returning id`,
      [n.title, n.body, n.category, n.audience ?? 'everyone', node, at, n.until ? addDays(today, n.until) : null, !!n.pinned, fileId, admin]);
    if (n.ageDays > 0) await tx.query(`insert into app.notice_reads (notice_id, person_id, read_at) select $1, p, $3::timestamptz + interval '2 hours'
      from unnest($2::uuid[]) p`, [row!.id, people.slice(0, Math.min(people.length, 20 + i * 17)), at]);
  }
  for (const d of DOCS[slug] ?? []) {
    const fileId = await file('document', d.title, d.lines);
    await tx.query(`insert into app.documents (ref, title, category, file_id, visibility, dated_on, review_on, uploaded_by, created_at)
      values (app.next_ref('document', 'DC'), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [d.title, d.category, fileId, d.visibility, addDays(today, d.dated), d.review === undefined ? null : addDays(today, d.review), admin, new Date(Date.parse(addDays(today, Math.max(d.dated, -400)) + 'T10:00:00+05:30'))]);
  }
  console.log(`${slug}: ${NOTICES[slug].length} notices, ${(DOCS[slug] ?? []).length} documents`);
}
