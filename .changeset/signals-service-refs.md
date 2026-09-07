---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

The service→(vertical, version) join moves behind the control plane (#1231's
last item). `GET /service-refs` answers what each of a tenant's deployed
Cloudflare scripts means in signal dimensions: the stable serving script from
the registry row's own `servingVersionId` (authoritative, where the dashboard's
scope-derived guess was an approximation) plus each per-version archive script,
each as a `serviceDimensions` entry — `signalStamp`'s first real consumer, with
the registry ULID in the stamp and the human label beside it, never inside it.
Tenant-narrowed by the forced-filter pattern (a builder's tenant comes from the
principal; a staff caller must name one — no fleet-wide answer on a forgotten
param), builder-allowlisted, and deliberately not behind the observability 501
guard: the join is a directory read and answers without a telemetry backend.
The dashboard now fetches this map instead of re-deriving it, keeps its
ownership pre-flight gates, gains `versionId` on metrics rows, and stops
leaking the seam's `namespace` field through an untyped spread.
