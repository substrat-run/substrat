---
description: "A platform-run object per scope. The vertical declares a binding and a kind, and reaches the object through getScopeStore. Hosted deploy waits until the kind is registered."
---

# Scope stores

A scope store is one platform-run object for one scope. The vertical names a binding and a kind. The platform mints the object, injects the binding, and is the only thing that knows which object that binding reaches.

This sits below the [per-tenant stores](./tenancy.md). A tenant store is one database or bucket for the whole tenant. A scope store is one object for one scope, and two scopes keep their own.

## Declaring it

`runtimeNeeds.scopeStores` is a list of `{ binding, kind }`. `binding` is a screaming-snake name. `kind` has no default. The only kind is `graph`.

```ts
scopeStores: [{ binding: 'GRAPH', kind: 'graph' }]
```

At push the platform injects `SUBSTRAT_STORE_GRAPH`. That binding is the platform's. A binding already used by another store is refused, and so is the name `ATTACHMENTS`.

A kind is registered before a push that names it can succeed. No kind is registered yet, so a push that declares a scope store is refused. Hosted deploy of the store script waits on [#2210](https://github.com/substrat-run/substrat/issues/2210).

## Calling it

`getScopeStore` is the door. It checks that the tenant and the scope are a pair the directory has, and it checks no permission. A binding that is not on the host is refused before that read. A host with no control plane takes the vertical from its own configuration (`scopeStores.vertical`) instead of from a scope row:

```ts
const store = await host.getScopeStore(principal, tenantId, scopeId, 'GRAPH');
const count = await store.invoke('increment', { by: 1 });
```

`invoke` takes an operation and its input, and nothing else: idempotency belongs to a scope operation, and a store call has none. An operation name is a fixed label: no `@`, no space and no `:`, at most 64 characters. Any other name is refused before the call leaves the vertical, and so is a name that starts with `substrat.`. `substrat.export`, `substrat.import`, `substrat.size`, `substrat.wipe` and `substrat.erase` are the platform's operations.

Each call is recorded on the invocation line of the request that made it, with nothing passed by the vertical. An entry is the binding, the operation, `ok` or `error`, and the duration. The input is not on the line, and neither is the store's error code or body. A line names the first 16 calls and counts the rest in `storeCallsDropped`. A line for a request that made no store call has neither key. A call made outside a request is not recorded and still runs.

`getScopeStore` takes an optional last argument, `{ onStoreCall }`. When it is passed, that observer hears each call instead of the request's line. It carries no authority, and a throw from it does not change the store's answer.

The call on the wire is `{ operation, input }`. The answer is `{ result }`, or `{ error: { code, status, body } }`. A store error arrives as `StoreError`. The platform code comes from the HTTP status. The store's own `code` and `body` travel in `storeCode` and `storeBody`.

## Later

The declaration and the door are in this stack. Three pieces follow them:

- [#2210](https://github.com/substrat-run/substrat/issues/2210) deploys and versions the store script. Until a kind is registered, a declaring push is refused, and there is no hosted store.
- [#2211](https://github.com/substrat-run/substrat/issues/2211) covers snapshot, fork, preview and reap of the object.
- [#2212](https://github.com/substrat-run/substrat/issues/2212) is the storage meter.

A kind that runs on the pure adapter ships a `ScopeStoreRunner`: `kind`, `start`, `stop`, and `invoke(address, request)`. The address is `{ tenantId, vertical, scopeId, binding }`. What that runner answers is tracked on [#2213](https://github.com/substrat-run/substrat/issues/2213).
