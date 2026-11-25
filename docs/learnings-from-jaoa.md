# What we carried over from JAOA Pragati

JAOA Pragati runs one 50-flat building. It keeps the whole workspace as one JSON document, which was right for a single community and is the main thing this rebuild replaces. Its code was read, not changed.

| JAOA Pragati | Pragati Cloud |
| --- | --- |
| One JSON document per workspace | Proper tables, one community per row, row-level security |
| Fixed roles (committee, Appu, Akash, Dinesh, owner, resident, viewer) in code | Roles each community defines from a list of permissions, optionally for one block or phase |
| Unanimous approval switch | Approval rules as settings: subject, amount band, place, stages, mode. A new community starts with JAOA's rule: every committee member approves |
| Proposer's vote counts as approval | Kept, per rule |
| Voters frozen at proposal; leavers stop counting | Kept; requests are also re-checked when someone leaves |
| Objection needs a note; votes can change | Kept |
| President, Treasurer or administrator can approve with a signed letter | Kept as the "approvals.override" permission, given to office bearers; a rule can switch it off |
| One open approval per subject | Kept |
| Apply the approved change to a copy first | Approval requests are separate from the change; future modules apply their change only after approval, in one transaction |
| Audit list inside the document | Append-only table, protected by triggers and grants |
| Email and password accounts with app_metadata flags | Mobile number and one-time code; sessions per community |
| Single block | Federation, phases, towers, wings, floors, streets, villas, shops, facilities |
| Owner and viewer permissions checked across UI, search, downloads, Ask Pragathi | Enforced in the API and the database; files always download through an access check |
| Tamil PDFs, phone-first screens | Phone-first web app with English and Tamil; PDFs come with the reporting modules |
| Nightly backups of the document | Point-in-time database backups for 35 days, geo-copied; full export per community |

## Still to carry over (Phase 2 and later)

Done in Phase 2, module 1 (operations): routines with versioned schedules, missed and late work, skips with reasons, blocked checks raising work orders, service requests with owner-visible and staff-only updates, incidents, maintenance, projects, and the asset and AMC register.

Done in module 2 (procurement): vendors, quotations with the GST basis and terms, like-for-like comparison checks, single-quotation justification, vendor choice through approvals, and vendor reviews. JAOA's AI comparison and public vendor research come with Ask Pragathi.

Done in module 3 (finance): JAOA's cash book, dues, bills, vouchers, journals, period close, statement reconciliation and reports, rebuilt as a double-entry ledger with billing plans for many blocks, owners' payment reports and Tally export.

Still to come: notices, records library, reports and weekly packs, Ask Pragathi, and the Tamil PDF layouts. These modules plug into the approval engine through `subject_type` and `subject_id`, as work orders already do.
