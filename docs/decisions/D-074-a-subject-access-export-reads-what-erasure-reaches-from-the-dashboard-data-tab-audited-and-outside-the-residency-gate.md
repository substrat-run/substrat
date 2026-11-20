---
id: D-74
date: 2026-11-20
layer: plan
title: "A subject access export (Art. 15) reads what erasure reaches, through one shared plan; a team's owner or admin runs it from the dashboard's Data tab, recorded under their name, outside the residency gate, and without recipients until the disclosure register exists"
status: proposed
aliases: []
amends: []
tracking: []
---

# D-74 — A subject access export (Art. 15) reads what erasure reaches, through one shared plan; a team's owner or admin runs it from the dashboard's Data tab, recorded under their name, outside the residency gate, and without recipients until the disclosure register exists

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

**A team's owner or admin runs it from the dashboard**, in a new **Personal data** section of the
app's Data tab. The route is `POST /tenants/:t/scopes/:s/subjects/:id/access`, on `TENANT_ROUTES`
and open to staff for requests a customer forwards, and absent from `BUILDER_ROUTES`. A new key,
`dashboard:subject-access`, held by `owner` and `admin` as `dashboard:restore-app-data` is, is
checked by a check-only dashboard operation before the plane is called. The form takes the
person's id, a reference for the request, and a confirmation that the requester's identity was
checked.

**Every request is recorded under the name of the person who made it.** The admin log records
`subjectAccess` with `onBehalfOf` naming the signed-in member, taken from the signed tenant token,
and the staff impersonation stamp when there is one. The K-24 access log records the read. The
team's Audit › Activity shows the row as that member, with a sentence written for the action. The
receipt carries counts, the reference and the confirmation, never content.

**The package is exempt from the jurisdiction gate** every bulk export carries (K-7, K-32). The
exemption covers this route alone, one subject per call, never whole-scope data, and the receipt
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

**The dashboard, because the controller is the one who answers.** A staff relay would add a hop
against a one-month deadline and pass a copy of the person through the platform. The dashboard
already holds what a team door needs: a permission checked in the team's scope, a tenant-pinned
credential with a default-deny route list, and admin rows that name the member (#977). The door
adds no reach: an owner or admin can already read every row in Data › Tables. What is new is one
person's rows, unmasked, in one file, so it is held to the two roles that may restore an app, one
person per call, and a recorded reference. Erasure keeps its own decision (D-45), because it
destroys evidence and access does not.

**Recorded under the member's name, because a pull nobody can see is the risk.** The row comes from
the token, not the caller, and it is shown to the team in Activity, so one admin's request is
visible to the others and to the platform.

**Outside the residency gate, because the law requires this copy to leave.** Art. 15(3) obliges the
controller to hand the person a copy within a month. Residency is the platform's promise to the
controller about where it processes the controller's data, not a limit on where the controller
sends its own. A disclosure to the person the data is about is not a Chapter V transfer on our
reading, which the RFC asks counsel to confirm before an `eu` scope exists.

**Without recipients, because waiting would hold the most-asked half behind the least-built half.**
An explicit `not-available` keeps the package honest, and the section is additive, so it lands
later without changing any consumer.
