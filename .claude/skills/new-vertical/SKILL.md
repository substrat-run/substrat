---
name: new-vertical
description: Build a complete Substrat vertical (declared model, module, seed world, server, API surface, app skin, scenario + conformance tests) from an approved concept, against the todo and ticket0 references. Use when asked to build, scaffold, or skin a new vertical or demo vertical on the Substrat platform.
---

# Build a Substrat vertical

> **Start from an approved design.** This skill *builds*; it does not decide what to build.
> If you arrived here without a reviewed design document, start from the **substrat** skill
> (`.claude/skills/substrat/SKILL.md`) — it interviews the user, maps the domain onto the
> engines, lands the `spec/concept.md` this skill turns into code, gated on the user's
> approval, and then declares the model (its Step 5). Do not re-interview the user here.

A vertical is a private package under `demos/<name>/` that composes the published engines
with its own vocabulary, tables, pricing, roles, and screens. It is built **forward from
its model**: `spec/model.ts` declares what exists, and the migrations, the manifest, the
route table, the OpenAPI document, the browser client and the permission artifact are all
derived from it. What is hand-written is what only a person could decide — the handlers,
the seed world, the tests, and the screens.

## The two references

Two demos, for two different questions. Both are maintained because they are used — todo is
what the scaffold's own docs point a new project at, ticket0 is a production support desk —
which is the property a reference needs; do not pick a third.

**`demos/todo` — the shape.** The smallest vertical that is still a real one (~1.9k lines).
Read these before writing anything, in this order:

1. `demos/todo/spec/model.ts` — `defineEntities` / `defineOperations` / `emitModel`. The
   permission array, the `http` line on each operation, `emits`, `paged`, `narrows`, and a
   `permission: { key, entity, idFrom }` entity check. Everything below derives from this.
2. `demos/todo/src/module.ts` — the handlers, `satisfies` a map derived from the
   declarations (an operation declared and not implemented, or the reverse, is a compile
   error naming the method), and the `ModuleRegistration` with
   `operationInputs: operationInputsOf(ops)`. `ctx.grant` / `ctx.revoke` doing
   user-initiated sharing in one line each.
3. `demos/todo/src/manifest.ts` — assembled, not written: `manifestOperations`,
   `manifestEntities`, `listsDeclaredBy`. What is left is deployment facts (id, version,
   journal) and the permission *descriptions*, which are prose.
4. `demos/todo/src/routes.ts` + `src/api.ts` — `mountOperations` derives the route table
   at mount time; `apiCatalogFrom` derives the OpenAPI document. Neither is a table you
   maintain.
5. `demos/todo/src/seed.ts` + `src/provision.ts` + `src/personas.ts` — the world (two
   tenants, always: the second exists to be attacked), `MODULES` + `ROLES`,
   `definePermissions` with the same `keys` array the model took, and the dev cast the
   issuer and the seed both read.
6. `demos/todo/src/server.ts` — the boot harness. Auth is an ordinary OIDC round-trip
   against `@substrat-run/dev-issuer`; there is no dev header and no principal picker.
7. `demos/todo/test/` — `scenario.test.ts` (written from the concept, never from the
   model), `server.test.ts` (the derived routes, driven with `app.request`),
   `conformance.ts` + `entity-checks.test.ts` (every declared entity check, proved
   behaviourally).
8. `demos/todo/tools/emit-migrations.mts` + `journal.json` + `src/migrations.generated.ts`
   — the journal is the record; nobody writes a version number.
9. `packages/kernel/src/scope-host.ts` — the contract your module code runs against.

**`demos/ticket0` — a deployed vertical.** Too large to read whole; these files are the
reference for the half todo does not have:

- **Composing an engine by call**: `spec/model.ts` lists the engine's permission keys
  (`metering:*`) in `TICKET0_PERMISSIONS` beside its own, because `MODULES` in
  `src/provision.ts` registers `meteringModule` next to the vertical's; the call itself is
  `recordUsage(ctx, …)` / `closePeriod(ctx, …)` inside the vertical's own handlers in
  `src/module.ts` — same transaction, the engine's invariants intact.
