---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
---

**Registry-driven marketplace, phase 3** (marketplace-publish.md §5) — the publish action.

- `HostAdmin.setVerticalListed(actor, slug, listed)` — a staff admission that flips the registry
  `listed` flag (both adapters); idempotent, audited (`setVerticalListed` admin action). Once
  `listed`, `availableCatalog` offers the vertical to every tenant.
- Control-plane endpoint `POST /verticals/:slug/listing` — **staff-only** (not on the builder
  allowlist), so a builder is refused (the review gate), staff flips it. Mirrors admission (model B).
- CLI `substrat publish <slug>` / `substrat unpublish <slug>`.

The `listed` column is set on insert and by this action only — **never clobbered by a re-push**
(covered by a contract-suite test across both adapters). Any owner may *request* publishing;
staff review is the gate (§5). The builder self-serve request surface (a dashboard "Request to
publish" button) is the remaining UX — the same open question as builder-plane's prod-promotion
request.
