---
description: "The always-on contract for building a Substrat vertical: the three layers, the ten non-negotiable module-code rules, the gates to run, and the two checkpoints an agent may never self-approve."
---

# Agent rules

**If you are an agent building on Substrat, this is the page to read first.** It is the
always-on contract — the rules that hold no matter what you touch — and most of what a
generated vertical gets wrong is on this page.

This is not a summary written for the website. It is the exact file
[`create-substrat`](/reference/create-substrat) writes into every scaffolded project as
`AGENTS.md`, published here so an agent that has not scaffolded anything can still read
it. The two are kept identical mechanically; a rule cannot say one thing in your project
and another thing here.

What this page is *not* is the build flow. Interviewing for a domain, mapping it onto the
engines, and landing a design document a human approves before any code is a **playbook**,
invoked when you start a vertical — `/substrat` in Claude Code, the `new-vertical`
command in Cursor and opencode. Scaffold first with [Getting started](/guide/getting-started);
this page is what a session already mid-build must never violate.

## The mental model

Three layers. You only own the third.

1. **Kernel — free, always.** Tenancy (one scope = one isolated database; there is no
   cross-tenant API), permissions (roles, grants, and a proof path for every decision),
   events + audit (every mutation emits a kernel-stamped event you cannot mislabel),
   migrations (journaled per module, applied lazily per scope).
