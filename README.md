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

## Phase 2, module 4: notices, records and report packs

| Area | What works |
| --- | --- |
| Notices | For everyone, owners, the committee or staff, across the community or for one block or phase. Publish now or at a set time, pin, take down on a date, attach a PDF or picture, withdraw with a reason. Residents see what is new; the publisher sees how many have opened it. |
| Records library | Bye-laws, minutes, AGM papers, accounts, audit reports, insurance, licences, contracts, plans. Each document is seen by everyone, owners, the committee or the finance team; new versions keep the old ones; review dates flag licences and policies that need renewing. Files always download through the access check. |
| Weekly committee pack | Checks done and missed by kind of work, work opened and closed, the oldest open work, renewals, approvals waiting and decided, cash and bank, payments and dues. Each part appears only for those allowed to see it. |
| Owners' monthly update | Checks done, requests fixed and how fast, work completed, collection rate, notices: counts only, no names or amounts. |
| Printing | Packs, statements of dues and payment vouchers open as A4 pages to print or save as PDF from the browser, which shapes Tamil correctly. Voucher pages carry signature lines. |




## Phase 2, module 6: project delivery and controls

| Area | What works |
| --- | --- |
| Project delivery | Requests for quotation with the written scope, reply date and vendors asked. After the vendor choice is approved, the contract (never above the approved amount) and its signed copy; an agreement made before the platform can be recorded with a note. Change orders in amount and time go through the approval rules; the committed amount and finish date include only approved changes. Milestones with payments; paid and pending vouchers against the work. |
| Handover | Tests, open defects, warranty, assets and a completion report, addressed to someone who looks after operations there. They accept it, which completes the work, or return it to be fixed. Contracted projects cannot be marked done any other way. |
| Asset service log | Services, inspections, repairs and statutory checks with the outcome and next due date; a failed check can raise a work order in the same step. Assets due for service are listed. |
| GST checks | The preparer records the vendor's GSTIN and invoice; only the treasurer verifies. A voucher with GST pending cannot be paid. A verified GSTIN fills in the vendor record. |
| Permits | Owners mark requests that need the committee's permission (terrace drilling or cabling, renovation, moving). Work cannot start without a permit in force; the committee grants it with conditions and an end date, declines it, or revokes it, which stops work in progress. |
| Ageing decisions | Approvals waiting longer than the community's setting (7 days unless changed) are flagged. |

## Phase 2, module 7: getting around, reports and the rest of JAOA

| Area | What works |
| --- | --- |
| Search | One box for requests and work, approvals, notices, records, homes, people, vendors, assets, routines and vouchers. Each source is read through the API as the person searching, so it shows only what their screens would. A reference such as WO-0012 opens the record. |
| QR labels | Printable labels for each place with checks; scanning one opens that place's checks for the day. |
| Installable and offline | The app installs on phones in the community's name and colour. Screens keep working without signal, and checks recorded offline wait on the phone (without photos) until they can be sent. Community data is never stored by the service worker. |
| Packs | An end-of-day summary, and an annual pack for the AGM: work by kind, time to fix requests, equipment services, projects with committed and paid amounts, decisions, and for those who see the books, income and expenditure, balance sheet, budget and collection. The weekly pack adds equipment due for service, incidents, project milestones and handovers waiting, and flags ageing decisions. |
| Notice templates | Standard notices (water or power off, lift outage, pest control, dues reminder, AGM) and the community's own, with fill-in fields such as {{day}}. |
| Voucher import | Up to 50 payments from a CSV saved from Excel or Google Sheets, checked line by line; saved only if every line passes, each sent for approval. |
| Ask Pragathi | References in answers open the record; copy and rate each answer; it drafts a service request for the asker's home, which they check and send themselves. Monthly usage and ratings for the committee. |
| Help and feedback | A short guide for each kind of person and a message form to the platform team. |

## Phase 2, module 5: Ask Pragathi

Questions in plain words, in English or Tamil, answered by Claude from the community's own records.

| Area | How it works |
| --- | --- |
| What it can see | Only what the person asking may see. Each lookup the assistant makes is an ordinary request to the app's own API with the asker's session, so it passes the same permission checks and row-level security as the screens. It can read dues, requests, work orders, quotations, assets, renewals, vendors, approvals, notices, the records library's titles, packs and, for those allowed, the books and reports. |
| What it cannot do | Change anything: it has no write lookups. Lookups are a fixed list; ids are checked, so a lookup cannot be steered to another address. |
| Privacy | Phone numbers, email addresses, UPI and bank details, and storage internals are removed before anything leaves the app. A community switches the assistant on in the app (Ask Pragathi, under More) after reading what is sent to the AI provider. Demo communities have it on. |
| Cost | Haiku by default (`ASK_MODEL`), with the instructions and lookup list cached. Each question is logged with its token counts. Limits: 25 questions per person per day and 1,500 per community per month (`ASK_DAILY_LIMIT`, `ASK_MONTHLY_LIMIT`). |
| Switching it on | Add the `ANTHROPIC_API_KEY` repository secret in GitHub; the next deploy passes it to the app as a Container Apps secret. Without it the assistant is off everywhere. |

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
