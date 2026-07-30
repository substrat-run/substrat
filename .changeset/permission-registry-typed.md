---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane-api': minor
---

Derive the permission registry from a typed source, and require it in the deploy manifest (D-41).

D-39 shipped the declared permission surface in the deploy manifest but left three seams as
convention and introduced a machine-only generated file in git. The surface was discovered by a
by-name `MODULES`/`ROLES`/`ENTITY_GRANTS` re-export from each vertical's `seed.ts` (wrong name,
wrong file, or a vertical outside `demos/`/`apps/` vanished from the checkpoint with no error);
`push` read a checked-in `permissions.json` and treated its absence as a silent empty surface; and
`deployManifest.registry` was optional, so a push could carry no declared surface at all.

Now the surface is declared once via a typed `definePermissions({ modules, roles, entityGrants })`
in `@substrat-run/contracts` — a compile-checked single source. The checkpoint tool discovers it
from a declared `package.json` `substrat.permissions` pointer rather than a `seed.ts` re-export
(a package with a `seed.ts` but no pointer is now a hard error, not a silent skip), and emits only
the human-readable `PERMISSIONS.md`. The machine-readable `permissions.json` is gone from git:
`substrat push` derives the registry from the typed entry with the same new
`buildPermissionRegistry`, bundling the entry with esbuild (deps left external, so a node-ful entry
still resolves its own `node_modules`) and hashing the result into `digests.permission` — proven to
reproduce the previously-committed files byte-for-byte, so the digest is unchanged.

`deployManifest.registry` is now **required**: a push that declares no surface is rejected at the
trust boundary and by the CLI before upload (absence is never a silent empty registry; a vertical
that genuinely exposes nothing ships an explicit empty registry). A lenient `storedDeployManifest`
(registry optional) is used only for re-reading manifests persisted before this change, so old
versions stay readable and re-deployable in place. `@substrat-run/cli` gains an `esbuild`
dependency.
