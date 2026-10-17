---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane': patch
'@substrat-run/dashboard-web': patch
'@substrat-run/docs': patch
---

The platform now runs the orphan-attachment sweep on its scheduled pass. The sweep is off until the platform turns it on, and it runs as a dry run before it deletes anything.

**The phase.** `runPlatformSweep` takes `orphanAttachments: { mode, sweepScopeFn, batch?, rng? }`. Left unset, the phase is skipped. Each pass visits at most `batch` active primary scopes (default 25). The window starts at a random point in the id order and wraps around, so every scope is reached over enough passes. The report counts three standing conditions apart, and none of them is an error:
- scopes the pass may not judge (`refused`);
- deployments built before the pass existed (`unsupported`);
- deployments that hold no attachment store for the tenant (`noStore`).

**A delete needs a dry run of the same scope first.** In `delete` mode a scope is swept for real only when the admin log holds a dry-run row for it from the last seven days. Any other scope gets a dry run instead. Every pass that finds or deletes an orphan writes a `sweepOrphanAttachments` admin-log row (`admin.recordOrphanSweep`). The row carries the counts and every key deleted, or every key a pass would delete.

**The control plane decides before any deployment judges.** For each scope it checks four things in its own directory: the scope is active and primary, it is bound to a vertical, its tenant is active, and every copy-ledger entry for it is `done`. Only then does it call `POST /internal/attachment-sweep` on the script the directory routes the scope to: its serving script, else its bound version's. There is no fallback to another script, and the control plane never asks its own host. The route requires `dryRun` and `copiesSettled: true`. It takes no instant from the body, and it answers 501 on a host built before it.

**A deployment with no attachment store answers so.** A pass whose deployment holds no attachment store for the tenant now returns `bucket: 'none'`, after every refusal the scope's copy makes, instead of failing. It does so only when the scope holds no attachment row either. A scope that holds files but has no store has a missing store binding, and its pass still fails. A store that held nothing answers without the marker.

The control plane's mode is `ORPHAN_ATTACHMENT_SWEEP`, with the values `off` (the default), `dry-run` and `delete`, and its window size is `ORPHAN_ATTACHMENT_SWEEP_BATCH`. `docs/architecture/orphan-attachment-sweep.md` has the rollout.

The dashboard's activity view reads the new admin-log rows as "swept orphan attachments".
