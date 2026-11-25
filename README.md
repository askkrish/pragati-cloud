# Pragati Cloud

A community management platform for apartment associations, gated communities and townships. Each community names its own platform, the way Jains Ansruta has **JAOA Pragati**: Palm Meadows gets *Palm Meadows Pragati*, Riverside Greens gets *Riverside Greens Pragati*.

This is a new codebase. JAOA Pragati keeps running unchanged; this repository carries over what worked there (see [docs/learnings-from-jaoa.md](docs/learnings-from-jaoa.md)) and rebuilds the foundations for many communities of any shape.

## What Phase 1 delivers

| Area | What works |
| --- | --- |
| Communities kept apart | Every row carries its community; PostgreSQL row-level security limits each request to one community; foreign keys include the community, so records can never point across. Tested table by table. |
| Any shape of community | A property tree of any depth with any names: federation or community → phase or zone → block or tower → wing or sub-block → floor or street → unit. Units of any type (studio to penthouse, villa, row house, plot, shop, office) with carpet, super and plot area, undivided land share, parking and meters. Shared facilities such as a golf course belong to the place that owns them. |
| People and ownership | Joint owners with percentage shares (never above 100%), tenants and family, sales that keep the ownership history. |
| Bulk set-up | Import a whole community from a spreadsheet saved as CSV. A preview runs every row and names each bad row; nothing is saved unless every row is clean. |
| Roles and access | Each community defines its own roles from a fixed list of permissions; a role can be given community-wide or for one block or phase. Nobody can give access they don't have; the last administrator can't be removed. |
| Committees and approval rules | An apex committee or federation council with block, phase and tower committees. Approval rules are settings: by subject, amount band and place; one to five stages; unanimous, majority, a set number or any one member. JAOA's rules carry over: the proposer's vote counts, people who leave stop counting, objections need a reason, office bearers can record a signed letter. |
| Sign-in | Mobile number and a one-time SMS code. Codes and session tokens are stored only as hashes; a session works only on the community it was made for; idle sessions lapse after 7 days. |
| Own name and look | Platform name ("<name> Pragati"), colour, logo, languages. English and Tamil screens. |
| Records | Append-only audit trail of every change; a full data export per community. |
| Azure | Terraform for the shared cloud, a dedicated installation and an installation in a customer's own subscription. |

## Phase 2, module 1: operations

Carried over from JAOA Pragati's daily operations, projects, service requests and asset register, and rebuilt for many blocks.

| Area | What works |
| --- | --- |
| Daily checklist | Routines due daily, on chosen weekdays, monthly (including "last day"), quarterly, half-yearly, yearly or once, each with an optional time window. Staff mark a check done, started, skipped (with a reason) or blocked; a day with nothing recorded after its window is missed, and work recorded after the window is late. Readings, reference numbers, photos and remarks can be required per routine. |
| Schedule history | A schedule change applies from today or a later day; past days are always judged by the schedule that applied then. |
| Work orders | Service requests raised by owners and residents for their own home, incidents, maintenance and projects. Status moves with the reason where it matters (on hold, done, reopened, cancelled); the person who raised a request confirms the fix. Updates can be staff-only; residents never see staff-only notes, estimates or staff names. A blocked check can raise a work order. Spending goes through the community's approval rules. |
| Assets and renewals | Lifts, generators, pumps, STPs and other equipment by place, with AMCs, warranties, insurance, licences and inspections. Renewing keeps the old record; overdue and due-soon items show on the home page. |
| Access | Operations permissions per role and per block: committee members see, facility managers set up and assign, staff without full view see only what is given to them. |


## Running it locally

Needs Node 22 and PostgreSQL 16.

```sh
npm install
npm run db:setup -- postgres://<admin>@localhost:5432/postgres pragati_dev   # roles, database, migrations
npm run seed                                                                # three sample communities
npm run build && PRAGATI_DEV_SHOW_OTP=1 npm start
```

Open http://maple-court.localhost:8080, http://riverside-greens.localhost:8080 or http://palm-meadows.localhost:8080. Sign in as an administrator with 90000 10001, 90000 20001 or 90000 30001; in development the code is shown on screen. All sample data is invented.

`npm test` runs 66 tests against a fresh database (set `TEST_ADMIN_URL` if your admin login differs).

## Layout

```
db/migrations/      SQL schema, row-level security, sign-in and platform functions
server/src/         API (Fastify, TypeScript)
  services/         approval engine, CSV import, files, audit, storage
  routes/           one file per area
web/src/            phone-first web app (React)
seed/               synthetic sample communities
scripts/            database set-up, onboarding command
infra/azure/        Terraform module and the three installation types
test/               isolation, sign-in, permission, approval and property tests
docs/               architecture, security and DPDP, onboarding, learnings from JAOA
```

## Onboarding a community

See [docs/onboarding-a-community.md](docs/onboarding-a-community.md). In short:

```sh
npm run platform -- create palm-meadows "Palm Meadows" "Palm Meadows Township Federation" Chennai federation "Palm Meadows Township" "Vasanthi Murthy" 9000030001
```

Then the community's administrator signs in, checks the platform name and colour, and imports the units.
