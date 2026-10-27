---
status: proposed
layer: plan
description: Parked platform-surface, handover, portability, and product ideas with concrete restart triggers.
---

# Platform surface, handover, and product ideas

These entries preserve proposals and decisions whose next step is not scheduled. An entry records a restart trigger, not a delivery commitment. The linked issues retain the design discussion; the linked decisions govern the current behavior.

## App contract and handover

### [#111 — App as a first-class surface](https://github.com/substrat-run/substrat/issues/111)

- Idea: name an operation-scoped app over one scope, with its own token and filtered OpenAPI view; run the D-22 contract diff per app view.
- State: the whole-vertical contract is emitted and checked, and K-26 gives `surface` a structural model role. An app-specific authority boundary, token, and view are not built.
- Parked on the issue's decision question: does D-22 keep code as the source of the contract, or does a declared surface move upstream? See [generated verticals](../strategy/generated-verticals.md) §4 and [control plane](../architecture/control-plane.md).
- Reopen when that direction is decided and an app-scoped consumer needs a contract and token.

### [#127 — Generated handover bundle](https://github.com/substrat-run/substrat/issues/127)

- Idea: render a per-app, versioned OpenAPI view, scoped token, and context file into target-specific handovers, including a Knowledge file, `replit.md`, a skill, or plain OpenAPI.
- State: emitted whole-vertical OpenAPI exists; the per-app view and assembled bundle do not. The context may later be an MCP resource.
- Parked behind #111. [D-15](../master-plan.md) keeps skills, SDKs, and tools derived from contracts; hand-maintained prompt text would drift.
- Reopen when #111 provides a scoped view and token and a named handover target is ready to consume them.

### [#131 — Agent-facing app-surface tracker](https://github.com/substrat-run/substrat/issues/131)

- Idea: coordinate one app contract rendered as filtered REST OpenAPI, an MCP surface, and the #127 handover, with per-app versioning and usage evidence.
- State: D-22 emission and checking exist; #111, #112, #127, and #114 remain separate work. K-26's structural `surface` is not the proposed app authority boundary.
- Sequencing is held for the maintainer, including #111's source-of-truth decision. The September triage marked this tracker human-owned.
- Revisit when the maintainer answers #111 and chooses an owner and order for the renderings; see [generated verticals](../strategy/generated-verticals.md).

## Experiments after operator proof

### [#125 — Lovable Knowledge-file experiment](https://github.com/substrat-run/substrat/issues/125)

- Idea: see whether a Knowledge file steers a frontend tool to use the emitted API rather than inventing its own data model; record the observed result either way.
- State: whole-vertical OpenAPI is available; #111's per-app view and token are not. The experiment has not run.
- Parked as *strictly post-operator-proof optionality* in [generated verticals](../strategy/generated-verticals.md) §7.4; the September triage reserved the third-party run for a person.
- Revisit when the maintainer chooses to run the experiment after operator proof, using #127's bundle or an explicitly chosen whole-vertical slice.

### [#126 — Bolt MCP-connector experiment](https://github.com/substrat-run/substrat/issues/126)

