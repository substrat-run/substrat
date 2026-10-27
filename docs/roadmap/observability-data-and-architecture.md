---
status: proposed
layer: plan
description: Parked observability, data, compliance and architecture ideas, with the conditions for revisiting them.
---

# Observability, data, compliance and architecture ideas

These entries preserve ideas until their stated triggers provide a reason to plan the work.
The linked issues and design documents retain the detailed questions and acceptance criteria.

### [#1692 — Staff lake query page](https://github.com/substrat-run/substrat/issues/1692)

- Idea: saved, parameterised audit queries in the console, restricted to staff and access-logged.
- State: the [tenant-scoped lake gateway](../architecture/control-plane.md) exists in code but is off pending a real-lake check; no console page calls it.
- Parked pending a real-lake gateway check and an owner for the staff workflow; lake erasure still blocks any payload view.
- Reopen for a named audit need once the gateway is verified. Keep results envelope-only until erasure reaches the lake; start with the questions in [the lake guide](../../apps/docs/book/11-audit-and-the-lake.md).

### [#1751 — Personal-data activity and request handling](https://github.com/substrat-run/substrat/issues/1751)

- Idea: an activity view with purpose and lawful basis, person lookup, a data-request register and two-admin erasure approval.
- State: the admin log and `shredSubject` exist; per-subject read activity, cross-app lookup, the request register and approval flow do not.
- Parked until an owner settles the grain and cost of read logging, where purpose is declared, and how approval precedes irreversible erasure.
- Reopen for a scoped data-request workflow or a concrete compliance requirement; coordinate processor-copy handling with [#860](https://github.com/substrat-run/substrat/issues/860) and the existing [erasure limits](../architecture/kernel-design.md).

### [#860 — Subject disclosure register](https://github.com/substrat-run/substrat/issues/860)

- Idea: answer which processors may hold a subject's data and send a traceable erasure notice when the subject is shredded.
- State: connection and delivery records exist, but no subject-level register or notification phase ships.
- Parked at the decision boundary: the [disclosure-register RFC](../rfc/disclosure-register.md) now recommends deriving subject edges from existing journals plus declared data classes, but remains proposed.
- Reopen when that RFC is ratified and an owner can build and validate its disclosure read, receipt and notification path; keep the RFC's limits on what a notice proves.

### [#1416 — Tenant-facing push alerts](https://github.com/substrat-run/substrat/issues/1416)

- Idea: deliver actionable failure notices to tenant admins, then consider metric thresholds.
- State: an opt-in staff failure digest ships; it sends no tenant mail, and the notifications engine does not read the platform failure ledger.
- Parked on the recipient policy: verified dashboard owners and admins subscribing themselves would require preferences and a dashboard wire; operator-maintained addresses have different ownership and opt-out costs.
- Reopen when that policy is chosen. The [issue's current-status note](https://github.com/substrat-run/substrat/issues/1416#issuecomment-6420204015) sketches a first daily, tenant-scoped failed-deploy digest; thresholds need their own definition.

### [#1237 — Invocation waterfall](https://github.com/substrat-run/substrat/issues/1237)

- Idea: expand one request into timed work and linked follow-ups, with a backward path to the event that caused it.
- State: cause walks and the request slide-over ship, and some call facts are recorded; the full permission, operation and transaction structure needed for a waterfall is not.
- Parked on where that structure belongs: durable spine facts or observability spans. The [request view](../../apps/dashboard/web/src/views/RequestSlideOver.tsx) currently labels the missing timing detail.
- Reopen when a real workflow needs the detailed waterfall and the recording contract, retention and cost are decided; use [#1752](https://github.com/substrat-run/substrat/issues/1752) for the view design.

### [#1581 — A sanctioned cross-scope read](https://github.com/substrat-run/substrat/issues/1581)

- Idea: a host-run, bounded read across a person's scopes with a declared scope set, page contract and partial-result behavior.
- State: the dashboard's privileged directory read addressed its latency, but ordinary verticals still have no equivalent; the [cross-scope-read RFC](../rfc/cross-scope-read.md) is proposed.
- Parked until a vertical needs this read shape and the RFC's scope-set, authority, cursor and audit questions have an owner.
- Reopen for that concrete screen, then ratify a first per-scope-section slice before designing a globally merged page.

### [#1579 — Enforcement for deployed bundles](https://github.com/substrat-run/substrat/issues/1579)

- Idea: decide what guarantees the platform can enforce when source-level layer rules are not available at admission.
- State: push lint and its receipt exist, while the runtime constrains only capabilities it owns; [D-61](../decisions/D-061-do-originated-egress-is-observed-and-never-refused-d-46-s-limit.md) proposes the egress posture and is not ratified.
- Parked because the remaining enforcement or admission policy has no selected approach or owner.
- Reopen with a concrete admission requirement or a change in the underlying egress capability, then settle D-61 and choose the smallest enforceable mechanism.

### [#1578 — Provider-neutral file-source facet](https://github.com/substrat-run/substrat/issues/1578)

- Idea: a shared connector facet for incremental file enumeration, streaming reads and controlled writes, with a resumable walk.
- State: one file-bearing provider, streams and provider-neutral change/write schemas ship; the shared `FileSource` facet and job-run bridge do not.
- Parked by the 2026-10-23 decision to extract the facet from two real implementations; [connections §6.3](../architecture/connections.md#63-file-bearing-sources-the-reference-shape) records the first shape and invariants.
- Reopen for a second committed provider, a vertical needing mirror freshness, or a large-library first sync that cannot finish; resolve the remaining questions in the [file-source RFC](../rfc/file-bearing-sources.md).
