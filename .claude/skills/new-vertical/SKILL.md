---
name: new-vertical
description: Scaffold a complete Substrat vertical (manifest, migrations, operations, seed world, server, app skin, scenario test) from a concept + the Callout reference. Use when asked to build, scaffold, or skin a new vertical or demo vertical on the Substrat platform.
---

# Scaffold a Substrat vertical

> **Start from an approved design.** This skill *builds*; it does not decide what to build.
> If you arrived here without a reviewed design document, start from the **substrat** skill
> (`.claude/skills/substrat/SKILL.md`) — it interviews the user, maps the domain onto the
> engines, and lands the `DESIGN.md` / `spec/concept.md` this skill turns into code, gated
> on the user's approval. Do not re-interview the user here.

A vertical is a private package under `demos/<name>/` that composes the published
engines with its own vocabulary, tables, pricing, roles, and screens. The reference
is **Callout** (`demos/callout`) — read these five files before writing anything:

1. `demos/callout/src/manifest.ts` — the declarative surface (permission consts +
   `moduleManifest.parse`); `src/migrations.ts` — the append-only journal;
   `src/module.ts` — operations, the pricing moment, and the `ModuleRegistration` wiring
2. `demos/callout/src/seed.ts` — host construction, roles, grants, seed world
3. `demos/callout/src/server.ts` — thin Hono wrapper, one route per operation
4. `demos/callout/test/scenario.test.ts` — the headless end-to-end scenario
5. `packages/kernel/src/scope-host.ts` — the contract your module code runs against

Also load the repo rules in `CLAUDE.md` (three-layer rule, module code rules, the two
human checkpoints). The engines' surfaces are their `src/index.ts`:
`engines/workorder` (PERM, in-scope functions `createWorkOrder`/`getReportedLines`/
`listOrders`/`completeWorkOrder`, operations `workorder/*`) and `engines/invoicing`
(INVOICING_PERM, operations `invoicing/*`, consumes `workorder.completed`).

## Order of work

### 1. Start from the approved design

The design already exists — it is the `DESIGN.md` / `spec/concept.md` the **substrat**
skill produced and the user approved. **Do not re-derive the domain; translate it.** The
design's sections map straight onto the build: the cast and roles → seed roles/grants; "the
thing that moves" and its lifecycle → engine composition; "the data we'll store" →
migrations; "who is denied what" → permission checks and portal grants; "the scenario the
test will replay" → `test/scenario.test.ts`.

If you are inside the monorepo and the design lives elsewhere (e.g. `DESIGN.md`), copy it to
`demos/<name>/spec/concept.md` as the vertical's checked-in spec, keeping its content. The
vertical owns **vocabulary, extra fields, price list, roles, screens** — nothing that
belongs to an engine's state machine. If a needed decision is genuinely missing from the
design, that is a gap to take *back to the design gate*, not to invent here.

### 2. Package skeleton

Copy the shape of `demos/callout/package.json`, `tsconfig.json`, `vitest.config.ts`.
Package name `@substrat-run/demo-<name>`, `"private": true`. Register the dev script
pass-through in the root `package.json` only if asked. Workspace globs already cover
`demos/*` and `demos/*/app`.

### 3. Module — three files

Split the module across three files so the declarative shape reads without wading
through operations (mirror Callout):

- **`src/manifest.ts`** — the vertical's declarative surface: the permission-key consts
  (`SC_PERM = { … permissionKey.parse('…') }`) **and** `moduleManifest.parse({...})`
  (id, version, `kernelContract: '^0.0.1'`, permission declarations — key + human
  description, these feed the permission diff — events emits/consumes,
  `attachmentTargets`, `entityRelations` (child → parent edges the permission walk
  follows, e.g. `bike → customer`), `entitlementKey`). Keep the perm consts beside the
  manifest's `permissions` list — they're the same keys twice, so "add a permission" is
  a single-file edit. Operations `import { SC_PERM } from './manifest.js'`.
- **`src/migrations.ts`** — `export const <name>Migrations`: `SqlMigration[]`, tables
  prefixed `<name>_`, TEXT ids, ISO-8601 TEXT timestamps, decimal/money as TEXT.
  Append-only forever after. Any `boundary-lint-allow R5` extraction block lives here
  with the migration it guards.
- **`src/module.ts`** — imports both, holds the operations and the `ModuleRegistration`.
- Operations: `OperationHandler<Input, Output>`; first line is always
  `assertAllowed(await ctx.check(...))`; validate inputs with Zod where they aren't
  already typed; `ctx.link(child, parent)` when creating entities with declared
  relations; compose engine in-scope functions for anything an engine owns
  (`createWorkOrder(ctx, …)` from your create operation, `getReportedLines` +
  `completeWorkOrder` from your pricing/completion operation).
