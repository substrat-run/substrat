---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
---

RUNTIME_BASELINE advanced to 2026-06-01 and treated as maintained (#636): a
staleness test goes red once the baseline falls ~6 months behind, and
`substrat push` now refuses a `runtimeNeeds` push whose (otherwise ignored)
wrangler.jsonc pins a compatibility date newer than the baseline — the D-38
migration can no longer silently downgrade a live worker's compatibility date.
A hand-authored config that states no date now also gets the baseline instead
of a second hard-coded default. Verticals on `runtimeNeeds` pick the new
baseline up on their next push; self-serve-deploy.md documents how an
already-provisioned tenant adopts a newly declared `blobStores` (one
idempotent re-provision after promote).
