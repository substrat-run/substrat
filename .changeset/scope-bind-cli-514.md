---
'@substrat-run/cli': minor
---

`substrat scope bind <scopeId> --version <id>` — the per-scope rollout primitive, reached
directly (issue #509 ask (c), part of #514).

`bindScopeVersion` is the platform's most general version primitive — a canary ("tenant A
gets 0.3.0 first") or a pinned tenant is just this call per scope, where a channel promote
is a fleet-wide rebind. The route (`POST /tenants/:tenantId/scopes/:scopeId/version`) already
existed and the console used it, but the CLI had `scope status|pull|restore|adopt-serving|rebind`
and no `bind` — so the axis was unreachable to a builder except indirectly through previews.

- `--snapshot` opts into fork-before-promote: the pre-migration data is archived first when
  the bind crosses a migration-digest boundary (a code-only rebind snapshots nothing), so a
  bad version leaves a rollback point — the same gate the route carries.
- A pending version is refused unless the target is a preview scope (the #513 carve-out); the
  refusal is surfaced verbatim.

No new route, no new concepts — the CLI simply reaches a primitive the platform already depends on.
