# Substrat — agent conventions

Substrat is a hosted substrate for vertical business software: a multi-tenant kernel
(tenancy, permissions, events, migrations) + headless **engines** owning invariants +
**verticals** owning everything a user touches. Canonical docs: [docs/master-plan.md](docs/master-plan.md)
(strategy, decision log) and [docs/architecture/kernel-design.md](docs/architecture/kernel-design.md) (architecture).

## Layout

| Path | What | Published |
|---|---|---|
| `packages/contracts` | Zod schemas + branded IDs — the shared vocabulary | Apache-2.0 |
| `packages/kernel` | Scope-host contract, permission checker, ulid | AGPL + commercial |
| `packages/adapter-sqlite` | Pure-SQLite scope host (dev, CI, self-host, escrow) | AGPL + commercial |
| `packages/contract-tests` | Suites every adapter must pass | AGPL + commercial |
| `packages/control-plane-api` | HTTP surface over `HostAdmin` — the audited control-plane transport | AGPL + commercial |
| `packages/dev-issuer` | A real local OIDC provider you sign into by picking a name — so a vertical needs no dev auth branch | unpublished (dev only; its signing key is checked in) |
| `engines/*` | Domain engines (workorder, invoicing) | AGPL + commercial |
| `connectors/*` | Third-party capability connectors (D-18 bucket 3) — host code, never module code | AGPL + commercial; unpublished while incomplete |
| `demos/*` | Demo verticals (Callout = `demos/callout`) | Apache-2.0, not published to npm |
| `apps/router` | The environment-wide router — hostname → (tenant, scope, surface), then dispatch | private |
| `apps/console` | Control-plane admin console (tenants, fleet, admin log, permissions) | private |
| `apps/docs` | Docs site | private |

## Commands

- `pnpm install` · `pnpm build` · `pnpm typecheck` · `pnpm test` (builds first) — the root
  scripts, not `pnpm -r …` directly: they exclude `.builder/projects/**`, the gitignored
  builder-studio scratch projects that are also workspace members. A half-built one
  otherwise reddens repo-wide gates and blocks every push (#769).
- `node tools/boundary-lint.mjs` — the layer rules below, enforced mechanically (runs in CI)
- `pnpm lint:permissions` — emit each vertical's `PERMISSIONS.md` (the permission-diff
  checkpoint below); CI runs it with `--check` and fails on drift
- `pnpm lint:changelog` — the published weekly changelog (`apps/docs/changelog/`).
  With no flag it prints a week's raw material — every first-parent merge grouped by
  area, the commits that landed without a PR, and each package's version span
  (`--week 2026-w34` for a named week). With `--check`, CI asserts **completeness**:
  every merge inside an entry's declared `range` is cited somewhere on its page. The
  prose is authored, not generated, and deliberately carries none of the three marks
  below — no producer could re-emit a digest. What rots invisibly is coverage, and
  that is what the gate holds. Written each Monday by the `weekly-changelog` skill,
  which opens a PR and never merges it. Needs real history, so the CI checkout is
  `fetch-depth: 0` and the check refuses to run on a shallow clone.
