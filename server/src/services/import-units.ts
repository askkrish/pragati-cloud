// Bulk set-up of a community from a spreadsheet saved as CSV: one row per unit.
//
//   location,unit,type,floor,carpet_sqft,super_sqft,uds_sqft,owner_name,owner_phone,owner_share
//   Phase 1 > Tower A > Floor 3,A-301,2BHK,3,1050,1380,412,Asha R;Ravi R,98400 12345;98400 54321,50;50
//
// "location" lists the places below the community, separated by ">". A place may name its kind,
// as in "tower:Sky" ; otherwise the kind is taken from the first word (Block, Tower, Wing, Phase,
// Zone, Floor, Street, Cluster). Missing places are created. Owners are matched to existing
// people by mobile number. A preview runs every row exactly as the real import would, inside a
// savepoint that is then rolled back, so the preview reports the same errors the import would hit.
import { normalisePhone } from '../auth/crypto.ts';
import { many, one, type Tx } from '../db.ts';
import { fail, fromDatabase } from '../errors.ts';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

const KIND_WORDS: Record<string, string> = {
  block: 'block', tower: 'tower', wing: 'wing', phase: 'phase', zone: 'zone', floor: 'floor', street: 'street',
  avenue: 'street', lane: 'street', road: 'street', cluster: 'cluster', 'sub-block': 'sub_block', sub_block: 'sub_block',
};
const KINDS = new Set(['phase', 'zone', 'block', 'tower', 'wing', 'sub_block', 'floor', 'street', 'cluster', 'other']);

export function parseSegment(seg: string): { kind: string; name: string } {
  const s = seg.trim();
  const m = /^([a-z_]+):\s*(.+)$/i.exec(s);
  if (m && KINDS.has(m[1].toLowerCase())) return { kind: m[1].toLowerCase(), name: m[2].trim() };
  const words = s.toLowerCase().split(/\s+/);
  const kind = KIND_WORDS[words[0]] ?? (words.includes('floor') ? 'floor' : 'other');
  return { kind, name: s };
}

const num = (v: string | undefined) => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`"${v}" is not a positive number`);
  return n;
};

export type ImportResult = {
  rows: number; unitsCreated: number; locationsCreated: string[]; peopleCreated: number; ownersLinked: number;
  errors: { row: number; message: string }[]; committed: boolean;
};

