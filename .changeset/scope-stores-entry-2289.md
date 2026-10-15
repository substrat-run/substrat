---
'@substrat-run/control-plane-api': minor
'@substrat-run/docs': patch
---

A scope-store script's entry checks every call with `verifyScopeStoreCall` before it constructs the kind's class, and refuses unless the object's own id is the id of the signed name (#2289). The kind gets the exact body that was verified, an environment without the entry's `SUBSTRAT_STORE*` bindings (the upload sets `disallow_importable_env`, so an imported `env` is empty too), one instance per object, and its alarms. `withStoreEntry({ className, script, callerPublicKeys, platformPublicKeys })` puts the entry in front of a kind bundle, and refuses the entry's reserved module, class and binding names a key listed for both audiences, and a kind flag of `allow_importable_env`.
