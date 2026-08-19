# Substrat

[![CI](https://github.com/substrat-run/substrat/actions/workflows/ci.yml/badge.svg)](https://github.com/substrat-run/substrat/actions/workflows/ci.yml)

**The hard parts, hosted.**

AI made building vertical B2B software fast — except for the parts that were never about
writing code: multi-tenancy, identity, permissions, integrations, data integrity, audit,
GDPR. Substrat is a hosted substrate that owns those parts and enforces them at runtime, so
small teams — including non-engineers wielding AI tools — can build production-grade
vertical SaaS on top.

We build the substrate. You build the verticals.

## The idea in three points

1. **Kernel** — everything true of every B2B SaaS, nothing true of any particular one.
   Identity, nested tenancy, permissions, documents, integrations, events/audit/reporting,
   modules. Owns no domain entities.
2. **Engines** — shared domain machinery (work orders, ticketing, protocols, scheduling)
   that owns invariants, while verticals own vocabulary, workflows, and UI.
3. **Verticals** — the businesses, built at AI speed on rails that make the speed
   survivable: generated code *cannot* cross a tenant boundary, skip the audit log, or
   touch raw credentials, because the guarantees live below the API surface.

## Status

Working end to end. The kernel and its contracts are real code with a conformance suite,
and a full demo vertical runs on **two adapters** — locally on pure SQLite and **deployed
on Cloudflare** (Durable Objects + D1) behind Better Auth, from one shared codebase.

- **Contracts & kernel** — `@substrat-run/contracts` (Zod contracts, the source of truth)
  and `@substrat-run/kernel` (the scope-host contract + the tuple permission checker).
- **Adapters** — `@substrat-run/adapter-sqlite` (pure-SQLite scope host; local dev, CI,
  self-host) and `@substrat-run/adapter-cloudflare` (Durable-Object scope host + a durable
  control plane; production). `@substrat-run/contract-tests` is the suite both must pass
  **unchanged** — the two-adapter discipline (decision 14).
- **Engines** — `engine-workorder`, `engine-invoicing`, `engine-protocol`: headless domain
  machinery that owns invariants, shared across verticals.
- **Verticals** — the demos below.

Run `pnpm install && pnpm test`.

## Demos

Reference verticals — the same vertical code on the kernel, proving the guarantees hold
(and, for Callout, that a vertical deploys unchanged from local SQLite to Cloudflare):

- **[Callout — field service](demos/callout/README.md)** — the flagship. A Swedish
  service/installation firm: work orders, time/material reporting, self-inspection protocols,
  invoice basis. Runs on pure SQLite locally **and deployed on Cloudflare** (Durable
  Objects + D1) behind Better Auth, from one shared route table + auth seam — only the
  adapter beneath differs. Architecture and request-flow diagrams in its README.
- **[Kallkälla Kaffe — e-commerce](demos/shop/)** — an online coffee roaster (catalog,
  cart, stock, discounts, orders) with Better Auth logins; proves the attachment contracts
  aren't field-service-shaped.
- **[Handlebar — bike shop](demos/handlebar/)** — an agent-scaffolded vertical (the same
  engines re-vocabularied to a bike workshop), from [acceptance run 001](docs/acceptance/agent-loop-001.md).

## Documentation

The canonical planning document is [docs/master-plan.md](docs/master-plan.md) —
thesis, architecture decisions, market landscape, concrete cases, commercial structure,
risks, open questions, and the decision log. Everything else derives from it.

The technical shape of those decisions — contracts, data models, lifecycles — lives in
[docs/architecture/kernel-design.md](docs/architecture/kernel-design.md).

Research feeding both:

- [docs/research/platform-landscape-drilldown.md](docs/research/platform-landscape-drilldown.md) —
  how the platform-with-modules incumbents (Odoo, SAP, Salesforce) and kernel-shaped
  foundations (Medusa, Supabase) handle extension, upgrades, and tenancy; why Substrat is
  a kernel, not an Odoo-class platform; and the lesson ledger mapping incumbent scar
  tissue to design decisions.
- [docs/research/fsm-vendor-feature-survey.md](docs/research/fsm-vendor-feature-survey.md) —
  feature survey of the Swedish/Nordic field-service-management market the first engines
  compete against.

Acceptance runs — the "can an agent build a vertical unaided up to the human checkpoints?"
benchmark, **retired as a standing practice (D-57)** and kept as evidence; open question 15
was found by run 007:

- [docs/acceptance/agent-loop-001.md](docs/acceptance/agent-loop-001.md) — run 001,
  Handlebar (2026-07-14): PASS, with notes.