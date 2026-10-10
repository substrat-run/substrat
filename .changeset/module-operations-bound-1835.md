---
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'@substrat-run/boundary-lint': minor
'@substrat-run/engine-absence': patch
'@substrat-run/engine-booking': patch
'@substrat-run/engine-invites': patch
'@substrat-run/engine-invoicing': patch
'@substrat-run/engine-metering': patch
'@substrat-run/engine-protocol': patch
'@substrat-run/engine-workorder': patch
'create-substrat': patch
'@substrat-run/docs': patch
---

**Breaking:** a module registration's handlers are bound to its declared operations by a type (#1835). Migrate in two lines:

- Replace `operationInputs: operationInputsOf(ops), operations: { … } satisfies OperationImpl<typeof ops, OperationContext>` with `...operationsFor(ops)({ … })`, imported from `@substrat-run/kernel`. Also drop any `operationConcurrency` / `operationIdempotencyOptOuts` lines; the binder derives both.
- A module with no declared operations wraps its map as `...undeclaredOperations('why it has none', { … })`.

What changes:

- `ModuleRegistration.operations` now takes a `BoundOperations`, and only `operationsFor` and `undeclaredOperations` produce one, so a hand-written `operations: { … }` no longer compiles. The brand is type-only: the host reads the same object it always did, and a deployed bundle is unaffected.
- `operationsFor(ops)(handlers)` holds the handlers exactly to the declaration. A missing, extra or mistyped handler is a compile error at that entry, and so is one whose type was erased with `as never` or `as any`. From the same declaration it returns the input schemas the host parses with, the `If-Match` concurrency map and the idempotency opt-outs.
- `@substrat-run/boundary-lint` adds **R11**, which refuses a cast of the whole map: an `as` on an `operations:` value or on either binder's handler argument. That is the one spelling the type cannot see. A deliberate cast goes in a `boundary-lint-allow R11` … `boundary-lint-end R11` block.
- `@substrat-run/contract-tests` exports `testOperations(handlers)`, the `undeclaredOperations` shorthand its fixtures use.
- The engines and the `create-substrat` template now bind through `operationsFor`. Their behaviour is unchanged.
