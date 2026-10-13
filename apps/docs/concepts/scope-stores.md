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

A hosted vertical's upload carries no store binding. A call from the vertical leaves through the platform, which checks the binding against what the version the scope runs declares and addresses the object for the scope the request was routed to. A binding already used by another store is refused, and so is the name `ATTACHMENTS`.

A kind is registered before a push that names it can succeed. No kind is registered yet, so a push that declares a scope store is refused. Hosted deploy of the store script waits on [#2210](https://github.com/substrat-run/substrat/issues/2210).

## Calling it

`getScopeStore` is the door. It checks that the tenant and the scope are a pair the directory has, and it checks no permission. A binding that is not on the host is refused before that read. A host with no control plane takes the vertical from its own configuration (`scopeStores.vertical`) instead of from a scope row:

```ts
const store = await host.getScopeStore(principal, tenantId, scopeId, 'GRAPH');
const count = await store.invoke('increment', { by: 1 });
```

`invoke` takes an operation and its input. Idempotency and observer options belong to a scope operation, and a store call has neither. A name that starts with `substrat.` is refused before the call leaves the vertical. `substrat.export`, `substrat.import`, `substrat.size`, `substrat.wipe` and `substrat.erase` are the platform's operations.

The call on the wire is `{ operation, input }`. The answer is `{ result }`, or `{ error: { code, status, body } }`. A store error arrives as `StoreError`. The platform code comes from the HTTP status. The store's own `code` and `body` travel in `storeCode` and `storeBody`.

## Later

The declaration and the door are in this stack. Three pieces follow them:

- [#2210](https://github.com/substrat-run/substrat/issues/2210) deploys and versions the store script. Until a kind is registered, a declaring push is refused, and there is no hosted store.
- [#2211](https://github.com/substrat-run/substrat/issues/2211) covers snapshot, fork, preview and reap of the object. The platform drives all of it, together with subject erasure and the meter, from its own record of what each version declares. The vertical's code takes no part.
- [#2212](https://github.com/substrat-run/substrat/issues/2212) is the storage meter.

A kind that runs on the pure adapter ships a `ScopeStoreRunner`: `kind`, `start`, `stop`, and `invoke(address, request)`. The address is `{ tenantId, vertical, scopeId, binding }`. What that runner answers is tracked on [#2213](https://github.com/substrat-run/substrat/issues/2213).
