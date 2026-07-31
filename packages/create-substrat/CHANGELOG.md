# create-substrat

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
