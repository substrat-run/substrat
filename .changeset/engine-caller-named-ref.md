---
'@substrat-run/contracts': minor
'@substrat-run/contract-tests': minor
'@substrat-run/engine-absence': minor
'@substrat-run/engine-protocol': patch
---

An engine declares a check narrowed to a ref the caller owns, and absence's are driven

`engines/absence` narrows six checks to `subject: EntityRef`, and until now they were
**undeclarable rather than undeclared** — two separate problems that had to be fixed in order.
The format could not hold them: a narrowed check named `entity: '<a type from a declared
registry>'`, and absence narrows to Meridian's `employee`, which appears in no registry absence
can see. #890's `entityFrom` did not reach it either — it changes where the type name comes
from, not that it has to be a name someone declared.

`refFrom` names the input field carrying the whole `EntityRef`. One field, both halves: the type
travels with the id, so there is nothing left for `entity` or `idFrom` to say, and declaring
either alongside is a compile error. A dotted path reaches one level in, for absence's `request`,
where the erasure key rides beside the ref in `subject: { ref, dataSubjectId }`.

**The kit drives these, and the harness plays the vertical.** A suite declares `refEntityType` —
absence's names `employee`, a noun the engine has never heard of — and `createEntity` mints a bare
ULID without writing a row anywhere, because a subject ref is exactly that: an opaque pointer the
vertical owns. A grant resolves against a ref whether or not any table on the engine's side knows
it, which is what makes the engine's indifference to the noun testable rather than merely stated.
Without a `refEntityType` the operations are reported uncovered, never skipped.

Driven rather than argued — `absence/balance` mutated to check the node:

```
× absence/balance — absence:read on employee, ref from 'subject'
  → denied a principal holding absence:read on the very employee it was invoked against
    — the handler is checking the node, not the entity
```

## engines/absence declares its operation surface

All eleven, in `src/operations.ts`, with `src/schemas.ts` carrying the shapes — the last of #891's
five packages. Four checks declare `refFrom` and are driven (`request`, `balance`, `availability`,
`list-entries`); all four were already honoured.

**The other two narrowed checks declare node keys, and that is the finding worth reading.**
`cancel` has two authorities and the narrowed one reads its ref off the STORED request, so there
is no field to name; `list-requests` narrows only when the caller supplies a subject, and a
`refFrom` on an optional field would claim a narrowing that a caller omitting it never gets. Both
are stated in `operations.ts` rather than left to be inferred, and both are the shapes #892 already
met in Meridian and Shop.

**Breaking at the operation seam:** three list reads now answer `Page<T>` (#811). Meridian composes
this engine by CALL — `requestAbsence`, `balanceAsOf`, `listEntries` — and those in-scope functions
are unchanged, so no consumer moves. **No migration:** `absenceEntities` declares one entity, the
ledger and the request book are rows rather than registry entities, and the leave-type read answers
a projection — so `paged.over` has nothing to name and no list index is provisioned. The ledger's
cursor is the `(effectiveDate, id)` pair, because `effective_date` is caller-supplied and an accrual
dated last year may be written today; the walk is driven in a test rather than asserted as a string.

## engine-protocol says what it actually does

`protocol/list-for-entity` declared `narrows`, which describes a per-row proof walk. It checks ONE
parent and then queries. It now declares `entityFrom`, which is true, and the kit reports it
**uncovered with a reason** — the type comes from an open `z.string()`, since an engine cannot
enumerate its callers' nouns. That is a louder outcome than being out of scope, and it is the
honest one: a real narrowed check that nothing is driving.
