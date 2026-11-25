# Security and the DPDP Act

Not legal advice. The contracts and notices below should be reviewed by a lawyer before the first paid community goes live.

## Who is responsible for what

Under the Digital Personal Data Protection Act, 2023 and its Rules (notified November 2025, with most obligations in force from May 2027):

- **Each association is the data fiduciary** for its residents' data. It decides why the data is collected and who sees it.
- **We are the data processor.** We process residents' data only on the association's instructions, under a written data processing agreement.
- In the customer-cloud tier the association also owns the Azure subscription; we act under the AMC and Azure Lighthouse access that the association can revoke.

## What the platform does to support the association's duties

| Duty | How Pragati Cloud supports it |
| --- | --- |
| Collect only what is needed | Phase 1 stores names, mobile numbers, optional emails, home and ownership details, committee roles. No Aadhaar, PAN or bank account numbers. |
| Security safeguards | Isolation by row-level security; encryption in transit (TLS 1.2+) and at rest (Azure-managed keys, storage infrastructure encryption); no public database or storage endpoints; managed identities instead of passwords; WAF; least-privilege database roles; append-only audit trail. |
| Access on a need-to-know basis | Roles per community, limited to a block or phase where needed. Owners see their own homes; other residents' phone numbers are hidden from them. |
| Records of processing | Every change is in the audit trail with who, what and when; it cannot be edited or deleted, even by the schema owner. |
| Data principal requests (access, correction, erasure) | Administrators can correct records and archive people. The full export answers access requests. Erasure that conflicts with the association's legal record-keeping (ownership history, approvals) needs a policy decision per association. |
| Breach notification | Front Door, database and Key Vault logs go to Log Analytics for 90 days. A breach runbook and the notification templates (to the Board and to affected residents) are to be written before go-live. |
| Retention | Backups 35 days; deleted files recoverable for 30 days. Per-association retention periods to be set in the processing agreement. |
| Data in India | All three tiers default to Central India, with geo-backups in South India. |

## Before the first paid community

1. Data processing agreement and terms of service (lawyer).
2. Privacy notice template the association gives residents, in English and Tamil.
3. External penetration test of a staging installation.
4. Breach runbook and contacts; alert rules in Azure Monitor.
5. Restore drill: restore the shared database to a new server and check one community end to end.
6. Tamil interface text reviewed by a native speaker.
7. DLT registration of the SMS sender and template with MSG91.

## Reporting a security problem

Email the security contact listed in the service agreement. Do not open a public issue.