- The **pricing moment** is the pattern to copy: read engine lines → apply the
  vertical's price list (min-qty, dropped internal articles, whatever the spec says)
  → call the engine's complete — one transaction, invariants intact.
- Portal listing: iterate entities and `ctx.check(perm, entityRef)` per entity — a
  proof walk, not UI filtering.
- Export a `ModuleRegistration` with namespaced operation names `'<name>/op-kebab'`.

### 4. World (`src/seed.ts`) and server (`src/server.ts`)

- `build<Name>Host(dir)`: `new SqliteScopeHost({ dir })` + `registerModule` for each
  engine and the vertical.
- Idempotent seed: provision scope(s), define roles **per tenant** from engine PERM +
  vertical permission keys, assign roles, create seed entities via `stub.invoke`
  (never raw SQL), entity-narrowed grants for portal principals, persist the cast to
  a JSON file so restarts reuse it.
- Server: dev principal picker via `x-principal` header, `getScope` → `invoke`, one
  route per operation, `PermissionDenied` → 403. **No business logic in routes.**

### 5. API surface (`src/api.ts` + docs routes)

Every vertical is born documented (design/api-surface.md; reference:
`demos/meridian/src/api.ts`, near-minimal: `demos/manyfold/src/api.ts`):

- Export every operation's input schema from `module.ts` (named consts — no inline
  anonymous `z.object(...).parse` in handlers; the catalog must reference the SAME
  objects the handlers parse).
- `src/api.ts`: an `ApiCatalog` (from `@substrat-run/contracts`) — one entry per
  registered operation with `summary`, `description` (name the permission it checks),
  `tag`, `input` (+ `inputOptional` for filter-style reads) — plus the import-time
  parity check and `API_DOCUMENT = buildOpenApiDocument(...)`, versioned by the
  manifest. Copy both blocks from Meridian verbatim.
