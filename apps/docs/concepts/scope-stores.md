---
description: "A platform-run object per scope. The vertical declares a binding and a kind and calls it through getScopeStore. No kind is registered yet, so nothing is live for a vertical today."
---

# Scope stores

A scope store is one platform-run object for one scope. The vertical names a binding and a kind. The platform mints the object and is the only thing that knows which object that binding reaches. The vertical never holds the store itself: its calls go through the platform.

This sits below the [per-tenant stores](./tenancy.md). A tenant store is one database or bucket for the whole tenant. A scope store is one object for one scope, and two scopes keep their own.

## What you can use today

Nothing here is live for a vertical yet. No store kind is registered, and a push that declares a scope store is refused. Everything below is what the platform does once a kind is registered and its store script is deployed.

Today a vertical author can:

- read the declaration and the call shape below, and write code against `getScopeStore` and `StoreStub`;
- run a store locally, on the pure adapter, with a `ScopeStoreRunner` a kind supplies (see the end of this page).

A vertical author cannot yet:

- push a vertical that declares `scopeStores`;
- reach a store from a hosted deploy.

## Declaring it

`runtimeNeeds.scopeStores` is a list of `{ binding, kind }`. `binding` is a screaming-snake name. `kind` has no default. The only kind named so far is `graph`.

```ts
scopeStores: [{ binding: 'GRAPH', kind: 'graph' }]
```

A hosted vertical's upload carries no store binding. The vertical is given neither the store's namespace nor anything that opens it. A binding already used by another store is refused, and so is the name `ATTACHMENTS`. The vertical's own Durable Object bindings count as stores for that check. A name in the `SUBSTRAT_` namespace is the platform's and is refused. The push and the control plane apply the same checks, so a manifest that did not come through `substrat push` is refused the same way.

