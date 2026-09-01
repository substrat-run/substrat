# create-substrat

## 0.8.5

### Patch Changes

- 17eca12: The scaffold's agent documentation catches up with the platform it describes: the coverage
  map names all seven engines (`engine-absence` and `engine-metering` were missing, so an
  agent would have quoted a build estimate for leave handling and usage metering that already
  exist), the module section stops telling handlers to hand-parse their input when the
  starter's own module passes `operationInputsOf` to the host, and both `AGENTS.md` and the
  playbook now carry the rule that catching an engine error requires `ctx.atomic` — the one
  rule whose absence lets a caught failure commit the partial writes an engine's invariants
  were protecting.

## 0.8.4

### Patch Changes

- 90e46d7: The `_substrat_*` rule now names the helper for the read it allows. A scaffolded project's `AGENTS.md` — and the same page on the docs site — points at `readTimeline` / `readHistory` from `@substrat-run/kernel` instead of leaving "reads are fine" to be answered with a hand-rolled `SELECT`, and says what `readHistory`'s three nullable fields mean, since each `null` there is a fact rather than missing data.

## 0.8.3

### Patch Changes

- 744325c: The scaffold now hands the host its declared operation inputs. Every `npm create substrat`
  project starts with `operationInputs` on its `ModuleRegistration`, so a malformed call is
  refused at the scope door — before the guards, before the permission check, on every path
  in — instead of reaching a handler that reads the field raw. The template's operations
  declare their input as a Zod object and take their handler's input type from it, so the
  schema and the type are one description rather than two that can drift; the timeline
  operation's hand-parse is gone, because the host already did it.

## 0.8.2

### Patch Changes

