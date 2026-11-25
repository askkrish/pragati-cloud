# Architecture

## One codebase, three ways to host it

| | Shared cloud | Dedicated | Customer's cloud |
| --- | --- | --- | --- |
| Where | Our Azure subscription | Our Azure subscription | The customer's Azure subscription |
| Database | One, shared by many communities | Its own | Its own |
| Who pays Azure | Us, in the subscription fee | Us, in a premium fee | The customer |
| Who runs it | Us | Us | Us, under an annual maintenance contract |
| Terraform | `infra/azure/envs/shared` | `infra/azure/envs/dedicated-example` | `infra/azure/envs/customer-cloud-example` |

Every installation runs the same image built from this repository. There is never a custom copy per client; differences are settings, roles and approval rules stored in the database. An installation in a customer's cloud receives the same releases as everyone else. Moving a community from the shared cloud to its own installation is an export from one and an import into the other: ids are UUIDs, so nothing collides.

## Request path

```
Browser ──HTTPS──▶ Azure Front Door + WAF ──▶ Container Apps (2–10 replicas) ──private network──▶ PostgreSQL 16
   <slug>.pragati.example     managed certificates,        Node 22, Fastify                       Flexible Server, zone-redundant,
   or the community's         OWASP rules, bot rules,       managed identity, no secrets           35-day backups, geo-copy
   own domain                 sign-in rate limit            in config                    ──▶ Blob Storage (private)
                                                                                         ──▶ Key Vault (private)
```

The app finds the community from the web address (`resolve_tenant`). Behind Front Door the original address arrives in `X-Forwarded-Host`; the app refuses any request without Front Door's own `X-Azure-FDID` value, so the container cannot be reached around the firewall.

## Keeping communities apart

Three independent layers, each tested:

1. **The database decides what is visible.** Every table with community data has row-level security switched on and forced. Each request runs in one transaction that sets `app.tenant_id` with `set_config(…, true)`, which ends with the transaction, so a pooled connection never carries a community into the next request. Without it, the app sees nothing. `test/isolation.test.ts` checks every such table, including any added later.
2. **References cannot cross.** Foreign keys include `tenant_id` (for example `(tenant_id, node_id) → property_nodes (tenant_id, id)`), so even a correct id from another community is rejected.
3. **The application role is narrow.** The app connects as a member of `pragati_app`: it owns nothing, cannot bypass row-level security, cannot change a community's address or hosting tier, cannot delete the audit trail, and cannot read sign-in tables at all. Sign-in works through five small `SECURITY DEFINER` functions. Onboarding uses a separate `pragati_platform` role that can create communities and read counts but not records.

## Data model (Phase 1)

```
tenants ─┬─ tenant_domains
         ├─ property_nodes (tree: parent_id, ancestor_ids[], depth)  ─┬─ units ─┬─ ownerships ── people
         │                                                            │         ├─ occupancies ── people
         │                                                            │         ├─ parking_slots, meters
         │                                                            └─ facilities
         ├─ unit_types
         ├─ roles (permissions[]) ── memberships (person, role, scope node)
         ├─ committees (scope node, parent) ── committee_seats (person, position, dates)
         ├─ approval_rules (subject, amount band, scope) ── approval_rule_stages (committee selector, mode)
         ├─ approval_requests (rule snapshot) ── approval_stages ── approval_stage_voters ── approval_votes
         ├─ files (bytes in Blob Storage)
         └─ audit_events (append-only)
auth_private: users (mobile number), otp_challenges, sessions      ← not readable by the app
```

`ancestor_ids` is kept by triggers, so "everything in Block A" is one indexed query, and moving a block moves everything inside it.

## Approval routing

When a request is raised, the most specific active rule wins: a rule for the request's own place before one for a place above it, a rule for its subject before a catch-all, then priority, then the higher amount band. Each stage names a committee by selector:

- **nearest**: the block, phase or apex committee closest above the request's place
- **apex**: the managing committee or federation council
- **fixed**: a named committee

If two consecutive stages land on the same committee (a community-wide request where "nearest" is the apex committee), it decides once under the stricter requirement. The rule is copied onto the request, so editing a rule never changes a request already raised. Voters are frozen when a stage opens; someone who leaves the committee stops counting, and pending requests are re-checked when a seat ends.

## Sign-in

1. The visitor enters a mobile number. The reply is identical whether or not the number has access, so the page can't be used to find out who lives there.
2. If the number belongs to someone with access, a 6-digit code is sent by SMS (MSG91 with a DLT-registered template in production). Only an HMAC of the code is stored. Limits: 3 codes per number per 15 minutes, 30 per address per hour, 5 attempts per code, 5-minute expiry; Front Door adds its own limit.
3. A correct code creates a session for that community only. The browser holds a random token in an HttpOnly, Secure, SameSite cookie; the database holds its SHA-256. Sessions end after 30 days, or 7 days unused, or at sign-out.

Changes also require an `x-pragati: 1` header, which browsers will not send cross-site without a CORS approval this API never gives.

## What comes next

Phase 2 builds on this foundation: billing (per sq ft, per unit type, per land share; block-only costs), facility bookings, UPI collection, the owner app, and the daily-work modules carried over from JAOA Pragati (projects, routines, procurement, notices, Ask Pragathi).
