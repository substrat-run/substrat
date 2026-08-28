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
| a proposal for a change nobody has agreed to yet | [`rfc/`](rfc/), `status: proposed` |
| the record of a decision, once made | a new file in [`decisions/`](decisions/) — never a table row by hand |
| how a shipped part of the platform works | [`architecture/`](architecture/), present tense, `status: built` |
| a spec for an engine | [`engines/`](engines/) |
| positioning, pricing, market | [`strategy/`](strategy/) |
| a brief for a design tool or an agent | [`briefs/`](briefs/) — expect it to become `historical` once consumed |
| a dated snapshot of the outside world | [`research/`](research/), `status: historical` |
| ~~the result of an acceptance run~~ | the practice is retired (D-57); `acceptance/` is closed to new files |
| a page for someone *using* Substrat | `apps/docs/` — not here |

Two rules carry the structure, and both are meant to be enforceable:

1. **`architecture/` is present tense.** A document there may not say "will", "proposed" or
   "not built". That single rule is what would have caught `dashboard.md` opening with
   *"design. Not built."* while `apps/dashboard` had a month of commits behind it.
2. **`rfc/` empties.** A decided RFC moves to `architecture/` — rewritten, not just
   relabelled — or to `archive/`, and lands an entry in [`decisions/`](decisions/). A
   document that never leaves `rfc/` is telling you something.

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
[rfc/docs-restructure.md](rfc/docs-restructure.md):

- **Eleven entries were written late.** The Phase-2 split found decisions that had shipped
  but were never logged: the TypeScript-derived permission registry (D-47 — its own draft
  had claimed the already-taken number 41), builder-studio's nine (D-48…D-56) and kernel
  open question 11 (K-38). Transcribed from their authors' text and ratified 2026-08-19.
- **`strategy/commerce-gaps.md` §6.1 is out of date.** It says engines have no tests and
  there is no engine analogue of `contract-tests`; all seven engines now have test scripts
  and `packages/engine-test-kit` exists. The rest of the document still reads true.
- **~~`engines/{workorder,invoicing,invites}` have no design doc~~** — written in Phase 4,
  from the source rather than from a prior argument, and each says so in its header.
