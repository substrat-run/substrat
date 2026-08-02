---
'@substrat-run/control-plane-api': patch
'@substrat-run/cli': patch
---

Cross-lineage rebind learns `abandonData` (#389): a directory-only flip for a scope whose
source script predates the `/internal/export` surface (#236) and so cannot be dumped at
all. No bytes are carried — the source script's copy stays intact as the backout, and the
scope is re-provisioned on the target via the idempotent `/verticals/:slug/instances`.
CLI: `substrat scope rebind --abandon-data`. Also: a vertical answering an `/internal/*`
call with non-JSON (an old script's SPA fallback) now surfaces as an actionable 502
instead of an unhandled parse error → opaque 500.
