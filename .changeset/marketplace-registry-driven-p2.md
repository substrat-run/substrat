---
"@substrat-run/dashboard": minor
"@substrat-run/contracts": minor
---

**Registry-driven marketplace, phase 2** (marketplace-publish.md §3) — the dashboard's hardcoded
`CATALOG` map is no longer a gate, so a pushed → promoted → published vertical shows and installs
with **no dashboard change**.

- Registry `vertical` gains a `listed` flag (published to the public marketplace) — its own
  column adapter-side (sqlite + cloudflare), set on insert and **never clobbered by a re-push**
  (publish is a distinct action from push).
- `availableCatalog` is registry-driven: a vertical shows if it's `listed` **or** owned by the
  caller's tenant (private to your team). Takes the caller's `tenantId`.
- `createApp`/retry read `entitlements`/`ownerGrants` from the registry row (via `installSpecFor`),
  falling back to `CATALOG` for a first-party not yet re-seeded.
- `ensureCatalog` seeds first-party verticals with their specifics and `listed: connected !== false`,
  so the `CATALOG` map is now just a first-party **seed**, not a visibility/install gate.

Removes the recurring "add a catalog entry + redeploy the dashboard" step. Phase 3 (the
staff-reviewed publish action) flips `listed` for builder verticals.