- `pnpm lint:scaffold` — the scaffold checkpoint (#797): `npm create substrat` at the
  published version, `npm install` from the registry with no workspace links, then the
  three gates a scaffolded project ships with. `packages/create-substrat/template` is
  **not** a workspace member — deliberately, since its job is to prove an npm install
  works. Runs post-release and weekly (`.github/workflows/scaffold.yml`), never on a
  PR: between a merge that adds a surface and the release that publishes it, the
  template legitimately runs ahead of npm. `--from=local` checks this checkout's
  template instead of the published one.
- **The template is compiled on every PR too** (#878), against the **workspace** rather
  than the registry: `tools/template-sync.mjs` materializes it into
  `packages/template-check`, a member that owns the `workspace:*` links, and
  `pnpm -r typecheck`, `pnpm -r test` and `node tools/boundary-lint.mjs` all reach it
  with no new command to remember. This is the gate that makes a **non-additive engine
  surface** red in its own PR: the template is a call site of every engine it imports,
  and it used to be the only one the compiler never saw — so #811's paged `listOrders`
  was merged, released, and reached `npm create substrat` failing all three of the
  gates a scaffold ships with. Registry-vs-workspace is the whole distinction: being
  ahead of npm is a pass here and a legitimate red there.
- `pnpm callout-demo dev` — run the Callout demo (issuer :8879 + API :8871 + web :5271).
  Demo dev ports live in a private `887x`/`527x` block to stay clear of the Vite (5173) and
  Wrangler (8787) defaults; `PORT=… WEB_PORT=… ISSUER_PORT=…` overrides all three. The Vite
  proxy must NOT set `changeOrigin`: the API derives its OIDC `redirect_uri` from the
  forwarded Host header, and rewriting it sends the login callback to the wrong port.
- **Callout, Meridian, Manyfold and Todo have no dev auth branch.** Their `… dev` scripts
  start `packages/dev-issuer` — a real OIDC provider whose only shortcut is that
  `/authorize` lists names instead of asking for a password — so the local login IS the
  production round-trip and changing issuer is a change of `OIDC_ISSUER`. Each vertical's
  cast lives in its own `src/personas.ts`, read both by the issuer and by its seed, which
  links each `sub` to a principal in the identity directory. Impersonation for scripts is
  `POST {issuer}/dev/token {sub}` — in the issuer, never in the vertical. The Vite proxy in
  front of a demo must NOT set `changeOrigin`: the API derives its OIDC `redirect_uri` from
  the forwarded Host header, and rewriting it sends the callback to the wrong port.
  `ALLOW_DEV_NODE` still exists in the workers and is a different thing — it addresses an
  un-routed local instance and authenticates nobody.
- **Callout, Meridian and Manyfold are OIDC-only** (`docs/architecture/oidc-only-demos.md`):
  they run no credential store — login/sign-up/password/reset live at the OIDC issuer, and
  the vertical only maps the authenticated `sub` → a scope principal (owner-claim + invites
  in the per-tenant `IdentityDO`). `demos/auth-server` is the full Better Auth issuer for
  exercising real accounts; **rally, handlebar and shop still run Better Auth**, and rally
  and handlebar still carry `ALLOW_DEV_HEADER` (see oidc-only-demos.md for why).
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

- Data access is `ctx.sql` **only** — never import `better-sqlite3`, adapters, `node:*`,
  or `cloudflare:workers` in module code. Harness code (`seed.ts`, `server.ts`, tests) is
  exempt. `cloudflare:workers` exports an ambient `env`: one import gives module code every
  binding and secret the script declares, including its own `SCOPE` DO namespace — which
  reaches another scope's data, where `ctx.sql` cannot. Capabilities come from `ctx`.
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
- An engine is composed **by call** or **by event**, and that decides its shape.
  - **By call** (workorder, protocol, booking): operations are thin — the permission
    check + one exported in-scope function. All logic lives in composable exports, so a
    vertical wraps it inside its own transaction and extends by composition, never forks.
  - **By event** (invoicing): the vertical *emits*, the engine consumes, and the vertical
    reads the result back through the engine's own operations or by consuming its events
    (side table keyed by the engine's id, per decision 28). There are deliberately **no
    in-scope exports** — the engine is the only writer of its rows, which is what keeps
    invariants like immutable-after-export safe from a half-finished caller.
  Which mode an engine is, is a fact about its exports; state it in the engine's header
  so an absence reads as intent rather than an omission.
- **Catching an engine error requires `ctx.atomic`** (#770, `docs/rfc/sub-transactions.md`).
  An engine call composed inside your transaction has no boundary of its own, so a bare
  `catch` leaves you holding its partial writes — the rows its invariants were protecting —
  and commits them. Wrap it instead:

  ```ts
  try {
    await ctx.atomic(() => completeWorkOrder(ctx, { orderId, billable }));
  } catch {
    // the engine's rows, events, links, grants and platform intents are all gone;
    // your own writes survive, and it still commits once
  }
  ```

  A succeeded `atomic` is still **provisional**: if the operation later throws, its writes
  go too. Sub-transactions nest but must not interleave — starting two concurrently throws.
  Outside `ctx.atomic`, catching an engine error stays forbidden.
- Engine surfaces evolve **additively only**: new operation inputs are optional with
  behavior-preserving defaults; emitted event payload fields are frozen once shipped —
  rename/remove/retype means a `schemaVersion` bump (dual-emit through a deprecation
  window); permission keys are never renamed.
- IDs come from `ulid()`; money/decimals are strings via `@substrat-run/contracts`
  helpers (`moneyOf`, `mulMoney`, `addDecimal`, `compareDecimal`) — never floats.
- **Time comes from `ctx.now()`** — module code has no other clock, and `new Date()` /
  `Date.now()` are boundary-lint **R6** violations (the same class of ban as `node:*`).
  It is stable for the whole invocation, so rows and the events announcing them agree
  about when. Timestamps are stored as **ISO 8601 text**, never epoch integers. A host
  takes a `clock`, so a scenario asserts elapsed time with `manualClock`/`frozenClock`
  instead of sleeping or shrinking the window to zero. Code that must read the *real*
  clock — a JWT whose `exp` a remote server judges — opts out with a reviewable
  `boundary-lint-allow R6` … `boundary-lint-end R6` block.
- Web-standard APIs always, node-only imports never: hashing/crypto is
  `globalThis.crypto` (Web Crypto — same API in Node, Workers, browsers), encoding is
  `TextEncoder`/`TextDecoder`, URLs are `URL`. Never hand-roll a hash to dodge an
  import ban. (Harness code may use `node:fs` etc. for genuinely node-only needs.)
- Parse, don't trust: operation inputs go through Zod schemas at the boundary — and the
  **host** is what applies them. A module passes `operationInputs: operationInputsOf(ops)`
  beside its `operations`, and every invocation is parsed before the guards and the handler,
  on every path in (HTTP, test, seed, schedule). Handlers do not hand-parse; a declared
  input that nobody parses is no longer possible rather than merely discouraged.

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

## Generated files carry three marks, or they are not generated

A file derived from something else in the repo is worth nothing if a reader cannot tell
it apart from one a person maintains — and worth less than nothing if it *says* it is
generated while nothing re-emits it. So a generated file has all three of:

1. **The `.generated.ts` suffix** (or, for a document, a `<!-- GENERATED … -->` first
   line). The filename is the signal a reviewer reads in a PR diff without opening it.
2. **A header naming the producer and the source** — `GENERATED by tools/client-emit.mts
   from spec/model.ts — do not edit by hand.`
3. **A `--check` re-emit in CI.** This is the only one that enforces anything. "Do not
   edit" is a request; the gate is what makes it true. `src/migrations.generated.ts` had
   the comment for a year and no gate, so a hand-edit to shipped SQL passed every check
   in the repo.

The gates today: `lint:permissions`, `lint:model`, `lint:api`, `lint:client`,
`lint:conformance`, `lint:migrations`, plus `lint:decisions`, `lint:playbook`, `lint:docs`,
`lint:llms`, `lint:agent-rules`, `lint:launch`, `lint:plugin`, `lint:pins`,
`lint:connector-grants`.

**The one exception, stated rather than hidden:** a file generated from a *remote* source
cannot be re-emitted hermetically in CI, so it gets marks 1 and 2 plus a `GENERATED_AT`
stamp instead of mark 3 — `apps/builder/src/rate-card.generated.ts` (models.dev),
`packages/psl/src/data.ts` (the public suffix list). Never invent a fourth category;
an in-repo source with no gate is a defect, not a style.

**A vertical's browser client is generated** (`substrat.client` in its package.json →
`app/src/api.generated.ts`). Every fact in it — the entity interfaces, the paths and
methods, the request bodies, the paged `Link` walk — is already in `spec/model.ts`. What
stays hand-written beside it is only what the model does not declare: which principal a
request is made as, and the error envelope the vertical picked in its own `app.onError`.

## Building a new vertical

Two phases, in order. **Design** with the **substrat** skill
(`.claude/skills/substrat/SKILL.md`): interview the user, map the domain onto the engines,
and land a reviewable `spec/concept.md` the user approves *before any code*.
Then **build** with the **new-vertical** skill (`.claude/skills/new-vertical/SKILL.md`),
which turns that approved design into a working vertical. Reference implementation:
`demos/callout` (spec in `demos/callout/spec/`, **declared model in `src/entities.ts` +
`src/operations.ts`**, module in `src/module.ts`, world in `src/seed.ts`, scenario test in
`test/scenario.test.ts`).

A vertical declares **what exists** — entities, operations, permissions — in one typed
module, and the compiler checks the joins between them: a parent naming no entity, an
`entityIdFrom` naming no output field, a payload carrying an `erasable` field are compile
errors. `pnpm lint:model --check` gates the emitted `model.json`, as `lint:permissions` gates
the permission surface. See `apps/docs/concepts/model.md` (published at
[substrat.net/concepts/model](https://substrat.net/concepts/model)).
