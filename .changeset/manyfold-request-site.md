---
'@substrat-run/demo-manyfold': minor
---

Multi-scope Manyfold, D1: an admin can request a new site (the intent producer).

Manyfold gains a `content:manage-sites` permission (held by `admin`) and a `manyfold/request-site`
operation: a tenant admin asks for a new site, and — since the vertical is sandbox-clean and can't
provision a scope itself — the op enqueues a `provision-sibling` platform intent
(platform-intents.md) via `ctx.requestPlatform`, seating the requesting admin as the new site's
owner, and returns the request id. The platform's drain (Phases B2/C) picks it up and provisions
the sibling.

**Permission checkpoint:** a new key `content:manage-sites` appears in `demos/manyfold/PERMISSIONS.md`,
granted only to `admin` — the reviewable diff for this widening.

Scenario-tested: an admin's request enqueues a durable `provision-sibling` intent (owner = the
admin); an author (lacking `content:manage-sites`) is denied.

Not yet wired: the vertical's `/internal/platform-requests` endpoints (so the platform drain can
reach these intents — needs `tenantId` threaded through the merged `VerticalClient`), the
`POST /api/sites` route + "New site" UI, and the router kick. Those are the next D slice. Refs #358.
