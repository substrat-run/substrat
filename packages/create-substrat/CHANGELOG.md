# create-substrat

## 0.6.2

### Patch Changes

- 7ef5106: The SessionStart hook now knows whether it is the project's copy or the plugin's.

  The Substrat agent plugin (#753) reaches the projects the scaffold never did — someone who
  opens an agent on a directory we did not generate — and it ships this same hook, because a
  script is the one thing an adapter cannot route to: it has to be somewhere the client can
  execute. That matters most for a project scaffolded before the hook existed, which today is
  nearly all of them.

  Two copies of a hook that both fire would announce the project twice, so the script now asks
  where it is running from. The project's copy always wins: it ships beside the playbook it
  points at, so it is the one that matches what is actually checked out. The plugin's exits
  silently whenever the project owns one.

  Asked positionally rather than through a flag, deliberately — the two copies must stay
  byte-identical for `pnpm lint:plugin --check` to have anything to compare, and a copy that is
  invoked differently is a copy that can be edited differently.

## 0.6.1

### Patch Changes

- 2fe7ae4: The design interview now decides the auth seam, and the deploy step tells the truth
  about assets and versioning.

  Three corrections to the build flow, all of them things a vertical got wrong _after_
  the design was approved, which is the expensive place to find out.

  **Auth.** The playbook offered to "wire a real login" with a credential-store pattern
  the reference verticals no longer use. The vertical is a pure OIDC relying party:
  a separate issuer, `@substrat-run/vertical-auth`, `IdentityDO` bound as a third DO
  store, `substrat:auth` config read per scope. The trap worth stating at design time is
  that the dashboard wires identity **only at app creation** — an install made without
  that choice stays unwired forever, and a worker whose `authenticatedPrincipal` returns
  null answers 401 to everything, however many auth servers the team has.

  **Assets.** A SPA is declared in `runtimeNeeds.assets` and served from the edge
  without invoking the worker. Base64-inlining a built `app/dist` into a generated
  worker module costs ~+33 % script size and a worker invocation per image.

  **Versioning.** `substrat push` defaults to the registry's highest semver,
  patch-bumped — `package.json`'s version is only a seed for the first push of a new
  slug. Left alone, the registry and `package.json` drift apart within a few deploys, so
  the release script lets changesets own the version and passes it with `--version`,
  read via `node -p` _after_ `changeset version` has rewritten the file (not
  `$npm_package_version`, which was captured before it).

## 0.6.0

### Minor Changes

- 1913e2d: A scaffolded vertical ships `.claude/launch.json`, so Claude Desktop starts its dev server,
  opens it in the Browser pane, and verifies its own changes there (#752).

  The dev topology is declared in the neutral `substrat.devServers` block of `package.json` —
  the block `substrat push` and the SessionStart hook already read — and the client file is
  emitted from it, because an adapter may trigger but may not _hold_ substance
  (design/agent-surface.md §3). A declaration names the env var that moves a port and the file
  that binds it; the number itself is read out of that file, so the launch file cannot drift
  from the server it starts.

  This matters most for the part tests cannot reach: a scenario test composes the host
  directly and never boots `src/server.ts`, so the HTTP layer is exactly what an agent needs a
  browser to check.

## 0.5.0

### Minor Changes

- dfcb6ad: A scaffolded vertical now announces itself to an agent at session start, and pins
  the docs it should read to the kernel version actually installed.

  The smooth part of a framework's agent integration is that the user never has to
  remember the framework _has_ one. `.substrat/hooks/session-start.mjs` runs when an
  agent session opens and hands it what it would otherwise have to discover: that this
  is a Substrat vertical, that the always-on rules are in `AGENTS.md` and the build
  flow in `.substrat/playbook.md`, and — the reason this exists — the URL of the docs
  slice describing **this project's** kernel.

  Substrat is 0.x and interfaces change without notice, so an agent working from pages
  it cached two minors ago is the expensive failure: confident, plausible, wrong.
  `llms.txt` is published at a version-pinned URL so the hook can point at the matching
  slice, and a 404 there is the mechanical signal that the docs have moved on. The hook
  also records which version it last announced, so the session after an upgrade opens
  with the kernel jump stated rather than discovered.

  The script lives in `.substrat/` — the tool-neutral home, beside `playbook.md` — and
  `.claude/settings.json` is a three-line adapter that runs it. Any other client that
  grows a session hook binds the same way.

  It is silent unless `package.json` has a `substrat` block (the same block
  `substrat push` reads — no sentinel file to invent), makes no network request, and
  never fails a session: any unexpected error exits quietly. Opt out entirely with
  `.substrat/no-session-context`.

## 0.4.2

### Patch Changes

- c0ca4d8: Fix the dependency pins — a scaffolded project could not install.

  `index.js` carried one `ENGINES` constant, `^0.3.37`, for every engine. Engines do
  not share a version line: `engine-workorder` had moved to 0.4.x and
  `engine-invoicing` to 0.6.x, and a caret range on a 0.x version pins the minor. So
  `npm create substrat my-app && pnpm install` resolved _nothing_ for either engine
  and failed at the first command in the getting-started guide.

  One pin per engine now, with the reason in a comment, so the next engine minor
  breaks one line instead of all of them. `SUBSTRAT` moves to `^0.71.0` and
  `BOUNDARY_LINT` to `^0.0.7` at the same time — both were pointing at releases
  several months old.

  Found while rewriting the getting-started page against what the scaffolder
  actually does. A template's pins are the one thing no test in this repo exercises:
  CI installs from the workspace, so the published ranges are only ever resolved by
  a stranger.

## 0.4.1

### Patch Changes

- 6ac51d1: docs: every package has a README, and the one on npm stops lying about the initializer

  `create-substrat`'s published README said "The initializer is not released yet. This package
  prints a pointer to the docs and exits. It does not scaffold anything." That has been false
  since the template landed — `index.js` copies the full template tree and generates
  `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` and a project README. The
  text on npm was telling readers the entry point to Substrat doesn't work. It also instructed
  `pnpm add … zod`, contradicting the rule the same package's generated `package.json` comment
  states — Zod schemas don't compose across copies, so `z` comes from `@substrat-run/contracts`
  and zod is never installed directly.

  - **Every package now has a README**, including the three that were public on npm without one
    (`vertical-auth`, `oidc-rp`, `psl`) and the monorepo-internal `engine-test-kit` and `ui`.
  - **Every README links substrat.net** — `boundary-lint`, `vertical-host`, `engine-invites` and
    `connector-scrive` each gained the documentation pointer in the shape its README already
    used.
  - **The docs site covers the package list**: new `/reference/vertical-auth`, `/reference/psl`
    and `/reference/create-substrat` pages, all three in the sidebar.

  README-only for the packages listed here; a patch is what carries the corrected text to npm.
  `vertical-host`'s README changed too but is deliberately not bumped — it is in the `fixed`
  group, and a documentation link is not worth a seven-package lockstep release. It ships with
  that group's next version.

## 0.4.0

### Minor Changes

- 0061325: chore(deps): one better-sqlite3, and it is 13.0.3

  The workspace had drifted onto three copies — `^13.0.3` in adapter-sqlite, `^13.0.2` in
  manyfold, `^12.0.0` in ten other packages — which is how `pnpm install` started failing.

  v13 changed its packaging: it **dropped its install script** and now ships prebuilt binaries
  for all eight platform targets inside the tarball, declaring `"gypfile": false`. It still
  ships a `binding.gyp`, and pnpm applies npm's legacy rule — _binding.gyp present + no install
  script ⇒ `node-gyp rebuild`_ — ignoring that opt-out. With `better-sqlite3` on the
  `onlyBuiltDependencies` allowlist, pnpm ran that phantom build and died wherever `node-gyp`
  isn't installed. CI images ship one, which is why it only bit locally.

  So the allowlist entry is now the bug rather than the fix: nothing in the tree needs
  compiling. Dropping `better-sqlite3` from `onlyBuiltDependencies` is the whole repair — the
  prebuilt binary is already on disk and `lib/binding.js` finds it.

  Two things had to move for that to be true everywhere:

  - **`overrides: { "better-sqlite3": "13.0.3" }`** — better-auth declares a `^12.0.0` peer, so
    pnpm was quietly resolving a _second_, duplicate v12 copy alongside ours. That copy needs a
    real build, and once better-sqlite3 left the allowlist it would have arrived with no binary
    at all on a fresh clone. The override collapses the tree to one version; a matching
    `peerDependencyRules.allowedVersions` records that v13 is deliberate, not unnoticed. All six
    better-auth packages pass on it.
  - **`create-substrat`** no longer scaffolds `onlyBuiltDependencies: ['better-sqlite3']`, which
    would have handed every new project the same failure.

  `@types/better-sqlite3` goes `^7.6.x` → `^9.6.0` to match. Requires Node >= 22, which CI
  (22 and 24) already satisfies.

## 0.3.0

### Minor Changes

- 54d3d0e: Add `@substrat-run/vertical-host` — the platform's `/internal/*` management contract
  (provision, reconcile, introspection, the read-only SQL console, platform-request drain,
  snapshot/delete/export/restore, bookmarks/rewind, configure) plus the guaranteed `{ error }`
  response envelope, authored once and mounted with `mountPlatformSurface(app, deps)`.

  Verticals no longer hand-copy these routes and a Hono `onError` into their own `worker.ts` —
  copies that had already drifted (route sets disagreed; some workers shipped without the error
  handler, so a failing `/internal/restore` reached the control plane as the runtime's bare
  `Internal Server Error` with no diagnosis, issue #510). Meridian, Manyfold and the
  `create-substrat` template now mount the shared surface; a repo-wide `hono` override pins a
  single version so the mounted `Hono` app type matches its consumers.

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
