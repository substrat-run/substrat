---
id: D-67
date: 2026-10-31
layer: plan
title: "The graph driver is admitted under a reviewed-release isolation lift"
status: proposed
aliases: []
amends: ["D-63"]
tracking: ["#2210", "#2394"]
---

# D-67 — The graph driver is admitted under a reviewed-release isolation lift

> **Proposed 2026-10-31, not ratified.** This is the decision record that step 5 of the
> [store-driver release approval RFC](../rfc/store-driver-release-approval.md) and
> [graph store registration](../rfc/graph-store-registration.md) wait for. Ratifying it is a
> policy choice about tenant isolation; it is written so that the choice can be made, not to
> make it.

**The graph driver may be registered with `isolationBasis: {kind: 'decisionRecord',
decisionRecord: 'D-67'}`, although D-63's three isolation conditions are not met by
construction. The review of each release, recorded in its approval (D-65), stays the control
between that release and the tenants it serves, and this record states the risk accepted in its
place.**

## The conditions, as they stand

D-63 lifts its rule for a third-party driver once that driver "cannot affect data outside the
object it serves by construction". For the graph driver:

| D-63 condition | Met? | Why |
| --- | --- | --- |
| A separate script per tenant | No | One script per (driver, vertical) serves every tenant of that vertical (D-63, K-49). |
| No outbound access | To be shown per release | The driver needs no outbound calls; the review records whether the uploaded script can make any. |
| Verification of the envelope outside the driver's reach | No | The generated Python store entry verifies the envelope in the same script and isolate as the driver. |

## What stands in their place

- **Per-object separation inside the driver.** The driver builds one runtime per object name
  and never shares a runtime between two objects. An object refuses a call that names another
  object. The approval's review checks this, together with the absence of per-object state at
  module level, as D-65 already requires.
- **The release controls of D-65.** A person approves exact bytes after reading the named source
  references; a canary calls every reserved operation before any vertical moves; a rollback
  returns to the last good release.
- **A narrow first use.** Until isolation exists by construction, the graph driver serves only
  verticals whose operator accepts that their tenants share the driver's isolate, and holds
  synthetic data until the driver's subject erasure (`substrat.erase`) is implemented. Today that
  operation answers `{erased: 0}`.

## The same footing as the platform's own code

Substrat already keeps tenants apart inside one script by review rather than by construction:

- The platform's own Durable Objects (the control-plane directory, scope copies, observability)
  serve every tenant from the platform's scripts, so objects of different tenants may share an
  isolate.
- Vertical code runs in one stable script per vertical (K-28, K-33), so tenants of one vertical
  share it. What keeps their data apart is a scope object per scope, the router's choice of scope,
  the kernel's permission doors and the absence of a raw namespace binding. The hosting notes say
  plainly that this does not contain hostile bundle code; admission and review do.
- `docs/rfc/store-instances.md` states the mechanism: objects of one class in one script may share
  an isolate; only a separate script makes two objects' data mechanically separate (K-53's script
  per tenant is the one place that buys it).

This record asks for the graph driver to stand on that same footing: one script per (driver,
vertical), its tenants kept apart by the driver's own per-object design and by the review of each
release, as the platform's own objects and verticals are.

## Evidence for the review

The driver's repositories carry evidence that the per-object separation holds, so the review
starts from it rather than from a reading alone:

- **An inventory of all state one process shares** in the driver's code and the libraries it
  uses, each place with its verdict. None is keyed by or holds what a tenant wrote: the compiled
  rule and derivation programs and patterns are kept per object, resource identities are parsed
  without the standard library's process-wide `urlsplit` cache, and each object has its own
  identity generator. Four places that did carry something between objects were changed.
- **Architecture tests** that parse the driver's source and fail on any new module-level or
  class-level state, cache, `global` or mutable default that is not on the reviewed list, with
  self-checks that 42 offending forms are caught.
- **A two-tenant test**: a random workload of two tenants, with the same session ids and
  idempotency keys, run step by step and concurrently with forced interleaving at every store
  call. Each tenant gets exactly the answers it gets alone, no answer, stored row or identity of
  one appears in the other, and a call naming the other object is refused. It runs in process, on
  a local workerd, and on a deployed test worker with the two tenants' objects shown to share one
  isolate before and after the run. Deliberate leaks (a shared program cache, a shared package
  holding area, a shared idempotency memory) each fail it.

The evidence lowers the chance of a defect; it does not replace the review of each release, and it
says nothing about a release written to behave badly, which only the review can catch.

## The risk accepted

A defect or a malicious change in an approved release could read or change another tenant's
object of the same vertical, or exhaust the isolate and restart that vertical's objects. Review
lowers the chance of the first; it does not rule it out. Tenants of other verticals are not
reachable, because each vertical has its own script.

## Revisit

This record is revisited, and the lift withdrawn, when any of these holds: a script per tenant
becomes possible for drivers, envelope verification moves outside the driver's script, or the
graph driver's erasure answer is still a no-op when real personal data is to be stored.