- **Kernel open question 16 has passed its own deadline.** It says decide before a third
  party consumes an engine event; all seven engines are on public npm.
  ([#128](https://github.com/substrat-run/substrat/issues/128))
- **`architecture/` is present tense but not yet *rewritten*.** Phase 1 corrected the
  status lines of 18 documents that described shipped work as unbuilt, and the gate now
  refuses new ones. The bodies below those headers are still written as proposals in
  places — an honest header on an argued-in-future-tense document. That is the remaining
  content debt.

## The decision log

[`DECISIONS.md`](DECISIONS.md) is the whole log — <!-- DECISIONS:COUNT -->100 entries<!-- /DECISIONS:COUNT -->, both layers, oldest first —
generated from [`decisions/`](decisions/), one file per decision. The tables in master plan
§12 and kernel design §14 are generated from the same source and must not be hand-edited.

```
pnpm lint:decisions            # regenerate
pnpm lint:decisions --check    # CI: fail if any generated table is stale
```

`D-*` are plan-layer, `K-*` kernel-layer. The two id vocabularies are historical: one log,
ids never reused. See [rfc/docs-restructure.md](rfc/docs-restructure.md) §7.

An entry's `status` is `accepted`, `proposed` (rendered as awaiting ratification) or
`superseded` (carries `superseded-by`, and every rendering of the row names the
replacement). The log is append-only, so a later entry that corrects an earlier one
declares `amends: [D-46]` and the earlier row gets the back-pointer — a reader landing on
D-46 sees D-58 without knowing to look for it. Every one of those references must name an
entry that exists, and the count above is written by the same tool; `--check` holds all of it.

## Index

<!-- INDEX:START — generated by tools/docs-structure.mjs -->

### Root

The plan, the log, this map.

| document | status | |
|---|---|---|
| [master-plan.md](master-plan.md) | `canonical` | Strategy, architecture decisions, and the D log. Canonical; everything else derives. |

### `strategy/`

Why we build this, for whom, at what price. These are **satellites of the master plan**, not rivals to it: where one disagrees with the plan, the plan wins and the satellite is stale. Several are cited as normative by `architecture/` documents and open questions, so none of them is idle background.

| document | status | |
|---|---|---|
| [candidate-verticals.md](strategy/candidate-verticals.md) | `canonical` | Living catalog of application categories. Falsifies the engine set; not a roadmap. |
| [commerce-gaps.md](strategy/commerce-gaps.md) | `historical` | Commerce capability gap walk, 2026-07-17. Its §6.1 precondition is now out of date. |
| [commercial-model.md](strategy/commercial-model.md) | `proposed` | Tiers, marketplace, what may be metered. Not ratified. |
| [generated-verticals.md](strategy/generated-verticals.md) | `proposed` | The prompt-to-app channel. Explicitly not scheduled. |
| [hosting-and-certification.md](strategy/hosting-and-certification.md) | `accepted` | Accepted as D-32. The long form of its argument; still cited by D-45/K-37. |
| [why-substrat.md](strategy/why-substrat.md) | `canonical` | The honest positioning source. Feeds four published pages; not itself published. |

### `architecture/`

How the platform works **today** — present tense. A document here may not open by calling itself unbuilt.

| document | status | |
|---|---|---|
| [api-surface.md](architecture/api-surface.md) | `built` | Every vertical serves its own OpenAPI; Scalar renders it. |
| [cms-content.md](architecture/cms-content.md) | `built` | Content types that compile to reviewed migrations. |
| [connections.md](architecture/connections.md) | `built` | The integrations hub: connections, connectors, executor runtime. |
| [control-plane.md](architecture/control-plane.md) | `built` | The shared platform layer N per-vertical deployments sit on. |
| [dashboard-teams.md](architecture/dashboard-teams.md) | `built` | One login, many teams; team = tenant. |
| [dashboard.md](architecture/dashboard.md) | `built` | The tenant-facing self-service surface. apps/dashboard. |
| [dependency-policy.md](architecture/dependency-policy.md) | `built` | Peer vs direct dependencies, and the declared-deps gate. |
| [kernel-design.md](architecture/kernel-design.md) | `canonical` | Technical shape of the plan's decisions, and the K log. |
| [marketplace-publish.md](architecture/marketplace-publish.md) | `built` | Push to your team, publish to everyone. |
| [membership.md](architecture/membership.md) | `built` | Membership, invites, and the admin as first consumer. |
| [multi-scope-manyfold.md](architecture/multi-scope-manyfold.md) | `built` | Multi-scope Manyfold and the Data-tab scope switcher. |
| [observability.md](architecture/observability.md) | `built` | Piggyback Cloudflare; stamp only what Cloudflare cannot know. |
| [oidc-only-demos.md](architecture/oidc-only-demos.md) | `built` | Remove the credential store from the verticals. |
| [orchestration.md](architecture/orchestration.md) | `built` | Portal-driven vertical deploy. Superseded in part by D-37/K-33. |
| [permission-registry-enforcement.md](architecture/permission-registry-enforcement.md) | `built` | The permission registry, derived from TypeScript. Logged as D-47. |
| [platform-intents.md](architecture/platform-intents.md) | `built` | How a sandbox-clean vertical requests a privileged platform action. |
| [platform-neutral-surface.md](architecture/platform-neutral-surface.md) | `built` | What Substrat exposes, minus Cloudflare. |
| [preview-and-snapshots.md](architecture/preview-and-snapshots.md) | `built` | Run a version against a copy of the data. |
| [scheduler.md](architecture/scheduler.md) | `built` | The platform scheduler. |
| [scope-local-permissions.md](architecture/scope-local-permissions.md) | `built` | Permission checks off the control-plane hot path. |
| [self-serve-deploy.md](architecture/self-serve-deploy.md) | `built` | The untrusted trust model and the sandbox contract. |
| [signature-contact-carrier.md](architecture/signature-contact-carrier.md) | `built` | Reaching a signatory without putting them in the spine. |
| [vertical-auth-detach.md](architecture/vertical-auth-detach.md) | `built` | Pick your issuer at install. All four phases implemented. |

### `architecture/builder/`

The builder subsystem — one plane, three documents.

| document | status | |
|---|---|---|
| [harness.md](architecture/builder/harness.md) | `building` | Model catalog and harness efficiency. Rows 6-7 open (#663). |
| [plane.md](architecture/builder/plane.md) | `built` | Tenant-owned verticals, self-serve. |
| [studio.md](architecture/builder/studio.md) | `built` | Chat to vertical, hosted. Its nine proposals landed as D-48..D-56. |

### `engines/`

One per engine, mirroring `engines/*`.

| document | status | |
|---|---|---|
| [absence.md](engines/absence.md) | `built` | The approved-absence ledger. |
| [booking.md](engines/booking.md) | `built` | Reservation and slot allocation. |
| [invites.md](engines/invites.md) | `built` | Invitations to an organization, and the connector seam that effects membership. |
| [invoicing.md](engines/invoicing.md) | `built` | The invoice-basis ledger — consumes delivery events, immutable after export. |
| [metering.md](engines/metering.md) | `built` | The billable-usage ledger. |
| [protocol.md](engines/protocol.md) | `built` | Protocol and checklist engine. OQ11 decided and logged as K-38. |
| [workorder.md](engines/workorder.md) | `built` | The work-order state machine, with append-only time and material reporting. |

### `rfc/`

Open proposals. A document leaves when it is decided — to `architecture/` rewritten in present tense, or to `archive/`. One that never leaves is a signal.

| document | status | |
|---|---|---|
| [agent-surface.md](rfc/agent-surface.md) | `building` | How any agent discovers and works with Substrat. #749 open. |
| [booking-social.md](rfc/booking-social.md) | `building` | Booking engine shipped; the cross-tenant social tier is not. |
| [docs-restructure.md](rfc/docs-restructure.md) | `building` | Audit of docs/ and the restructure. All four phases executed; the prose rewrite is what remains. |
| [error-model.md](rfc/error-model.md) | `proposed` | One error model — RFC 9457 problem+json, a closed code taxonomy, typed throws that survive the RPC hop. |
| [model-phase-plan.md](rfc/model-phase-plan.md) | `building` | The model phase. Umbrella #685 open. |
| [sub-transactions.md](rfc/sub-transactions.md) | `proposed` | Sub-transactions at the engine seam: ctx.atomic. |

### `briefs/`

Handoffs with a short shelf life by design. They become `historical` once consumed.

| document | status | |
|---|---|---|
| [dashboard-ui.md](briefs/dashboard-ui.md) | `historical` | Visual UI brief handed to a design tool. Consumed. |
| [first-flow.md](briefs/first-flow.md) | `historical` | The first end-to-end flow. Milestone completed. |
| [manyfold-ui.md](briefs/manyfold-ui.md) | `historical` | UI design brief for Manyfold. Consumed. |

### `research/`

Dated snapshots of the outside world. Never revised.

| document | status | |
|---|---|---|
| [fsm-vendor-feature-survey.md](research/fsm-vendor-feature-survey.md) | `historical` | Feature survey of the Nordic FSM market, surveyed 2026-07-13. |
| [platform-landscape-drilldown.md](research/platform-landscape-drilldown.md) | `historical` | How platform incumbents handle extension, upgrades, tenancy. |

### `acceptance/`

Agent-loop run records. **Closed** — the practice is retired (D-57); the records stay because later work cites them.

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

<!-- INDEX:END -->
