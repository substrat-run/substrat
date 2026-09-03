# @substrat-run/boundary-lint

## 0.4.1

### Patch Changes

- deb80ca: `DEFAULT_HARNESS` gains the auth adapter's BankID files (`bankid.ts`, `bankid-plugin.ts`,
  `bankid-transport-node.ts`) — the same class of declared boundary as `cimd-fetch.ts`: an
  issuer calling BankID's mTLS RP API has no `ctx` and no connector to delegate to, and the
  transport file exists separately so what it can and cannot guarantee is reviewable in one
  place.

## 0.4.0

### Minor Changes

- a6d9f80: The unserved-UI preflight now recognises the pre-#340 inline pattern before it has been
  built, and `preview create` accepts `--allow-unserved-ui`.

  The exemption looked only for an `assets.generated.*` module under `src/` — build output,
  normally gitignored, and written by the very build step this check deliberately precedes. It
  therefore found the file on a machine where an earlier build had left one and never on a
  fresh checkout, so CI was refused for a UI the push would in fact have served. It now also
  accepts source that **imports** the module, which is the half that is committed.

  `substrat preview create` called the same `push()` without forwarding `--allow-unserved-ui`,
  so the flag the refusal names was accepted and silently dropped — on the path most likely to
  meet the check, since previews run per-PR.

  Reading the import needs a scanner that can tell one from a comment or a quoted string, and
  `boundary-lint` already had it — so `maskSource` (comments, string bodies and regex literals
  blanked, every offset kept) is now exported rather than copied. The CLI matches against the
  masked copy and reads the specifier back out of the original at those offsets.

### Patch Changes

- fea0cbb: `cimd-fetch.ts` joins the default harness list, beside the other `auth*.ts` entries it is
  imported by.

  R3 bans `fetch` in module code because a module's capabilities come from `ctx`, and a
  vertical that needs the outside world reaches it through a connector. An issuer resolving a
  Client ID Metadata Document has neither: the client's `client_id` IS an HTTPS URL, and
  fetching the document at it is what the OAuth draft defines that identifier to mean. The
  file is the auth adapter's network boundary, sits beside `auth-do.ts` and `auth-schema.ts`,
  and is reachable from no `ModuleRegistration`.

  This matters to a scaffolded project the same way `config-do.ts` did: the list is literal, so
  a name missing from it is a new project failing its own gate on a file the template told it
  to write.

## 0.3.0

### Minor Changes

- 382f697: R8: an engine may not read with a star. `SELECT *`, `SELECT DISTINCT *` and the qualified
  `SELECT t.*` in an engine's module code are now violations — a star publishes whatever
  columns the physical table currently holds, so a column that moves between two engine
  versions reaches a vertical as wrong data on a screen rather than a throw. A read names
  its columns (`columnsOf(schema)`) and returns through `returns(schema, …)`. Scoped to
  engine packages, with the reviewable `boundary-lint-allow R8` … `boundary-lint-end R8`
  hatch R5 and R6 carry. `SELECT COUNT(*)` is untouched.

  A config-declared package with `"engine": true` now defaults to no harness exemptions, the
  same as `engines/*` in the monorepo — an engine's `index.ts` is its whole surface, not a
  composition root, so it was the one file every rule skipped.

### Patch Changes

- 7bf77df: `substrat-boundary-lint` is now a checked-in launcher rather than `dist/cli.js` directly. A
  package manager creates the bin symlink at **install** time, when a workspace copy of this
  package has no `dist` yet — so in any repo that installs before it builds, the bin was silently
  never linked and `substrat-boundary-lint` came back "not found" later in the same job. Published
  installs are unaffected; the tarball carries `dist` and the launcher just forwards to it.

## 0.2.1

### Patch Changes

- 733469b: These packages' `test/` directories are now typechecked. Nothing they ship changes — the
  build tsconfig already emitted from `src` alone — but their `typecheck` script now compiles
  the tests too, which caught a `vertical-host` test fixture that had drifted from
  `VerticalScopeHost` and stayed green for months.

## 0.2.0

### Minor Changes