2. **Engines — compose or feed.** Headless, own invariants that cannot be violated
   (state machines that can't skip states, append-only entries). You either **compose**
   an engine (import it; its in-scope functions run in *your* transaction) or **feed** it
   (emit a fat event; it consumes — no import). Engines never import each other. Read an
   engine's real surface from `node_modules/@substrat-run/engine-*/dist/index.d.ts` —
   never guess at it.
3. **Your vertical — everything a user touches.** Vocabulary, price list, extra fields,
   roles, screens. If your core noun isn't something an engine already owns, this is most
   of the app — a normal, supported outcome.

## Project layout

The linter and tests expect this shape. `manifest`/`migrations`/`module` are **module
code** (the rules below bind them); `seed`/`server` are **harness** (exempt).

```
src/manifest.ts        moduleManifest.parse({…}) + PERM consts   ← module code
src/migrations.ts      the SqlMigration[]                         ← module code
src/module.ts          imports both; operations + registration    ← module code
src/provision.ts       MODULES, ROLES, grant shapes — node-free    ← module code
src/seed.ts            host, tenants, demo cast, seed world        ← harness
src/routes.ts          the HTTP route table — BOTH hosts mount it   ← harness
src/server.ts          the dev entrypoint (node + persona picker)   ← harness
src/worker.ts          the deployable Cloudflare worker             ← harness
src/config-do.ts       per-instance config store (Cloudflare only)  ← harness
test/scenario.test.ts  the scenario — including the denials
```

**A new route goes in `src/routes.ts`, never in an entrypoint.** Both `server.ts`
and `worker.ts` mount that one table, so a route added there is live on both — and
a route added to only one is a surface that works in dev and 404s in production
(or the reverse), which nothing catches until you deploy: the scenario tests call
operations directly and never boot either host. What an entrypoint may still own
is only what is genuinely its own — building a host, resolving a caller, and its
own auth-shaped route (`/api/cast` in dev, `/api/me` in the worker).

`provision.ts` is deliberately node-free: both hosts register from it (the dev
server's SQLite host and the worker's `ScopeDO`), and `substrat push` reads the
permission registry from it (package.json `substrat.permissions`). Roles or
modules defined anywhere else will run locally and silently not deploy.
`worker.ts` **mounts** the platform's `/internal/*` management contract via
`mountPlatformSurface` from `@substrat-run/vertical-host` (one call — the routes
and the `{ error }` envelope are authored there, not here, so they can't drift or
ship half-done). What `worker.ts` still owns is **the auth seam** — the dev
`x-principal` header is the only caller resolution until you wire real auth there;
deploying with `ALLOW_DEV_HEADER` set is a cross-tenant hole with a UI.

**A UI ships as declared assets.** If `app/` exists, `substrat.runtimeNeeds.assets` must
point at its build output and `runtimeNeeds.build` must produce it — otherwise the deployed
vertical serves the API and 404s on `/`, with every local gate green. Declare it in the same
change that creates `app/`, not at deploy time. (`substrat push` refuses an undeclared UI,
but by then you are already deploying.)

Among the hooks it passes, **`onConfigure` is the one you must not drop.** It is
how per-instance settings reach the running app: the dashboard's Settings → Env
and Identity tabs POST to `/internal/configure`, and a vertical that supplies no
hook answers **501** to that call for its whole life — the setting is saved, the
dashboard reports `delivered: false`, and the app never sees it. That includes the
`substrat:auth` issuer choice, i.e. the difference between a working login and
401-on-everything. The starter stores deliveries in `config-do.ts` and reads them
back through `resolveScopedEnvSpec` (`instanceConfig`). Read settings that way and
never off `env` directly: an `envSpec` default rides as a worker binding shared by
every install of one serving script, so `env.FOO` is the same string for every
tenant no matter what any of them saved. Declare a setting in **both**
`src/manifest.ts` (`SHOP_ENV`) and package.json `substrat.envSpec` — `substrat
push` reads the JSON, not the TypeScript.

## The rules (non-negotiable)

**Module code** = everything reachable from a `ModuleRegistration` (operations,
consumers). Rules 1–5 are enforced mechanically by `boundary-lint`.

1. **Data access is `ctx.sql` only.** Never import `better-sqlite3`, an adapter,
   `node:*`, or `cloudflare:workers` in module code. That last one is not a style rule:
   it exports an ambient `env`, so a single import hands module code every binding and
   secret your worker declares — including its own `SCOPE` Durable Object namespace,
   which reaches *another scope's* data. `ctx.sql` is closed over one scope and cannot.
   Capabilities arrive on `ctx`; `DurableObject` is imported in harness code
   (`worker.ts`, `*-do.ts`), never here.
2. **No `fetch` / network in module code.** It would hold the scope's transaction open on
   a third party. The sanctioned path is a **connector**: emit a fat event, register a
   handler that runs outside the transaction. An integration is never impossible because
   of this rule — it has an answer.
3. **Never write `_substrat_*` tables.** Reads are fine (timelines are projections);
   writes forge the audit spine.
4. **Another module's tables are private.** Never `SELECT` from `workorder_*` etc. — use
   the engine's exported in-scope functions. This is the rule with no runtime equivalent:
   the shortcut *works* and silently welds you to an engine's private schema forever. Need
   extra data on an engine entity? Add **your own side table keyed by the engine's id** —
   never a column upstream.
5. **Time comes from `ctx.now()`.** Module code has no other clock — `new Date()` and
   `Date.now()` are banned exactly like `node:*`. It is the same instant for the whole
   operation, so your rows and the events announcing them agree about when. Store it as
   ISO text, never an epoch integer. Because the host injects the clock, a scenario can
   test elapsed time (`manualClock` from `@substrat-run/kernel`) instead of sleeping or
   shrinking the window to zero — the workaround that proves nothing.
6. **Every operation checks a permission first.** `assertAllowed(await ctx.check(PERM))`
   is the first line.
7. **Every mutation emits a fat event** — a consumer must never need a cross-module read.
8. **Never fork an engine.** Extend by composition. If you must fork, the engine drew its
   line wrong — that's design feedback, not a coding problem.
9. **IDs are `ulid()`. Money is strings** via `@substrat-run/contracts` helpers
   (`moneyOf`, `mulMoney`, `addDecimal`, `compareDecimal`) — never floats.
10. **Web-standard APIs always** — `globalThis.crypto`, `TextEncoder`, `URL`. Never
    hand-roll a hash to dodge an import ban.
11. **Parse, don't trust.** Zod at every boundary — but import `z` from
    `@substrat-run/contracts`, **never from `zod`**. Zod schemas don't compose across
    copies or majors; composing a contracts schema into one built from a separate `zod`
    fails at *runtime* (`expected a Zod schema`) with an error pointing nowhere near the
    cause.

## Declare every link edge

`entityRelations` in the manifest must declare every edge you traverse — both your own
(`bike → customer`) and the ones an engine makes on your behalf (`workorder → bike`). The
adapter **rejects** a `ctx.link` for an undeclared edge, so a missing one fails loudly.
This is also what lets a portal permission-walk reach the owner.

## The gates — run them, believe them

```sh
npm test                        # the scenario, including the denials
npx @substrat-run/boundary-lint # the layer rules (1–5)
npm run typecheck
```

`boundary-lint` exits non-zero if it *couldn't do its job* (no module code found, no
engines resolvable) — a pass that checked nothing is worse than no linter. Never wave that
through; fix the setup until it can see your code.

A green scenario test does **not** mean the app works: the test calls operations directly
and never exercises `server.ts`, its routes, or the principal picker. Before calling a
vertical done, boot the server and drive the real flow over HTTP as two personas — one who
should succeed and one who should be denied — and confirm the denial arrives as a denial
(not a generic error).

## Two human checkpoints — you may never self-approve

Present these and stop:

1. **Migration diff** — every new `SqlMigration`, verbatim. Migrations are append-only
   forever once shipped, so this is the last cheap moment to change your mind.
2. **Permission diff** — a table: key → description → which roles hold it → why. Walk the
   reviewer through it in their own vocabulary until they can answer *who can now see the
   money, and who can see other tenants' data?* A permission diff nobody understands is
   theater — it reproduces the exact failure Substrat exists to prevent.
