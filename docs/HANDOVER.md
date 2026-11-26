# Handover: Pragati Cloud to Amrish (with Codex)

As of 26 November 2026. Krish built Pragati Cloud with Claude; Amrish takes it forward with Codex and ChatGPT. The rules for every code change are in [AGENTS.md](../AGENTS.md).

## Summary

Pragati Cloud is built (Phase 1 foundation and Phase 2 modules 1 to 8), tested (106 automated tests) and running as a pilot on Azure with three made-up demo communities. It is ready to be taken forward, but not yet for real residents: nine go-live tasks remain (below), mostly registrations, legal paperwork and checks rather than code.

JAOA Pragati, the system Jains Ansruta Owners Association uses today, is a separate repository and deployment. Nothing here changes it.

## Links

| What | Where |
| --- | --- |
| Code | https://github.com/askkrish/pragati-cloud (main branch; currently public) |
| Rules for Codex | [AGENTS.md](../AGENTS.md) |
| Features, module by module | [README.md](../README.md) |
| Architecture | [docs/architecture.md](architecture.md) |
| Security and India's data protection law | [docs/security-and-dpdp.md](security-and-dpdp.md) |
| Adding a community | [docs/onboarding-a-community.md](onboarding-a-community.md) |
| What came from JAOA | [docs/learnings-from-jaoa.md](learnings-from-jaoa.md) |
| Azure notes | [infra/azure/README.md](../infra/azure/README.md) |
| Deploys | https://github.com/askkrish/pragati-cloud/actions/workflows/deploy-pilot.yml |
| Live pilot | https://ca-pragati-pilot-web.gentlehill-90531a97.southindia.azurecontainerapps.io (Palm Meadows demo) |
| Azure | Resource group `rg-pragati-pilot` (South India); Terraform state in `rg-pragati-tfstate` |
| JAOA Pragati (reference only, private) | https://github.com/askkrish/jaoa-pragati |

## Access

Grant by role; never share passwords or keys in chat, code or documents.

| Access | How | For |
| --- | --- | --- |
| GitHub | Repository Settings, Collaborators: Amrish with Maintain (Admin to manage secrets) | Code, pull requests, deploys |
| Codex | Amrish connects GitHub in ChatGPT and allows Codex on this repository | Codex tasks and pull requests |
| Ask Pragathi and document reading | Create a key at console.anthropic.com; add it as the repository secret `ANTHROPIC_API_KEY`; the next deploy switches it on | The assistant and reading |
| Azure, read | Invite Amrish as a guest in Entra ID; Reader on `rg-pragati-pilot`; Cost Management Reader on the subscription | Logs, health, costs |
| Azure, change | Contributor on `rg-pragati-pilot` only when needed; normal changes go through Terraform | Emergencies, restore drill |
| SMS (later) | MSG91 and DLT registration; key into Azure as a secret | Real sign-ins |

Deploys need no personal Azure sign-in: GitHub Actions uses the deployment identity `pragati-cloud-github-deploy`, whose federated credential trusts exactly `askkrish/pragati-cloud`, environment `pilot`. If the repository is moved or renamed, update that credential in Entra ID and the `ARM_*` values in `.github/workflows/deploy-pilot.yml` in the same change, or deploys stop.

### Demo sign-ins (invented people; the code shows on screen)

| Mobile | Person | Role |
| --- | --- | --- |
| +91 90000 30001 | Vasanthi Murthy | Secretary: administrator and office bearer |
| +91 90000 30003 | Rajesh Sharma | Treasurer |
| +91 90000 30002 | Sridhar Natarajan | Office bearer |
| +91 90000 30101 | Prakash Menon | Facility manager |
| +91 90000 30105 | Ravi Shankar | Staff |
| +91 93000 00483 | Deepak Sharma | Owner |

Demo data is refreshed three times a day by the job `caj-pragati-pilot-demo`.

## Architecture

```
Browser ──HTTPS──▶ Web app (Container App ca-pragati-pilot-web, Node 22, Fastify + React, managed identity)
                      ├──▶ PostgreSQL 16 Flexible Server (private network, row-level security per community)
                      ├──▶ Blob Storage (files; identity only, no keys)
                      └──▶ Anthropic API (Ask Pragathi and reading; off until the key is set)

GitHub main ──▶ GitHub Actions deploy-pilot.yml:
                tests → Terraform apply → image to registry → migrations job → switch app → demo data job → 27 live checks
```

The pilot uses Azure free allowances. Before a community stores real data, move it to the production module `infra/azure/modules/pragati` (Front Door with firewall, standby database, Key Vault, private endpoints).

## What is left before real communities

1. SMS sign-in: DLT registration of the sender and template, MSG91 account, then `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`.
2. Own web address: buy the domain and follow the Domains step in `infra/azure/README.md`.
3. Production installation: apply `modules/pragati` with the Azure owner present.
4. Data processing agreement and terms (lawyer), naming Anthropic as a sub-processor; privacy notice in English and Tamil.
5. Tamil review of `web/src/i18n.ts` and the print packs by a native speaker.
6. External penetration test of a staging copy.
7. Restore drill: restore the database to a new server, check one community end to end, write down the steps.
8. Breach runbook, notification templates and Azure Monitor alerts.
9. Decide whether the repository stays public or moves to a company organisation.

Start 1 and 4 first; they depend on others.

## Working with Codex

1. Create a Codex cloud environment for this repository. Ask for Node 22 and PostgreSQL 16, then `npm ci`, `npm run build`, `npm test`. Publish it only when all tests pass. Agent internet: package managers only. No secrets needed.
2. First prompt (no changes): "Read AGENTS.md and docs/HANDOVER.md, run npm test, then explain how a request travels from the browser to the database and how communities are kept apart. List anything in the docs that no longer matches the code. Change nothing."
3. First safe task: "Write scripts/export-labels.ts that prints every English phrase and its Tamil draft from web/src/i18n.ts into a CSV a Tamil reviewer can correct, with a column for phrases that have no Tamil yet. Add a test. Open a pull request."
4. Before every merge: "Review this pull request against the ten rules in AGENTS.md; for each, pass or fail with the line that shows it. Run npm test and npm run typecheck."
5. Bigger changes (MSG91 sign-in, production move): plan first, then small pull requests with tests.

Read every diff touching `db/migrations/`, `server/src/db.ts`, `services/ledger.ts`, `services/approvals.ts` or `test/isolation.test.ts` yourself.

## Costs

The pilot is designed to cost well under ₹500 a month during Azure's 12-month free allowances (database B1ms and registry), which end about November 2027. A ₹3,000 budget alert is on the subscription. The Anthropic key is pay per use, model `claude-haiku-5-5`, capped by the app at 25 questions a person a day, 1,500 a community a month and 40 document reads a person a day; every question's cost is logged.

## First week

- [ ] Access: GitHub, Azure Reader, Anthropic key as a secret.
- [ ] Read this file, AGENTS.md, README.md, docs/architecture.md.
- [ ] Walk the pilot as each demo person: a check, a request, quotations, an approval, a voucher paid.
- [ ] Run locally with `npm test` green.
- [ ] Set up Codex; run the first two prompts; merge the first pull request and watch the deploy pass 27 of 27 live checks.
- [ ] Start DLT registration, the lawyer and the Tamil reviewer.
- [ ] Agree with Krish on the domain and the repository's visibility.
