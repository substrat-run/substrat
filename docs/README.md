---
status: canonical
layer: plan
description: The map of this directory. Hand-written today; should be generated.
---

# `docs/` — the decision record

**This directory answers *why*. [`apps/docs/`](../apps/docs) answers *what*.**

`docs/` is where decisions are argued and recorded: the master plan, the kernel design, the
RFCs behind them, and the research and acceptance runs that fed them. It is written for
whoever has to change the platform, and it keeps the reasoning — including rejected
alternatives — that a working system no longer shows.

`apps/docs/` is the manual, published to [substrat.net](https://substrat.net). It describes
a working system to someone using it, and carries no history.

Both should exist. Nothing belongs in both.

## Where to write a thing

| You are writing… | It goes… |
|---|---|
| a proposal for a change nobody has agreed to yet | `design/`, `status: proposed` |
| the record of a decision, once made | a new file in [`decisions/`](decisions/) — never a table row by hand |
| a description of how the platform works today | `apps/docs/` |
| a dated snapshot of the outside world | `research/`, `status: historical` |
| the result of an acceptance run | `acceptance/`, `status: historical` |
| a brief to hand to a design tool or an agent | `design/`, and expect it to become `historical` |

## Status vocabulary

Every file carries frontmatter. `status` is one of:

| value | meaning |
|---|---|
| `canonical` | a living reference, continuously updated — the plan, the kernel design |
| `proposed` | argued, not agreed |
| `building` | agreed and in flight |
| `built` | shipped; the document describes something that exists |
| `superseded` | replaced — carries `superseded-by` |
| `historical` | a dated record, never revised (research, acceptance, consumed briefs) |

There is deliberately **no `updated:` field**. Git knows when a file changed, and a
hand-kept date is a field that exists only to go wrong — five of them were wrong when this
index was written.

## Known gaps

These are recorded rather than fixed, and are tracked in
[proposals/docs-restructure.md](proposals/docs-restructure.md):

- **Eleven entries were written late.** The Phase-2 split found decisions that had shipped
  but were never logged: the TypeScript-derived permission registry (D-47 — its own draft
  had claimed the already-taken number 41), builder-studio's nine (D-48…D-56) and kernel
  open question 11 (K-38). Transcribed from their authors' text and ratified 2026-08-19.
- **`design/commerce-gaps.md` §6.1 is out of date.** It says engines have no tests and
  there is no engine analogue of `contract-tests`; all seven engines now have test scripts
  and `packages/engine-test-kit` exists. The rest of the document still reads true.
- **`engines/{workorder,invoicing,invites}` have no design doc** — the three oldest and
  most-composed engines. Coverage runs inverse to maturity.
- **Kernel open question 16 has passed its own deadline.** It says decide before a third
  party consumes an engine event; all seven engines are on public npm.
  ([#128](https://github.com/substrat-run/substrat/issues/128))
- **Nothing describes what is true *now* at architecture level** — only what was decided
  (the logs) and what was proposed (these documents).

## The decision log

[`DECISIONS.md`](DECISIONS.md) is the whole log — 94 entries, both layers, oldest first —
generated from [`decisions/`](decisions/), one file per decision. The tables in master plan
§12 and kernel design §14 are generated from the same source and must not be hand-edited.

```
pnpm lint:decisions            # regenerate
pnpm lint:decisions --check    # CI: fail if any generated table is stale
```

`D-*` are plan-layer, `K-*` kernel-layer. The two id vocabularies are historical: one log,
ids never reused. See [proposals/docs-restructure.md](proposals/docs-restructure.md) §7.

## Index


### Root — strategy

| document | status | |
|---|---|---|
| [candidate-verticals.md](candidate-verticals.md) | `canonical` | Living catalog of application categories. Falsifies the engine set; not a roadmap. |
| [master-plan.md](master-plan.md) | `canonical` | Strategy, architecture decisions, and the D log. Canonical; everything else derives. |
| [why-substrat.md](why-substrat.md) | `canonical` | The honest positioning source. Feeds four published pages; not itself published. |

### `acceptance/` — agent-loop runs, append-only

| document | status | |
|---|---|---|
| [agent-loop-001.md](acceptance/agent-loop-001.md) | `historical` | Agent-loop acceptance run 001. |
| [agent-loop-002.md](acceptance/agent-loop-002.md) | `historical` | Agent-loop acceptance run 002. |
| [agent-loop-003.md](acceptance/agent-loop-003.md) | `historical` | Agent-loop acceptance run 003. |
| [agent-loop-004.md](acceptance/agent-loop-004.md) | `historical` | Agent-loop acceptance run 004. |
| [agent-loop-005.md](acceptance/agent-loop-005.md) | `historical` | Agent-loop acceptance run 005. |
| [agent-loop-006.md](acceptance/agent-loop-006.md) | `historical` | Agent-loop acceptance run 006. |
| [agent-loop-007.md](acceptance/agent-loop-007.md) | `historical` | Agent-loop acceptance run 007. |
| [agent-loop-008.md](acceptance/agent-loop-008.md) | `historical` | Agent-loop acceptance run 008. |

### `design/`

| document | status | |
|---|---|---|
| [agent-surface.md](design/agent-surface.md) | `building` | How any agent discovers and works with Substrat. #749 open. |
| [api-surface.md](design/api-surface.md) | `built` | Every vertical serves its own OpenAPI; Scalar renders it. |
| [booking-social.md](design/booking-social.md) | `building` | Booking engine shipped; the cross-tenant social tier is not. |
| [builder-harness.md](design/builder-harness.md) | `building` | Model catalog and harness efficiency. Rows 6-7 open (#663). |
| [builder-plane.md](design/builder-plane.md) | `built` | Tenant-owned verticals, self-serve. |
| [builder-studio.md](design/builder-studio.md) | `built` | Chat to vertical, hosted. NOTE: proposes D-47..D-55, none landed. |
| [cms-content.md](design/cms-content.md) | `built` | Content types that compile to reviewed migrations. |
| [commerce-gaps.md](design/commerce-gaps.md) | `historical` | Commerce capability gap walk, 2026-07-17. See NOTE in docs/README.md. |
| [commercial-model.md](design/commercial-model.md) | `proposed` | Tiers, marketplace, what may be metered. Not ratified. |
| [connections.md](design/connections.md) | `built` | The integrations hub: connections, connectors, executor runtime. |
| [control-plane.md](design/control-plane.md) | `built` | The shared platform layer N per-vertical deployments sit on. |
| [dashboard-teams.md](design/dashboard-teams.md) | `built` | One login, many teams; team = tenant. |
| [dashboard-ui.md](design/dashboard-ui.md) | `historical` | Visual UI brief handed to a design tool. Consumed. |
| [dashboard.md](design/dashboard.md) | `built` | The tenant-facing self-service surface. apps/dashboard. |
| [dependency-policy.md](design/dependency-policy.md) | `built` | Peer vs direct dependencies, and the declared-deps gate. |
| [engine-absence.md](design/engine-absence.md) | `built` | The approved-absence ledger. |
| [engine-booking.md](design/engine-booking.md) | `built` | Reservation and slot allocation. |
| [engine-metering.md](design/engine-metering.md) | `built` | The billable-usage ledger. |
| [engine-protocol.md](design/engine-protocol.md) | `built` | Protocol and checklist engine. NOTE: OQ11 entry awaits ratification. |
| [first-flow.md](design/first-flow.md) | `historical` | The first end-to-end flow. Milestone completed. |
| [generated-verticals.md](design/generated-verticals.md) | `proposed` | The prompt-to-app channel. Explicitly not scheduled. |
| [kernel-design.md](design/kernel-design.md) | `canonical` | Technical shape of the plan's decisions, and the K log. |
| [manyfold-ui.md](design/manyfold-ui.md) | `historical` | UI design brief for Manyfold. Consumed. |
| [marketplace-publish.md](design/marketplace-publish.md) | `built` | Push to your team, publish to everyone. |
| [membership.md](design/membership.md) | `built` | Membership, invites, and the admin as first consumer. |
| [model-phase-plan.md](design/model-phase-plan.md) | `building` | The model phase. Umbrella #685 open. |
| [multi-scope-manyfold.md](design/multi-scope-manyfold.md) | `built` | Multi-scope Manyfold and the Data-tab scope switcher. |
| [observability.md](design/observability.md) | `built` | Piggyback Cloudflare; stamp only what Cloudflare cannot know. |
| [oidc-only-demos.md](design/oidc-only-demos.md) | `built` | Remove the credential store from the verticals. |
| [orchestration.md](design/orchestration.md) | `built` | Portal-driven vertical deploy. Superseded in part by D-37/K-33. |
| [permission-registry-enforcement.md](design/permission-registry-enforcement.md) | `built` | The permission registry, derived from TypeScript. NOTE: log entry never landed. |
| [platform-intents.md](design/platform-intents.md) | `built` | How a sandbox-clean vertical requests a privileged platform action. |
| [platform-neutral-surface.md](design/platform-neutral-surface.md) | `built` | What Substrat exposes, minus Cloudflare. |
| [preview-and-snapshots.md](design/preview-and-snapshots.md) | `built` | Run a version against a copy of the data. |
| [scheduler.md](design/scheduler.md) | `built` | The platform scheduler. |
| [scope-local-permissions.md](design/scope-local-permissions.md) | `built` | Permission checks off the control-plane hot path. |
| [self-serve-deploy.md](design/self-serve-deploy.md) | `built` | The untrusted trust model and the sandbox contract. |
| [signature-contact-carrier.md](design/signature-contact-carrier.md) | `built` | Reaching a signatory without putting them in the spine. |
| [sub-transactions.md](design/sub-transactions.md) | `proposed` | Sub-transactions at the engine seam: ctx.atomic. |
| [vertical-auth-detach.md](design/vertical-auth-detach.md) | `built` | Pick your issuer at install. All four phases implemented. |

### `proposals/`

| document | status | |
|---|---|---|
| [docs-restructure.md](proposals/docs-restructure.md) | `proposed` | Audit of docs/ and the restructure plan. This document. |
| [hosting-and-certification.md](proposals/hosting-and-certification.md) | `accepted` | Accepted as D-32. The long form of its argument; still cited by D-45/K-37. |

### `research/` — dated external snapshots

| document | status | |
|---|---|---|
| [fsm-vendor-feature-survey.md](research/fsm-vendor-feature-survey.md) | `historical` | Feature survey of the Nordic FSM market, surveyed 2026-07-13. |
| [platform-landscape-drilldown.md](research/platform-landscape-drilldown.md) | `historical` | How platform incumbents handle extension, upgrades, tenancy. |

---

This index is hand-written today and should be generated — see
[proposals/docs-restructure.md](proposals/docs-restructure.md) §8.