- 0a536b7: `readRoutedNode` fails closed without a secret (#966). When a request carries
  `x-substrat-tenant`/`x-substrat-scope` headers and the worker has no `expectedSecret`
  configured, it now throws `RouterAssertionError` instead of trusting the unsigned
  assertion — a vertical deployed without its `ROUTER_SECRET` refuses routed requests (400)
  rather than serving whichever tenant the header named. The new `allowUnsigned` option is
  the explicit opt-out for an un-routed local instance behind a dev router; the scaffolded
  `worker.ts` sets it from `ALLOW_DEV_NODE` and from nothing else. The no-headers → `null`
  path is unchanged, so a standalone deploy and `ALLOW_DEV_NODE` keep working as before.

## 0.8.1

### Patch Changes

- e745b6a: The scaffold's `AGENTS.md` names `ctx.grant` / `ctx.revoke` as how an app shares a record

  An agent building a shared-list app found `CapabilityGrant` (the general capability-grant
  type in `@substrat-run/contracts` — a principal, a permission, a node, an optional entity),
  saw no revoke on it, checked that `ctx.link` edges cannot be removed, and concluded the
  only revocable per-entity primitive was org membership — so it minted two orgs per list
  and a tombstoned membership table, all in an append-only migration (#798). The primitive
  it wanted was one file away on `OperationContext`, and nothing an agent reads had ever
  named it.

  `AGENTS.md` (and its published twin, `/guide/agent-rules`) now has a section that shows
  the two-line shape — `ctx.grant(principal, perm, entityRef)` and
  `ctx.revoke(principal, perm, entityRef)` — with the three guardrails (entity-required,
  delegating, transactional), and says in the same breath why neither alternative is it: a
  `ctx.link` edge is permanent, and org membership is revocable but coarse-grained. The
  template playbook's kernel tier and seed step point at the same call and at the todo demo,
  so a scaffolded project cannot rediscover the wrong answer from either document.

## 0.8.0

### Minor Changes

- 2352a3b: Every surface answers problem+json — and the message-matching goes with it

  `/openapi.json` has said `application/problem+json` on every error response since the error
  model's first phase. Nothing served one. Seven verticals, the scaffold template and the
  control plane each hand-rolled a handler that read a status out of an error's **prose** —
  `/not found/` → 404, `/out of stock/` → 409, `/cannot edit|frozen|already/` → 409 — and
  answered `{ error: "<message>" }`. This is phase 4 of #113: the transports read the code.

  ```http
  409 Conflict
  content-type: application/problem+json
  ```

  ```json
  {
    "type": "https://substrat.net/errors/conflict",
    "title": "Conflict",
    "status": 409,
    "detail": "out of stock: SKU-14 — 2 available, 5 requested",
    "code": "conflict",
    "reason": "out_of_stock",
    "instance": "/api/op/shop/add-to-cart",
    "error": "out of stock: SKU-14 — 2 available, 5 requested"
  }
  ```

  **The patterns were not kept as a fallback; the throw sites were typed instead.** A regex
  table living beside typed throws is a table nobody maintains. So 73 raw `new Error(...)`
  across the six verticals became `substratError('conflict', …, { reason })` — the platform
  owns the code, the vertical owns the reason — and the two platform refusals every vertical
  had independently hand-matched (`unknown operation`, `operation not entitled`) are typed in
  the adapters and the kernel where they are raised. Seven `onError` handlers are one line
  each now. `problemResponse(c, err)` is exported from `@substrat-run/vertical-host` and is
  what the scaffold template ships with.

  **A body with no `code` is information.** Two failures reach a transport that the closed
  taxonomy cannot name: a throw nobody typed (answered with the caller's 400, deliberately —
  an unrecognised throw must not claim to be the platform's fault) and a status raised
  somewhere else (a downstream vertical's refusal, a Durable Object fault's 502). Those get
  RFC 9457's `about:blank` form — status, message, no code — because inventing one would put
  our vocabulary on a failure we cannot describe, and a client switching on `code` would
  match it. `problem.code` is optional in the schema for exactly that reason, and the absence
  doubles as a visible to-do list: every one marks a throw site still untyped.

  **Nothing breaks.** `error` still duplicates `detail` on every body, which is why roughly
  thirty contract-suite assertions on message text, and every SPA in the repo, went green
  untouched. It goes in phase 5, along with the last patterns; `detail` is what to read.

  Three deliberate exclusions, stated rather than hidden:

  - **`engine-booking`'s `SlotUnavailable`** publishes its own `code = 'SLOT_UNAVAILABLE'`,
    which both RallyPoint clients switch on. An engine surface evolves additively only, so
    retyping it is a dual-emit through a deprecation window — `demos/rally` answers it by
    hand and says so.
  - **`demos/auth-server`** is an OIDC issuer whose OAuth endpoints owe RFC 6749 error
    bodies, where `error` is an OAuth code rather than a message. Merging the two
    vocabularies on one surface is the OAuth work's call, not a transport sweep's.
  - **The control plane's 23 remaining patterns** cover untyped `HostAdmin` throws. The table
    names a **code** per row now instead of a status, so an entry says what the failure IS and
    the status follows from the catalog — the two can no longer disagree.

  **Statuses moved, and that is the point.** A vertical's default for anything its pattern
  list did not recognise was the caller's 400, so every domain refusal that did not happen to
  say "not found" arrived as one: `cart is empty`, `discount code expired`, `the club is
closed on 2026-08-25`, `no employment terms set`, `only a submitted expense can be decided`.
  Those are 409 now — the request was well-formed and the state refused it — and `no such
plan` / `no such credit pack` are 404, which their wording had hidden from the pattern that
  would have caught them. No client in the repo branches on those statuses (the demo SPAs
  read `{ error }`, and only Todo's reads a status at all, for 403), so this lands as a
  correction rather than a break.

  One outright fix falls out: Manyfold's public delivery read of an unpublished slug answered
  409, because `not published` sat in an app-level pattern list that meant "conflict". It is a
  404 — the entry does not exist yet.

## 0.7.3

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

- b6e7ee4: A UI the push would never serve is refused, and the rule that prevents it moved to where
  `app/` is created (#881).

  The playbook told the agent to scaffold a UI in Step 7 and to declare it in Step 9, sixty
  lines and one **optional** step apart. A build that stopped before deploying therefore
  produced a vertical whose `app/` was real, tested, and invisible in production — and the
  failure is silent at every gate that runs before it: `pnpm test` never touches `server.ts`,
  `boundary-lint` has no opinion about static files, and `substrat push` cannot complain
  because a vertical with no UI must legitimately declare no assets.

  It reached a live vertical: `training`, a gym app with a full mobile web app under `app/`,
  deployed clean and answered 404 at its own hostname. Its `runtimeNeeds` declared `entry`,
  `needsNodeCompat`, `stores` and a five-key `envSpec` — no `build`, no `assets` — so
  `app/dist` was never built, never uploaded, and `/` fell through to a Hono 404 that looks
  exactly like an unbound hostname.

  **cli**: `assertUiIsServed` runs before the bundle is built and refuses a push whose UI
  nothing would serve, with the `runtimeNeeds.assets` recipe in the message. It fires only
  where the UI is provably unreachable — `app/index.html` present, no `assets` in either
  vocabulary, and no inlined-assets module under `src/` (the pre-#340 base64 pattern serves
  its files from the worker and correctly declares nothing). `--allow-unserved-ui` is the
  deliberate override for an `app/` the tree cannot speak for: a mock, a fixture, or one
  built and deployed elsewhere.

  **create-substrat**: the assets block now lives at the UI-scaffold point in
  `.substrat/playbook.md` — _the same change that creates `app/` declares it_ — with Step 9
  carrying a back-reference instead of a second copy that can drift, plus the two adjacent
  failures that are each silent on their own (`runWorkerFirst` missing a worker-owned prefix
  answers API calls with `index.html`; an app that bakes a base URL instead of calling its own
  origin works on the author's machine and reaches nothing from a phone). Step 9 gains a
  verification gate — a deploy is not done until `curl /` returns HTML and `curl /api/me`
  returns the worker — and a triage table separating a router 404 from a worker 404. The
  same edit is ported into the source skill, and `AGENTS.md` states the rule in one line
  because it is the always-on file and the playbook is not.

  **Not fixed here, and worth its own issue:** a scaffold freezes `.substrat/playbook.md` at
  create time and nothing updates it. `main` being right for months did not help the affected
  vertical, whose 310-line copy ends at Step 8, and will not help any vertical already
  scaffolded.

## 0.7.2

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

## 0.7.1

### Patch Changes

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

- 2580eb3: One name for the design document: `spec/concept.md`.

  The playbook told a scaffolded project to write `DESIGN.md` in the project root, while every
  demo, the docs site, the builder studio and `CLAUDE.md` called the same artifact
  `spec/concept.md`. Two names for one file — and the root/`spec` split put it in a different
  directory from `spec/model.ts`, which is that same design one rung more concrete.

  `spec/concept.md` wins because it is the name everything mechanical already keys on:
  `apps/builder/src/phase.ts` detects the interview phase by its absence and
  `interviewWriteGuard` refuses every non-`spec/**` write until it exists; the eval fixtures
  and `tools/model-diff.mts` name it; D-56 encodes it as a phase-ladder fact. `DESIGN.md`
  appeared only in prose instructions, never in code.

  The old rationale — `DESIGN.md` for a standalone project, `spec/concept.md` inside the
  monorepo — was already false when it was written: the builder generates standalone projects
  and writes `spec/concept.md` into them.

  So the three artifacts now read the same everywhere, one role each:

  | artifact          | says                 | written by                 |
  | ----------------- | -------------------- | -------------------------- |
  | `spec/concept.md` | what the business is | human, approved            |
  | `spec/model.ts`   | what exists          | human-approved, AI-drafted |
  | `src/`            | how it behaves       | AI, gated                  |

  **No `spec/` ships in the template, on purpose.** A pre-made `concept.md` would mark the
  interview as already done — exactly the fact the phase ladder reads — so the agent creates
  the directory when it writes the file at Step 3.

## 0.7.0

### Minor Changes

- 8b9f234: The scaffold's deployed surface is the one you developed against, and it can receive
  config (#799).

  **Two entrypoints, two APIs.** `server.ts` mounted ~20 named REST routes; `worker.ts` —
  the one that actually deploys — mounted `/api/me` and `POST /api/invoke`. Nothing was
  wrong with either alone. What was wrong is that a scaffolded project's local surface was
  not its deployed surface, and nothing said so until deploy: build a UI against the dev
  routes, ship it, and it talks to an API that isn't there. The failure is silent in the
  direction that matters, arriving after the route names are load-bearing.

  The fix already existed in the repo. `src/routes.ts` is now one route table with a
  `mountApi(app, resolveStub)`, and both entrypoints mount it — callout's shape, and its
  stronger claim: the SAME vertical surface runs on both adapters, so the two cannot drift.
  Each entrypoint keeps only what is genuinely its own — building a host, resolving a
  caller, and its one auth-shaped route. `/api/cast` (the dev persona picker) and `/api/me`
  stay split on purpose; that asymmetry is how a client tells a dev server from a
  deployment, and it is now written down rather than incidental. `/api/invoke` moved into
  the shared table: it is the useful generic escape hatch and read as a Cloudflare-only
  affordance.

  **One error vocabulary.** The table's `onError` is built on `classifyError`
  (`@substrat-run/vertical-host`) — the same function `mountPlatformSurface` uses. This
  matters more than it looks: Hono keeps only the last-registered `onError`, so in the
  worker the platform's envelope replaces the table's. That is safe precisely because both
  classify through one function. It also retires the starter's hand-rolled
  `/invalid transition|immutable|already/` regex in favour of the #113 taxonomy, so a
  refusal that declares what it is outranks a guess about its prose.

  **`onConfigure`, the seam that was missing.** The template passed six hooks to
  `mountPlatformSurface` and not this one, so a scaffolded vertical answered **501** to
  per-instance config for its whole life. Concretely: the dashboard delivers a scope's
  Identity choice (the `substrat:auth` entry) over exactly that route, so saving an issuer
  in Settings landed in the account's record and never reached the running app. The
  dashboard was honest about it (`delivered: false`) — but the remedy is a new version
  pushed and promoted, and nobody knows they need one until they are standing at the wall.
  It also taught at least one agent that the platform was stricter than it is: finding no
  delivery seam in its own worker, it concluded OIDC wiring was create-time and permanent.

  Deliveries now land in `src/config-do.ts`, a per-tenant DO whose `scope_config` table
  matches `@substrat-run/vertical-auth`'s `IdentityDO` exactly — so a project that later
  adopts vertical-auth for real logins swaps the binding and keeps its rows. They are read
  back through `resolveScopedEnvSpec`, which is the half that keeps the hook from being
  write-only: an `envSpec` default rides as a worker binding shared by every install of one
  serving script, so reading `env.FOO` directly always yields the shared default no matter
  what a tenant saved. A declared `SHOP_NAME` (manifest + `substrat.envSpec`) makes that
  demonstrable rather than theoretical.

  The starter still ships no auth — the seam is deliberate — so `substrat:auth` is stored,
  typed and surfaced rather than acted on. What changes is the failure: a 401 now names the
  situation instead of being bare, because "an issuer is configured and every request is
  still 401" is the case that reads as a platform bug and isn't.

  **Found while verifying, and worth recording.** `export const AUTH_CONFIG_KEY` on
  `worker.ts` made workerd refuse to boot — every named export of the entry module must be a
  handler or a Durable Object class. `tsc` was clean and all nine scenario tests passed. The
  constant moved to `config-do.ts`. That is the same defect class this changeset fixes,
  reproduced on the fix for it, and it is what #797 exists to catch: the template is not a
  workspace member, so no repo gate builds the artifact we hand users. Verification was a
  real scaffold — `npm install` from the registry, both hosts driven over HTTP.

## 0.6.4

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

## 0.6.3

### Patch Changes

- c40449d: The scaffold ships against the packages we actually publish, and can no longer drift.

  `index.js` pinned `^0.71.0` and `^0.4.3` while we shipped 0.75.0 and 0.6.2. On 0.x a
  caret locks the minor, so those ranges never drifted forward — every project scaffolded
  for four minors got old packages, and the session hook then pointed each one at
  `llms-0.71.0.txt`, a docs slice that 404s.

  The pins going stale is what hid the real damage. Frozen there, the template kept
  testing green against packages nobody runs, while two surfaces moved underneath it:

  - **`engine-invoicing`** split document-level provenance from per-line (#328).
    `source_type`/`source_id` used to carry the delivery; now `document_type`/`document_id`
    do, and `source_*` carries `time`/`material` and is nullable. The scenario test still
    asserted the old meaning, and now asserts both levels.
  - **`vertical-host`** types `onProvision`/`onDeleteScope` as `Promise<void>`. The worker
    passed the sweeper's roster calls straight through, which return a count — so the
    scaffold did not typecheck. They await and discard now.

  Both are additive changes the template simply never followed, and nothing would have
  said so: `packages/create-substrat/template` is not a workspace member, so its tests and
  typecheck never ran in CI.

  The pins are now emitted from each package's own version by `pnpm lint:pins`, checked in
  CI, and written by `version-packages` so a bump and its pins land in the same PR. The
  tool also asserts the seven runtime packages really do share one version, because
  `SUBSTRAT` being a single range for all of them is only correct while that holds.

  A gate on the numbers still says nothing about whether the template _compiles_ against
  them — that needs the scaffold built and tested against published packages, which is a
  separate job and not yet in CI.

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
