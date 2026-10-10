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

- `ModuleRegistration.operations` is now a `BoundOperations`, one value holding the `handlers` and the three maps derived from their declaration: `inputs`, `concurrency` and `idempotencyOptOuts`. The `operationInputs`, `operationConcurrency` and `operationIdempotencyOptOuts` fields are gone, so a registration can neither forget a map nor pair its handlers with another declaration's. Only `operationsFor` and `undeclaredOperations` produce the value. It is a class with an ES-private brand, so a hand-written `operations: { … }`, a spread of a bound value or a copy with one map swapped does not compile. Both adapters also refuse such a value at registration (`assertBoundOperations`). Apart from that new refusal, what the host parses, compares and refuses is unchanged.
- `operationsFor(ops)(handlers)` holds the handlers exactly to the declaration. A missing, extra or mistyped handler is a compile error at that entry, and so is one whose type was erased: cast `as never` or `as any`, or typed with `any` parameters or an `any` return. From the same declaration it returns the input schemas the host parses with, the `If-Match` concurrency map and the idempotency opt-outs.
- `@substrat-run/boundary-lint` adds **R11**, for the casts no type can see. It refuses:
  - an `as` or `<T>` on the whole map, at an `operations:` key, the shorthand `operations`, a binder's handler argument, or the initializer of the local name handed over there;
  - a cast on any entry of the handlers a binder is given;
  - a cast to `BoundOperations` or `ModuleRegistration['operations']` anywhere in module code.

  A deliberate cast goes in a `boundary-lint-allow R11` … `boundary-lint-end R11` block. **R2** also refuses module code importing a test seam: `@substrat-run/kernel/testing`, `@substrat-run/contract-tests` or `@substrat-run/engine-test-kit`.
- `@substrat-run/contract-tests` exports `testOperations(handlers, derived?)`. With handlers only, it is the `undeclaredOperations` shorthand its fixtures use. With `derived`, it is the test seam the refusal suites use to hand the host maps that no binder made, built through the kernel's new `@substrat-run/kernel/testing` subpath.
- The engines and the `create-substrat` template now bind through `operationsFor`. Their behaviour is unchanged.
