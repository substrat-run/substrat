# Substrat — agent conventions

Substrat is a hosted substrate for vertical business software: a multi-tenant kernel
(tenancy, permissions, events, migrations) + headless **engines** owning invariants +
**verticals** owning everything a user touches. Canonical docs: [docs/master-plan.md](docs/master-plan.md)
(strategy, decision log) and [docs/design/kernel-design.md](docs/design/kernel-design.md) (architecture).

## Layout

| Path | What | Published |
|---|---|---|
| `packages/contracts` | Zod schemas + branded IDs — the shared vocabulary | Apache-2.0 |
| `packages/kernel` | Scope-host contract, permission checker, ulid | AGPL + commercial |
| `packages/adapter-sqlite` | Pure-SQLite scope host (dev, CI, self-host, escrow) | AGPL + commercial |
| `packages/contract-tests` | Suites every adapter must pass | AGPL + commercial |
| `packages/control-plane-api` | HTTP surface over `HostAdmin` — the audited control-plane transport | AGPL + commercial |
| `engines/*` | Domain engines (workorder, invoicing) | AGPL + commercial |
| `connectors/*` | Third-party capability connectors (D-18 bucket 3) — host code, never module code | AGPL + commercial; unpublished while incomplete |
| `demos/*` | Demo verticals (Callout = `demos/callout`) | Apache-2.0, not published to npm |
| `apps/router` | The environment-wide router — hostname → (tenant, scope, surface), then dispatch | private |
| `apps/console` | Control-plane admin console (tenants, fleet, admin log, permissions) | private |
| `apps/docs` | Docs site | private |

## Commands

- `pnpm install` · `pnpm -r build` · `pnpm -r typecheck` · `pnpm test` (builds first)
- `node tools/boundary-lint.mjs` — the layer rules below, enforced mechanically (runs in CI)
- `pnpm lint:permissions` — emit each vertical's `PERMISSIONS.md` (the permission-diff
  checkpoint below); CI runs it with `--check` and fails on drift
- `pnpm callout-demo dev` — run the Callout demo (API :8871 + web :5271). Demo dev
  ports live in a private `887x`/`527x` block to stay clear of the Vite (5173) and
  Wrangler (8787) defaults; `PORT=… WEB_PORT=… ` overrides both ends of the proxy.
- `pnpm --filter @substrat-run/demo-shop dev` — the shop demo runs **three** processes:
  API :8873, storefront :5273, back-office :5274 (`ADMIN_PORT=…`). Customer-facing and
  staff-facing surfaces are separate Vite apps against one API — the split is chrome and
  audience, never a second source of truth. Both origins must be trusted by Better Auth.