- Routes on BOTH entrypoints: `POST /api/op/*` (full registered names — the documented
  convention), `GET /openapi.json` (session-gated on the worker, open on the dev
  server), `GET /api/docs` (Scalar, self-hosted — copy `src/docs.ts` and the
  gen-assets Scalar block from Meridian; `@scalar/api-reference` as devDependency;
  never a CDN, never Scalar's proxy).
- Run `pnpm lint:api` and COMMIT the emitted `demos/<name>/openapi.json` — CI checks
  it with `--check`; that diff is the API-surface review artifact (a human checkpoint,
  like the permission diff).

### 6. Scenario test (`test/scenario.test.ts`)

Replay the spec's scenario headlessly against a temp dir: migrations journaled →
lifecycle happy path → **denials hold** (wrong role, portal isolation between two
customers, cross-tenant attacker gets `unknown scope` / `permission denied`) →
pricing math exact to the öre → event consumed by invoicing (if used) → state
machine can't skip. Denial assertions are not optional — they are the demo.

Two things that decide whether these assertions are worth anything:

- **Never write a bare `.rejects.toThrow()`.** In a demo whose whole point is denials, an
  unpatterned rejection passes for reasons you have not verified — wrong permission, wrong
  state, a typo'd operation name. Pin the message. Done well it becomes a real test of the
  machinery: a guard's refusal should *move* from "must be signed" to "must be
  counter-signed" as state changes. And pair every "this door is closed" assertion with a
  control proving a neighbouring door is still open — otherwise a withdrawal test passes
  just as happily if the engine were never registered.
- **Compute money literals with the real helpers before asserting them.** Write a throwaway
  script that runs the pricing moment through `mulDecimal`/`addDecimal` and prints the
  result; don't hand-derive it. `fromMicro` strips trailing zeros
  (`packages/contracts/src/money.ts`), so 34 894,80 kr serialises as `'34894.8'` —
  asserting `'34894.80'` fails on a *correct* number.

### 7. App skin (`app/`)

Copy-and-own from `demos/callout/app`: Vite + React, hash routing, principal picker in
the top bar, views renamed to the vertical's vocabulary. Change brand, labels, and
which columns matter; keep the api.ts pattern (typed wrappers over the server routes).

- **Keep view state in the URL.** The active screen (and its key/id) belongs in the
  `#/…` hash, not just React state — otherwise a refresh drops the user back to the root
  view. A tiny `parseHash()/viewToHash()/useHashRoute()` trio (see `demos/manyfold/app/src/App.tsx`)
  is enough; `navigate(v)` sets `location.hash`, a `hashchange` listener re-derives the
  view. Site/persona can stay in `localStorage` (they persist across refresh anyway).

### 8. Drive it over HTTP — the step the scenario test cannot do for you

**A vertical's scenario test can be 100% green while the demo is 100% broken.** The test
calls `stub.invoke(...)` directly, so it never executes `server.ts`, the route table, the
`x-principal` picker, `auth-adapters.ts`, or the `onError` status mapping. Nothing in
`pnpm test` covers that layer — across the existing demos, only `rally` has a test that
touches it at all. A principal-resolution bug there 403s every request in the browser and
does not move a single assertion.

So before you call it done: boot the server and walk the spec's scenario over HTTP as at
least two different personas — one who should succeed and one who should be denied.

```bash
PORT=<api> pnpm --filter @substrat-run/demo-<name> server &
curl -s -H 'x-principal: <someone>'    localhost:<api>/api/<happy-path>
curl -s -o /dev/null -w '%{http_code}\n' \
     -H 'x-principal: <someone-else>'  localhost:<api>/api/<denied-path>   # expect 403
```

Confirm three things the test structurally cannot:

1. **The principal picker resolves.** Whatever the app puts in `x-principal` must be what
   the server looks up. If the app stores a principal id and the server keys a cast map by
   nickname, every request is `not authenticated`.
2. **Denials keep their meaning through the transport.** `PermissionDenied` → 403, refused
   transitions and guard refusals → 409, unknown → 404. A denial that arrives as a generic
   400 has lost the thing the demo exists to show.
3. **The Vite proxy reaches the kernel** — `curl localhost:<web>/api/...`, not just the API
   port, so `PORT`/`WEB_PORT` are genuinely wired at both ends.

Shell quoting mangles this quickly; a throwaway Python/node driver that walks the whole arc
and prints each persona's status code is more reliable than a chain of `curl | jq`.

## Conventions the reference doesn't show

- **Permission keys** are host-local: two verticals never registered on the same host
  may reuse a key (`customer:manage`); rename only when the meaning differs. Roles are
  vertical vocabulary — name them for the persona (`workshop-admin`), don't copy the
  reference's role names.
- **Side-by-side demos**: demo dev ports live in a private `887x`/`527x` block, kept
  clear of the Vite (5173) and Wrangler (8787) defaults that collide with unrelated
  projects. Pick the next free pair (fsm :8871/:5271, bike-shop :8872/:5272, shop
  :8873/:5273), read both from `PORT`/`WEB_PORT` in `server.ts` *and* `vite.config.ts`
  so one env var moves both ends of the proxy, and use a vertical-specific
  localStorage key for the principal picker, so demos coexist.
- **User-authored config is DATA, not code.** If the app lets a user shape the schema or
  settings (content types, field definitions, pricing rules a user edits), store it in a
  table and seed defaults lazily (an idempotent `ensureX(ctx)` guarded on emptiness), and
  gate edits behind an admin permission. Never turn user input into runtime DDL — the
  "compile to a migration" stays a *reviewable artifact* the UI can show, not a live
  `CREATE TABLE`. Manyfold's content types are the reference: `manyfold_content_type` +
  `save-type`/`list-types`, bodies persisted as JSON so adding a field is free.
- **Sandbox-clean is the default worker shape** (policy: every vertical is sandbox-clean,
  only the dashboard is privileged). Copy Meridian's `worker.ts`/`wrangler.jsonc`: own
  `ScopeDO` + `IdentityDO`, `/internal/provision` platform-gated, SPA inlined via
  `gen-assets` (no ASSETS binding). **Multi-scope is native**: one `SCOPE` DO namespace,
  `idFromName(tenant, site)` = one DO per site; the router asserts the tenant, the app
  selects the site (`x-scope`), permissions evaluate from that site's own storage.
- **Kill stale dev servers before driving over HTTP.** A `tsx src/server.ts` left running
  from an earlier iteration serves the OLD route table — you'll chase phantom
  `unknown operation` 404s against code you already fixed. `pkill -f 'tsx src/server.ts'`
  (and check `lsof -ti :<port>`) before each smoke run, and boot fresh.
- **Declare every link edge you traverse**: engines link the refs you hand them
  verbatim (workorder → your facility-shaped entity), and the adapter rejects links
  undeclared in any registered manifest — so your `entityRelations` must cover both
  your own edges (`bike → customer`) and the engine-made ones (`workorder → bike`).
  This is also exactly what makes the portal proof-walk reach the customer.

## Gates before you're done

Run all of these from the repo root; all must pass:

```bash
pnpm -r build && pnpm -r typecheck
node tools/boundary-lint.mjs
pnpm lint:permissions --check          # PERMISSIONS.md is checked in; CI fails on drift
pnpm lint:api --check                  # openapi.json is checked in; CI fails on drift
pnpm --filter @substrat-run/demo-<name> test
```

…and then the one that is not a command — **step 8: drive the arc over HTTP**. Green tests
plus a broken `server.ts` is a real and unremarkable outcome here, so a vertical you have
not actually run is not finished, however green the suite.

Then STOP and present the two human checkpoints — never merge past them yourself:

1. **Migration diff**: every new `SqlMigration` verbatim.
2. **Permission diff**: a table of new permission keys, descriptions, role
   definitions, and grants (who can now do what, and why).
