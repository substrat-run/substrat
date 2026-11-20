---
id: D-74
date: 2026-11-20
layer: plan
title: "A subject access export (Art. 15) reads what erasure reaches, through one shared plan; staff-only in v1, outside the residency gate, and without recipients until the disclosure register exists"
status: proposed
aliases: []
amends: []
tracking: []
---

# D-74 — A subject access export (Art. 15) reads what erasure reaches, through one shared plan; staff-only in v1, outside the residency gate, and without recipients until the disclosure register exists

> Proposed, not accepted. The design, the alternatives and the open questions are in
> [rfc/subject-access.md](../rfc/subject-access.md).

**The platform answers "what do you hold about me" by reading exactly the places a subject erasure
writes, and both go through one plan.** The subject-match predicate `moduleErasurePlan` builds for
erasure becomes one exported function. A new kernel read, `readSubject`, uses it on both adapters
over the event log, the declared entities, bindings, platform intents, job runs and platform
stores. A contract test runs `readSubject` then `shredSubject` on the same subject and asserts the
counts agree, so the two guarantees cannot drift. The event read is wider than erasure's on
purpose: it returns every outbox row with the subject's id, `piiClass: 'none'` included, and an
already-erased event as its envelope.

**The route is `POST /tenants/:t/scopes/:s/subjects/:id/access`, staff-only in v1**, beside
`…/shred` and absent from `BUILDER_ROUTES`. The builder forwards the request, staff run it, and the
package goes back to the builder, who answers the person. It is audited in both logs and returns a
receipt of counts, never content.

**The package is exempt from the jurisdiction gate** every bulk export carries (K-7, K-32). The
exemption covers this route alone, one subject per call, never `full` scope data, and the receipt
records `residencyExempt: true`. No hosted scope is pinned today, since only `global` is
provisionable, so this is decided ahead of the work that makes `eu` real.

**v1 ships without the recipients section.** The package carries
`recipients: { status: 'not-available', reason }`, never an empty list, until P1 of the disclosure
register (`listSubjectDisclosures`) lands and fills it.

The package also carries derived data categories, the platform's storage locations and retention
windows, and the same unreached list a shred receipt names. It masks other subjects' ids and other
actors with the pseudonymizer the masked exports use. The purposes, lawful basis, retention of live
data and the review of other people's data stay the controller's.

## Why

**Erasure already did the hard part of access.** To erase a person the platform had to know where
they are, so a second, separately maintained map of the same person would be the way the two come
to disagree. One plan plus a parity test makes "everything erasure reaches, access reads" a gate
instead of a claim.

**Staff-only, because the door is not ready for builders yet.** The package is the most
concentrated personal-data artefact the platform produces. A builder door needs an authority model
the platform does not have: which role may pull a person, and under what recorded reason. Access
destroys nothing, so the case for opening it later is stronger than for erasure (D-45). That door
is the RFC's last phase.

**Outside the residency gate, because the law requires this copy to leave.** Art. 15(3) obliges the
controller to hand the person a copy within a month. Residency is the platform's promise to the
controller about where it processes the controller's data, not a limit on where the controller
sends its own. A disclosure to the person the data is about is not a Chapter V transfer on our
reading, which the RFC asks counsel to confirm before an `eu` scope exists. A gate here would make
the platform the reason a controller misses a statutory deadline.

**Without recipients, because waiting would hold the most-asked half behind the least-built half.**
An explicit `not-available` keeps the package honest, and the section is additive, so it lands
later without changing any consumer.
