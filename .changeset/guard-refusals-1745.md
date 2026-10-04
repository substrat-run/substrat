---
'@substrat-run/kernel': minor
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/engine-protocol': patch
---

A manifest-declared guard that refuses an operation is now recorded, beside refused lifecycle moves (#1745).

When a guard predicate the kernel runs before an operation throws a `conflict`, both adapters write a row of kind `guard` to the scope's refusal log after the rollback, the way a refused transition is recorded. The row holds the predicate's name, the operation, the problem's `reason`, the record when the predicate named it, the actor and the call. It holds no state, and never the error's message, the operation's input or the guard's config. Any other throw from a predicate, and a guard whose predicate no module contributes, still blocks the operation and records nothing. A guard a vertical composes into its own operation is not recorded.

A refusal row now keeps only the model's own vocabulary. A transition's from-state is recorded only when the lifecycle declares it, and as `undeclared` otherwise, never as whatever the record's status column held. A reason is recorded only when it is a code, and as `unrecognized` otherwise. A record's type is recorded only when it is spelled as an entity type, and as `undeclared` otherwise; its id is kept.

- **contracts**: `problemReason`, the snake_case grammar every problem code is written in (at most `PROBLEM_REASON_MAX`, 64), `UNRECOGNIZED_REFUSAL_REASON`, `UNDECLARED_STATE`, and `refusalEntityType` / `UNDECLARED_ENTITY_TYPE` / `REFUSAL_ENTITY_TYPE_MAX`. `assertTransition` carries a declared `from` or `UNDECLARED_STATE`. `refusalRecord.fromState` is now nullable (null on a guard row), and the record gains `guard`. `refusalFilter` takes an optional `kind`. New `nameRefusedRecord(err, { entityType, entityId })` and `refusedRecordOf(err)`, which let a predicate name the record its refusal is about.
- **kernel**: `markGuardRefusal`, `refusalOf`, the `RefusedGuard` type, and `REFUSALS_REBUILD` / `refusalsAdmitGuards`. `refusalInsert` accepts a guard refusal and now writes the `reason` column for both kinds. `readLifecycleFlow`'s `refused` counts transition rows only.
- **adapters**: `_substrat_refusals` gains `guard` and `reason`, and `from_state` drops its NOT NULL. A scope that holds the old table rebuilds it on its next wake, in one transaction, keeping every row and the index. `listRefusals` reads both kinds.
- **engine-protocol**: `requireSigned` and `requireCountersigned` name the record on their `protocol_required` refusal, so a `protocol/all-signed` guard refusal counts against it.
