---
id: D-65
date: 2026-10-28
layer: plan
title: "A store driver release runs after a person approves its uploaded bytes"
status: accepted
aliases: []
amends: ["D-63"]
tracking: ["#2210", "#2297"]
---

# D-65 — A store driver release runs after a person approves its uploaded bytes

> **Ratified 2026-10-28 by the merge of #2683.** This is step 1 of the
> [store-driver release approval RFC](../rfc/store-driver-release-approval.md). It amends D-63's
> release pin and third-party registration rule. It changes no code or registration.

**A store driver is registered in this repo. A release of it runs only once a person on the
platform's staff has approved that release for that driver in the control plane, the approval has
not been revoked, and the driver's registration in this repo still carries an isolation basis that
admits it.** The registration names the driver. The platform names each store script. An approval
names the release's class, operation catalog and `schema`; those facts are fixed at its first
approval. An upload alone never makes a release runnable.

**The platform computes the sha256 of an uploaded release bundle and stores the bytes by driver
and sha256.** The approval records a structured list of `(repository, commit)` source references
for the driver package and every dependency built from a repository. The reviewer also reads the
pyproject/lock. A dependency built from another repository is third-party wherever it is installed;
one resolved from a public package index is install output. The platform does not prove those
references produced the bytes. The uploader's `sourceCommit` stays on the upload, and the release
row records who uploaded it. The approval copies `sourceCommit` as a consistency check. It also
records who approved it, when, why, the release facts, the source references and the isolation
review. There is no two-person rule yet.

**The review behind an approval is the review of what the platform will run for every tenant.** It
records, with evidence, whether each of D-63's three isolation conditions is met, and that the
reviewer checked the envelope, every reserved operation (including `substrat.erase`) and the
absence of per-object state at module level. A condition recorded as not met does not itself
refuse the approval: the review is the control until isolation exists. The canary runs at rollout,
not approval. It runs on the platform's object, calls and asserts every reserved operation before
any vertical moves, and a failed canary moves no vertical. A failure after a move and a deliberate
rollback return to the immediately previous good release, subject to the no-lower-`schema` rule.
The module rule still applies when bytes are uploaded and loaded; an approval has no expiry.

**Moving to a release requires a live approval. Leaving one reads its fixed facts even if its
approval was revoked.** A rollout, rollback, push or serve that builds a script, and a rebuild all
check the approval under the driver's hold. The bytes are re-hashed before every script upload,
including a rollback or return, and the target cannot have a lower `schema` than the release a
script runs. If the approval read fails, the request refuses with 503; no approval is cached. A
stored release is readable only by staff.

**An approval takes effect when written and stands until a staff person revokes it.** Its release
facts never change; an incorrect fact requires new bytes and a new sha256. A revoke stops later
uploads of the release, including a rollback to it, but cannot stop a script already running it.
Without an emergency flag and a reason, revocation is refused while the release is current or any
script of that driver runs it. The guard walks each script's own release setting under the driver's
exclusive hold, in pages, with a cursor ledger; there is no directory table of which release each
script runs. An emergency revoke skips the walk. Every revoke records who made it, when, why and
whether it was an emergency. Approvals and their revocations are kept, never deleted. At most one
approval per `(driver, sha256)` is live; a later approval of the same bytes must carry the same
release facts.

**The driver id and its isolation basis stay in this repo.** A driver written outside this repo is
registered only with an isolation basis naming a decision record that lifts D-63's requirement for
that driver. Without one its registration is refused and no release of it is approved. An approval
under a "written in this repo" basis cannot name another repository in its source references.
The basis is checked wherever an approval is read. The graph driver is written outside this repo;
its registration awaits such a lifting record. The prepared registration in #2394 adds no pin and
does not register it. A future registration adds its id and basis only, after the approval readers
replace pins.

## Why

D-63 requires a person to publish, a review of the exact bytes that will run across tenants, and
an isolation gate in this repo. A separately written, audited approval supplies the first two
without a merged source pin for each repack. The driver id and isolation basis stay compiled in
because a released CLI's push check and the platform's store lifecycle gates need them without a
directory read. The review remains the control while D-63's isolation conditions are unmet.

## Limits and rollout order

- This record decides the policy only. The approval vocabulary and directory tables, staff
  routes, and the switch of every pin reader ship in separate steps of the RFC. No release is
  runnable under approval until all readers switch together. The first rollout after a driver is
  registered waits for a person to attest that the registering deploy has finished.
- A wrong approved `schema` can weaken the no-lower guard. The approver's reading of the release's
  migrations is the check; a new approval cannot correct the fact for the same bytes.
- Revocation stops future uploads. Scripts already on the release continue until a rollout moves
  them. An emergency revoke of the current release can leave a failed roll-forward diverged.
- Excluding installer-written `*.dist-info` files, reading a stored release for staff review, a
  two-person rule, and a controlled build from source remain follow-ups in the RFC. Until the
  staff read exists, a reviewer compares the bundle they hold with the stored digest.
