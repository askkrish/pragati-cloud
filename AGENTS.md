# AGENTS.md: how to work on Pragati Cloud

Read this first on every task. The longer handover is in `docs/HANDOVER.md`.

## What this is

Pragati Cloud runs apartment and township associations for many communities from one codebase: operations checklists, work orders, procurement, project delivery, double-entry finance, committee approvals, notices, records, report packs, an AI assistant (Ask Pragathi) and document reading. It is the multi-community successor to JAOA Pragati, which is a separate, live system.

Status: a pilot on Azure with three made-up demo communities. No real residents yet.

## Commands

| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Build (web, type check, server bundle) | `npm run build` |
| Type check only | `npm run typecheck` |
| Tests (106, against a fresh Postgres database the tests create) | `npm test` (set `TEST_ADMIN_URL=postgres://<admin>@localhost:5432/postgres` if needed) |
| Local database: roles, database, migrations | `npm run db:setup -- postgres://<admin>@localhost:5432/postgres pragati_dev` |
| Apply new migrations | `DATABASE_URL_OWNER=... npm run db:migrate` |
| Demo data | `node --env-file=.env --import tsx seed/samples.ts` |
| Run | `npm run build && node --env-file=.env dist/server/main.js`, then open http://palm-meadows.localhost:8080 |

The app does not read `.env` by itself; pass `--env-file=.env` or export the values. Needs Node 22 and PostgreSQL 16. `PRAGATI_DEV_SHOW_OTP=1` shows sign-in codes on screen in development. Demo administrator: 90000 30001 (Palm Meadows).

Before you finish any task: `npm run build` and `npm test` must both pass.

## Layout

```
server/src/routes/     API, one file per area; index.ts registers them
server/src/services/   approvals.ts (approval engine), ledger.ts (double-entry books), audit.ts,
                       files.ts + storage.ts (Blob or disk), ai.ts (all Claude calls),
                       internal.ts (getAs: internal lookups with the person's own permissions)
server/src/db.ts       one transaction per request, scoped to one community
server/src/actor.ts    who is asking and what they may do
web/src/pages/         React screens, one per area
web/src/i18n.ts        English and Tamil strings (Tamil is a draft awaiting native review)
db/migrations/         numbered SQL files, append-only
seed/                  made-up demo communities
test/                  node:test suites; isolation.test.ts guards community separation
scripts/               platform.ts (create/suspend communities), smoke.ts (live checks), db-setup.ts
infra/azure/           Terraform: modules/pragati-pilot (running), modules/pragati (production, not applied)
.github/workflows/     ci.yml (every push and PR), deploy-pilot.yml (push to main deploys)
```

No ORM: SQL is written by hand. Inputs are checked with zod. Errors are thrown with `fail(status, message, code)`; the error's status property is `.status`.

## Rules that must not be broken

1. **Leave JAOA Pragati alone.** Never push to `askkrish/jaoa-pragati`, redeploy it, or connect to its database.
2. **Made-up data only.** Tests, seeds and screenshots use invented people and numbers. Never add real residents, bank details or JAOA records.
3. **Every community table is fenced.** New tables holding community data get `tenant_id`, `enable` and `force row level security`, the `tenant_isolation` policy using `app.current_tenant()`, and foreign keys that include `tenant_id`, for example `(tenant_id, node_id) references app.property_nodes (tenant_id, id)`. Never weaken `test/isolation.test.ts`.
4. **The app's database role stays narrow.** The app connects as `pragati_web` (member of `pragati_app`). Never grant it ownership, `bypassrls`, delete on the audit trail, or access to sign-in tables. Never run the app as `pragati_owner`.
5. **Migrations only move forward.** Never edit a migration already in `db/migrations/` (0001 to 0012 are deployed). Add the next number. New permission keys go into the permissions catalog and `platform.role_templates()` in the same migration.
6. **Money goes through the ledger.** Every posting is balanced double entry through `services/ledger.ts`. Never update balances directly or delete posted journals; corrections are reversals. Payment stays blocked while a voucher's GST check is pending.
7. **Decisions go through the approval engine.** Expenses, vendor choices, contract changes, permits and projects use `services/approvals.ts` (subject_type and subject_id), never a flag set from the screen.
8. **Permissions are checked on the server.** Every route checks its permission key. Search, Ask Pragathi and packs read data through `getAs` so a person never sees more than on the screens.
9. **No secrets in code.** Keys live in GitHub secrets or Azure. Claude is called only through `services/ai.ts`, only when the community has `assistant_enabled`, within the configured limits, with contact details removed.
10. **Main must stay green.** A push to main deploys to the pilot. Work on a branch, open a pull request, merge only when CI passes.

Also: screens use plain words in English and Tamil, phone first; every change is written to the audit trail.

## Working style

- Small pull requests, one change each, with tests.
- For anything touching migrations, `db.ts`, `ledger.ts`, `approvals.ts` or the isolation test, explain the change in the pull request so a person can check it against the rules above.
- When unsure how something behaves, write a test that shows it rather than guessing.
- Keep README.md and docs/ in step with the code you change.
