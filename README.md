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

## Phase 2, module 2: procurement

| Area | What works |
| --- | --- |
| Vendors | A directory per community with kinds of work, contacts and GSTIN; vendors can be put on hold or blocked, with the reason recorded. |
| Quotations | Recorded against a work order with the GST basis, scope, exclusions, time, warranty, validity and payment terms, and the quotation itself. A revised quotation replaces the earlier one, which is kept. |
| Comparison | Side by side, with the total including GST where it can be known. No quotation is called the lowest until all show the same GST basis, and the terms each one leaves out are listed for follow-up. |
| Choosing a vendor | A reason is always recorded; a single quotation needs a justification; lapsed quotations and blocked vendors cannot be chosen. The choice goes through the approval rules as "choosing a vendor", carrying the comparison. |
| Reviews | Quality, time and value scores after the work is done; a low score needs a comment. |

## Phase 2, module 3: finance

Full books for each community, as agreed in the commercial plan, with export to Tally.

| Area | What works |
| --- | --- |
| Books | Double entry with a standard chart per community (general, corpus and sinking funds; receivables kept per home). Every entry balances and is permanent; corrections are reversals. Closed periods and each bank account's reconciled-through date are enforced by the database itself. |
| Billing | Plans by area (carpet, built-up, super built-up, plot or UDS), by kind of home, or a flat amount; monthly to yearly; for the whole community or one block or phase. A billing run is a draft until posted, and runs once per period. |
| Dues | Each home's statement and balance; payments settle the oldest charges first; ageing in 30-day bands. Owners see their own homes only, pay by UPI with the amount filled in, and report payments with the UTR for the treasurer to confirm. |
| Vouchers | Prepared by the facility manager, decided by the approval rules for spending, paid by the treasurer with TDS deducted where it applies. The same vendor invoice cannot be paid twice. |
| Bank | Import a bank statement (CSV), match it automatically by reference and amount, match the rest by hand, then lock the account up to that day. |
| Reports | Income and expenditure (also for one block), balance sheet, trial balance, cash and bank, dues by home, billing and collection, budget and actual, day book; each downloads for Excel. Tally ledgers and entries download as XML. |
| Roles | A Treasurer role keeps the books; committees and auditors read them; facility managers prepare vouchers. |




## Running it locally

Needs Node 22 and PostgreSQL 16.

```sh
npm install
npm run db:setup -- postgres://<admin>@localhost:5432/postgres pragati_dev   # roles, database, migrations
npm run seed                                                                # three sample communities
npm run build && PRAGATI_DEV_SHOW_OTP=1 npm start
```

Open http://maple-court.localhost:8080, http://riverside-greens.localhost:8080 or http://palm-meadows.localhost:8080. Sign in as an administrator with 90000 10001, 90000 20001 or 90000 30001; in development the code is shown on screen. All sample data is invented.

`npm test` runs 81 tests against a fresh database (set `TEST_ADMIN_URL` if your admin login differs).

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
