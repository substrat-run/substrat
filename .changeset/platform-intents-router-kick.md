---
'@substrat-run/control-plane': patch
'@substrat-run/router': patch
---

Router kick: drain a scope's platform-intents in seconds, not at the next sweep.

The last piece of the platform-intents latency story. A vertical enqueues an intent and
flags it on the response with `x-substrat-platform-request`; the router — the one hop that
already knows the resolved `(tenant, scope)` — pings the control plane to drain that scope
immediately, collapsing the ~2-min periodic-sweep delay to seconds.

- **control-plane:** the per-scope drain the sweep ran inline is extracted to a module-level
  `drainOneScope(env, tenant, scope)` (serving-ref → bound-version → prod ladder, the same
  `provision-sibling` + `archive-scope` handlers). A new platform-secret-gated
  `POST /internal/drain-scope` runs it on demand. Identity stays inherent: the body only
  *names* which scope to drain; the tenant/vertical are re-derived from this directory's own
  record, so a caller with the global secret can at most accelerate a scope's own pending
  work. An unconfigured secret **refuses** (fails closed), never bypasses.
- **router:** after dispatch, when the response carries `x-substrat-platform-request`, the
  router `ctx.waitUntil`s a best-effort kick to `/internal/drain-scope` over a new
  `CONTROL_PLANE_KICK` service binding (prod → `substrat-control-plane`, test → its `-test`
  peer), presenting the global `PLATFORM_SECRET`. Out of band and best-effort by design: the
  user's response is returned untouched, and a missing/failed/unconfigured kick simply falls
  back to the durable sweep — latency, never correctness.

The sweep remains the reliability backstop; the kick is pure latency. Tested: the router
kicks the *resolved* node (not caller-supplied) with the secret when flagged, does not kick
otherwise, and never throws when unconfigured; the control-plane endpoint fails closed when
no secret is bound. Refs #358.
