---
status: proposed
layer: plan
description: Where closed tracking issues point, and when parked distribution and delegated-assistant work should resume.
---

# Tracking issues: closure pointers and restart triggers

A tracker closes when its finished work has evidence and its unfinished work has a separate home. The linked issues keep their detailed history; a roadmap entry records a reason and a trigger, not a delivery commitment.

## Parked work

### [#131 — agent-facing app surfaces](https://github.com/substrat-run/substrat/issues/131)

- **Idea:** Render a scoped app contract as REST OpenAPI, MCP, and a handover, with versioning and usage evidence from the same declarations.
- **State:** Per-vertical MCP shipped. The app contract, handover, dual-emit and usage proposals closed into the [app](platform-surface-and-product-ideas.md#app-contract-and-handover) and [version](platform-surface-and-product-ideas.md#version-evolution-and-live-api-guarantees) roadmap entries. [#112](https://github.com/substrat-run/substrat/issues/112) still holds the distinct platform admin/build MCP scope; [#2686](https://github.com/substrat-run/substrat/pull/2686) records its remaining scope and closes it on merge.
- **Parked because:** No owner has scheduled a platform admin/build workflow or a handover target, and the version work needs a real deprecation event.
- **Resume when:** A named builder workflow needs the platform MCP scope or a deployed app needs a filtered contract and handover; scope that slice from the linked issues and roadmap entries.

### [#133 — distribution experiments and operator proof](https://github.com/substrat-run/substrat/issues/133)

- **Idea:** Prove a self-hosted path, choose an internal operator proof, and test optional prompt-to-app channels after that proof.
- **State:** The local adapter and exports exist, but the cluster acceptance run is unperformed. The operator proof needs a human commitment; the two channel experiments have not run. The companion [roadmap sweep PR #2686](https://github.com/substrat-run/substrat/pull/2686) closes #123, #125 and #126 on merge and retains their separate [self-hosting](platform-surface-and-product-ideas.md#123--tested-self-hosting-path) and [experiment](platform-surface-and-product-ideas.md#experiments-after-operator-proof) entries. [#124](https://github.com/substrat-run/substrat/issues/124) holds the operator-proof decision.
- **Parked because:** No owner has scheduled the cluster run or experiments, and the operator proof is a business choice. See [generated verticals](../strategy/generated-verticals.md) for the channel boundary.
- **Resume when:** An operator commits to an end-to-end self-hosting run or a first-party production case; schedule a channel experiment only after that proof and a named evaluation question.

### [#1824 — delegated assistant calls across app surfaces](https://github.com/substrat-run/substrat/issues/1824)

- **Idea:** Let an assistant use a host's MCP operations for the signed-in user, with a delegated ceiling and both participants recorded.
- **State:** The two issuer exchanges and grant reader landed in [#1832](https://github.com/substrat-run/substrat/pull/1832); host opt-in and the MCP call ceiling landed in [#2398](https://github.com/substrat-run/substrat/pull/2398). The remaining slices are below; the issue retains the full flow and design questions.

| Remaining slice | Evidence on `main` |
|---|---|
| Host-support gate for delegation grants | The issuer can read a grant, but no platform writer checks the **running** host version and opt-in before delivering one or revokes it after rollback. |
| Grant and actor-client delivery to the shared issuer | `apps/` has no writer for `substrat:delegations`; no delivered host configuration supplies the actor's client id. |
| Host-side assertion exchange helper | `demos/auth-server/src/token-exchange.ts` serves exchange A, but `packages/vertical-auth` has no client helper that calls it. |
| Bounded read-only MCP calls from the support assistant | The current assistant harness retrieves and drafts an answer; it has no MCP client, endpoint/tool configuration, or bounded call-and-continue loop. |
| Delegated actor in operation history | The MCP ceiling enforces the delegated scope, but the `act` participant is not recorded in the scope's event history. |

- **Parked because:** These are concrete slices without a scheduled host integration or owner. The host-support gate also needs its placement decision before grant delivery.
- **Resume when:** The first vertical needs its assistant to call its own MCP on behalf of the signed-in user. Start with the running-version gate and grant delivery, then complete the exchange, tool loop, and history proof together.

## Closed tracker index

| Tracker | Closure pointer | Current proof |
|---|---|---|
| [#44](https://github.com/substrat-run/substrat/issues/44) | [#41](https://github.com/substrat-run/substrat/issues/41) owns the remaining commercial and legal work; the [billing decision](platform-surface-and-product-ideas.md#39--platform-billing-decision) is parked. | The engineering children and later hosting-capability issues are closed. |
| [#131](https://github.com/substrat-run/substrat/issues/131) | The parked entry above, [#112](https://github.com/substrat-run/substrat/issues/112), and the app/version entries in the existing roadmap. | The per-vertical MCP rendering shipped; #111, #127, #128 and #114 closed into the roadmap. |
| [#132](https://github.com/substrat-run/substrat/issues/132) | [#113](https://github.com/substrat-run/substrat/issues/113) owns the remaining problem-document routes; [#118](https://github.com/substrat-run/substrat/issues/118) owns notification ratification and whether to wire the originally proposed consumer. | The other eight listed guarantees have closed. |
| [#133](https://github.com/substrat-run/substrat/issues/133) | The parked entry above, with separate proof and experiment records. | No channel experiment or self-hosting acceptance run is scheduled. |
| [#749](https://github.com/substrat-run/substrat/issues/749) | Its eight completed child issues, #750–#756 and #760. | The model view, API-doc guidance, test UI, and preview-skill correction are on `main`. |
| [#1752](https://github.com/substrat-run/substrat/issues/1752) | [#1749](https://github.com/substrat-run/substrat/issues/1749) retains the AI text and Ask follow-up. | Process map, Findings, logs modes, request slide-over, Audit and Pulse have shipped; the data children are closed. |
| [#1824](https://github.com/substrat-run/substrat/issues/1824) | The parked delegation entry above. | Issuer exchange and host MCP admission shipped; the five integration slices remain. |