A kind is registered before a push that names it can succeed. There is one store script per kind and vertical, and a later release replaces that script in place. The objects stay where they are. Uploading that script is [#2210](https://github.com/substrat-run/substrat/issues/2210).

## Calling it

`getScopeStore` is the door. It does not check a permission. The operation that calls does that first.

```ts
const store = await host.getScopeStore(principal, tenantId, scopeId, 'GRAPH');
const count = await store.invoke('increment', { by: 1 });
```

On the platform path the call leaves the vertical as a fetch of `store.substrat.internal`. The egress worker hands it to the router, together with who the caller is. The vertical cannot change that part: it comes from the dispatch, not from the request. The router refuses a `substrat.*` operation, a scope other than the one the request was routed to, and a binding the running version does not declare. Then it addresses the store script. A Cloudflare host takes this path when it is created with `scopeStores: { transport: 'platform' }`. Its default is still the direct binding below.

`invoke` takes an operation and its input, and nothing else. Idempotency belongs to a scope operation, and a store call has none. An operation name is a fixed label: no `@`, no whitespace and no `:`, at most 64 characters. Any other name is refused before the call leaves the vertical. So is a name that starts with `substrat.`. `substrat.export`, `substrat.import`, `substrat.size`, `substrat.wipe` and `substrat.erase` are the platform's operations. The control plane calls the store script for those itself. The vertical is not on that path.

The call on the wire is `{ operation, input }`. The answer is `{ result }`, or `{ error: { code, status, body } }`, where `status` is an HTTP error status from 400 to 599. An answer with any other status is not the envelope, and it arrives as `bad_envelope`. A store error arrives as `StoreError`. The platform code comes from the HTTP status. The store's own `code` travels in `storeCode`. Its `body` travels in `storeBody` only for a 4xx whose JSON is at most 1 KiB (`STORE_BODY_MAX_BYTES`). A client can read that body, so a 5xx body, a larger one, or one that is not JSON stays in the store. The vertical's own code gets the same filtered `storeBody`.

A direct binding exists for local development and for tests. It is not an isolation boundary. The hop above is meant to be the hosted isolation boundary, and it is not finished: it is not the default yet, and the checks the store script runs on each call are not built (see [Known limits](#known-limits)).

## The invocation line

On a pushed vertical, each store call is recorded on the invocation line of the request that made it. The vertical passes nothing for that: the platform entry in front of a pushed vertical tracks the current request. A vertical run without that entry, locally for example, records nothing unless it passes `onStoreCall` (below). An entry has four fields: the binding, the operation, `ok` or `error`, and the duration. The input is not on the line, and neither is the store's error code or body.

The line names the first 16 calls in `storeCalls` and counts the rest in `storeCallsDropped`. A line for a request that made no store call has neither key. A call made outside a request is not recorded and still runs. A call made after the response has gone, inside `waitUntil`, is not recorded either: the line was written when the response left.

`getScopeStore` takes an optional last argument, `{ onStoreCall }`. When it is passed, that observer hears each call instead of the request's line. It carries no authority, and a throw from it does not change the store's answer.

## Erasure

Subject erasure calls `substrat.erase` on every store the scope's version declares, before the subject's key is destroyed. The erasure's answer lists each binding and how many rows that store said it erased. When the control plane erases a scope its own host holds, the host's audited receipt does not list those store erasures yet; only the answer does. A store that answers with an error stops the erasure before the key is touched, and the next run finishes it.

Erasure fails closed. When the platform cannot tell which stores a scope's version declares, or cannot reach them, the erasure is refused with 503 and the key stays until a retry reaches the store.

Erasure reaches the live store. It does not reach a copy already in a backup. See below.

## Snapshot, restore, export and backup

A scope dump carries `stores`: one entry per binding, with the kind and the tables `substrat.export` returned. An old dump has no list, and loads as a scope that had none. On the hosted plane the control plane reads those tables from the store script. A store it cannot name or reach fails the backup, the pull or the export, instead of leaving the store out.

**A store's tables in a backup are not sealed per subject.** The platform cannot see inside them, so it cannot seal a subject's data in them the way it seals the scope's own classified fields. Erasing a subject reaches the live store and never the backup file at rest. The restore replay below is what removes that subject again when the backup comes back.

A masked export carries no stores. The masker cannot see inside them, so they are left out rather than shipped unmasked. The full tenant export carries them.

Restore and import call `substrat.import`, which replaces the object. A dump store whose binding the destination's version does not declare, or declares as another kind, refuses the restore before anything is written.

After a restore, and after a snapshot copy, the platform runs `substrat.erase` again on every store of the destination, for every subject erased in the destination or in the dump's source. Each subject is erased once. The restore's answer reports it, and only when there is something to report:

- `storeErasuresReplayed`: how many erase calls ran.
- `incomplete`: some erasure that applies was not replayed. A failed call is one cause, and running the same restore again finishes it.
- `sourceUnknown`: the dump's source is not a scope of this tenant on this platform, for example another environment's backup or an uploaded file. Its erasures cannot be read, and running the restore again does not change that. An unknown source never refuses the restore.

The host's own `restoreScope` result carries the same facts as `storeErasuresReplayed`, `storeErasureIncomplete` and `storeErasureSourceUnknown`. With none of them present, nothing had to be replayed and nothing is missing.

Reap, deleting a snapshot, reaping a preview and deleting the scope call `substrat.wipe` on each store before the scope's own storage goes. A wipe that cannot run stops the delete, and the scope's storage is left for the retry.

## The storage meter

The storage gauge samples each scope's stores in the same pass as the scope database, at most once a day. The hosted reading asks the store script for `substrat.size`. It keeps one row per binding per day in `_substrat_scope_store_storage`. Retention drops those rows on the same horizon as the database samples.

- A store read has its own deadline. A store that hangs fails that one scope's store reading. The database size just read stands, and the rest of the batch is recorded.
- A store that cannot report its size is not recorded as size 0. The database sample stands, and the store keeps its last reading.
- A version that drops its last binding stops being billed for stores: the day is recorded as measured with no stores in it.

`/meters` adds the store bytes up as `stores` when a sample exists, and leaves the field off when it does not.

## Known limits

These are open, and are tracked in the [scope-stores RFC](https://github.com/substrat-run/substrat/blob/main/docs/rfc/scope-stores.md) (§10.8). The first group is to be closed before the first kind is registered. The second can follow.

Before the first kind:

- **The hosted path is not the default.** A Cloudflare host defaults to the direct binding, and nothing in production sets the platform path yet.
- **The store's checks on each call.** What the platform sends a store script does not yet bind the operation, the audience or the time, and no store script checks it yet. The checks are planned in an entry module the platform supplies in front of the kind.
- **Unroute before wipe.** No path stops routing a scope before it wipes the scope's stores, and an erasure is not fenced against a deploy that lands while it runs.
- **Orphaned bindings.** Every lifecycle path reads only the current version's bindings. Objects under a binding a later version dropped, or declared as another kind, are out of reach of wipe, erase and the meter.

Later:

- **Replay budget.** The restore's erasure replay runs inside one request and starts again from the first subject on a retry. It converges only while it fits one request.
- **Audited receipt.** On the path where the control plane erases a scope its own host holds, the audited receipt lacks the platform's store erasures. The answer carries them.
- **Versions without a kept manifest.** Replay and wipe skip a destination whose version predates kept manifests. Such a version holds no store, and a test that says so is still to come.
- **Delete without a tenant id.** The Cloudflare host's scope delete skips the store wipe when it is not given a tenant id. Hosted, the control plane's own wipe covers it.
- **Peer calls.** A vertical serving a [peer call](../guide/architecture.md#calling-another-vertical-the-peer-door) has its store calls refused.
- **Only during a request.** A call from a Durable Object, including a scheduled job, does not pass egress and is refused. The platform's own jobs are not affected.

## Writing a kind for the pure adapter

A kind that runs on the pure adapter ships a `ScopeStoreRunner`: `kind`, `start`, `stop`, and `invoke(address, request)`. The address is `{ tenantId, vertical, scopeId, binding }`. A host starts each runner once, on the first store call. If one runner's `start` throws, the next call starts only the runners that have not started. `close` waits for a start in flight, starts no runner after that, and then calls `stop` on every runner. A `stop` that throws does not keep the others from being called. One failure is rethrown as it is, and several as an `AggregateError`.

What a runner answers:

- One object per whole address. Two addresses that differ in any one field never share an object.
- `stop` without `start` resolves. A `stop` and then a `start` serve the same objects: they outlive the process, not the runner.
- Every answer is the envelope, `{ result }` or `{ error: { code, status, body? } }`. An operation the kind does not know is an error answer, not a throw.
- `substrat.size` answers `{ bytes }`.
- `substrat.export` answers `{ tables }`, each in the scope-dump table shape.
- `substrat.import` takes `{ tables }`, replaces the whole object, and answers `{ tables }` as the count it wrote.
- `substrat.wipe` answers `{}` and leaves an empty object, also for an address nothing was written to.
- `substrat.erase` takes `{ subjectId }` and answers `{ erased }`. A repeat answers `{ erased: 0 }`.

`scopeStoreRunnerContractSuite` in [`@substrat-run/contract-tests`](../reference/contract-tests.md) holds a runner to each of these. A kind runs it in its own repository, with one write and one read of its own catalog:

```ts
import { scopeStoreRunnerContractSuite } from '@substrat-run/contract-tests';

scopeStoreRunnerContractSuite('graph', {
  makeRunner: () => graphRunner({ dir }),
  write: { operation: 'apply', input: change },
  read: { operation: 'inspect' },
});
```

A dev host reads its bindings from the vertical's declaration with [`scopeStoreRunnersFor`](../reference/adapter-sqlite.md#scope-stores). How a blob cell is spelled in an export that crosses JSON is not settled yet, and the suite does not assert one.
