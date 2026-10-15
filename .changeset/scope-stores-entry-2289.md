---
'@substrat-run/control-plane-api': minor
'@substrat-run/docs': patch
---

A scope-store script's entry checks every call with `verifyScopeStoreCall` before it constructs the kind's class, and refuses unless the object's own id is the id of the signed name (#2289). The kind gets the exact body that was verified, its own bindings only (the entry's `SUBSTRAT_STORE*` bindings are stripped from its env, and the upload sets `disallow_importable_env` and `disable_ctx_exports`, so neither an imported `env` nor `ctx.exports` reaches them), one instance per object, and its alarms. `withStoreEntry({ className, script, callerPublicKeys, platformPublicKeys })` puts the entry in front of a kind bundle, and refuses the entry's reserved module, class and binding names, a key listed for both audiences, and a kind flag of `allow_importable_env` or `enable_ctx_exports`.
