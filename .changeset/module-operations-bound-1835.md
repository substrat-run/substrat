---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
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

- Replace `operationInputs: operationInputsOf(ops), operations: { … } satisfies OperationImpl<typeof ops, OperationContext>` (and any `operationConcurrency` / `operationIdempotencyOptOuts` line) with `...operationsFor(ops)({ … })`, imported from `@substrat-run/kernel`.
- A module with no declared operations wraps its map as `...undeclaredOperations('why it has none', { … })`. Code that reads a registration's handlers reads `registration.operations?.handlers`.

What changes:

- `ModuleRegistration.operations` is now a `BoundOperations`, one value holding the `handlers` and the three maps derived from their declaration: `inputs`, `concurrency` and `idempotencyOptOuts`. The `operationInputs`, `operationConcurrency` and `operationIdempotencyOptOuts` fields are gone, so a registration can neither forget a map nor pair its handlers with another declaration's. Only `operationsFor` and `undeclaredOperations` produce the value, so a hand-written `operations: { … }` no longer compiles. Both adapters read the new shape. What the host parses, compares and refuses is unchanged.
- `operationsFor(ops)(handlers)` holds the handlers exactly to the declaration. A missing, extra or mistyped handler is a compile error at that entry, and so is one whose type was erased with `as never` or `as any`. From the same declaration it returns the input schemas the host parses with, the `If-Match` concurrency map and the idempotency opt-outs.
- `@substrat-run/boundary-lint` adds **R11**, which refuses a cast of the whole map: an `as` on an `operations:` value or on either binder's handler argument. That is the one spelling the type cannot see. A deliberate cast goes in a `boundary-lint-allow R11` … `boundary-lint-end R11` block.
- `@substrat-run/contract-tests` exports `testOperations(handlers, derived?)`. With handlers only, it is the `undeclaredOperations` shorthand its fixtures use. With `derived`, it is the test seam the refusal suites use to hand the host maps that no binder made.
- The engines and the `create-substrat` template now bind through `operationsFor`. Their behaviour is unchanged.
