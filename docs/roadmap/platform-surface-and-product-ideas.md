---
status: proposed
layer: plan
description: Parked platform-surface, handover, portability, and product ideas with concrete restart triggers.
---

# Platform surface, handover, and product ideas

These entries preserve proposals and decisions whose next step is not scheduled. An entry records a restart trigger, not a delivery commitment. The linked issues retain the design discussion; the linked decisions govern the current behavior.

## App contract and handover

### [#112 — Platform MCP admin and build scopes](https://github.com/substrat-run/substrat/issues/112)

- Idea: give agents separate admin authority to change contracts and build authority to read the spec, inspect entities, and create test data; keep contract changes behind the human checkpoints in [generated verticals](../strategy/generated-verticals.md) §6.1.
- State: [#1182](https://github.com/substrat-run/substrat/pull/1182) shipped the per-vertical user-runtime MCP rendering of declared HTTP operations. It did not deliver the platform admin or build scopes proposed here.
- Parked because: no owner has chosen the platform server's access model or a build-scope consumer; the shipped user-runtime endpoint answers a different role. [D-15](../decisions/D-015-spec-first-contracts.md) still governs derivation from contracts.
- Resume when an admin workflow or external builder needs one of these scopes; define its authority boundary and source-of-truth rules before exposing tools. The issue retains the proposed operations and handover-resource question.

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
- Parked as *strictly post-operator-proof optionality* in [generated verticals](../strategy/generated-verticals.md) §7.4; the dated September triage reserved the observed third-party run for a person.
- Revisit when the maintainer chooses to run the experiment after operator proof, using #127's bundle or an explicitly chosen whole-vertical slice.

### [#126 — Bolt MCP-connector experiment](https://github.com/substrat-run/substrat/issues/126)

- Idea: give a frontend tool the MCP build scope and a scoped handover, then check that its generated UI uses the contract and stays within the granted operations.
- State: the MCP build scope (#112), #127 bundle, and #111 app token are unbuilt; the experiment has not run.
- Parked under the same *post-operator-proof optionality* as #125. The dated September triage reserved this observed third-party run for a person; see [generated verticals](../strategy/generated-verticals.md).
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
- State: `adapter-sqlite` passes the shared contract suites, export paths exist, and #2202 proved #1638 **layer 1** on one machine. #1638 is closed; **layer 2** (k3d/cluster CI) and **layer 3** (real-node loss, volume recovery, and performance) remain unproven, as does a repeatable self-hosting bundle.
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

## Recorded domain-engine use cases

### [#326 — VAT carriage in invoicing](https://github.com/substrat-run/substrat/issues/326)

- Idea: a third invoicing use case requests per-line tax rates and a per-rate net/tax breakdown frozen with the exported document; tax determination remains outside the engine.
- State: currency shipped separately, so the original co-sequencing request has elapsed. The proposed [VAT carriage RFC](../rfc/vat-carriage.md) now holds the concept spec, including the multi-rate example; no carriage code is in `engines/invoicing/src`.
- Parked on a maintainer decision on the RFC's open questions, including the export-event shape under [K-39](../decisions/K-039-payload-changes-are-loud-failure-replaces-until-dispatch-rou.md), with no implementation owner. [Commerce gaps](../strategy/commerce-gaps.md) §4.1 holds the engine-versus-integration argument.
- Resume when that decision is recorded and an invoicing consumer needs the breakdown; implement it additively against the shipped currency shape.

### [#327 — Booking turnaround](https://github.com/substrat-run/substrat/issues/327)

- Idea: a room may be unavailable during a turnaround period after a reservation; the request argues for widening the allocation exclusion window while leaving the booked interval true.
- State: [booking open question 3](../engines/booking.md) records the use case but still leans toward vertical padding; no turnaround rule is implemented in the engine.
- Parked on the engine-boundary decision: padding would lengthen stored intervals, events and `availability()` results, while resource-specific turnaround changes physical overlap. The issue preserves the argument and proposed zero-default shape.
- Resume when a booking consumer needs the rule and the maintainer answers open question 3; then document the padding consequence or add an engine rule to allocation and availability.

## Builder-studio measurement

### [#681 — Model-first build comparison](https://github.com/substrat-run/substrat/issues/681)

- Idea: compare tokens per passing build with an approved model against a model-less build, using concept-derived tests as the independent referee.
- State: the build already reads guarded `spec/model.ts` and transcribes it; the issue's `spec/schema.graphql` premise is obsolete (no such path remains on main). The A/B has not run.
- Parked because: the model phase and context plumbing shipped, but no owner has scheduled the measurement; [#695](https://github.com/substrat-run/substrat/issues/695) explains why model-derived tests would rig it.
- Resume when a frozen concept fixture and budget allow both arms to be run and compared on passing behavior and token cost, rather than assuming the model improves the build.

### [#682 — Sequential API and UI lanes](https://github.com/substrat-run/substrat/issues/682)

- Idea: give the API and UI passes disjoint write guards, a smaller context each, one gate at the join, and a recorded contract gap for the next API pass.
- State: [#2200](https://github.com/substrat-run/substrat/pull/2200) shipped this locally as **opt-in** sequential lanes over `spec/model.ts`; the eval harness can run either arm, but no laned-versus-unlaned outcome is recorded.
- Parked because: the proposed token and continuation savings are still a claim, not measured evidence; [#683](https://github.com/substrat-run/substrat/issues/683) makes parallel lanes conditional on that comparison.
- Resume when a concept fixture with screens can compare tokens per passing build and wall-clock time; use the result to decide whether lanes should become the default or gain concurrency.

### [#685 — Staged model-flow umbrella](https://github.com/substrat-run/substrat/issues/685)

- Idea: approve a typed model before building, then test whether an API/UI split improves a complete build; the issue holds the revised sequence and the independent-test caution.
- State: `spec/model.ts`, deterministic emitters, declared returns, the production-data phase gate, model view, and opt-in sequential lanes have shipped. GraphQL SDL was dropped; #681's model-first A/B and #682's lane comparison remain unrun.
- Parked because: the remaining umbrella claim is evidence-gated, while [#683](https://github.com/substrat-run/substrat/issues/683) already holds the conditional parallel-lane work. The shipped slices have their own records.
- Resume when those comparisons show a repeatable gain on concept-derived tests; then choose any default-lane or parallel follow-up from the measured result.

## Product-scope survey and search

### [#1089 — ticket0 product-scope survey](https://github.com/substrat-run/substrat/issues/1089)

- Idea: the August 2026 comparison with Zendesk, Freshdesk and Intercom asks how far ticket0 should go as a support product rather than treating every competitor gap as a defect.
- State: separate issues track near-term gaps (#1079–#1088). The dated survey here records the uncommitted choices: public articles, outbound messaging, company/custom fields, multiple desks, tenant integrations, languages, agent efficiency and more channels.
- Parked because: [ticket0's concept](../../demos/ticket0/spec/concept.md) §10 defers several of these, and no product-scope decision or owner has selected which should become work.
- Resume when the maintainer decides whether ticket0 aims to replace those products or remain a platform-proof demo; file only the selected gaps. The issue retains the comparison and its per-gap argument.

### [#1576 — Scope-local semantic search](https://github.com/substrat-run/substrat/issues/1576)

- Idea: meaning-based matching over prose and uploaded documents, while keeping keyword FTS read-after-write behavior.
- State: [K-57](../decisions/K-057-a-semantic-index-is-scope-local-a-semantic-read-is-declared-eventual-an-external-index-only-as-a-store-driver.md) decided a scope-local, asynchronously filled index and a separate declared semantic read that reports freshness; no implementation has shipped.
- Parked until the first vertical needs meaning-matching. [#2500](https://github.com/substrat-run/substrat/issues/2500), labelled `dibs`, is where work resumes: first measure 1k/10k/100k chunks, then settle the embedder, erasure, restore and read contracts.
- Resume at #2500 when that vertical appears; keep FTS as the default and use a scope-store driver if the spike shows the in-scope table is insufficient.