export async function importUnits(tx: Tx, csv: string, opts: { dryRun: boolean; grantOwnerAccess: boolean }): Promise<ImportResult> {
  const table = parseCsv(csv);
  if (table.length < 2) fail(400, 'The file needs a header row and at least one unit.', 'invalid');
  if (table.length > 5001) fail(400, 'Import up to 5,000 units at a time.', 'invalid');
  const header = table[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (name: string) => header.indexOf(name);
  for (const need of ['location', 'unit', 'type']) if (col(need) < 0) fail(400, `The header row needs a "${need}" column.`, 'invalid');

  const root = (await one(tx, `select id, name from app.property_nodes where parent_id is null`))!;
  const types = await many(tx, `select id, code, lower(name) as name from app.unit_types`);
  const typeId = (v: string) => {
    const k = v.trim().toLowerCase().replace(/\s+/g, '');
    return types.find(t => t.code === k || t.name.replace(/\s+/g, '') === k)?.id;
  };
  const ownerRole = await one(tx, `select id from app.roles where key = 'owner' and archived_at is null`);
  const nodeCache = new Map<string, string>([['', root.id]]);
  const result: ImportResult = { rows: table.length - 1, unitsCreated: 0, locationsCreated: [], peopleCreated: 0,
    ownersLinked: 0, errors: [], committed: false };

  await tx.query('savepoint import_all');
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '');
    await tx.query('savepoint import_row');
    // Places and counts from this row only count once the row succeeds; a failed row is rolled back.
    const rowNodes = new Map<string, string>();
    const rowLocations: string[] = [];
    const tally = { units: 0, people: 0, owners: 0 };
    try {
      let segs = get('location').split('>').map(s => s.trim()).filter(Boolean);
      if (segs[0]?.toLowerCase() === root.name.toLowerCase()) segs = segs.slice(1);
      let parent = root.id, key = '';
      for (const seg of segs) {
        const { kind, name } = parseSegment(seg);
        key += '>' + name.toLowerCase();
        let id = nodeCache.get(key) ?? rowNodes.get(key);
        if (!id) {
          const found = await one(tx, `select id from app.property_nodes where parent_id = $1 and lower(name) = lower($2)`, [parent, name]);
          id = found?.id ?? (await one(tx, `insert into app.property_nodes (parent_id, kind, name, sort_order)
              values ($1, $2, $3, (select coalesce(max(sort_order), 0) + 10 from app.property_nodes where parent_id = $1))
              returning id`, [parent, kind, name]))!.id;
          if (!found) rowLocations.push(segs.slice(0, segs.indexOf(seg) + 1).join(' > '));
          rowNodes.set(key, id!);
        }
        parent = id!;
      }
      const label = get('unit') || fail(400, 'The unit number is missing.');
      const tId = typeId(get('type')) ?? fail(400, `Unknown unit type "${get('type')}". Add it under Unit types first.`);
      const floor = get('floor') ? Number.parseInt(get('floor'), 10) : null;
      if (floor !== null && !Number.isInteger(floor)) fail(400, `Floor "${get('floor')}" is not a whole number.`);
      const unit = (await one(tx,
        `insert into app.units (node_id, unit_type_id, label, floor_no, carpet_sqft, builtup_sqft, super_sqft, plot_sqft, uds_sqft)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [parent, tId, label, floor, num(get('carpet_sqft')), num(get('builtup_sqft')), num(get('super_sqft')),
          num(get('plot_sqft')), num(get('uds_sqft'))]))!;
      tally.units++;

      const names = get('owner_name').split(';').map(s => s.trim()).filter(Boolean);
      const phones = get('owner_phone').split(';').map(s => s.trim());
      const shares = get('owner_share').split(';').map(s => s.trim());
      for (const [j, name] of names.entries()) {
        const phone = phones[j] ? normalisePhone(phones[j]) ?? fail(400, `"${phones[j]}" is not a mobile number.`) : null;
        const share = shares[j] ? num(shares[j])! : Math.round((100 / names.length) * 100) / 100;
        let person = phone ? await one(tx, `select id from app.people where phone_e164 = $1 and archived_at is null`, [phone]) : null;
        if (!person) {
          person = await one(tx, `insert into app.people (full_name, phone_e164) values ($1, $2) returning id`, [name, phone]);
          tally.people++;
        }
        await tx.query(`insert into app.ownerships (unit_id, person_id, share_pct) values ($1, $2, $3)`, [unit.id, person!.id, share]);
        tally.owners++;
        if (opts.grantOwnerAccess && phone && ownerRole) {
          await tx.query(`insert into app.memberships (person_id, role_id) values ($1, $2) on conflict do nothing`,
            [person!.id, ownerRole.id]);
        }
      }
      if (names.length) await tx.query(`update app.units set occupancy = 'owner_occupied' where id = $1`, [unit.id]);
      // Ownership shares are checked at commit; check this unit now so the row gets the error.
      const total = await one(tx, `select coalesce(sum(share_pct), 0) as t from app.ownerships where unit_id = $1 and ends_on is null`, [unit.id]);
      if (Number(total.t) > 100) fail(400, `Owner shares add up to ${total.t}%.`);
      await tx.query('release savepoint import_row');
      for (const [k, v] of rowNodes) nodeCache.set(k, v);
      result.locationsCreated.push(...rowLocations);
      result.unitsCreated += tally.units; result.peopleCreated += tally.people; result.ownersLinked += tally.owners;
    } catch (e) {
      await tx.query('rollback to savepoint import_row');
      const msg = fromDatabase(e)?.message ?? (e as Error).message;
      result.errors.push({ row: i + 1, message: msg });
      if (result.errors.length >= 200) break;
    }
  }
  if (opts.dryRun || result.errors.length) {
    await tx.query('rollback to savepoint import_all');
    if (!opts.dryRun) fail(400, `${result.errors.length} row(s) have problems; nothing was imported. Preview the file to see them.`, 'import_errors');
  } else {
    await tx.query('release savepoint import_all');
    result.committed = true;
  }
  return result;
}
