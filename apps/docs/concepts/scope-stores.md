---
description: "A platform-run object per scope. The vertical declares a binding and a kind. The platform holds the namespace and the key, and opens the object."
---

# Scope stores

A scope store is one platform-run object for one scope. The vertical names a binding and a kind. The platform mints the object and is the only thing that opens it.

This sits below the [per-tenant stores](./tenancy.md). A tenant store is one database or bucket for the whole tenant. A scope store is one object for one scope, and two scopes keep their own.

## Declaring it

`runtimeNeeds.scopeStores` is a list of `{ binding, kind }`. `binding` is a screaming-snake name. `kind` has no default. The only kind is `graph`.

```ts
scopeStores: [{ binding: 'GRAPH', kind: 'graph' }]
```

The platform does not put the store's namespace or its signing key on the vertical. A binding already used by another store is refused, and so is the name `ATTACHMENTS`.

A kind is registered before a push that names it can succeed. No kind is registered yet, so a push that declares a scope store is refused. There is one store script per kind and vertical, and a later release replaces that script in place. The objects stay where they are. Uploading that script into a dispatch namespace is not proven from a local checkout. That remains [#2210](https://github.com/substrat-run/substrat/issues/2210).

## Calling it

`getScopeStore` is the door. It checks the tenant and scope pair the way `getScope` does, and that the binding is declared for the version being served. It does not check a permission. The operation that calls does that first.

```ts
const store = await host.getScopeStore(principal, tenantId, scopeId, 'GRAPH');
const count = await store.invoke('increment', { by: 1 });
```

On a hosted deploy the call leaves the vertical as a fetch of `store.substrat.internal`. Egress hands it to the router. The router knows the caller from the dispatch policy it set when the worker started, which the worker cannot change. It signs the object name and addresses the store script. The first version reaches only the scope the request was routed to.

`invoke` takes an operation and its input. An operation name is a fixed label: no `@`, no space and no `:`, and at most 64 characters. Idempotency belongs to a scope operation, and a store call does not take it. A name that starts with `substrat.` is refused. `substrat.export`, `substrat.import`, `substrat.size`, `substrat.wipe` and `substrat.erase` are the platform's operations. The store accepts them only for the platform's own signature. The control plane calls the store script directly for those.

The request's invocation line records the call: the binding, the operation, whether it succeeded, and how long it took. Not the input. The vertical does not pass an observer for that. An observer it does pass is the one that is used. A line names at most 16 calls and then counts the rest as `storeCallsDropped`. A call made where no request is current is not logged.

The call on the wire is `{ operation, input }`. The answer is `{ result }`, or `{ error: { code, status, body } }`. A store error arrives as `StoreError`. The platform code comes from the HTTP status. The store's own `code` and `body` travel in `storeCode` and `storeBody`.

A direct binding exists for local development and for tests. It is not an isolation boundary. Hosted isolation is the hop above.

## Erasure

Subject erasure calls `substrat.erase` on every binding of the scope, after the scope's own rows are redacted and before the subject's key is destroyed. The receipt lists each binding and how many rows that store said it erased. A store that answers with an error stops the erasure before the key is touched. `erase` is idempotent, so the next run finishes.

## Snapshot, restore, and backup

A scope dump carries `stores`: one entry per binding, with the kind and the tables `substrat.export` returned. An old dump has no list, and loads as a scope that had none. Import and restore call `substrat.import`, which replaces the object. A dump that names a binding the scope does not have is refused before anything is written. Reap, deleting a snapshot, and deleting the scope call `substrat.wipe` before the storage goes.

A restore, and a snapshot copy, then run `substrat.erase` again for every subject whose key was destroyed, on every binding, whatever the time. The receipt counts those calls as `storeErasuresReplayed`. A failed call leaves the restore incomplete, and running it again finishes. The backup file at rest is not reached until someone restores it.

## The storage meter

The gauge keeps one row per binding per day in `_substrat_scope_store_storage`, beside the scope database's own sample. The sweep reads both on the same pass, and at most once a day. The hosted reading asks the store script for `substrat.size`. `/meters` adds the store bytes up as `stores` when a sample exists, and leaves the field off when it does not. Retention drops the store rows on the same horizon as the database samples.

## What is still open

No kind is registered. `STORE_KINDS` is empty until a release is pinned, and a push that declares a scope store is still refused.

A store call works during a request. A call from a Durable Object, including a scheduled job, does not pass egress and is refused. The platform's own jobs call the store script directly and are not affected.

A kind that runs on the pure adapter ships a `ScopeStoreRunner`: `kind`, `start`, `stop`, and `invoke(address, request)`. The address is `{ tenantId, vertical, scopeId, binding }`.
