---
"@substrat-run/contracts": minor
"@substrat-run/cli": minor
---

**Registry-driven marketplace, phase 1** (marketplace-publish.md) — carry a vertical's
install metadata to the registry on push, so a later phase can drop the dashboard's hardcoded
`CATALOG` map.

- `moduleManifest` gains additive fields: `ownerGrants: permissionKey[]` (the day-one owner
  grant — the role *table* stays vertical-owned + runtime-customizable), `entitlements`, and
  `provides` / `requires` **capability** lists (`oidc-issuer` etc., wired tenant-side through
  the connection store — no `kind` flag, no bundling). New `capability` contract type.
- The registry `vertical` + `registerVerticalInput` carry all four; stored as one
  `install_spec` JSON column in both adapters (sqlite + cloudflare), via the existing
  `ensureColumn`/`addColumn` helper, alongside `env_spec`.
- `substrat push` reads them from `package.json` `substrat.*` and the control-plane deploy
  endpoint validates + stores them on `registerVertical` — exactly the rail `envSpec` rides.

No behaviour change yet: the dashboard still gates on `CATALOG`. Phase 2 makes
`availableCatalog`/`createApp` registry-driven.
