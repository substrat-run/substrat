---
'@substrat-run/vertical-auth': minor
---

`IdentityDO.getScopeConfig(scopeId)` — the blessed read for a hosted vertical's ordinary
env-spec keys (#398): the per-scope config map the platform delivered via
`/internal/configure`, ready to hand to `resolveScopedEnvSpec` (contracts) so an Env-tab
override actually takes effect instead of the shared deployment default (the #374
silent-defaults trap). `authWiring()` now reads through it; its shape is unchanged.