- One vitest scenario per demo vertical: `pnpm --filter @substrat-run/demo-callout test`
- `pnpm --filter @substrat-run/docs cf:deploy` — build + ship the docs site to
  [substrat.net](https://substrat.net) (Cloudflare Pages). Every deployable
  workspace uses the `cf:deploy` script name (dashboard, control-plane, router, docs, demos) —
  chosen over `deploy` so `pnpm cf:deploy` never collides with pnpm's built-in `deploy` command.

## The three-layer rule (never violated)

1. **Kernel owns no domain entities.** It provides `OperationContext` (`ctx.sql`,
   `ctx.emit`, `ctx.check`, `ctx.link`), scope provisioning, roles/grants, migrations.
2. **Engines own invariants**: state machines that can't skip states, append-only
   entries, immutable-after-export, every mutation emits an event, every operation
   checks a permission. Engines never import other engines (**star topology**) —
   they cooperate via fat event payloads and opaque `EntityRef`s only.
3. **Verticals own vocabulary, pricing, screens, roles.** A vertical composes engine
   **in-scope functions** (plain exports like `createWorkOrder(ctx, …)`) inside its own
   operations — same transaction — and does the permission check itself. If a vertical
   needs to fork an engine, the engine drew its line wrong.

## Module code rules (mechanically linted)

Module code = everything reachable from a `ModuleRegistration` (operations, consumers).

- Data access is `ctx.sql` **only** — never import `better-sqlite3`, adapters, or
  `node:*` in module code. Harness code (`seed.ts`, `server.ts`, tests) is exempt.
- No `fetch`/network in module code; connectors handle the outside world.
- Never write to `_substrat_*` tables (reads for projections like timelines are fine —
  writes forge the spine).
- Every operation's first line: `assertAllowed(await ctx.check(PERM))`; per-entity
  checks (`ctx.check(perm, entityRef)`) for portal-style walks.
- Every mutation emits a **fat** event (consumer must never need a cross-module read);
  payload validated by the consumer's own Zod parse, never the producer's types.
- Migrations are append-only ordered `SqlMigration[]`; never edit a shipped version.
- Another module's tables are **private** — never reference them in SQL (decision 28).
  Engine data is reached through the engine's exported in-scope functions; the stable
  surface is entity ids, `EntityRef`s, and event payloads. A vertical needing extra data
  on an engine entity adds its **own side table keyed by the engine's id** — never a
  column upstream. One-time extraction handoffs use an explicit
  `boundary-lint-allow R5` … `boundary-lint-end R5` comment block (reviewable escape hatch).
- Engine operations are thin: the permission check + one exported in-scope function.
  All engine logic lives in composable exports so verticals extend by composition, never fork.
- Engine surfaces evolve **additively only**: new operation inputs are optional with
  behavior-preserving defaults; emitted event payload fields are frozen once shipped —
  rename/remove/retype means a `schemaVersion` bump (dual-emit through a deprecation
  window); permission keys are never renamed.
- IDs come from `ulid()`; money/decimals are strings via `@substrat-run/contracts`
  helpers (`moneyOf`, `mulMoney`, `addDecimal`, `compareDecimal`) — never floats.
- Web-standard APIs always, node-only imports never: hashing/crypto is
  `globalThis.crypto` (Web Crypto — same API in Node, Workers, browsers), encoding is
  `TextEncoder`/`TextDecoder`, URLs are `URL`. Never hand-roll a hash to dodge an
  import ban. (Harness code may use `node:fs` etc. for genuinely node-only needs.)
- Parse, don't trust: operation inputs go through Zod schemas at the boundary.

## Two human checkpoints (agents never self-approve)

1. **Migration diff** — new/changed `SqlMigration[]` presented for review before merge.
2. **Permission diff** — new permission keys and role definitions presented as a readable
   table (key → description → which roles hold it). This one has a **mechanical home**:
   each vertical exports `MODULES` + `ROLES` from its seed, and `pnpm lint:permissions`
   renders `demos/*/PERMISSIONS.md` from those same objects. The file is checked in and CI
   re-emits with `--check`, so a widened role cannot merge without appearing in the PR diff.
   Entity-narrowed **grants** are per-principal and ULID-keyed, so only their declared
   *shapes* (`ENTITY_GRANTS`) are in the artifact — the grants themselves are a runtime
   console concern (control-plane.md §4.5).

Both are still a *human* reading a diff. CI going red is what makes the reading unskippable;
it is not itself the approval.

Everything else the platform pushes back on mechanically: the typed SDK rejects invalid
states at compile time, `tools/boundary-lint.mjs` blocks raw access, contract tests and
the demo scenarios fail fast.

## Building a new vertical

Two phases, in order. **Design** with the **substrat** skill
(`.claude/skills/substrat/SKILL.md`): interview the user, map the domain onto the engines,
and land a reviewable `DESIGN.md` / `spec/concept.md` the user approves *before any code*.
Then **build** with the **new-vertical** skill (`.claude/skills/new-vertical/SKILL.md`),
which turns that approved design into a working vertical. Reference implementation:
`demos/callout` (spec in `demos/callout/spec/`, module in `src/module.ts`, world in
`src/seed.ts`, scenario test in `test/scenario.test.ts`).