- **The worker**: `src/worker.ts` — sandbox-clean, own `SCOPE` + `AUTH` DOs, one
  `mountPlatformSurface(app, {…})` call for the `/internal/*` contract, the same
  `routes.ts` the node server mounts. Its header explains what is host-specific and why
  there is no `wrangler.jsonc`.
- **The declaration a push reads**: `package.json` → `substrat.runtimeNeeds` (entry,
  build, node-compat), `outbound` (the egress allowlist), `ownerGrants`, `requires`.
- **Shipping it**: `.github/workflows/substrat-deploy.yml` — gates, `substrat push
  --promote prod`, and a preview per PR.

Also load the repo rules in `CLAUDE.md` (three-layer rule, module code rules, the two
human checkpoints). **The engines are self-describing — read them, don't guess**: each
engine's `src/index.ts` states whether it is composed by call or by event, its `PERM`
keys, its in-scope functions and the events it emits and consumes.

## Order of work

### 1. Start from the approved design and the declared model

The design already exists — the `spec/concept.md` the **substrat** skill produced and the
user approved — and so does `spec/model.ts`, declared in that skill's Step 5. **Do not
re-derive the domain; translate it.** The design's sections map straight onto the build:
the cast and roles → seed roles/grants; "the thing that moves" and its lifecycle → engine
composition; "who is denied what" → the entity checks the model already declares and the
grants the seed makes; "the scenario the test will replay" → `test/scenario.test.ts`.

If the concept was written outside the vertical's own directory, copy it to
`demos/<name>/spec/concept.md` as the vertical's checked-in spec, keeping its content. The
vertical owns **vocabulary, extra fields, price list, roles, screens** — nothing that
belongs to an engine's state machine. If a needed decision is genuinely missing from the
design, that is a gap to take *back to the design gate*, not to invent here.

**Do not edit `spec/model.ts` during the build.** If a handler cannot return what the
model declares, that is real information — say so and stop. The model changes because the
business changed, never to accommodate what got built.

### 2. Package skeleton

Copy the shape of `demos/todo/package.json`, `tsconfig.json`, `vitest.config.ts`. Package
name `@substrat-run/demo-<name>`, `"private": true`. The `substrat` block in `package.json`
is what the tooling discovers the vertical through — `slug`, `permissions`
(`src/provision.ts`), `conformance` (`test/conformance.ts`), `client` (model → generated
browser client), `devServers`. Register the dev script pass-through in the root
`package.json` only if asked. Workspace globs already cover `demos/*` and `demos/*/app`.

Demo dev ports live in a private `887x`/`527x` block, and that block is full — `tock`, the
newest demo, sits just above it at `8880`/`5280`, so take the next free pair above that.
Read them from `PORT`/`WEB_PORT` in `server.ts` *and* `app/vite.config.ts`; the issuer is
`8879` for every demo because that is `dev-issuer`'s own default.

### 3. Derive the migrations

Copy `demos/todo/tools/emit-migrations.mts` (change the package name in its messages) and
run it:

```bash
pnpm --filter @substrat-run/demo-<name> emit:migrations
```

It reads the entities, diffs them against `journal.json`, appends exactly one entry when
they differ, and renders `src/migrations.generated.ts`. Commit all three. `pnpm
lint:migrations` runs every vertical's `emit:migrations --check` in CI, so a schema change
cannot merge without its migration in the diff — that is the migration checkpoint's
mechanical half. A side table for extra data on an engine's entity is keyed by that
engine's id and lives in *your* model, never as a column upstream.

### 4. Module — the handlers

`src/manifest.ts`, `src/routes.ts`, `src/api.ts` are near-verbatim copies of todo's with
the names swapped; the only prose in them is the permission descriptions (these feed the
permission diff) and the API tags. `src/module.ts` is where the work is:

- One handler per declared operation, `satisfies` the derived map — copy the `satisfies`
  block from todo verbatim; it is what makes a missing or extra handler a compile error.
