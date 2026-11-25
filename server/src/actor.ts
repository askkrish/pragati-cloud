import { many, one, type Tx } from './db.ts';
import { fail, forbidden } from './errors.ts';

export type NodeRef = { id: string; ancestor_ids: string[] };
export type Grant = { roleKey: string; roleName: string; perms: Set<string>; scope: string | null; scopeName: string | null };

// The signed-in person and what each of their roles allows, and where. A role given for a block
// applies to that block and everything inside it; a role with no location applies community-wide.
export class Actor {
  constructor(
    public userId: string,
    public personId: string,
    public name: string,
    public phone: string,
    public grants: Grant[],
  ) {}

  private covers(g: Grant, node?: NodeRef | null) {
    if (g.scope === null) return true;
    if (!node) return false;
    return node.id === g.scope || node.ancestor_ids.includes(g.scope);
  }
  can(perm: string, node?: NodeRef | null) {
    return this.grants.some(g => g.perms.has(perm) && this.covers(g, node));
  }
  canAnywhere(perm: string) {
    return this.grants.some(g => g.perms.has(perm));
  }
  require(perm: string, node?: NodeRef | null) {
    if (!this.can(perm, node)) forbidden();
  }
  // null = everywhere; otherwise the list of locations (and their subtrees) the permission covers.
  scopes(perm: string): string[] | null {
    const gs = this.grants.filter(g => g.perms.has(perm));
    if (!gs.length) forbidden();
    if (gs.some(g => g.scope === null)) return null;
    return [...new Set(gs.map(g => g.scope as string))];
  }
  permissions() {
    return [...new Set(this.grants.flatMap(g => [...g.perms]))].sort();
  }
}

export async function loadActor(tx: Tx, userId: string, phone: string): Promise<Actor | null> {
  const person = await one(tx,
    `select id, full_name from app.people where user_id = $1 and archived_at is null order by created_at limit 1`, [userId]);
  if (!person) return null;
  const rows = await many(tx,
    `select r.key, r.name, r.permissions, m.scope_node_id, n.name as scope_name
       from app.memberships m
       join app.roles r on r.tenant_id = m.tenant_id and r.id = m.role_id and r.archived_at is null
       left join app.property_nodes n on n.tenant_id = m.tenant_id and n.id = m.scope_node_id
      where m.person_id = $1 and m.status = 'active'`, [person.id]);
  if (!rows.length) return null;
  return new Actor(userId, person.id, person.full_name, phone, rows.map(r => ({
    roleKey: r.key, roleName: r.name, perms: new Set<string>(r.permissions), scope: r.scope_node_id, scopeName: r.scope_name,
  })));
}

export async function getNode(tx: Tx, id: string | null | undefined) {
  const node = id
    ? await one(tx, `select * from app.property_nodes where id = $1`, [id])
    : await one(tx, `select * from app.property_nodes where parent_id is null`);
  return node ?? fail(404, 'That location was not found.', 'not_found');
}

export async function rootNode(tx: Tx) {
  return getNode(tx, null);
}
