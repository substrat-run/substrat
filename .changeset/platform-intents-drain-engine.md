---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

Platform intents, Phase B2: the drain engine + `provision-sibling` handler.

The platform-side execution for `docs/design/platform-intents.md`. Because a scope's intent rows
live in the vertical's own deployment (K-31), the platform PULLS them over the vertical's
`/internal` surface: `VerticalClient` gains `listPlatformRequests` / `settlePlatformRequest`
(the B1 read/settle surface, now reachable cross-deployment).

- `drainScopePlatformRequests(client, ctx, handlers)` lists a scope's pending intents, dispatches
  each to the handler registered for its `kind`, and settles the outcome — an unknown kind settles
  `failed` (never a silent drop), a thrown handler settles `pending` (retried next drain).
- `provisionSiblingScope(...)` extracts the exact sequence M1's `POST /tenants/:tenantId/scopes`
  route runs (inherit parent vertical/jurisdiction → provision → materialize → activate) into one
  reusable home; the route now calls it. `provisionSiblingHandler` wraps it as the
  `provision-sibling` intent handler, with two-phase idempotency (a scope id minted on an earlier
  pass is reused, so a retry targets the same sibling).
- `contracts` gains the shared `provisionSiblingPayload` (`{ slug, name, owner }`) + the
  `provision-sibling` kind constant.

Tested with a fake vertical transport (dispatch → settle: done / unknown-kind-failed /
thrown-pending) and against a real SQLite host (the handler provisions + activates a sibling under
the parent tenant, seating the owner). The triggers — the periodic sweep phase and the router kick,
plus each vertical's `/internal/platform-requests` endpoints — are Phase C. Refs #358.
