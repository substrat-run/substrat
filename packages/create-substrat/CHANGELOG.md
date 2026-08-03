# create-substrat

## 0.2.0

### Minor Changes

- 5a9d7bd: The scaffold is pushable from day one. The template gains `src/worker.ts` (the
  sandbox-clean Cloudflare shape: own `ScopeDO`, the full platform-gated
  `/internal/*` management contract — provision, reconcile, tables, query,
  platform-requests, snapshot/export/restore/bookmarks/rewind — and a clearly
  marked auth seam; the dev `x-principal` header is the only caller resolution
  until real auth is wired) and `src/provision.ts` (node-free MODULES/ROLES/
  grant shapes + `definePermissions`, registered by both hosts and read by
  `substrat push`). The generated package.json now carries
  `substrat.permissions` + `substrat.runtimeNeeds` (the CLI derives the deploy
  config — no wrangler.jsonc), a worker typecheck config, and current version
  pins (kernel line ^0.39.0, engines ^0.3.37, plus @types/node that the old
  scaffold only got by hoisting luck).
- b82d40f: `defineScopeSweeperDO` — the timer a CP-less vertical owns (#461, closing the trigger
  half). `runPlatformSweep`'s drain and schedule phases enumerate scopes via the
  control-plane directory, which a CP-less dispatch vertical does not have — so its
  declared schedules parsed, granted, and never ran. The new singleton DO keeps a roster
  of the deployment's scopes (fed by the platform through `/internal/provision` and
  `/internal/reconcile` via `noteScope`, pruned by `/internal/delete-scope` via
  `forgetScope` — forks stay off by construction, since a snapshot target is never
  provisioned) and alarm-drives each rostered scope's `drainDue` + `runDueSchedules`
  through the deployment's own host, with the same non-overlap/never-dies loop as
  `definePlatformSweeperDO`. The alarm lapses on an empty roster and re-arms on the
  next `noteScope`, so an idle deployment costs nothing. The create-substrat template
  wires it by default: a `SWEEPER` store in `substrat.runtimeNeeds`, the three route
  calls, and the kernel-line pin moves to the release that ships the sweeper.

## 0.1.1

### Patch Changes

- 33163f4: Point `create-substrat` at the live docs domain and clarify the missing-directory error.

  The `DOCS` constant still referenced the old Cloudflare Pages hostname
  (`substrat.ahlstrand.es`), so the usage text, the generated README, and the getting-started
  link in every scaffolded project pointed at a stale domain. It now uses the canonical
  `https://substrat.net`.

  Running `npm create substrat` with no target directory previously dumped the usage text and
  exited non-zero, which npm surfaces as a bare `npm error code 1` with no hint that an argument
  was missing. It now prints an explicit `a target directory is required` message, while
  `--help`/`-h` exits 0 as expected.

## 0.1.0

### Minor Changes

- 8873aad: `npm create substrat <dir>` now scaffolds a real project instead of printing a
  placeholder message.

  The initializer copies a **tool-agnostic instruction layer** into the new project so
  Claude Code, Cursor, and opencode all read the same rules and build flow from one source:

  - **`AGENTS.md`** — the always-on constitution (module-code boundaries, the gates, the two
    human checkpoints). Read by every tool; `CLAUDE.md` is a one-line `@AGENTS.md` import so
    Claude sees it too without a symlink.
  - **`.substrat/playbook.md`** — the interview → coverage-map → scaffold → run → checkpoints
    flow, as a single source of truth. Its Step 8 now updates `AGENTS.md` (which every tool
    reads) rather than a Claude-only file, so a vertical stays multi-tool-competent for the
    next session in any editor.
  - **Per-tool entry points** that all point at the playbook: a thin Claude skill (keeps
    `/substrat` + progressive disclosure), a Cursor command + rule, and an opencode command.

  It also generates the tooling configs that need the project name interpolated
  (`package.json` with the published `@substrat-run/*` deps and no `zod`, `tsconfig.json`,
  `vitest.config.ts`, `.gitignore`, `README.md`), refuses to overwrite an existing project,
  and stays dependency-free (node built-ins only).

  The reference vertical (`src/*` + scenario test) is not shipped yet — a fresh scaffold
  installs and is ready for the agent to build the vertical, guided by the playbook.

- a47b155: `npm create substrat` now scaffolds a **working reference vertical** in `src/` + `test/`,
  not an empty `src/`.

  The reference is a minimal bike-repair shop composed on `engine-workorder` and
  `engine-invoicing`, green out of the box (`npm test` → 9 passing, `tsc --noEmit` and
  `substrat-boundary-lint` clean, verified against the published packages). It demonstrates
  every load-bearing pattern in one place — the manifest/migrations/module split, the
  permission check as each operation's first line, the **pricing moment** (read the engine's
  reported lines → apply the vertical's price list → hand priced lines back to
  `completeWorkOrder`), invoicing **by event** (the star topology, zero imports between
  engines), the customer-portal **proof walk** (per-entity `ctx.check`), a two-tenant seed
  whose second tenant exists to be attacked, and denial assertions pinned to their messages
  and paired with open-door controls.

  The playbook's Step 4 becomes "reshape the reference" rather than "build from empty": the
  agent reads a real, green implementation and renames it into the user's domain, which is
  both safer and faster than authoring from scratch. The generated `package.json` gains the
  two engine dependencies (`^0.3.27`).

## 0.0.1

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.
