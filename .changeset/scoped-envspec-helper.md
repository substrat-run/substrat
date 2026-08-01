---
'@substrat-run/contracts': minor
'@substrat-run/demo-auth-server': patch
---

Add `resolveScopedEnvSpec` — read a hosted instance's delivered per-scope config overlaid on its envSpec defaults

A hosted vertical's per-install settings (saved in the dashboard Env tab, delivered via
`/internal/configure`) land in the scope's own storage, not in worker bindings. Env-spec
`default:` values ride as worker bindings shared by every install of one serving script, so
`resolveEnvSpec(env)` can only ever return the deployment-wide default — a vertical that reads
it silently ignores a saved per-install override.

`resolveScopedEnvSpec(spec, raw, delivered)` is the pure merge that fixes that: precedence
**delivered > env > default**, declared keys only (the manifest stays the allow-list), an empty
delivered value is not an override, and `missingRequired` is recomputed over the overlaid values.
It stays dependency-free; each vertical supplies `delivered` from its own per-scope store.
`resolveEnvSpec` is documented as deployment/defaults-only, and auth-server's `effectiveCfg` now
uses the shared helper instead of a hand-rolled overlay.
