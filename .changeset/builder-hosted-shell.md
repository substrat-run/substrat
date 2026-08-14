---
"@substrat-run/builder": minor
---

Hosted shell for the builder studio (#625): staff-only worker at
builder.substrat.net — OIDC via @substrat-run/oidc-rp plus the control plane's
staff_actor roster (shared AUTH_DB, read-only, fail closed) gating every path
including the SPA assets; BuilderAgent DO carrying the local .builder/ state
(project registry, per-project history, names) under mirrored storage keys;
cf:deploy + secrets manifest entry (no provider keys in the shell). Execution
endpoints 503 naming #626 until the ContainerWorkspace lands.
