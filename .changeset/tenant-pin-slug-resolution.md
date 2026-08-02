---
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': patch
---

One (bare slug, tenant context) → registry id resolution for every route that addresses
a vertical (#417). Registry rows for pushed verticals are keyed `<tenantSlug>/<slug>`;
a builder got the prefix from auth, but a staff/service caller — the CLI over a service
token, the dashboard's tenant-narrowed seam — queried the bare slug and missed, so
`substrat versions <slug> --tenant <t>` came back empty and the dashboard refused to
install a workspace's own just-pushed private vertical.

The control plane now reads the workspace a staff caller acts for from the same
`x-substrat-tenant` header a builder session uses (exported as `TENANT_HEADER`), and
`versions`/`channels`/`history`/`promote`/`publish-request`/`adopt-serving`/previews
resolve the prefix exactly as a pinned push forms it — existence-guarded, so a pin never
redirects to a lineage that is not there: a bare slug the workspace owns and a
platform-owned bare slug stay addressable as themselves, and an unknown pin is a no-op.
Config delivery's `verticalForScope` retries the prefixed id on its miss path too, so a
scope bound to a bare spelling of a prefixed lineage still resolves.

The CLI sends the tenant header with every auth kind (it was browser-session-only): a
service token keeps its staff reach, and `--tenant` / `SUBSTRAT_TENANT` / the stored
default now name the workspace for slug resolution.
