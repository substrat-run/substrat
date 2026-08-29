# Substrat

[![CI](https://github.com/substrat-run/substrat/actions/workflows/ci.yml/badge.svg)](https://github.com/substrat-run/substrat/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@substrat-run/kernel?label=%40substrat-run%2Fkernel)](https://www.npmjs.com/package/@substrat-run/kernel)

**The hard parts, hosted.**

AI made building vertical B2B software fast — except for the parts that were never about
writing code: multi-tenancy, identity, permissions, integrations, data integrity, audit,
GDPR. Substrat is a hosted substrate that owns those parts and enforces them at runtime, so
small teams — including non-engineers wielding AI tools — can build production-grade
vertical SaaS on top.

We build the substrate. You build the verticals.

Documentation lives at **[substrat.net](https://substrat.net)** — start with
[what Substrat is](https://substrat.net/guide/what-is-substrat),
[getting started](https://substrat.net/guide/getting-started) and the
[weekly changelog](https://substrat.net/changelog/).

## The idea in three points

1. **Kernel** — everything true of every B2B SaaS, nothing true of any particular one.
   Identity, nested tenancy, permissions, events/audit, migrations, modules. Owns no domain
   entities; provides `ctx.sql`, `ctx.emit`, `ctx.check`, `ctx.link`, `ctx.grant`.
2. **Engines** — headless domain machinery that owns invariants (state machines that
   cannot skip states, append-only ledgers, immutable-after-export), shared across
   verticals. Engines never import each other; they cooperate through fat events.
3. **Verticals** — the businesses, built at AI speed on rails that make the speed
   survivable: generated code *cannot* cross a tenant boundary, skip the audit log, or
   touch raw credentials, because the guarantees live below the API surface.

## Quick start

```sh
npm create substrat my-app
cd my-app && pnpm install
pnpm test
```

That gives you a small working vertical — a bike-repair shop — green out of the box, with
the instruction layer (`AGENTS.md`, `.substrat/playbook.md`) that Claude Code, Cursor and
opencode read to turn it into your domain. When it is ready to run somewhere:

```sh
npx @substrat-run/cli login      # sign in through the browser
npx @substrat-run/cli push       # build, upload, and (for a private vertical) promote
```

There is no `wrangler.jsonc` to write; the platform holds the only Cloudflare credential.
The full path is in the [deploying guide](https://substrat.net/guide/deploying).

## What is here

Substrat is a pnpm workspace. Everything a vertical imports is published to npm; the
platform's own applications are source-available but not licensed for reuse.

| Path | What | License |
|---|---|---|
| `packages/contracts` | Zod schemas and branded ids — the shared vocabulary, and the source of truth for every emitted artifact | Apache-2.0 |
| `packages/kernel` | The scope-host contract, the tuple permission checker, `ulid`, the read-only SQL gate | AGPL-3.0 + commercial |
| `packages/adapter-sqlite` | Pure-SQLite scope host — local dev, CI, self-host, escrow | AGPL-3.0 + commercial |
| `packages/adapter-cloudflare` | Durable-Object scope host and the durable control plane — production | AGPL-3.0 + commercial |
| `packages/contract-tests` | The suite every adapter must pass unchanged (decision 14) | AGPL-3.0 + commercial |
| `packages/control-plane-api` | HTTP surface over `HostAdmin` — the audited control-plane transport | AGPL-3.0 + commercial |
| `packages/vertical-host` | The `/internal/*` surface and error envelope a hosted vertical mounts | AGPL-3.0 + commercial |
| `packages/vertical-auth` | Pluggable auth for verticals: an `AuthProvider` contract, OIDC, a per-tenant identity store | AGPL-3.0 + commercial |
| `packages/oidc-rp` | OIDC relying party — authorization code + PKCE, workerd-safe | AGPL-3.0 + commercial |
| `packages/cli` | `substrat` — login, push, promote, versions, scope tools | Apache-2.0 |
| `packages/create-substrat` | `npm create substrat` — the scaffolder | Apache-2.0 |
| `packages/boundary-lint` | The layer rules (R1–R7) as static analysis, runnable outside this repo | Apache-2.0 |
| `packages/model-emit` | Build-time tooling over a declared model — DDL, migrations, the client | Apache-2.0 |
| `packages/psl`, `packages/dev-issuer` | The public suffix list behind the domain guards; a local OIDC provider for dev | AGPL-3.0 + commercial |
| `engines/*` | `workorder`, `invoicing`, `protocol`, `booking`, `invites`, `absence`, `metering` | AGPL-3.0 + commercial |
| `connectors/*` | `scrive` — e-signature (Swedish BankID) over the connector runtime | AGPL-3.0 + commercial |
| `demos/*` | Reference verticals (below) | Apache-2.0, not published |
| `apps/*` | The control plane, router, dashboard, console, builder studio and docs site | source-available, no grant |

Engines are extracted at the second vertical that needs them, never designed ahead, and
their surfaces evolve additively only; the rules a module must follow are in
[`CLAUDE.md`](CLAUDE.md) and enforced by `tools/boundary-lint.mjs`.

## Demos

Nine reference verticals, each the same kernel under a different shape of app. They run
locally on SQLite and deploy unchanged to Cloudflare; several are installable from the
hosted marketplace.

- **[Callout](demos/callout/)** — field service: work orders, time and material,
  self-inspection protocols, invoice basis. The engine-composing reference, and the first
  vertical that went through `substrat push`.
- **[Todo](demos/todo/)** — the smallest vertical that is still a real one: shared lists,
  per-list sharing by email, revoke. The reference for user-initiated sharing
  (`ctx.grant` / `ctx.revoke`) and for a screen that tells a 403 from an empty list.
- **[Meridian](demos/meridian/)** — HR: leave, project time, expenses, onboarding, and an
  employment contract issued as a signed document through the protocol engine and the
  Scrive connector. The shape-breaker that fits no ready-made engine.
- **[Manyfold](demos/manyfold/)** — a multi-scope headless CMS where a site is a scope:
  an editorial lifecycle that cannot skip states, content types authored as data that
  compile to reviewable migrations.
- **[ticket0](demos/ticket0/)** — an AI-assisted support desk: an embeddable chat widget,
  an inbox that receives real email, an assistant that answers from your docs, tokens
  metered per tenant.
- **[Kallkälla Kaffe](demos/shop/)** — e-commerce: catalog, cart, stock, discounts,
  orders; a customer storefront and a staff back-office over one API.
- **[RallyPoint](demos/rally/)** — racket-club booking on the booking engine, and the
  end-to-end walk of invites.
- **[Handlebar](demos/handlebar/)** — Callout's engines re-vocabularied to a bike
  workshop; what `npm create substrat` scaffolds is a smaller cousin.
- **[Auth Server](demos/auth-server/)** — a standalone OIDC issuer you can host and point
  any application at, inside Substrat or outside it.

Each demo carries a `spec/concept.md` (the design it was built from), a `PERMISSIONS.md`
(its permission surface, regenerated by CI) and one scenario test.

## Status

Pre-1.0 (`0.92.x` for the kernel group). Interfaces change without a deprecation window
until the first vertical ships; the [changelog](https://substrat.net/changelog/) says so
plainly each week. What exists and runs:

- **Two adapters, one contract.** Every kernel guarantee ships with a Cloudflare adapter
  and a pure-SQLite one, and the contract suite is what keeps them the same.
- **A hosted platform.** A vertical deploys with `substrat push` into a dispatch
  namespace; a router resolves hostnames to scopes; a control plane owns tenants, scopes,
  entitlements and the admin log; a tenant-facing dashboard handles sign-up, teams,
  installs, snapshots, custom domains and deployments.
- **Permissions evaluated in-scope.** A hosted vertical checks permissions from its own
  storage, fail-closed, with the control plane as a write-time authority — nothing on the
  request path reaches across a tenant boundary.
- **Snapshots and previews.** Migrations are forward-only, so an upgrade snapshots first,
  a test copy gets its own hostname and a TTL, and a scope can be pulled to a laptop as a
  masked SQLite file.
- **Connectors.** Per-tenant provider credentials sealed at rest, at-least-once outbound
  delivery with retry and dead-letter, and a connection that writes back as its own
  permission subject.
- **A generated surface.** Each vertical declares its model once; entities, operations,
  permissions, migrations, an OpenAPI document and a typed browser client are emitted from
  it and gated in CI.

## Working in the repo

```sh
pnpm install
pnpm build            # everything except the builder's scratch projects
pnpm typecheck
pnpm test             # builds first
node tools/boundary-lint.mjs
```

Beyond tests, the repo is held together by re-emit gates: a generated file is only
generated if CI re-emits it with `--check`. `pnpm lint:permissions`, `lint:model`,
`lint:api`, `lint:client`, `lint:migrations`, `lint:decisions`, `lint:docs`,
`lint:changelog` and their siblings all follow that rule; `CLAUDE.md` lists them. Two
things are never self-approved: a migration diff and a permission diff — CI going red is
what makes a human read them.

To run a demo: `pnpm callout-demo dev` (issuer, API and web on a private port block), or
`pnpm todo-demo dev`. To run the whole platform locally on one SQLite directory:
`pnpm dev`.

## Documentation

**[substrat.net](https://substrat.net)** is the manual: guides, concepts, the engine and
connector catalogs, the platform surfaces (control plane, console, router, dashboard),
package references, and the weekly changelog. It is built from [`apps/docs`](apps/docs).

**[`docs/`](docs/README.md)** is the decision record — it answers *why*:

- [`docs/master-plan.md`](docs/master-plan.md) — thesis, market, commercial structure,
  risks, open questions. The canonical plan; everything else derives from it.
- [`docs/architecture/`](docs/architecture/) — how shipped parts work, present tense:
  [kernel design](docs/architecture/kernel-design.md), the control plane, scope-local
  permissions, self-serve deploy, snapshots, connections, sub-transactions, the error
  model.
- [`docs/decisions/`](docs/decisions/) — one file per decision, a hundred and counting,
  indexed in [`DECISIONS.md`](docs/DECISIONS.md).
- [`docs/engines/`](docs/engines/) — one spec per engine.
- [`docs/rfc/`](docs/rfc/) — proposals not yet agreed; [`docs/strategy/`](docs/strategy/)
  — positioning, pricing, candidate verticals; [`docs/research/`](docs/research/) — dated
  snapshots of the outside world, including the
  [platform landscape](docs/research/platform-landscape-drilldown.md) that explains why
  Substrat is a kernel and not an Odoo-class platform.
- [`docs/acceptance/`](docs/acceptance/) — the "can an agent build a vertical unaided?"
  runs, retired as a practice (decision 57) and kept as evidence.

## Licensing

Dual-licensed. The interface you import — `contracts`, the CLI, the scaffolder, the
linter, and every demo — is Apache-2.0, so building on Substrat can never copyleft-capture
your application. The substrate — kernel, adapters, contract tests, control-plane API,
engines, connectors — is AGPL-3.0-only with a commercial licence available, which is what
makes self-hosting and escrow real. The platform applications under `apps/` are
source-available with no grant: readable so you can inspect the surfaces that operate your
data, and nothing more. Details and the reasoning in [LICENSING.md](LICENSING.md).