- c0a8d84: Catching an engine error outside `ctx.atomic` is now a lint error

  Issue #770 landed `ctx.atomic`, so a vertical _can_ catch an engine error safely. It only
  moved the line: **outside** an atomic, a bare `catch` around an engine call is still exactly
  the same bug — you are holding the engine's partial writes, the rows its invariants were
  protecting, and you will commit them. The repo had traded one convention for a narrower
  one, still enforced by review.

  `R7` is the mechanism (#786):

  > In module code, a `catch` whose `try` block calls an imported engine in-scope function,
  > and which is not lexically inside a `ctx.atomic` callback, is a violation.

  ```ts
  try {
    await completeWorkOrder(ctx, { orderId, billable }); // ✗ R7
  } catch {
    return { ok: false }; // the engine's rows just committed
  }

  try {
    await ctx.atomic(() => completeWorkOrder(ctx, { orderId, billable })); // ✓
  } catch {
    // rows, events, links, grants and platform intents all gone; your writes survive
  }
  ```

  Two shapes do not swallow, and both pass: **`try`/`finally` with no `catch`**, and a catch
  that **always rethrows** (`catch (e) { log(e); throw e }`, wrapped or not) — the operation
  still fails, so the whole transaction rolls back either way.

  "Always" is decided by one mechanical test: the catch's **last top-level statement** is a
  `throw`. So a _braced_ conditional rethrow is flagged, because the throw is nested and the
  catch runs on past it —

  ```ts
  catch (e) { if (fatal(e)) { throw e } return null }   // ✗ flagged — there is a path that swallows
  catch (e) { if (fatal(e)) { throw e } }               // ✗ flagged — same, the fall-through swallows
  catch (e) { if (fatal(e)) throw e; }                  // ✓ passes — see the under-fire below
  ```

  — while the _unbraced_ form on the last line is at top level and reads as an always-rethrow.
  That last one is a real hole, listed with the others below.

  There is **no** `boundary-lint-allow R7` hatch. Unlike R5's one-time extraction handoff or
  R6's real-clock JWT, there is no legitimate reason to swallow an engine error unprotected,
  so a hatch would only ever be used to silence the rule.

  **It is R7, not the R6 the design note proposed.** Rule numbers are claimed when they ship;
  the no-clock rule (#812) landed first and took `R6`. Two rules sharing a number would be
  worse than a stale proposal.

  **No new dependency.** R7 needs two things R1–R6 did not — which identifiers are bound to
  an engine import (aliases and namespace imports included), and whether a call sits lexically
  inside a `ctx.atomic` callback — and neither needs a type checker. One offset-preserving
  mask of comments, string bodies and regex literals makes brace matching exact, and the pass
  runs only on files that import an `@substrat-run/engine-*` package at all. `typescript` in
  `dependencies` would have been ~20MB in a package that has none, installed into every
  scaffolded vertical, to answer scanner questions.

  It under-fires on purpose — a rule that misfires gets suppressed wholesale, which is worse
  than not having it, so **a clean run is not a proof that no engine error is swallowed**.
  Three shapes it does not flag: an engine call moved into a **local helper** (R7 reads only
  the calls written inside the `try`); the **promise spelling**,
  `await completeWorkOrder(ctx, x).catch(() => null)`, since the rule is the `catch` clause;
  and the **unbraced** conditional rethrow above. Widening any of them is fixtures, not a
  redesign.

## 0.1.2

### Patch Changes

- 925b262: The scaffold template is compiled against the workspace on every PR (#878).

  `packages/create-substrat/template` is a call site of every engine surface it imports, and
  it was the one call site the TypeScript compiler never saw. A non-additive engine change
  could therefore be correct, reviewed, merged and released — and reach `npm create substrat`
  broken — with no gate red until after publish. #811 moved `listOrders(ctx, status?)` to
  `listOrders(ctx, page)`, `lint:pins` advanced the template's pins in the same
  Version-packages PR, and `create-substrat@0.7.1` shipped a scaffold failing **all three**
  gates it ships with: 4 of 9 scenario tests, 2 type errors, 1 boundary violation.

  `tools/template-sync.mjs` materializes the template into `packages/template-check`, a
  private member that owns the `workspace:*` links, so `pnpm -r typecheck`, `pnpm -r test` and
  `node tools/boundary-lint.mjs` all reach it — no new command, no new CI step. Verified by
  renaming an engine export and watching the template's typecheck go red on the import.

  **This does not weaken #797, and does not add a `pull_request` trigger to `scaffold.yml`.**
  The two ask different questions and only one of them can run on a PR: `lint:scaffold`
  installs from the **registry** and answers "does a real npm install produce a working
  project?", which is only honest after a release. This compiles against the **workspace** and
  answers "does the template's source still match the surface we are about to ship?" Being
  ahead of npm is a pass here and a legitimate red there — #812 put `ctx.now()` in the template
  while the pins still said `^0.83.0`. #811 would have gone red in its own PR, beside the
  eleven other call sites it fixed.

  `create-substrat` changes only in that the generated `tsconfig.json` and `vitest.config.ts`
  move to `project-files.js` (added to `files`), so the check compiles the template under
  exactly the configs a scaffold gets rather than a second hand-kept copy. The scaffolder's
  output is byte-identical; the package stays dependency-free and buildless.

  **boundary-lint**: an external engine's ownership scan is narrowed to its shipped `dist`
  when it has one — what the function's own doc comment already claimed. Scanning the whole
  package directory picks up `CREATE TABLE` in text that is not a table declaration: an
  engine's test suite asserting `no CREATE TABLE for '<name>'` registers a phantom table
  called `for`, and every consumer with the word `for` in any line is then told it references
  a private table. A published install is dist-only so this never fired there; a
  workspace-linked one — a monorepo linting its own scaffold template — points at the full
  source tree, and it produced six false R5 violations immediately.

## 0.1.1

### Patch Changes

- 0d5fe04: A scaffolded project passes its own three gates again (scaffold checkpoint, #797).

  The post-release scaffold job went red on the run that published `create-substrat@0.7.1`,
  and it was right to: `npm create substrat` produced a project failing **all three** of the
  gates it ships with — 4 of 9 scenario tests, 2 type errors, 1 boundary violation. Two
  independent causes, neither of them the scaffolder's.

  **The template never followed #811 through the paging change.** `listOrders` became
  `listOrders(ctx, page): Page<WorkOrder>` — two required arguments, and a page rather than an
  array — but `portalRepairsOp` still called `listOrders(ctx)` and iterated the result, and the
  scenario asserted `toHaveLength` on what `invoicing/list` now returns as `{ entries }`. The
  portal walk is now built on `pageVisible`, which is the helper this exact shape wants:
  a permission-filtered walk must OVER-FETCH, because twenty rows read from the table can leave
  three standing after the proof walk, and the cursor must advance by the last row _examined_ or
  the rejected rows are re-examined forever. Callout and Handlebar were migrated when #811
  landed; the template is not a workspace member, so nothing in the repo compiled it and it was
  left behind.

  **`config-do.ts` was not in `DEFAULT_HARNESS`.** The R2 violation message advertises
  _"harness code (worker.ts, `_-do.ts`)"*, but the list is literal filenames — `auth-do.ts`,
`do-contract.ts`, and no `config-do.ts`. The template ships `src/config-do.ts`(the durable half
of`/internal/configure`, and a file whose own header says it is a harness store), so **every
scaffolded project was born holding a boundary-lint violation** while the message explaining it
described the file as exempt. Its `cloudflare:workers`import is the`DurableObject` base class
  workerd requires, not a reach for the ambient env that #862 added R2 to close.

  The gate itself needed no change — it caught this on the first release after the breakage
  existed, which is what it was built in #797 to do.

## 0.1.0

### Minor Changes

- 77b0c1f: R2 bans `cloudflare:workers` in module code — the ambient env is not a capability (#862).

  Every capability module code holds is meant to arrive on `ctx`, and the scope boundary was
  described as physical on that basis: `ctx.sql` is closed over one scope's storage, so no SQL
  string a module composes can reach another scope's database. That half is true. The other
  half was not enforced.

  `cloudflare:workers` exports an **ambient** `env` — `export const env: Cloudflare.Env` in
  `@cloudflare/workers-types`, confirmed by probe under the repo's own workerd test pool, which
  returned the full binding list (`SCOPE`, `CONTROL_PLANE`, …) to a module that was passed
  nothing. So one import hands module code every binding and secret the vertical's script
  declares, including its own `SCOPE` namespace:

  ```ts
  import { env } from "cloudflare:workers";
  env.SCOPE.get(env.SCOPE.idFromName(someOtherScopeId)); // another tenant's scope
  ```

  That is the one import that turns the scope boundary from physical into advisory, and it is
  sharper for engines than for verticals: an installed engine — the layer whose whole job is
  owning invariants — could reach every scope of the vertical that composed it.

  It belongs to R2 rather than a new rule for the reason `node:*` does: a capability the host
  owns and injects, imported behind the host's back. Numbering is untouched, so #786's
  `catch`-outside-`ctx.atomic` rule keeps R7.

  Harness code is exempt exactly as it is for `node:*` — `worker.ts` and `*-do.ts` are where
  `DurableObject` legitimately comes from, and every such file in this repo stays green
  (`boundary-lint: all layer rules hold`).

  **This is a lint, and lint is not containment.** It runs in this repo's CI and in a
  vertical's own, not on the hosted push path, so for third-party code it raises the floor
  rather than closing the hole. Whether the layer rules should run platform-side at
  push/admit — over the built bundle, where obfuscation is harder — is the open question this
  change does not answer.

- 892d611: Module code gets a clock, and loses the wall clock (#812).

  `OperationContext` had no way to ask what time it was, so module code reached past the
  kernel for one: 95 hand-rolled `new Date()` / `Date.now()` calls across `engines/*` and
  `demos/*`, stamping rows the host could not see. Meanwhile `contracts/ids.ts` described
  the `instant` brand as "stamped kernel-side, never caller-side" — true of events, false
  of every domain row in the repo.

  `ctx.now(): Instant` is that clock, and `boundary-lint` **R6** is what keeps it the only
  one — the same class of ban as R2's `node:*`, and shipped in `@substrat-run/boundary-lint`
  so it enforces on generated and third-party verticals too.

  **It is stable for the whole invocation.** Every call within one operation returns the
  same instant, so two rows written in one transaction cannot disagree about when they were
  written, and an event carries the same instant as the row it describes. That is a promise
  about the value, not an optimisation: it is what a frozen clock rests on. Both hosts stamp
  it once when the context is built, and route `emit`'s `occurredAt` and `requestPlatform`'s
  `requested_at` through the same value.

  **The point is what becomes testable.** The host takes a `clock` (the same seam as
  `fetch`), and `manualClock` / `frozenClock` ship from the kernel. `demos/shop` has the
  worked example: its scenario suite already "covered" hold expiry by passing
  `holdSeconds: 0`, which proves an already-expired hold is swept and nothing about expiry.
  The new `test/hold-expiry.test.ts` holds a unit for its real fifteen minutes, asserts it is
  still reserved at fourteen, and gone at sixteen — with no real time elapsed.

  R6 has a reviewable `boundary-lint-allow R6` … `boundary-lint-end R6` block, because
  unlike R5's one-time handoff there is a recurring legitimate case: a timestamp a _remote_
  clock judges. The three uses in `apps/dashboard` are a GitHub App JWT's `iat`/`exp` and
  two `capturedAt` provenance stamps in host-driving code that has no operation to borrow an
  instant from.

  Timestamps are pinned to ISO 8601 text. The issue expected drift to migrate here; on
  inspection there was none in module code — every Substrat table already stores ISO text,
  and the epoch integers are Better Auth's own schema in `demos/auth-server`, which is that
  library's storage contract rather than ours. Recorded rather than migrated.

## 0.0.8

### Patch Changes

- 87ec6f2: Every published package now actually ships its license text.

  `LICENSING.md` has always opened by claiming each package "ships the full text in its
  tarball." Eight of them did not: `adapter-cloudflare`, `control-plane-api`,
  `vertical-auth`, `oidc-rp`, `psl`, `boundary-lint`, `model-emit` and `create-substrat`
  declared a license in `package.json` and shipped no `LICENSE` file. npm auto-includes
  `LICENSE*` when present — none was present, so nothing was included.

  That is worth a version bump rather than a docs fix, because a tarball is where the
  claim is either true or false, and `adapter-cloudflare` is the load-bearing case: §5.7
  makes the Cloudflare adapter half of the two-adapter rule that keeps the escrow story
  literally true, and AGPL is what stops a hosted derivative of it from staying closed.
  An AGPL package distributed without its license text is the weakest possible version of
  that. The texts are the stock unmodified AGPL-3.0 and Apache-2.0, byte-identical to the
  copies already in `kernel` and `contracts`.

  No code changes.

## 0.0.7

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

## 0.0.6

### Patch Changes

- 5a9d7bd: `assets.ts` and `assets.generated.ts` join `DEFAULT_HARNESS`. The generated
  file is the built SPA inlined as string literals (gen-assets.mjs) — its
  `fetch(` is browser code the worker serves, the same edge-wiring class as
  `page.ts`. It is also gitignored, so linting it produced local-only R3 reds on
  content CI never sees.

## 0.0.5

### Patch Changes

- d93e690: Detachable vertical auth (docs/architecture/vertical-auth-detach.md): auth moves out of the
  verticals and becomes an install-time choice — a team Auth Server app or any external
  OIDC issuer — with `builtin` (embedded Better Auth) as the unchanged default.

  **auth-server** is now a real multi-instance vertical: one issuer DO per scope behind
  the router (own users, signing secret, JWKS per install), the fixed-name single issuer
  standalone. It implements the K-31 surface (`/internal/provision`, `/internal/configure`)
  and answers unknown `/internal/*` paths with JSON — never the SPA fallback that
  surfaced as "Provisioning failed — internal error".

  **Config delivery seam** (control-plane-api): `VerticalClient.configureInstance` +
  `POST /tenants/:t/scopes/:s/configure` deliver per-instance config to the deployment
  holding the scope's DO (bound-version resolution, 501 when there is nowhere to deliver);
  `ProvisionInstanceInput` gains optional `config` so an app arrives configured
  atomically. The dashboard Env tab now delivers after authoring (`delivered` flag).

  **RP flow** (vertical-auth): `oidcRpAuthProvider` — the full server-side
  Authorization-Code + PKCE relying party as an `AuthProvider`, cookie sessions signed
  with a per-tenant DO-minted secret, bearer fallback for API clients. The IdentityDO
  stores platform-delivered per-scope config and keeps the provider-agnostic
  `sub → principal` directory (TOFU owner claim + invites) under every mode. Meridian
  selects its provider per scope from the delivered `substrat:auth`; its SPA renders a
  redirect sign-in and invite-accept in OIDC mode. jose is bumped to v6 so node JWKS
  fetching goes through `fetch`, matching workerd.

  **Install-time identity** (dashboard): the New-app form's Identity section — builtin,
  a team Auth Server (the app is auto-registered there via RFC 7591 dynamic client
  registration against its real bound hostname), or an external issuer. Wiring failures
  mark the app failed with the reason on its audit trail.

## 0.0.4

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.

## 0.0.3

### Patch Changes

- 6a7768a: Recognize `auth-do.ts` as harness. A Durable Object that wires an authentication adapter
  (Better Auth over the DO's own SQLite) is the workerd analogue of the already-exempt
  `auth-node.ts` — edge auth wiring, not module code — so its `fetch` request-interface method
  is no longer mistaken for a network call by the R3 rule.

## 0.0.2

### Patch Changes

- d0cb7a6: Treat `page.ts` and `oidc.ts` as harness. A served SPA (an HTML/JS string the worker
  returns) is edge wiring, not module code reachable from a `ModuleRegistration` — its
  `fetch` is browser code. `oidc.ts` is an OIDC relying party at the server edge (token
  exchange, JWKS) — the same node/network-touching auth-adapter class as `auth.ts`.
  Both added to `DEFAULT_HARNESS` alongside `worker.ts`/`routes.ts`, so R3 (no network
  in module code) no longer false-positives on a vertical's served page or auth edge.
- 0572a3b: **Typecheck on the native (Go) TypeScript compiler — `typescript` 5.6 → 7.**

  TypeScript 7 (the native compiler, formerly the `tsgo`/`@typescript/native-preview`
  rewrite) is now GA as `typescript@latest`. The binary is still `tsc`, so every package's
  `tsc -p … --noEmit` script is unchanged — only the toolchain pin moves. No source or
  public API changes; this bumps the published packages solely because their build now runs
  through the native compiler.

  Full-workspace `pnpm -r typecheck` drops to ~3s wall; per-package the native checker is
  roughly an order of magnitude faster (kernel 1.33s → 0.07s, control-plane-api 1.50s →
  0.12s, engine-invoicing 0.91s → 0.06s on this machine).

  Two migration deltas TS7's stricter resolution surfaced (both green on 5.6, red on 7):

  - **CSS side-effect imports (`TS2882`).** `import './ui.css'` in the six Vite app/admin
    surfaces now needs an ambient declaration. Fixed the way `demos/meridian/app` already
    did it — `"types": ["vite/client"]` in each app `tsconfig.json` (vite/client declares
    `*.css`) — rather than adding a stray `vite-env.d.ts`.
  - **`boundary-lint` node globals (`TS2584`/`TS2591`).** The linter CLI's `process`,
    `console`, and `node:fs`/`node:path` imports stopped resolving because the base tsconfig
    leaves `types` unset and TS7 no longer implicitly pulls in `@types/node` here. Added an
    explicit `"types": ["node"]` to `packages/boundary-lint/tsconfig.json`.

  Note: TS7 is a major bump that drops deprecated 5.x behavior. Editors should run their
  TS Server on 7 to keep CLI and IDE diagnostics aligned.
