# @substrat-run/boundary-lint

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
