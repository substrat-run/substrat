---
'@substrat-run/demo-callout': patch
'@substrat-run/demo-meridian': patch
'@substrat-run/demo-manyfold': patch
---

Each demo vertical's declarative surface now lives in its own crisp files instead of being
embedded at the top of `module.ts`. Open `src/manifest.ts` and you see the *entire* shape of
the vertical — permission keys, id/version, events, entity relations, entitlement — with
nothing executable to wade through; `src/module.ts` is now just operations and the
`ModuleRegistration` wiring.

For each of Callout, Meridian, and Manyfold:

- **`src/manifest.ts`** — the permission-key consts (`SC_PERM`/`HR_PERM`/`MF_PERM`) **and**
  `moduleManifest.parse({...})`. The consts sit beside the manifest's `permissions` list —
  they're the same keys twice — so "add a permission" stays a single-file edit and the pair
  can't drift.
- **`src/migrations.ts`** — the append-only `SqlMigration[]` journal (Callout's
  `boundary-lint-allow R5` extraction block moved with the migration it guards).
- **`src/module.ts`** — imports both; holds row types, operations, and the module wiring.

Each package gains a `./manifest` export subpath so the dashboard catalog reads a vertical's
permission consts without dragging `seed.ts`'s `node:fs`/SQLite into the Worker bundle
(`manifest.ts` imports only from `@substrat-run/contracts`). The `new-vertical` skill now
scaffolds this three-file shape. Pure reorganization — no behavior, schema, or permission
change (permission snapshots unchanged; all demo + dashboard scenario tests green).
