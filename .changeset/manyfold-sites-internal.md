---
'@substrat-run/control-plane-api': minor
'@substrat-run/demo-manyfold': minor
---

Multi-scope Manyfold, D2: the platform can drain Manyfold's site-creation intents end-to-end.

Wires the platform drain (Phases B2/C) to the vertical over its `/internal` surface, completing the
loop from D1's `request-site` producer:

- **Manyfold worker** exposes `GET /internal/platform-requests` and
  `POST /internal/platform-requests/settle` (platform-secret gated), backed by the CP-less
  `host.listPlatformRequests` / `settlePlatformRequest` (B1) — the scope's DO lives in the vertical's
  own deployment, so the platform pulls its intents from here. Plus `POST /api/sites`, which runs
  `manyfold/request-site` as the caller (its own `content:manage-sites` gate) and returns `202` + the
  request id, tagging the response with `x-substrat-platform-request` for the router kick (Phase D3).
- **`VerticalClient.listPlatformRequests` / `settlePlatformRequest` now take `tenantId`** (the CP-less
  vertical host reads by `(tenantId, scopeId)`); `drainScopePlatformRequests` passes it from the
  drained scope's context. A small signature change to the just-added B2 methods, contained to the
  drain path.

So a `request-site` intent is now picked up by the periodic sweep (C) and provisioned via
`provision-sibling` (B2), appearing in the M2 site registry within a sweep cycle. The low-latency
router kick and the "New site" UI are Phase D3. Refs #358.