- Idea: give a frontend tool the MCP build scope and a scoped handover, then check that its generated UI uses the contract and stays within the granted operations.
- State: the MCP build scope (#112), #127 bundle, and #111 app token are unbuilt; the experiment has not run.
- Parked under the same post-operator-proof option as #125. The September triage reserved this third-party run for a person; see [generated verticals](../strategy/generated-verticals.md).
- Revisit when operator proof and those dependencies exist and the maintainer schedules an observed run.

### [#133 — Distribution and dogfooding tracker](https://github.com/substrat-run/substrat/issues/133)

- Idea: coordinate a tested self-hosting claim (#123) with optional prompt-to-app experiments (#125, #126); the operator-proof work (#124) remains separately owned.
- State: the channel experiments are unrun; #123 has only a one-machine spike, and #124 is outside this roadmap's closing set.
- Parked for maintainer sequencing. [Generated verticals](../strategy/generated-verticals.md) calls the channel strictly post-operator-proof optionality, and September triage marked this tracker human-owned.
- Revisit after operator proof when the maintainer selects a concrete distribution experiment or self-hosting acceptance run.

## Version evolution and live API guarantees

### [#128 — Routable dual-emit and deprecation](https://github.com/substrat-run/substrat/issues/128)

- Idea: route in-scope consumers by `(type, schemaVersion)` and give the consumer registry a version dimension, so a short, explicit deprecation window can work.
- State: in-scope dispatch still selects event type alone. Cross-vertical delivery already matches versions, but it does not supply this in-scope mechanism; the #114 removal gate and #112 agent migration notice are unbuilt.
- [K-39](../decisions/K-039-payload-changes-are-loud-failure-replaces-until-dispatch-rou.md) chose loud-failure replacement for the interval and says routable dual-emit is **postponed rather than abandoned**. The old D-28 dual-emit clause is unavailable under that decision.
- Reopen when a versioned event change needs parallel consumption; amend K-39 and assign the dispatch and registry work before promising a sunset window.

### [#114 — Spec-version usage and removal gate](https://github.com/substrat-run/substrat/issues/114)

- Idea: generated clients identify their spec version; edge telemetry records deprecated usage by token, and an Analytics Engine to D1 rollup supports reminders and a **zero readers in 30 days** removal gate.
- State: no `X-Substrat-Spec` signal or that rollup/removal gate exists. Existing outbox meters do not count reads; an optional raw archive is only a later retention choice.
- Parked until app-specific clients and a deprecation window need measured readership; the gate pairs with #128, not with billing meters.
- Reopen when a surface is marked deprecated and a removal date needs evidence rather than an estimate.

### [#132 — Live API guarantees tracker](https://github.com/substrat-run/substrat/issues/132)

- Idea: coordinate shared error, write, lifecycle, and notification guarantees for a live operation surface, with declarations checked by CI rather than prose alone.
- State: several former children are complete (#116, #117, #120, #129, #130, and now #115 and #119); #113 and #118 remain active separately. The tracker body predates these changes.
- Sequencing remains maintainer-owned under the September triage; this umbrella is not a separate implementation task.
- Revisit when the maintainer updates the child ledger and chooses which remaining guarantee needs a coordinated release; the individual issues hold their own work.

### [#121 — AuthHero token-plumbing residue](https://github.com/substrat-run/substrat/issues/121)

- Idea: explore OAuth scopes as a ceiling on local authorization, `amr` and `client_id` as inputs, upstream groups for role mapping, and a versioned effective-permissions cache only if traces justify it.
- State: D-16 and K-21 already place membership and permission evaluation in the kernel; the listed token-plumbing choices are not implemented as a new shared contract.
- Parked with the AuthHero project's own backlog rather than a new platform authorization program; the [kernel design](../architecture/kernel-design.md) §4.3 constraint on claim-derived permissions still applies.
- Reopen when that project has a concrete token-flow requirement or trace evidence for the cache, and reconcile it with local evaluation first.

## Portability and platform product

### [#123 — Tested self-hosting path](https://github.com/substrat-run/substrat/issues/123)

- Idea: publish a repeatable Kubernetes runbook, local SQLite path, and documented gaps against the hosted deployment, proven end to end at least once.
- State: `adapter-sqlite` passes the shared contract suites, export paths exist, and #2202 proved #1638 layer 1 on one machine. No cluster or real-hardware run has established the self-hosting claim.
- The September triage reserved this acceptance run for a person; [platform-neutral surface](../architecture/platform-neutral-surface.md) and [spike findings](../../spikes/k3s-sharding/FINDINGS.md) state the limits.
- Revisit when the maintainer schedules an actual cluster run and records the result and hosted-equivalence gaps before publishing self-hosting copy.

### [#1638 — k3s sharding spike](https://github.com/substrat-run/substrat/issues/1638)

- Idea: test scope placement, one-writer fencing, pod loss, resharding, directory separation, and background work across shards on k3s.
- State: [#2202](https://github.com/substrat-run/substrat/pull/2202) merged **layer 1**: processes on one machine, with placement, leases, a storage fence, router, and resharding evidence. The contract suite did not cross a process boundary.
- Parked after that slice. **Layer 2** (k3d in CI) and **layer 3** (real nodes) remain; pod-loss/volume behavior and the directory as a service are unresolved, as [FINDINGS](../../spikes/k3s-sharding/FINDINGS.md) explains.
- Reopen when the maintainer funds the cluster slice, then the real-node acceptance run needed by #123.

### [#1073 — Platform-side model inference](https://github.com/substrat-run/substrat/issues/1073)

- Idea: have the platform make the provider call and record observed usage after a vertical requests inference; this is the connector-shaped end state of [D-59](../decisions/D-059-the-model-provider-seam-is-a-table-platform-billed-inference-is-a-cr.md).
- State: the provider catalog, rate card, and usage ledger exist, but `createModelHost` runs in the vertical. BYOK and platform-observed metering wait on moving the call.
- Parked on the architecture choice between an awaited platform hop and an asynchronous result, plus the migration of existing bindings and usage reporting.
- Reopen when those choices are decided for a real inference consumer and an owner can land the seam in slices.

### [#39 — Platform billing decision](https://github.com/substrat-run/substrat/issues/39)

- Idea: price and collect platform usage after the commercial model is chosen; this is separate from verticals' own invoicing.
- State: entitlements and meters exist, and billing-grade usage history was captured in #2501. There is no pricing, dunning, payment rail, or platform invoice flow.
- [D-30](../decisions/D-030-control-plane-the-shared-layer-across-n-per-vertical-deploym.md) still says **meter, don't bill**. The later maintainer decision favors pass-through tenant usage attributed by tenant and vertical, while pricing and collection remain undecided.
- Reopen when the maintainer makes the commercial pricing decision and a billable usage unit needs an invoice and payment path.
