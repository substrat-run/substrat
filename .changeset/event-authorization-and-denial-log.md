---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

Record what authorized a mutation on its event, and what was refused (K-34, K-35).

**K-34 — authorization on the event envelope.** `ctx.check` computes a `Decision` whose
allow branch carries the proof chain, and the kernel discarded it — so a mutation-event
recorded who acted but never under what authority. `DomainEvent` gains an optional,
kernel-stamped `authorization: {permission, grant?}[]`: the checks the emitting operation
passed, plus — when the allow came via a capability grant rather than a role — the granting
tuple's `object` (the entity/node it was granted on). The shape correction from the design
note: there is no grant *id* — a grant is a relation tuple with no surrogate key, so the
tuple's object is what names it; `contracts` exports `grantRefFromProof` for this. The full
proof chain is not persisted (`explain` re-derives it); only the pointer re-derivation
cannot recover — which check was consulted at write time — is kept. Module code can neither
supply it (not on `DomainEventInput`) nor suppress it; system/override actors are
unconditionally allowed, so their checks are not recorded. The operation context is now
built fresh per invoke so the accumulator cannot leak across operations.

**K-35 — a scope-local denial log.** `assertAllowed` threw `PermissionDenied` and nothing
recorded it. A denial happens in the scope's serialization domain and rolls its own
operation back, so it cannot reach the directory access log and would be erased if written
in the operation's transaction. It now lands in a scope-local `_substrat_denials` (actor,
permission, node, operation, at, drained_at), recorded at the operation boundary the moment
a `PermissionDenied` unwinds it — a fresh autocommit write after the rollback, so it
survives. Only enforced denials record; a bare `ctx.check` a module branches on is not a
denial. `PermissionDenied` now carries the checked `permission` and `node`.

Both surfaces are additive kernel-schema changes (a nullable `_substrat_outbox.authorization`
column and the new `_substrat_denials` table), applied on both adapters (pure-SQLite and the
DO port) via KERNEL_DDL + an additive column on existing scopes. Legacy outbox rows read as
`authorization` NULL — honestly unrecorded, not empty. Held to the same contract on both
adapters by new cases in the permission contract suite.
