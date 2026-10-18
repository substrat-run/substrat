---
id: D-64
date: 2026-10-18
layer: plan
title: "The hosted review runner advises through one pinned model and blocks only promotion, only on a platform-owned script's finding"
status: proposed
aliases: []
amends: []
tracking: ["#2365", "#2388"]
---

# D-64 — The hosted review runner advises through one pinned model and blocks only promotion, only on a platform-owned script's finding

> Draft for the human to confirm. It records the answers the human gave on 2026-10-18 to the questions of [the hosted review runner RFC](../rfc/hosted-review-runner.md) §6, collected in its §7. The RFC holds the options, the reasoning and the cost of each answer being wrong. Nothing here is built yet.

**One checklist, any runner.** The hosted runner reads the same `plugin/substrat/review/checklist.md` the local review skill reads, bundled from this repository when the runner is built, with the procedure beside it. One digest covers both, and both runners print it. Every checklist version is immutable and stored, so an old record can be re-read against the rules it was produced under. The model reads only the items the checklist marks `judgement`.

**The reviewed change is uploaded with the push, and later built from.** Through phases 1–3 the CLI uploads the full source tree with the push. That upload is advisory, because it is self-reported. Later the platform builds the bundle from that same archive in its own sandbox. Reading the customer's git is dropped.

**Only a platform-owned script's finding may block, and it blocks promotion, never the upload.** A gate result counts as script-confirmed only when the seven conditions of the RFC's §2.2 hold. At first that may be the boundaries gate alone. A model's finding never blocks. The promote gate waits for the controlled build. It is opt-in per vertical and off by default, and it becomes mandatory at staff admission for listed verticals once the per-item thresholds are met. A private vertical's owner may override a refusal with a recorded reason. A listed vertical's override belongs to staff admission.

**One platform-chosen model, pinned per checklist version.** It is reached through the platform's gateway, with no tie to one vendor. A model change ships only after it passes the seeded corpus. Reviews are metered to the tenant through the model ledger and zero-rated in phases 1–2. A per-review budget is checked before the call and hard-capped during it, with a per-tenant spend limit. A review over budget, or one that did not run, is never shown as clean.

**Enabled by a staff-granted entitlement and a per-vertical switch.** A tenant owner or admin holds the switch, and every change of state is recorded with who made it and when. Turning it off stops new reviews and deletes nothing. The entitlement becomes plan-shaped once reviews are billed. The review entitlement must never be one a tenant can grant itself, and that must hold before phase 2 (#2388 or an equivalent). For a listed vertical, admission grants the entitlement, and the owner's switch does not reach the admission gate.

**The review record is a first-class platform object.** It has its own API, and every surface is a view of it: the CLI read first, then the dashboard's version view, then the push headline, with a pull-request comment last and optional. The console is not a findings surface. The record holds findings, digests and run metadata, every path exclusion in force, and no transcript or prompt. Its retention follows the source archive's.

**A record is read by the owner tenant only.** The readers are the roles that can already read the vertical's migration SQL and production history, plus the credential that pushed the version. Installers of a listed vertical see at most a pass/fail summary the owner chooses to publish.

**The seeded corpus comes first and keeps running.** It is re-run on every model or checklist change, after a gate is required as well as before, so misses stay measured. Owner feedback and an automatic signal are added to it. Script-confirmed findings are expected to have no false positives; one that does is a gate bug. The human sets the per-item thresholds at phase 3.

## Why

A Substrat vertical fails in ways that look like success, and a general reviewer does not know the rules. The answer withdrawn in #2365, a model key in GitHub CI, tied review to one git host and metered nothing per customer. Review belongs behind the platform instead, enabled and metered per tenant and independent of where the customer's git lives. Blocking is the one effect that can stop a production deploy. So it is reserved for a result the reviewed tree cannot influence, on code the platform itself built, and it acts at promotion, where a refusal costs the builder least. Findings quote source, and a listed vertical is readable by every tenant that installs it. That is why the record stays with the owner, by the same rule that keeps a version's migration SQL and production history owner-only.
