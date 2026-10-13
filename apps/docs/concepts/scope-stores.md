---
description: "A platform-run object per scope. The vertical declares a binding and a kind, and reaches the object through getScopeStore. Hosted deploy waits until the kind is registered."
---

# Scope stores

A scope store is one platform-run object for one scope. The vertical names a binding and a kind. The platform mints the object and is the only thing that knows which object that binding reaches. The vertical never holds the store itself: its calls go through the platform.

This sits below the [per-tenant stores](./tenancy.md). A tenant store is one database or bucket for the whole tenant. A scope store is one object for one scope, and two scopes keep their own.

## Declaring it

`runtimeNeeds.scopeStores` is a list of `{ binding, kind }`. `binding` is a screaming-snake name. `kind` has no default. The only kind is `graph`.

```ts
scopeStores: [{ binding: 'GRAPH', kind: 'graph' }]
```

A hosted vertical's upload carries no store binding. A call from the vertical leaves through the platform, which checks the binding against what the version the scope runs declares and addresses the object for the scope the request was routed to. A binding already used by another store is refused, and so is the name `ATTACHMENTS`. The vertical's own durable-object bindings count as stores here. The push and the control plane apply the same check, so a manifest that did not come through `substrat push` is refused the same way.

A kind is registered before a push that names it can succeed. No kind is registered yet, so a push that declares a scope store is refused. Hosted deploy of the store script waits on [#2210](https://github.com/substrat-run/substrat/issues/2210).

## Calling it

`getScopeStore` is the door. It checks that the tenant and the scope are a pair the directory has, and it checks no permission. A binding that is not on the host is refused before that read. A host with no control plane takes the vertical from its own configuration (`scopeStores.vertical`) instead of from a scope row:

```ts
const store = await host.getScopeStore(principal, tenantId, scopeId, 'GRAPH');
const count = await store.invoke('increment', { by: 1 });
```

`invoke` takes an operation and its input. Idempotency and observer options belong to a scope operation, and a store call has neither. A name that starts with `substrat.` is refused before the call leaves the vertical. `substrat.export`, `substrat.import`, `substrat.size`, `substrat.wipe` and `substrat.erase` are the platform's operations.

Subject erasure reaches each store through `substrat.erase`, before the subject key is destroyed. It fails closed: when the platform cannot tell whether a deployment holds a store, or cannot ask it, the erasure is refused and the key stays until a retry can reach the store. While no store kind is registered nothing can hold a store, so this changes nothing yet.

The call on the wire is `{ operation, input }`. The answer is `{ result }`, or `{ error: { code, status, body } }`, where `status` is an HTTP error status from 400 to 599. An error with any other status is not the envelope, and it arrives as `bad_envelope`. A store error arrives as `StoreError`. The platform code comes from the HTTP status. The store's own `code` travels in `storeCode`. Its `body` travels in `storeBody` only for a 4xx whose JSON is at most 1 KiB (`STORE_BODY_MAX_BYTES`), because a client can read it. A 5xx body, a larger one, or one that is not JSON stays in the store. The vertical's own code does not see it either: `storeBody` on the error it catches is the same filtered value.

## Later

The declaration and the door are in this stack. Three pieces follow them:

- [#2210](https://github.com/substrat-run/substrat/issues/2210) deploys and versions the store script. Until a kind is registered, a declaring push is refused, and there is no hosted store.
- [#2211](https://github.com/substrat-run/substrat/issues/2211) covers snapshot, fork, preview and reap of the object. The platform drives all of it, together with subject erasure and the meter, from its own record of what each version declares. The vertical's code takes no part.
- [#2212](https://github.com/substrat-run/substrat/issues/2212) is the storage meter.

A kind that runs on the pure adapter ships a `ScopeStoreRunner`: `kind`, `start`, `stop`, and `invoke(address, request)`. The address is `{ tenantId, vertical, scopeId, binding }`. A host starts each runner on the first store call, once. If one runner's `start` throws, the next call starts only the runners that have not started yet. `close` first waits for a start that is in flight, which starts no further runner once `close` has begun, so no runner starts after it. It then calls `stop` on every runner. A `stop` that throws does not keep the others from being called: one failure is rethrown as it is, and several as an `AggregateError`. What that runner answers is tracked on [#2213](https://github.com/substrat-run/substrat/issues/2213).
