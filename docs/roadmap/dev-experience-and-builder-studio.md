---
status: proposed
layer: plan
description: Parked developer-experience ideas and builder-studio experiments, with evidence needed to resume them.
---

# Developer experience and builder studio — parked work

These are proposals without a current owner or evidence that warrants scheduling. Closing their tracking issues preserves the ideas here; a trigger below is a reason to scope new work, not a commitment to ship it. [#749](https://github.com/substrat-run/substrat/issues/749) remains the live tracker for building a vertical with Claude Code. The first local trace slice shipped in [#2626](https://github.com/substrat-run/substrat/pull/2626); the remainder of [#2358](https://github.com/substrat-run/substrat/issues/2358) stays open.

## Developer experience

### [#2357 — “Never leave Claude” and the local sidekick](https://github.com/substrat-run/substrat/issues/2357)

- **Idea:** Keep planning, building, inspecting requests, reviewing and shipping within the Claude Code workflow, with a local sidekick and optional in-chat mods.
- **State:** The plugin, design gate, local request traces, console data contract and several CI checks exist. The integrated sidekick and mods do not; this umbrella explicitly proposed a direction rather than claimed work.
- **Parked because:** The remaining pieces have no owner and depend on the tracing and console slices, while [#749](https://github.com/substrat-run/substrat/issues/749) remains the active umbrella.
- **Resume when:** An owner chooses an end-to-end builder workflow, scopes its next dependency, and validates the need against the shipped CLI and console data source. The original issue retains the layer diagram and open UI/bridge questions.

### [#2359 — agent-readable request traces](https://github.com/substrat-run/substrat/issues/2359)

- **Idea:** Add `substrat logs` and MCP request reads with concise, causally ordered failures, code pointers and redaction by default.
- **State:** `substrat dev` now records local request traces through [#2626](https://github.com/substrat-run/substrat/pull/2626); the CLI/MCP readers and failing-test-to-request link are unbuilt.
- **Parked because:** The trace buffer prerequisite landed only recently, and no owner has taken the reader and output contract.
- **Resume when:** A builder debugging a real failed request needs an agent-readable path from a test or response id to its trace; then specify one CLI/MCP shape and its redaction rules from the issue.

### [#2361 — local sidekick](https://github.com/substrat-run/substrat/issues/2361)

- **Idea:** Serve a read-mostly Concept, App and Requests view beside `substrat dev`, with a seeded role switcher and links from requests to traces and model concepts.
- **State:** The local tracing slice and [`ConsoleDataSource`](../architecture/console-data-source.md) contract exist. `substrat dev` does not serve the sidekick; the local source has no screens wired to it.
- **Parked because:** The UI needs an owner to join the local source, trace buffer and dev server, and the existing [#756](https://github.com/substrat-run/substrat/issues/756) browser surfaces remain live.
- **Resume when:** A concrete build workflow needs one local view across model, permissions, app and traces; settle the dashboard-versus-console home and the local action boundary recorded in the issue.

### [#2366 — optional Substrat mod pack](https://github.com/substrat-run/substrat/issues/2366)

- **Idea:** Thin in-chat guardrails, status, notices, trace attachment and sidekick prompts backed by CLI behavior, with the plugin usable when mods are unavailable.
- **State:** The plugin, local traces and review gates exist, but no mod pack is shipped; trace attachment and the sidekick bridge also await [#2359](https://github.com/substrat-run/substrat/issues/2359) and [#2361](https://github.com/substrat-run/substrat/issues/2361).
- **Parked because:** Its API and dependent content need evidence from those workflows; CI remains the enforcement point described in the proposal.
- **Resume when:** The CLI and sidekick flows exist and a repeated in-chat friction point justifies a small, optional mod. The issue lists the proposed events and degradation requirements.

### [#2367 — request-sequence replay on a preview fork](https://github.com/substrat-run/substrat/issues/2367)

- **Idea:** Replay a causally ordered, redacted request sequence against a preview fork and compare resulting local traces with the source record.
- **State:** Local traces shipped; the replay path, source adapter and comparison are unbuilt. The request record, hosted views and preview forks are separate prerequisites.
- **Parked because:** This is a later slice requiring those prerequisites and an explicit review of access, redaction and retention before implementation.
- **Resume when:** A real production-only failure cannot be reproduced from a safe local fixture and the prerequisite records and forks can support an audited, expiring replay flow. The original issue holds its acceptance criteria.

## Builder-studio experiments

### [#629 — user-authored acceptance ledger](https://github.com/substrat-run/substrat/issues/629)

- **Idea:** Pin a confirmed behavior from chat into `spec/accepted.md` and the scenario narrative, run the ledger every turn, and report regressions in the builder's words.
- **State:** [D-51](../decisions/D-051-regression-safety-comes-from-an-acceptance-ledger-the-user-a.md) accepts the principle, and the [studio design](../architecture/builder/studio.md) describes the flow; the pin affordance and ledger runner are unbuilt.
- **Parked because:** The decision predates an implementation owner or a measured need in the current builder loop.
- **Resume when:** An acceptance run shows confirmed user behavior regressing across turns. Preserve the distinction between a user-authored claim and agent-authored test code, and resolve the issue's module-rewrite vocabulary question.

### [#683 — parallel API and UI lanes](https://github.com/substrat-run/substrat/issues/683)

- **Idea:** Run guarded API and UI generation concurrently, then gate once at their join; carry lane identity through hosted events, history and usage if local results warrant a hosted port.
- **State:** [#2200](https://github.com/substrat-run/substrat/pull/2200) shipped opt-in **sequential** lanes locally. Parallel execution and hosted lane tagging are unbuilt; the current eval fixtures cannot yet measure the UI lane.
- **Parked because:** The proposal is conditional on [#682](https://github.com/substrat-run/substrat/issues/682) showing that wall-clock savings matter after its token-cost comparison. That evidence is missing.
- **Resume when:** A concept fixture with screens lets [#630](https://github.com/substrat-run/substrat/issues/630) measure sequential lanes against an unlaned build, and the results show a wall-clock cost worth concurrent execution. The issue holds the local join and hosted plumbing questions.
