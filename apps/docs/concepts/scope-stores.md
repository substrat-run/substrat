---
description: "A platform-run object per scope. The vertical declares a binding and a kind, and reaches the object through getScopeStore. Hosted deploy waits until the kind is registered."
---

# Scope stores

A scope store is one platform-run object for one scope. The vertical names a binding and a kind. The platform mints the object, injects the binding, and is the only thing that knows which object that binding reaches.

This sits below the [per-tenant stores](./tenancy.md). A tenant store is one database or bucket for the whole tenant. A scope store is one object for one scope, and two scopes keep their own.

## Declaring it

`runtimeNeeds.scopeStores` is a list of `{ binding, kind }`. `binding` is a screaming-snake name. `kind` has no default. The only kind is `ontomate`.

```ts
scopeStores: [{ binding: 'GRAPH', kind: 'ontomate' }]
```

At push the platform injects `SUBSTRAT_STORE_GRAPH`. That binding is the platform's. A binding already used by another store is refused, and so is the name `ATTACHMENTS`.

A kind is registered before a push that names it can succeed. No kind is registered yet, so a push that declares a scope store is refused. Hosted deploy of the store script waits on [#2210](https://github.com/substrat-run/substrat/issues/2210).

## Calling it

`getScopeStore` is the door. It makes the same directory check as `getScope`, then reaches the binding:

```ts
const store = await host.getScopeStore(principal, tenantId, scopeId, 'GRAPH');
const count = await store.invoke('increment', { by: 1 });
```

`invoke` takes an operation and its input. Idempotency belongs to a scope operation, and a store call does not take it. A name that starts with `substrat.` is refused before the call leaves the vertical. `substrat.export`, `substrat.import`, `substrat.size`, `substrat.wipe` and `substrat.erase` are the platform's operations.

`getScopeStore` takes an optional observer as its last argument. The observer carries no authority. It hears the binding, the operation, whether the call succeeded, and how long it took. It does not hear the input. The invocation record lives on the request, which this door cannot see, so a vertical that wants the line filled passes `scopeStoreInvocationObserver(record)`. A line names at most 16 calls. A request that made none has no `storeCalls` field.

The call on the wire is `{ operation, input }`. The answer is `{ result }`, or `{ error: { code, status, body } }`. A store error arrives as `StoreError`. The platform code comes from the HTTP status. The store's own `code` and `body` travel in `storeCode` and `storeBody`.

## Erasure

Subject erasure calls `substrat.erase` on every binding of the scope, after the scope's own rows are redacted and before the subject's key is destroyed. The receipt lists each binding and how many rows that store said it erased. A store that answers with an error stops the erasure before the key is touched. `erase` is idempotent, so the next run finishes.

## Snapshot, restore, and backup

A scope dump carries `stores`: one entry per binding, with the kind and the tables `substrat.export` returned. An old dump has no list, and loads as a scope that had none. Import and restore call `substrat.import`, which replaces the object. A dump that names a binding the scope does not have is refused before anything is written. Reap, deleting a snapshot, and deleting the scope call `substrat.wipe` before the storage goes.

A backup copies those tables as they are. They are not sealed per subject. The spine's payloads in the same backup are. `substrat.erase` reaches the live store. It does not reach the copy already in a backup, and a restore brings that copy back.

## The storage meter

The gauge keeps one row per binding per day in `_substrat_scope_store_storage`, beside the scope database's own sample. The sweep reads both on the same pass, and at most once a day. `/meters` adds the store bytes up as `stores` when a sample exists, and leaves the field off when it does not. Retention drops the store rows on the same horizon as the database samples.

## What is still open

No kind is registered. `STORE_KINDS` is empty until a release is pinned, and a push that declares a scope store is still refused.

The upload plan is one script per kind and vertical. The script name and the object name both leave the release out, so a new release does not move the objects. A call can carry an HMAC of the object name. The key is the control plane's and the store script's, not the vertical's. Uploading that script into a dispatch namespace, and a cross-script Durable Object binding there, are not proven from a local checkout. That remains [#2210](https://github.com/substrat-run/substrat/issues/2210).

A kind that runs on the pure adapter ships a `ScopeStoreRunner`: `kind`, `start`, `stop`, and `invoke(address, request)`. The address is `{ tenantId, vertical, scopeId, binding }`. What that runner answers is tracked on [#2213](https://github.com/substrat-run/substrat/issues/2213).
