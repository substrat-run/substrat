---
status: proposed
layer: kernel
description: A platform-run object per scope, declared as a kind and reached through its own door. #2207.
---

# RFC: scope stores

**Status:** proposed · **Tracking:** [#2207](https://github.com/substrat-run/substrat/issues/2207)
· **Evidence:** [spikes/scope-store-binding/FINDINGS.md](../../spikes/scope-store-binding/FINDINGS.md)
· **Decisions:** [K-49](../decisions/K-049-a-scope-store-is-a-platform-run-object-per-scope-reached-by-its-own-door.md),
[D-63](../decisions/D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md),
[K-50](../decisions/K-050-a-hosted-scope-store-s-lifecycle-is-driven-by-the-platform-from-its-own-record.md)
(the hosted lifecycle, §10)

A vertical can hold state in four shapes, and none of them is a service with its own runtime.
`runtimeNeeds.stores` is the vertical's own Durable Object classes. A static `d1` binding is
one database for every tenant. `tenantStores` is one platform-minted relational database per
tenant. `blobStores` is bytes per tenant. Module code has no `fetch`. A connector runs on an
event, at least once. `peerClient` calls another vertical. `ADMISSIBLE_BINDING_TYPES` refuses
`service`, and a `durable_object_namespace` with a `script_name` is refused on a binding the
vertical declares.

The first kind is a graph-database-shaped store: a Python schema and data engine, one
repository per scope, that needs its own script and is called synchronously from the operation the user is waiting on. The mechanism is generic. A new kind
adds a catalog, not a method.

## 1. The trust boundary

The spike ran a counter Durable Object in one worker and addressed it from another with
`idFromName`, through a `durable_object_namespace` binding whose `scriptName` pointed at the
first worker. Two results decide the shape:

- On a script two callers share, the caller chooses the name. One caller incremented
  `tenant-1/vertical-b/scope-1/GRAPH`. The other caller, bound to the same script, read `1`.
  Nothing checked that the name's vertical was the caller.
- One script per vertical closes that. The same name on `store-a` and `store-b` was two
  objects. It does not close the same hole between two tenants of one vertical: they would
  share that script, and a caller who chooses the name can address the other tenant.

So the vertical never chooses the name. `getScopeStore` takes a binding. The platform
builds `<tenantId>/<vertical slug>/<scopeId>/<binding>` from the pair the router asserted
when it dispatched the request, the same pair `getScope` checks against the directory (K-3).

The vertical's worker holds neither the store's Durable Object namespace nor the signing
key. A call leaves the worker as `fetch` of `store.substrat.internal`. Egress forwards
that host to the router's `ScopeStoreCalls` entrypoint and refuses a call that has no
dispatch policy or no scope. The caller is `OUTBOUND_POLICY`, which the router set when
the worker started and which the worker cannot write. The router checks that the scope is
the one in that policy and that the binding is declared on the version being served, signs
the object name, and addresses `substrat-store-<kind>-<vertical>` in the dispatch
namespace. The key is bound on the router and on the store script. This is the same shape
as a call between verticals.

A direct `durable_object_namespace` binding remains for local development and for tests.
It is not an isolation boundary: code in that worker can address any name the binding
reaches. Hosted isolation is the hop above, not that binding.

The signature is HMAC-SHA256 over the object name. The spike's check compared the MAC to
the header and never to the object being addressed, so one signature opened every object.
The design closes that by having the store script remember the first name it accepts and
refuse a later call that names a different object, including one that carries a valid MAC
for that other name. The object cannot read its own `idFromName`, which is why the
remembered string is the signed name. **This is design intent. The spike does not
implement or exercise it** (see Not yet evidenced).

One script per (kind, vertical), upgraded in place. A new release replaces the script.
The objects keep their storage, and the kind migrates its schema when an object wakes.
A script per (kind, version, vertical) would make the next version an empty object and
would require moving every one, so that model is rejected. See D-63. Who uploads the
script, and what a failed upload does to the vertical's push, is still [#2210](https://github.com/substrat-run/substrat/issues/2210).
`substrat dev` runs the kind's runner in-process and does not upload a script.

What the spike did not show is a Workers for Platforms upload. Local miniflare accepts
`scriptName` between workers it was given. The upload API documents `script_name` and
`dispatch_namespace` on a `durable_object_namespace` binding. Whether a user-worker upload
accepts a binding aimed at a platform script is still to be run on an account that has
the product.

## 2. The door

`ScopeStubOptions` is observers. Its comment says they carry no authority and change
nothing about what the stub may do. `getImpersonatedScope` is a separate door for the
same reason: an authority that arrives as an optional parameter on the ordinary path is
one a caller can forget.

`getScope(…, { store })` would put the store on that options bag. This RFC does not.
The door is `getScopeStore(principal, tenantId, scopeId, binding)`. The returned stub
has `tenantId`, `scopeId`, `subjectKind` and `invoke(operation, input)`. `invoke` takes
no `InvokeOptions`. Passing them is an error, the same rule as a silent `ifMatch`.
The type is `StoreStub<Catalog>`, parameterized by the kind's operation catalog.

`getConnectorScope` and `getSystemScope` do not grow a store parameter in this proposal.
A store call is a decision of the vertical's own operation. A later door can be added
if a connector or a schedule needs one; it is not implied.

## 3. Declaration and binding

`scopeStoreNeed` is `{ binding, kind }`. `binding` uses the SCREAMING_SNAKE rule
`tenantStoreNeed` already has. `kind` is `z.literal('graph')` until a second kind
asks to widen it, which is an additive change, the same intent as the comment on
`tenantStoreNeed.kind`. No default: the kind is the choice.

`runtimeNeeds.scopeStores` and `deployManifest.scopeStores` are arrays defaulting to
`[]`. A binding declared twice, or declared as another store's binding, is refused at
push. `ATTACHMENTS` stays reserved.

The platform does not inject a store binding onto the vertical. `ADMISSIBLE_BINDING_TYPES`
does not grow, and the vertical's upload carries no `SUBSTRAT_STORE_*` namespace and no
HMAC key. An undeclared binding is refused by the router before it signs. The name
`SUBSTRAT_STORE_<BINDING>` is the direct binding used in local development and tests,
and that binding is not an isolation boundary (§1).

**Implementation status / scaffolding.** The implementation stack (#2224, #2225)
currently injects a raw `SUBSTRAT_STORE_<BINDING>` `durable_object_namespace` into the
serving upload. That is temporary scaffolding and does not match the intent above. It is
inert while no store kind is registered. It is removed and replaced by the signed router
hop of §1 before the first kind is registered (§10.9, rule L1). The guard on main
(`control-plane-api/test/deploy.test.ts`) fails if a kind is registered while that
injection exists.

A push that names a kind with no registration is refused twice: by the CLI's push check,
and again by the control plane on upload. A declaration the platform cannot run is not
stored as if it could. See D-63.

The vertical slug is not a field of the Cloudflare host today. It comes from the scope
record when the control plane is present, and from the host option the pure adapter
takes for dev and tests. The host needs it to build the object name. A deployed vertical's
host has no control plane, so in production the name is built by the router and the
control plane, from their own records, and never by the vertical (§10.6).

## 4. The envelope

One envelope, over the object's `fetch`. The request is `{ operation, input }`. The
response is `{ result }` or `{ error: { code, status, body } }`. `StoreError` extends
`SubstratError` with a closed code derived from the status. The store's own `code` and
`body` ride in `extensions`, the way `PermissionDenied` and `ImpersonationRefused` keep
a closed code and add their own facts.

Reserved names, only the platform may send:

| operation | input | result | what it does |
|---|---|---|---|
| `substrat.export` | none | `{ tables }` | the kind's dump, each table a `scopeDumpTable` |
| `substrat.import` | `{ tables }` | `{ tables }` | load that dump into this object |
| `substrat.size` | none | `{ bytes }` | the object's whole storage. The spike read `databaseSize` |
| `substrat.wipe` | none | `{}` | remove all of it |
| `substrat.erase` | `{ subjectId }` | `{ erased }` | the kind's answer to subject erasure (#2068, D-45) |

The design is that the store accepts a reserved name only when the MAC's audience is
`platform`. The spike has no audience: its MAC covers the name alone, so this is not yet
evidenced. That MAC is a second use of the same key, made by the control plane, which calls the store script
through the dispatch namespace and does not go through the vertical. A caller holding a
direct binding, or a request signed for audience `caller`, is refused by the store. The
vertical's stub also refuses `substrat.*` before it fetches, so a vertical cannot ask.
The refusal that matters is the store's. The spike's flag on the caller is not a control:
the caller that holds the binding can leave the flag unset. A MAC over the name alone, with
the audience beside it unsigned, does not carry this either. §10.3 replaces it with a
signed envelope whose audience is inside the MAC.

`substrat.erase` is required of a kind before a hosted deploy stores tenant data. What
it deletes is specified with #2068. This RFC only reserves the name and requires the
operation to exist, so a kind cannot ship without a place for erasure to land.

The kind decides what a dump holds. For the first kind that is the repository. Open sessions
and unsaved drafts are not part of it, so a fork or a restored scope starts without
them. The dump format is `scopeDumpTable` (`packages/contracts/src/introspection.ts`):
name, DDL, columns, rows. Nothing in the four lifecycle operations is specific to that kind.

## 5. Registering a kind

A kind is registered, not owned. The registration lives in this repo, pinned to an exact
release of the kind's code, the way `CONNECTORS` is. It names the kind, the release, the
script, the class and the operation catalog. A review of the registration is the review
of what the platform will run.

The registration has to show three things. The envelope. The reserved operations,
including `substrat.erase`. No per-object state at module level: an object that wakes
reopens its repository from its own storage. The kind's suite lives in its repo and runs
against the same envelope. This repo's contract suite runs against a trivial test kind
and takes no dependency on a real one.

## 6. The invocation log

An operation name is a fixed label: no `@`, no space and no `:`, at most 64 characters.
The door and the router both refuse anything else.

The host records the call on the request already open: the binding, the operation name,
the outcome and the duration. Not the input. The vertical does not pass an observer.
The platform entry runs the request in an `AsyncLocalStorage`, and the stub reads the
current record from there. An observer the vertical does pass still wins. A call made
where no request is current is not logged and does not throw. Past 16 calls the line
keeps a `storeCallsDropped` count instead of another entry. The principal is the one
the invocation already has. The store does not evaluate it.

## 7. The local runner

D-14 requires the pure adapter to implement the same contract. It does not own an
external process. A runner is handed to `SqliteScopeHost` and satisfies:

- `kind`
- `start` and `stop`
- `invoke(address, request)` where `address` is `(tenant, vertical, scope, binding)` and
  `request` is the envelope, answered with the same envelope
- the reserved operations, on the platform path only

The kind ships the runner. The first kind's is a local process with one repository per address.
The contract suite uses an in-process runner of the trivial kind, on both adapters.

## 8. Copies, and what a shred reaches

A store dump is opaque to the platform, so a copy can bring an erased subject's rows
back. After a restore, and after a snapshot copy, the platform runs `substrat.erase`
again for every subject whose key row has `shredded_at` set, on every declared binding,
whatever the timestamp. Erase is idempotent. The receipt counts `storeErasuresReplayed`.
A failed call leaves the restore incomplete, and the same call again converges. Key rows
live in the directory. The marks read are the target scope's and the source scope's. An
unknown source never refuses the restore and is reported instead (§10.5, rules L9–L11).

What remains unsealed is the backup file at rest, until someone restores it. That is
the limit. Tenant deletion wipes each declared store before the scope's own storage
goes. Tenant export reads `substrat.export` through the platform, not through the
vertical.

## 9. Not in this RFC

A real dispatch-namespace upload is [#2210](https://github.com/substrat-run/substrat/issues/2210).
Snapshot, fork, preview, backup and reap are [#2211](https://github.com/substrat-run/substrat/issues/2211).
The storage meter is [#2212](https://github.com/substrat-run/substrat/issues/2212). They
consume the reserved operations above and do not change them.

A store call works during a request. A call from a Durable Object, including a schedule,
does not pass egress and is refused. The platform's own jobs call the store script
directly and are not affected. The first version reaches only the scope the request was
routed to. One script per (kind, vertical) is the cost shape: not one script per live
version. Who is billed for the store script's CPU is part of #2212, and this RFC does
not invent a number.

The door checks the tenant and scope pair and that the binding is declared. It does not
check a permission. The operation that calls does. A store call is not inside that
operation's transaction: if the operation commits and the call fails, the vertical sees
the error. There is no idempotency key. A retry is safe when the operation is. A cold
start is the kind's latency.

`kind: z.literal('graph')` in the Apache-2.0 contracts package is intended. The kind id
is part of the public vocabulary and names a shape, not a product. A second kind widens
the union additively.

Jurisdiction: every scope is `global` today, and a store object follows its scope when
per-jurisdiction ids exist. No placement hint. No keep-alive. No permission model inside
the store.

## 10. The hosted lifecycle is the platform's

*Amendment of 2026-10-13, recorded as [K-50](../decisions/K-050-a-hosted-scope-store-s-lifecycle-is-driven-by-the-platform-from-its-own-record.md).
The owner has chosen this direction. It goes for ratification together with K-49.*

**Decision.** In a hosted deployment, everything the platform does to a scope's stores is
driven by the platform. That covers export, snapshot, fork, carry, restore, import, reap,
wipe, subject erasure, the size meter, and replaying erasures after a copy. The control
plane drives it, through the dispatch namespace, to the store script. The vertical's own
worker does not drive it, and `CloudflareScopeHost` does not drive it by reading ambient
`SUBSTRAT_STORE_*` bindings. The kind and the vertical come from the control plane's own
reviewed records. Nothing about stores is wired into the vertical's worker, so a deployed
vertical with no control plane needs no record of its own. The vertical never holds a raw
store namespace. It keeps one door, `getScopeStore`, and a call through it takes the router
hop of §1.

### 10.1 Why not wire the vertical

A deployed vertical's host has no control plane: `CloudflareScopeHost` sets `cpLess` when
it is given none (`packages/adapter-cloudflare/src/host.ts`). On main its vertical lookup
for a store therefore reads the `scopeStores.vertical` host option. The lifecycle stack
(#2240–#2247) reads the kind from a `scopeStores.kinds` host option, which only tests set.
To run hosted, that path needs the uploader to write the kind and the vertical into the
vertical's environment, next to the raw namespace binding. Three things are wrong with that:

- It keeps the vertical's code in the trust path. Code in the worker can address any name
  the namespace reaches (§1).
- The vertical states its own identity, and the object name is built from that identity.
- The routes it needs on the vertical (`/internal/scope-store-*`) are deleted again by the
  router hop.

That path would be built, shipped, and then deleted again.

### 10.2 Who can address what

| Caller | Reaches | Through | Its identity comes from |
|---|---|---|---|
| A vertical's operation | The kind's own operations, on a binding the serving version declares, for the scope the request was routed to | `fetch` of `store.substrat.internal`, then egress, then the router's `ScopeStoreCalls` entrypoint, then the store script | The router's `OUTBOUND_POLICY` (vertical, tenant, scope) and the serving version's manifest record |
| The control plane | The reserved `substrat.*` operations, for a scope it operates | The dispatch namespace, then the store script | Its own scope record (vertical, version) and version record (bindings, kinds) |
| Anyone else | Nothing | none | none |

A hosted upload carries no `SUBSTRAT_STORE_*` binding. The direct binding, and the runner,
remain for `substrat dev`, tests, and a self-hosted pure host. There the host process is
the platform, and the binding is not claimed to be an isolation boundary.

### 10.3 The signed envelope

A MAC over the object name alone, which is what #2247 and #2254 sign, binds no audience,
no operation and no time. A captured signature therefore stays valid for every operation
on that object, forever. The design replaces it with one envelope that both signers use:

| Field | Meaning |
|---|---|
| `v` | Envelope version, starting at `1`. The store refuses a version it does not know |
| `aud` | `caller` (the router, for a vertical's call) or `platform` (the control plane) |
| `name` | `<tenantId>/<vertical>/<scopeId>/<binding>`, built by the signer from its own records |
| `op` | The operation name |
| `digest` | SHA-256 of the request body (`{ operation, input }`), so a signed envelope carries one input |
| `iat` | Issue time, in seconds |
| `nonce` | 128 random bits |

The MAC covers a canonical encoding of every field, and every field travels inside the
signed bytes. Nothing the store acts on rides beside the MAC. The store checks, in order,
before any of the kind's code runs:

1. The MAC verifies, and `digest` matches the body received.
2. `aud` matches `op`: a `substrat.*` operation needs `platform`, and any other operation
   needs `caller`.
3. `iat` is inside the freshness window.
4. `name` equals the first name this object accepted. On an object's first accepted call
   the name is recorded in the object's own storage, before the operation runs.

Replay inside the window is bounded by the window. The reserved operations are idempotent,
and a kind operation's retry safety is the vertical's (§9). Per-object nonce memory is
open question Q2.

### 10.4 What moves and what stays

| Operation | In the stack #2240–#2247 | After this amendment |
|---|---|---|
| `substrat.size` (meter) | Control plane, then the vertical's `/internal/scope-store-sizes`, then the host, then the ambient binding | Control plane, then the store script |
| `substrat.erase` (shred) | Control plane, then `/internal/scope-store-erase`, then the host | Control plane, then the store script |
| `substrat.export` (backup, pull, snapshot) | Control plane, then `/internal/scope-store-export`, then the host | Control plane, then the store script |
| `substrat.import` (restore, snapshot) | Control plane, then `/internal/scope-store-import`, then the host | Control plane, then the store script |
| `substrat.wipe` (reap, snapshot delete) | Inside the host's `deleteScopeLocal` / `reapScope`, reached by `/internal/delete-scope` | Control plane, then the store script, before the scope's own delete |
| Erasure replay after a copy | none | Control plane, then the store script |
| A vertical's own operation | `getScopeStore`, then the ambient binding | `getScopeStore`, then the router hop (§1) |

The vertical's `/internal/scope-store-*` routes are never part of a hosted release.
`getScopeStore` and `callScopeStore` stay. The host-side lifecycle (`exportScopeStores`,
`importScopeStores`, `wipeScopeStores`, `eraseScopeStores`) stays for the pure adapter and
for dev, where the host process is the platform.

### 10.5 Each operation

**Export** (backup, full pull, snapshot source). The control plane reads the scope's
bindings from the version record (§10.6) and calls `substrat.export` on each. It puts the
result in the dump's `stores` as `{ binding, kind, tables }`. A masked pull or a masked
export carries no stores. A store that fails to export fails the export: a dump that says
it is whole while missing a store is not written.

**Restore and import.** The control plane loads the scope's own tables and calls
`substrat.import` on each binding in the dump's `stores`. Only bindings the destination's
version declares, with the same kind, are imported. A dump binding the destination does
not declare refuses the restore before any write (L8). Erasures are then replayed (L9–L11):

- The subjects are the union of the target scope's tombstones and the source scope's.
  Each is erased once, on every binding the target declares.
- The source is known when the directory has its row. A reaped scope keeps its row and its
  marks.
- An unknown source never refuses the restore. It is reported as
  `storeErasureIncomplete` with `storeErasureSourceUnknown`, and the route answers
  `incomplete` and `sourceUnknown`. The source's marks were not read, and running the
  restore again does not change that.
- A failed erase is reported as `storeErasureIncomplete` without `sourceUnknown`. The same
  restore again converges.
- A target with no store restores unchanged. The receipt carries no replay fields, and an
  absent receipt field means nothing had to be replayed and nothing is missing.

This is what the #2254 review fix ships: `replayStoreErasures` in
`packages/kernel/src/scope-store.ts`, behind both the host's replay and the control
plane's. Before that fix, #2254 read only the source's marks, through a caught page loop.

**Snapshot and fork.** A snapshot is an export of the source scope, then an import into
the snapshot scope, then the replay above. The snapshot scope has its own id, so it has its
own store objects. Deleting a snapshot wipes its stores before its own storage (L6). The
snapshot's replay outcome is reported as a restore's is (L10, L11). #2254 discards it
today, which is item (h).

**Carry and preview.** There is one store script per (kind, vertical), upgraded in place
(D-63). A version carry therefore moves no store object, because the object name has no
version in it. A preview scope is its own scope with its own objects. Its stores are
created and reaped with it, and its outbound effects stay inert as every non-primary
scope's do (#2005).

**Reap and wipe, stores first.** Every path that deletes a scope's storage calls
`substrat.wipe` on each declared binding first. The paths are tenant reap, scope storage
deletion, preview reap, snapshot deletion and the sweeper's reap. A wipe that fails stops
the delete. The scope's own storage is not deleted around the store, and the delete is
retried, which is what #2254's `wipePlatformStores` already does by throwing (L6, L7). A
path that cannot tell which stores a scope has fails the same way and does not skip the
wipe (L7).

**Subject erasure, fail closed.** Erase never concludes "nothing to erase" when it cannot
tell. The key is destroyed only after every store that may hold the subject has answered.
Two arms, as the #2242 review fix ships them:

- **Host arm** (the pure adapter, dev, and any host holding a direct binding or a runner).
  If the host has no control plane and no configured vertical, it cannot tell which objects
  belong to the scope. It refuses `unavailable`, as the size read and the door do, and the
  subject key survives (`erasureStoreVertical` in `adapter-cloudflare/src/host.ts`). With a
  control plane, a scope row with no vertical is a known "no store", because nothing names
  an object for it.
- **Control-plane arm** (`mayHoldScopeStores` in `control-plane-api/src/api.ts`). It is
  gated on the registered kinds. With none registered, no deployment can hold a store,
  because a push of one is refused, so this arm is dormant until the first kind.
  - No vertical means no store.
  - Otherwise the version the asked deployment runs decides: the serving pointer's version
    for the serving script, the bound version for its own script, and unknown for the
    by-slug rung.
  - An unknown version, or a manifest that cannot be read, may hold a store.
  - A version with no manifest predates kept manifests, and so predates scope stores, and
    holds none.
  - A deployment that may hold a store and cannot be asked keeps the key, and the route
    answers 503.

After this amendment the control-plane arm asks the store script directly, rather than the
vertical. The host arm stays the rule for dev and self-host.

**Size and the meter.** The daily sweep calls `substrat.size` per declared binding. A store
that cannot answer leaves that day's store rows unsampled. It is never written as `0`.

### 10.6 Where the kind and the vertical come from

- **The vertical and the version** come from the directory's scope record: `scopes.vertical`
  and `scopes.vertical_version_id`. That record is the control plane's own, written at
  provisioning and moved by bind. No deployed vertical writes it.
- **The bindings and kinds** come from that version's reviewed manifest record:
  `vertical_versions.manifest_json`, field `scopeStores`, parsed by `storedDeployManifest`.
  It was accepted at push against `STORE_KINDS` (D-63) and is not edited afterwards.
- **For a vertical's own call**, the router reads the same field for the version it is
  serving. #2254 reads it in the route resolver's SQL. The router does not trust the
  vertical's claim about which bindings exist.
- **Reading the record.** A missing manifest is "no stores" only where the version predates
  kept manifests. An unreadable one fails closed (503, or "may hold" on the erase arm).
  `declaredStoresOf` in #2254 already does this.

Nothing here is per-vertical configuration that a worker carries. A deployed vertical with
no control plane is covered by the records the platform already keeps.

### 10.7 Rules

Each rule is one assertion a test can make. The follow-up issues cite these ids.

| Id | Rule |
|---|---|
| L1 | A hosted serving upload carries no binding named `SUBSTRAT_STORE_*`, whatever `STORE_KINDS` holds |
| L2 | A hosted `getScopeStore` call leaves the worker only as `fetch` of `store.substrat.internal`. With no direct binding and no runner configured, the host never falls back to an ambient binding |
| L3 | The router refuses a `substrat.*` operation, a scope other than the routed one, and a binding the serving version does not declare, before it signs |
| L4 | The store refuses an envelope whose MAC fails, whose `digest` does not match the body, whose `aud` does not match `op`, whose `iat` is outside the window, or whose `name` differs from the first name it accepted. Each is checked before kind code runs |
| L5 | A signature for one object, operation or audience does not open another. A validly signed envelope for name Y is refused by an object that remembers X |
| L6 | Every scope-deletion path calls `substrat.wipe` on each declared binding before it deletes the scope's storage |
| L7 | A failed or undecidable wipe stops the delete, and the scope's own storage is left for the retry. The delete never proceeds around the store |
| L8 | A restore imports only bindings the destination version declares with the same kind. Any other dump binding refuses the restore before any write |
| L9 | A restore re-erases the union of the target's and the source's tombstoned subjects on every binding the target declares, each subject once |
| L10 | An unknown source never refuses a restore. It yields `storeErasureIncomplete` and `storeErasureSourceUnknown` |
| L11 | A failed replay erase yields `storeErasureIncomplete` without `storeErasureSourceUnknown`, and the same restore again converges |
| L12 | Subject erasure never destroys the key while a store that may hold the subject has not answered. "Cannot tell" counts as "may hold", on both arms of §10.5 |
| L13 | A store that cannot report its size is not recorded as size `0` |
| L14 | The kind and the vertical used for any platform call come from the scope record and the version's manifest record, never from the vertical's environment |
| L15 | A masked export or pull carries no stores, and a failed store export fails the export |

### 10.8 What #2254 already does, and what is open

#2254 already does most of this decision:

| Already in #2254 | Where |
|---|---|
| The control plane drives size, erase, export, import, wipe and replay straight to the store script through `DISPATCH` | `control-plane-api/src/platform-scope-stores.ts` |
| The kind and bindings come from the version manifest, the vertical and version from the scope record. Unreadable manifests fail closed | `declaredStoresOf`, `manifestStores` |
| The vertical's `/internal/scope-store-*` routes and their `VerticalClient` methods are removed | vertical-host, control-plane-api |
| The serving upload plan carries no store bindings | `scopeStoreUploadPlan(…).bindings` is `[]` |
| A vertical's call goes `store.substrat.internal`, then egress, then `ScopeStoreCalls`, which refuses `substrat.*`, a foreign scope and an undeclared binding | `contracts/src/scope-store-transport.ts`, `apps/router/src/store-calls.ts` |
| Wipe before delete on the reap paths | `wipePlatformStores`, the sweeper's `wipeDeclaredScopeStores` |
| Restore erasure replay, with target and source marks and an unknown source reported (review fix) | `replayStoreErasures` |

Still open:

| | Open item | Rule | Before #2210? |
|---|---|---|---|
| (a) | The MAC covers the name only. The audience header is unsigned, and nothing binds the operation, the time or a nonce | L4, L5 | **Yes** |
| (b) | First-name memory and the audience check exist as helpers and in a test fixture, not in a store script. No kind is registered to carry them | L4, L5 | **Yes**, in the test kind and in the registration requirements (D-63) |
| (c) | `transport: 'platform'` exists, but the host defaults to `'binding'` and nothing in production sets `'platform'` | L2 | **Yes** |
| (d) | `scopeStoreScriptBindings` and the guard that tests it remain. After #2254 no production path calls them | L1 | **Yes**: delete the function and retarget the guard |
| (e) | The host keeps an ambient lifecycle path. It is right for dev and self-host, and needs the fail-closed host arm | L12 | **Yes** (the #2242 review fix) |
| (f) | Replay and wipe skip when the destination's manifest is null. That is correct for a version that predates kept manifests, and needs a test that says so | L9, L7 | No, later |
| (g) | `importStores` imports whatever binding and kind the dump names, without checking them against the destination's declaration | L8 | **Yes**: before any tenant data |
| (h) | The snapshot route calls the erasure replay and discards its result, so an incomplete replay into a fork is not reported | L10, L11 | **Yes**: a fork must not look sealed when it is not |

Also open but not on #2254. The stack's `deleteScopeLocal` skips the store wipe when it is
not given a tenant id (#2243). Hosted, the control plane's wipe makes that path moot. It
still breaks L6 on a self-hosted pure host, and is fixed there before a kind runs self-hosted.

### 10.9 The migration path

In order. Steps 1–5 come before the first kind is registered (#2210). Step 6 and later do
not block it.

1. Land the stack through #2254, with the #2242 and #2254 review fixes.
2. Delete `scopeStoreScriptBindings`. Change the guard from "no kind while the injection
   exists" to L1, asserted on the serving upload with a test-registered kind. Its positive
   twin is that the same upload still carries the vertical's own declared bindings.
3. The signed envelope (§10.3), signed by the router and by the control plane, with a
   verifier the store script imports from `@substrat-run/contracts`. It replaces
   `signScopeStoreName`.
4. Make the hosted transport the platform hop. A host with no control plane, no direct
   binding and no runner sends a vertical's call to `store.substrat.internal`. The ambient
   path is taken only where a binding or runner was given explicitly (L2).
5. The import check (L8), and the snapshot reporting its replay (h). The trivial test kind
   implements L4 and L5, and the contract suite asserts them on workerd. The spike's "Not yet evidenced" items move to FINDINGS
   Shown only when they pass.
6. #2210 itself: the store script upload. It is the first registration, and is reviewed
   against D-63, including that the kind's script uses the step-3 verifier.
7. Later: the null-manifest test (f), the self-host wipe (`deleteScopeLocal` without a
   tenant id), per-object nonce memory if Q2 says so, and a door for schedules (§9).

What each open PR keeps:

| PR | Keeps | Loses |
|---|---|---|
| #2240 reserved ops | `callReservedStoreOperation`, and `HostAdmin.scopeStoreSizes` on the pure host | `/internal/scope-store-sizes` and `VerticalClient.scopeStoreSizes` (removed in #2254) |
| #2242 erasure | Ordering (redact, erase, then destroy the key) and both fail-closed arms | `/internal/scope-store-erase` (removed in #2254) |
| #2243 dump, restore, reap | Stores in the dump, stores-first ordering, masked exports without stores | `/internal/scope-store-export` and `-import`. `scopeStoreKind` / `scopeStores.kinds` become dev and test only |
| #2244 meter | The gauge table and the sweep | Its reader moves from the vertical's route to the control plane (in #2254) |
| #2246 invocation log | Everything | none |
| #2247 upload plan | `scopeStoreScriptName`, one script per (kind, vertical) | The name-only MAC, replaced in step 3 |
| #2249 docs | Its erasure, backup and meter prose, where it agrees with §10 | Wording that describes injecting a binding |
| #2254 platform hop | Almost all of it | Items (a)–(h) above, done as steps 2–5 |
| #2266 CodeRabbit follow-up | Everything | Its note that `scopeStores.kinds` is unwired becomes "dev and test only, by design" |

### 10.10 Failure modes and compatibility

- **A vertical with no stores.** No version record declares one, so nothing is called and
  nothing changes. This is every vertical today.
- **A version that predates kept manifests.** It holds no store, by construction, and is
  treated as none.
- **Mixed versions during a carry.** The object name has no version, so the old and the new
  version address the same object. The kind migrates its schema when the object wakes
  (D-63). The router reads the declared bindings of the version it is serving, so a binding
  a newer version removed is refused from the moment that version serves.
- **A store script older than the envelope.** It cannot exist hosted: steps 2–5 land before
  the first registration, and the registration review requires the verifier.
- **A store script newer than the signer.** The store refuses an envelope `v` it does not
  know, and the call fails loudly. An envelope change is a new `v` that the store accepts
  before any signer sends it.
- **The control plane cannot reach the store script.** Export fails, restore is incomplete,
  wipe strands the scope, erase keeps the key, and the meter leaves the day unsampled. No
  path reads unreachable as empty.

### 10.11 Tests

- **The guard (L1).** A test-registered kind, a serving upload plan, and no `SUBSTRAT_STORE_*`
  name in it. The positive twin: the vertical's own declared bindings are still there.
- **Router (L3).** `substrat.*`, a foreign scope and an undeclared binding are each refused
  before signing. The twin: a declared binding on the routed scope is signed and dispatched.
- **Envelope (L4, L5).** Unit tests over the canonical encoding. On workerd, through the test
  kind: a wrong audience, a stale `iat`, a validly signed other name, and a replayed
  envelope after the window are each refused. Each has its admitted twin.
- **Lifecycle (L6–L13, L15).** Control-plane route tests with a fake platform caller:
  ordering, stranding, the import check, the replay's three outcomes, and both erase arms
  with registered and unregistered kinds.
- **Contract suite.** The same lifecycle assertions on the pure adapter with the in-process
  runner, so dev and hosted agree on the rules.
- **Still owed** after these: a real dispatch-namespace upload (#2210), isolate sharing, and
  resource limits on rejected traffic.

### 10.12 Open questions

| | Question | Recommendation |
|---|---|---|
| Q1 | How long is the freshness window? | 60 seconds. The router and the control plane sign immediately before dispatch, and a long window only widens replay |
| Q2 | Does an object remember nonces inside the window? | Not in v1. The reserved operations are idempotent, a kind call is a vertical retry the window bounds, and nonce memory is a write on every call. Revisit if a kind registers a non-idempotent operation the platform itself calls |
| Q3 | Where does first-name memory live: in the kind's code, or in a platform wrapper around the kind's class? | A wrapper class from `@substrat-run/contracts` that the registration requires. A kind then cannot forget it, and the review checks one import instead of re-reading a protocol |
| Q4 | Does a dump binding the destination does not declare refuse the restore (L8), or get skipped and reported? | Refuse. A skipped binding is store data silently dropped, and the operator can restore into a version that declares it |
| Q5 | Should a schedule or a connector reach a store? | Not in this amendment. When one needs it, it gets its own door, signed by the platform with audience `caller` for the scope it runs in (§9) |
| Q6 | Does the control plane sign `platform` envelopes for every tenant from one place? | Yes. It already operates every scope's lifecycle, and the envelope's `name` is built from its own record, which is the authority this amendment relies on |

## Not yet evidenced

The spike (`spikes/scope-store-binding`) shows what its FINDINGS list under Shown. It does
not show these, and the isolation argument in §1 rests on the first two:

- **First-name memory.** `store.mjs` verifies the MAC against the `x-store-name` header
  only. It stores no first name and compares nothing to it. A caller with a valid MAC for
  X who sets header X but addresses `idFromName(Y)` is admitted.
- **MAC audience (`platform` vs `caller`).** The MAC covers the name alone. Reserved
  operations are refused by a flag on the spike's caller worker, which the RFC itself says
  is not a control. No store-side refusal of `substrat.*` for a non-platform MAC exists.
- **The router hop.** `store.substrat.internal`, egress forwarding, the `ScopeStoreCalls`
  entrypoint and the declared-binding check are not in the spike; callers there address
  the namespace directly.
- **`substrat.erase`.** Not implemented by either probe, and `substrat.export` and
  `substrat.import` were not run on the Python object.
- **Admission before dispatch.** The store initialises its table before the signature is
  checked in the object, and a binding holder can reach object activation for any name.
  Resource limits on rejected traffic are not measured.
- **Hosted behaviour.** A dispatch-namespace upload, isolate sharing, jurisdiction,
  metering, snapshot and reap (§1, FINDINGS).

- **The §10 envelope.** No code signs or verifies `aud`, `op`, `digest`, `iat` or `nonce` inside the
  MAC. #2247 and #2254 sign the object name only.

Follow-up: extend the spike with first-name pinning (including a validly signed other
name) and `platform` vs `caller` audience for `substrat.*`, each with an assertion in
`run.mjs`, and move them into FINDINGS Shown only when they pass. Until then the RFC
claims them as design.

## Alternatives rejected

- **`getScope(…, { store })`.** Puts an authority on an options bag that the type
  describes as observers. §2.
- **One shared script per kind, and trust the kind.** The spike's shared script did not
  isolate, and the kind is not the platform's code. The host owning the name fixes the
  addressing. The script split fixes the isolate. §1.
- **The vertical pushes its own Python script.** Every vertical then has its own copy
  and version of the kind, which is the opposite of a generic store.
- **The vertical's host drives the hosted lifecycle**, with the kind and the vertical
  written into its environment at upload. The vertical would hold the raw namespace and
  name its own identity, and the routes it needs are deleted by the router hop anyway. §10.1.
- **Folding the store into `tenantStores`.** Wrong level. A scope store is per scope.
  The per-tenant lists being split into `tenantStores` and `blobStores` is a separate
  defect, [#2221](https://github.com/substrat-run/substrat/issues/2221).
