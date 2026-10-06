---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
'@substrat-run/dashboard': minor
---

Findings with a lifecycle (#1748): a tenant-scoped inbox of anomalies, triaged like email.

- A finding is one per (tenant, kind, subject), in a new directory table `_substrat_findings` (`FINDINGS_DDL`, kernel-owned, so both adapters run the same statements). Kinds: `recurring` (a tenant's own ops failures on one `_substrat_issues` fingerprint), `invariant` (a failed scheduled run) and `drift` (a freshness expectation judged stale). Each is opened on write by `recordOpsFailure` / `recordSweepRun` themselves: no cron, no scan, one indexed rule lookup and one upsert per occurrence. A replayed drain the sweep record ignores is not counted again.
- Statuses `open`, `acked`, `resolved`, `suppressed`, with a `regressed` flag; the issue statuses map 1:1 (new → open, regressed → open + regressed, resolved → resolved, ignored → suppressed). A resolved finding seen again reopens `regressed`, and when it came back under a version other than the one it was resolved under, that version is its `likelyCause`.
- A finding carries the tenant's own count, versions and scope, an `evidence` reference to where its rows are read, and the codes seen — never the evidence's free text, and never the fleet count of a fingerprint it shares with other tenants.
- `HostAdmin.listFindings`, `setFindingStatus` (acknowledge / resolve / reopen, keyed on the tenant), `createFindingRule` / `revokeFindingRule` / `listFindingRules`. A suppress rule names at least one of kind, operation, code or subject and expires within `FINDING_RULE_MAX_DAYS` (90); covered occurrences are still counted. Every mutation is audited (`setFindingStatus`, `createFindingRule`, `revokeFindingRule`).
- `HostAdmin.pruneFindings(actor, limit)`, run by the platform sweep as its own `findings` phase: an open or acked finding quiet for `FINDING_RETENTION_DAYS` is resolved as `stale`, with a `resolveStaleFinding` audit row written in the same unit, rather than deleted; resolved and suppressed findings are deleted once both their last occurrence and their last resolve are past the horizon, and expired rules once their expiry is. `PlatformSweepReport.findings` carries what it did. A tenant reap clears a tenant's findings and rules.
- Control plane: `GET /findings` (staff read the fleet; a tenant credential its own tenant), `PUT /tenants/:t/findings/:id/status`, and `GET`/`POST /tenants/:t/finding-rules`, `DELETE /tenants/:t/finding-rules/:id`, path-pinned for the tenant credential and absent for builders.
- Dashboard: `GET /api/findings`, `PUT /api/findings/:id/status`, and `GET`/`POST /api/findings/rules`, `DELETE /api/findings/rules/:id`, each asking the person first. Two new permission keys: `dashboard:read-findings` (owner, admin, member, viewer) and `dashboard:manage-findings` (owner, admin, member). Existing teams receive them through the role reconcile.
- `findingsContractSuite` holds both adapters to it.