- First line is always `assertAllowed(await ctx.check(...))` — with the entity ref for an
  operation whose declaration carries `entity`, and **for a `resolved` check the entity the
  handler looks up first** (todo's `revoke-share` reads the share, then checks the list).
- `ctx.link(child, parent)` when creating entities with declared parents. The kernel links
  the refs you hand an engine verbatim, and the adapter rejects a link no registered
  manifest declares — `manifestEntities` derives yours from `parents`, so declare the
  parent an engine-made edge lands on too.
- Compose engine in-scope functions for anything an engine owns, inside your handler:
  `createWorkOrder(ctx, …)` from your create operation; `getReportedLines` +
  `completeWorkOrder` from your pricing/completion operation. **The pricing moment** is
  the pattern: read engine lines → apply the vertical's price list → call the engine's
  complete — one transaction. Catching an engine error needs `ctx.atomic` (CLAUDE.md).
- Every mutation emits the fat event the declaration names; the payload keys are the
  ones `emits.payload` lists, and an `erasable` field cannot be among them.
- A listing is a **proof walk**: `pageVisible` with a per-entity `ctx.check`, or a `paged`
  read the kernel composes for you — never a `WHERE` clause on ownership.
- Money and decimals are strings via the contracts helpers; time is `ctx.now()`.

### 5. World, permissions, server

- `src/seed.ts`: `buildHost(dir)` = `new SqliteScopeHost({ dir })` + `registerModule` for
  each engine and the vertical; `MODULES` and `ROLES` exported. An idempotent `seed()`:
  two tenants, roles **per tenant** from engine `PERM` + the vertical's keys, seed
  entities created through `stub.invoke` (never raw SQL), the bootstrap grants a person
  needs on their own entity, and `linkDevPersonas` binding each persona's `sub` to a
  principal.
- `src/provision.ts`: `definePermissions({ modules, roles, entityGrants, keys })`, with
  `keys` the **same** array `spec/model.ts` handed `defineOperations` — it throws at load
  if the two disagree. `ENTITY_GRANTS` declares the shapes of the grants made outside the
  role table. `pnpm lint:permissions` renders `PERMISSIONS.md` from this file, checked in,
  `--check`ed in CI.
- `src/personas.ts`: the dev cast, one per role the scenario needs, including one who
  lives in the *other* tenant.
- `src/server.ts`: copy todo's. Host built once on `.data`, cast persisted, `devLogin`
  from `@substrat-run/dev-issuer` for `/api/auth/*` and `/api/me`, `/openapi.json` served
  from `API_DOCUMENT`, and `mountApi` with a `resolveStub` that reads the caller from the
  identity directory. **No business logic in routes, and no dev header** — impersonation
  for scripts is `POST {issuer}/dev/token {sub}`, at the issuer.

### 6. The generated artifacts

Each is derived from the model, carries the generated marks, and has a `--check` gate:

```bash
pnpm lint:model        # model.json
pnpm lint:api          # openapi.json — the API-surface review artifact
pnpm lint:client       # app/src/api.generated.ts, from `substrat.client`
pnpm lint:permissions  # PERMISSIONS.md
pnpm lint:conformance  # CONFORMANCE.md, from test/conformance.ts
pnpm lint:migrations   # journal.json + src/migrations.generated.ts
```

Run each, commit what it writes. A vertical missing one of these is not "not yet
documented"; it is failing a gate.

### 7. Tests — three files

- **`test/scenario.test.ts`** — replay the spec's scenario headlessly against a temp dir:
  lifecycle happy path → **denials hold** (wrong role, portal isolation between two
  customers, the other tenant's persona gets `unknown scope` / `permission denied`) →
  pricing math exact to the öre → event consumed by the engine (if used) → state machine
  can't skip. Denial assertions are not optional — they are the demo. Written from the
  **concept**, with literal inputs and outputs: a test derived from the model agrees with
  a wrong model perfectly and forever (`pnpm lint:tests` refuses one that reads it).
- **`test/server.test.ts`** — the derived routes, driven with `app.request` (no port, no
  process): status codes, the `problem` envelope, a denial arriving as 403 and not 400.
- **`test/conformance.ts` + `test/entity-checks.test.ts`** — `declareEntityChecks` over the
  operations, and `entityCheckConformanceSuite` proving each declared entity check
  behaviourally, with a probe persona who holds nothing on the entity until the suite
  grants it. List what the kit cannot generate under `uncovered`, with the reason.

Two things that decide whether the scenario's assertions are worth anything:

- **Never write a bare `.rejects.toThrow()`.** An unpatterned rejection passes for reasons
  you have not verified — wrong permission, wrong state, a typo'd operation name. Pin the
  message. Done well it becomes a real test of the machinery: a guard's refusal should
  *move* from "must be signed" to "must be counter-signed" as state changes. And pair every
  "this door is closed" assertion with a control proving a neighbouring door is still open —
  otherwise a withdrawal test passes just as happily if the engine were never registered.
- **Compute money literals with the real helpers before asserting them.** Write a throwaway
  script that runs the pricing moment through `mulDecimal`/`addDecimal` and prints the
  result; don't hand-derive it. `fromMicro` strips trailing zeros
  (`packages/contracts/src/money.ts`), so 34 894,80 kr serialises as `'34894.8'` —
  asserting `'34894.80'` fails on a *correct* number.

### 8. App skin (`app/`)

Copy-and-own from `demos/todo/app`: Vite + React, the generated client in
`app/src/api.generated.ts` (regenerated by `pnpm lint:client`, never edited), and the two
things it cannot know beside it in `app/src/api.ts` — who the request is made as, and the
error envelope the vertical picked in `app.onError`. Change brand, labels, and which
columns matter. The app tells a 403 wall from an empty list; keep that.

- **The Vite proxy passes Host through** — the object form with `changeOrigin: false`
  written out. The string shorthand expands to `changeOrigin: true`, the API builds its
  OIDC `redirect_uri` from the Host it is handed, and the login callback lands on the wrong
  port. `pnpm lint:vite-proxy` refuses the shorthand (#1388).
- **Keep view state in the URL.** The active screen (and its key/id) belongs in the `#/…`
  hash, not just React state — otherwise a refresh drops the user back to the root view.
  A tiny `parseHash()/viewToHash()/useHashRoute()` trio is enough.
- **The same change that creates `app/` declares it**: `substrat.runtimeNeeds.assets` in
  `package.json` (the substrat skill's Step 7 has the block). Undeclared, the deployed
  vertical 404s at `/`, and no gate before deploy notices.

### 9. Drive it over HTTP — the step the tests cannot do for you

**A vertical's scenario test can be 100% green while the demo is 100% broken.** The
scenario calls `stub.invoke(...)` directly and `server.test.ts` mounts the routes on an
in-process app, so between them nothing boots `server.ts`: the host on `.data`, the
persisted cast, the identity links, the issuer round-trip. A bug there 401s every request
in the browser and does not move a single assertion.

So before you call it done: `pnpm --filter @substrat-run/demo-<name> dev`, mint a token per
persona at the issuer, and walk the spec's scenario over HTTP as at least two of them — one
who should succeed and one who should be denied.

```bash
TOKEN=$(curl -s -XPOST localhost:8879/dev/token -d '{"sub":"dev|<someone>"}' | jq -r .access_token)
curl -s -H "Authorization: Bearer $TOKEN" localhost:<api>/api/<happy-path>
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $OTHER" \
     localhost:<api>/api/<denied-path>            # expect 403
```

Confirm three things the tests structurally cannot:

1. **The login resolves.** `/api/me` answers with the principal the seed linked to that
   `sub`, in the tenant the persona lives in.
2. **Denials keep their meaning through the transport.** `PermissionDenied` → 403, refused
   transitions and guard refusals → 409, unknown → 404. A denial that arrives as a generic
   400 has lost the thing the demo exists to show.
3. **The Vite proxy reaches the kernel** — `curl localhost:<web>/api/...`, not just the API
   port, so `PORT`/`WEB_PORT` are genuinely wired at both ends.

One assertion trap: **the cross-tenant denial over HTTP legitimately looks like `200 []`,
not 403.** The server resolves each persona to their OWN (tenant, scope), so the attacker
never even addresses the victim's database — the attack is unformulable, which is the
STRONGER isolation. Assert 403 only where the attack is addressable (kernel level:
`getScope` with the victim's pair, pinned in the scenario test). Over HTTP, the right
assertion for the other firm's persona is 200 with ZERO of the victim's rows — a naive
"expect 403" here goes red against a correct system.

Shell quoting mangles this quickly; a throwaway node driver that walks the whole arc and
prints each persona's status code is more reliable than a chain of `curl | jq`.

**Kill stale dev servers before driving — by PORT, never by pattern.** A `tsx
src/server.ts` left running from an earlier iteration serves the OLD route table, and
EVERY demo starts its server that way, so `pkill -f` on the pattern kills all of them,
including whatever the user has running in the shared tree. `lsof -ti :<api-port> | xargs
kill`, then boot fresh.

## Conventions the references don't show

- **Permission keys** are host-local: two verticals never registered on the same host may
  reuse a key (`customer:manage`); rename only when the meaning differs. Roles are
  vertical vocabulary — name them for the persona (`workshop-admin`), don't copy a
  reference's role names.
- **User-authored config is DATA, not code.** If the app lets a user shape the schema or
  settings (content types, field definitions, pricing rules a user edits), store it in a
  table and seed defaults lazily (an idempotent `ensureX(ctx)` guarded on emptiness), and
  gate edits behind an admin permission. Never turn user input into runtime DDL — the
  "compile to a migration" stays a *reviewable artifact* the UI can show, not a live
  `CREATE TABLE`. Manyfold's content types are the reference: `manyfold_content_type` +
  `save-type`/`list-types`, bodies persisted as JSON so adding a field is free.
- **A vertical is not pushable without a worker entry.** `substrat push` derives the
  deploy config from `substrat.runtimeNeeds` in `package.json` — never hand-authored
  wrangler config. No `worker.ts` + no `runtimeNeeds` = the push preflight refuses with
  the recipe. If the demo is meant to deploy, budget the worker in from the start:
  `create-substrat`'s template ships the minimal one, `demos/ticket0/src/worker.ts` is the
  full one.
- **Sandbox-clean is the only worker shape** (every vertical is sandbox-clean; only the
  dashboard is privileged). Own `ScopeDO` + `IdentityDO`, and **mount the platform-gated
  `/internal/*` contract with one `mountPlatformSurface(app, {…})` call** from
  `@substrat-run/vertical-host` — never hand-copy those routes (`provision`, `reconcile`,
  `configure`, `tables`, `query`, `platform-requests`, the snapshot/restore family, and the
  `{ error }` envelope the control plane reads a failure from; authored by hand they drift
  or ship without the error handler). You supply the hooks (`onProvision`, `resolveOwner`,
  `onConfigure`, `onDeleteScope`). **Multi-scope is native**: one `SCOPE` DO namespace,
  `idFromName(tenant, site)` = one DO per site; the router asserts the tenant, the app
  selects the site (`x-scope`), permissions evaluate from that site's own storage.
- **Outbound calls are declared** (`substrat.outbound`, D-46) and made through a
  connector, never from module code.

## Gates before you're done

Run all of these from the repo root; all must pass:

```bash
pnpm build && pnpm typecheck
node tools/boundary-lint.mjs
pnpm lint:model --check && pnpm lint:api --check && pnpm lint:client --check
pnpm lint:permissions --check && pnpm lint:conformance --check && pnpm lint:migrations --check
pnpm lint:vite-proxy && pnpm lint:tests
pnpm --filter @substrat-run/demo-<name> test
```

…and then the one that is not a command — **step 9: drive the arc over HTTP**. Green tests
plus a `server.ts` nobody booted is a real and unremarkable outcome here, so a vertical you
have not actually run is not finished, however green the suite.

Then STOP and present the two human checkpoints — never merge past them yourself:

1. **Migration diff**: the new `journal.json` entry and `src/migrations.generated.ts`
   verbatim.
2. **Permission diff**: the `PERMISSIONS.md` diff — new permission keys, descriptions, role
   definitions, and grant shapes (who can now do what, and why).
