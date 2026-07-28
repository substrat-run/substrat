---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
---

Ship the vertical's declared permission surface in the deploy manifest (D-39).

The permission registry — every key + description a registered manifest declares, the
role templates provisioning defines, and the entity-grant shapes — existed only at build
time as `demos/*/PERMISSIONS.md`. The deploy manifest carried `ownerGrants` and a
`digests.permission` HASH of that surface, so the platform committed (at promotion) to
content it did not hold, and the dashboard kept a hardcoded third copy. Worse, the digest
was a placeholder: it hashed the worker's `bindings`, not any permission content, so the
"permissions changed" promotion checkpoint fired on binding changes and missed real
permission changes.

Now `deployManifest` carries a first-class `registry` (`permissionRegistry`:
`permissions[]` with `declaredBy`, `roles[]`, `entityGrants[]`), and `digests.permission`
is its content hash. `tools/permission-diff.mts` emits a machine-readable
`permissions.json` next to `PERMISSIONS.md` — from the SAME `MODULES` + `ROLES` +
`ENTITY_GRANTS` the host registers — CI-checked with `--check`, so it cannot drift from
what is enforced and it never requires the CLI to load (or execute) module code. `push`
reads that checked-in artifact and injects it; the digest is a canonical, formatting-
independent hash of the surface, so it moves iff a key, description, role, or grant shape
moves. Additive and optional (D-28): a vertical shipping no registry hashes the empty
surface (never bindings again), and the control-plane trust-boundary parse accepts the
new field unchanged.

This is what a tenant-facing permissions view (and a real version-to-version admission
diff) consume without new backend plumbing.
