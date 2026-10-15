---
status: proposed
layer: kernel
description: A platform-run object per scope, declared as a kind and reached through its own door. #2207.
---

# RFC: scope stores

**Status:** accepted (K-49 and K-50 ratified 2026-10-15; D-63 ratified, with a hash-and-commit pin, once [#2306](https://github.com/substrat-run/substrat/pull/2306) merges; D-64 as proposed on [#2298](https://github.com/substrat-run/substrat/pull/2298) not accepted as written; the open items of §10.8 remain open) · **Tracking:** [#2207](https://github.com/substrat-run/substrat/issues/2207)
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

**Implementation status.** The implementation stack (#2224, #2225) first injected a raw
`SUBSTRAT_STORE_<BINDING>` `durable_object_namespace` into the serving upload, as temporary
scaffolding. #2247 removed that injection: no upload carries a store binding, and a test
holds the serving and per-version uploads to rule L1 (§10.8 item (d), §10.9 step 2). The
router hop of §1 is #2254.

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

A kind is registered, not owned. The registration lives in this repo, the way `CONNECTORS`
does. It names the kind, the script, the class and the operation catalog. A release of the
kind's code is pinned by two values: the sha256 of the release bundle and the source commit
it was built from, recorded in the registration or in an allowlist file the registration
names (D-63, ratified 2026-10-15). The bytes may live outside this repo and may be published
to the platform first, but a release runs only once both values are pinned here by a
reviewed change. A review of that change is the review of what the platform will run.

A release is published by a person with a staff credential, never by the CI or automation
service token. That rule keys on the actor: the service token resolves to the staff
principal kind too, so publishing refuses a service actor rather than admitting "staff".
The rollout's canary runs on a platform-owned canary object that holds no tenant data and
is never a tenant's scope. It calls every reserved operation (`substrat.export`,
`substrat.import`, `substrat.size`, `substrat.wipe`, `substrat.erase`) and asserts each
answer before the rollout continues. A rollback goes to the immediately previous good
release. The module names in a release are validated, and the names the platform's entry
module imports are reserved. No kind written outside this repo is registered until a kind
cannot affect data outside the object it serves by construction: a script per tenant, no
outbound access, envelope verification outside the kind.

The platform enforces the sha256; the source commit is what a reviewer checks, and the
link between them holds only as far as the build is reproducible. Every upload of the
script, restore and rollback included, re-hashes the bytes it sends and compares them with
the pin. D-63's "Limits and follow-ups" lists what the pin does not yet settle: withdrawing
a pinned release, a rollback across a schema migration, the canary id, and the allowlist
taking effect at control-plane deploy.

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
A kind holds its own runner to this section with `scopeStoreRunnerContractSuite`
(`@substrat-run/contract-tests`, #2213), and a dev host reads its bindings from the
declaration with `scopeStoreRunnersFor` (`@substrat-run/adapter-sqlite`).

## 8. Copies, and what a shred reaches

Which stores a scope has is read from the version its script runs, by one rule that the
router's route read and the control plane both apply. A scope pinned to its vertical's
current serving script runs the serving version. A scope with no pin runs its bound
version. A scope pinned to any other script (stamped at provision, or a fork kept on its
copy's script) runs a version nothing names, so it is unknown. Provisioning sets the
serving pin and no bound version, so reading the bound version alone answered "no store"
for an ordinary install. The control plane resolves stores in one place (`scopeStoresOf`)
for backup, full pull, the full tenant export, snapshot, reap, restore, erasure and the
sweep's wipe and storage gauge. The router gives an unknown scope no store, so its store calls are refused.

`mayHoldScopeStores` is the gate. With no kind registered, nothing can hold a store and
every path proceeds as before. Once a kind is registered, an unknown version or an
unreadable manifest makes the operation refuse with 503 rather than skip a store that may
hold data. A hosted control plane with no route to the store scripts refuses the same way.

A store dump is opaque to the platform, so a copy can bring an erased subject's rows
back. After a restore, and after a snapshot copy, the platform runs `substrat.erase`
again for every subject whose key row has `shredded_at` set, on every declared binding,
whatever the timestamp. Erase is idempotent. The receipt counts `storeErasuresReplayed`.
A failed call leaves the restore incomplete, and the same call again converges.

Key rows live in the directory, keyed by scope, and a dump does not carry them. So the
replay reads two scopes' marks: the target's, always, because the data now lives there,
and the source's (the upload's stated source, else the dump's `scopeId`) when that source
is a scope of the same tenant on this host. Each subject is erased once. One function
does this for both adapters and the control plane: `replayStoreErasures` in the kernel.

A restore is never refused because its source is unknown. A backup from another host,
an upload, another tenant's scope or a deleted snapshot restores, and the result says
`storeErasureIncomplete` with `storeErasureSourceUnknown` (the restore route answers
`incomplete` and `sourceUnknown`). Running it again does not change that answer, unlike
a failed store call. Both adapters behave the same:

- a reaped source keeps its directory row and its key rows, so its marks are read;
- a deleted snapshot loses its directory row, so its marks are not read.

A scope this host keeps no store for (no binding, or a vertical no store is kept for)
replays nothing and reads no marks. A restore returns the replay's result only when there
is something to report: `storeErasuresReplayed > 0` or `storeErasureIncomplete`. Absent
means no erasure had to be replayed and none is missing, which is also what a restore
returned before stores existed.

A hosted snapshot answers its fork's replay the same way (`storeErasuresReplayed`,
`incomplete`). A restore refuses, before anything is written, a dump store the
destination's version does not declare, or one of another kind.

The gap that remains: a subject erased in a source this host does not know is not
re-erased from the restored stores. Closing it needs a tenant-level erasure ledger that
outlives the scope and travels between hosts. That is not designed here.

A shred calls `substrat.erase` on each declared binding after the scope-side redaction
and before the subject key is destroyed (#2068). The key is what makes every other copy
unreadable, so an empty answer from the stores is a claim that nothing is held, and the
platform does not make that claim when it cannot tell (#2242). Erasure fails closed:

- A scope that may hold a store has its stores erased. "May" means its version's manifest
  declares a store, or the version cannot be named, or its manifest cannot be read. The
  version is the one the router reads (above): the serving pointer's when the scope is pinned
  to the vertical's current serving script, the bound version when it has no pin, and
  unknown otherwise.
- If such a scope's stores cannot be resolved or reached, the erasure is refused (503) and
  the key stays. So does a store that answers with an error. A retry converges.
- A Cloudflare host with no control plane and no `scopeStores.vertical` cannot name the
  scope's store objects. With a store binding present it refuses `unavailable`, as the
  size read and the door do, rather than answering an empty list.
- An empty list means the host knows it holds nothing: no binding, a scope with no
  vertical, or a scope on a vertical the host is not pinned to.

The control plane's rule is gated on the store-kind registry. A push that declares an
unregistered kind is refused, so while `STORE_KINDS` is empty no deployment can hold a
store, and erasure proceeds as it did before stores existed. The fail-closed arm is
dormant until the first kind is registered.

`erased` counts what that attempt removed. A retry after a partial failure lists every
binding it asked, with zero for one an earlier attempt already erased. The count is not
carried across attempts.

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
The owner chose this direction and ratified it together with K-49 on 2026-10-15.*

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
| The control plane | The reserved `substrat.*` operations, for a scope it operates | The dispatch namespace, then the store script | Its own scope record (vertical) and the manifest of the version the scope's deployment runs, resolved exactly as the router resolves it (§10.6) |
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

**Who runs these checks.** The store script runs the kind's code, and the kind is not the
platform's code (§1). A wrapper class the kind imports does not hold the checks, because
the kind's own class can leave it out, and a review that "checks one import" proves little.
**The requirement is that the checks run in platform code the kind cannot replace.** The
platform supplies the store script's entry module, and the kind supplies only the class
behind it. That is the role `lint:platform-entry` already plays for a vertical's bundle.
The entry module verifies the envelope and the remembered name before it hands the request
to the kind's object. How the entry module reaches the object's storage for the remembered
name, without the kind's class being able to rewrite it, is open question Q3.

**Keys (L16).** Store-envelope signing keys are scoped per store script and per audience.
A store script never holds a key that can mint an envelope for another script, and no signer
holds a key for an audience it does not sign.

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
not declare refuses the restore before any write. The check therefore runs ahead of
`host.restoreScope`, which loads the scope's own tables first (L8, the recommended answer
to Q4). #2254 does this at `2f442969d` (`refuseUndeclaredDumpStores`, called before
`host.restoreScope`). It reads the destination's declaration through the one resolver of
item (i). Erasures are then replayed (L9–L11):

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

This is on #2254 as pushed at `2f442969d`: `replayStoreErasures` in
`packages/kernel/src/scope-store.ts`, behind both the host's replay and the control
plane's. Before that commit, #2254 read only the source's marks, through a caught page
loop. Which destination stores the replay reaches is decided by the version resolution in
§10.6 (item (i)).

**Snapshot and fork.** A snapshot is an export of the source scope, then an import into
the snapshot scope, then the replay above. The snapshot scope has its own id, so it has its
own store objects. Deleting a snapshot wipes its stores before its own storage (L6). The
snapshot's replay outcome is reported as a restore's is (L10, L11). #2254 does this at
`2f442969d`: the snapshot route returns `storeReplayFields`.

**Carry and preview.** There is one store script per (kind, vertical), upgraded in place
(D-63). A version carry therefore moves no store object, because the object name has no
version in it. A preview scope is its own scope with its own objects. Its stores are
created and reaped with it, and its outbound effects stay inert as every non-primary
scope's do (#2005).

**Reap and wipe: unroute, then stores, then the scope.** Every path that deletes a scope's
storage first stops the scope being routed. It then calls `substrat.wipe` on each binding
(L17), and only then deletes the scope's own storage (L6). The paths are tenant reap,
scope storage deletion, preview reap, snapshot deletion and the sweeper's reap. The router
serves a scope while it is active. A vertical call that lands between the wipe and the
delete would repopulate the object, which then outlives its scope with nothing left to
reach it. Tenant reap is already fenced by the tenant's status. Scope, preview and snapshot
deletion need the scope unrouted before the wipe.

PR #2285 does this for snapshot deletion, preview reap and the sweeper's snapshot reap. Each takes
every refusal it can decide up front first: the reap claim (a copy move in flight), a copy the
platform cannot reach, and the store resolution. A refused delete therefore leaves the scope
routed and its stores untouched. Only then does it unbind every hostname of the scope, wipe and
delete. Unbinding by hostname is the fast path, not a drain. The durable fence is a scope state
that the store door itself checks, and that is a follow-up.

A wipe that fails stops the delete. The scope's own storage is not deleted around the
store, and the delete is retried. #2254's `wipePlatformStores` does this by throwing when
a store call fails. A path that cannot tell which stores a scope has must fail the same way
(L7). #2254 does this: a scope whose stores cannot be named, or a hosted control plane with
no route to the store scripts, refuses the delete with 503 and keeps the scope (item (j)).

**Subject erasure, fail closed.** Erase never concludes "nothing to erase" when it cannot
tell. The key is destroyed only after every store that may hold the subject has answered.
"Cannot tell" and "cannot ask" are `unavailable`, which is 503
(`packages/contracts/src/errors.ts`). 502 stays what it already means: a downstream that
answered badly (`bad_envelope`). There are two arms. They are written in the #2242 review
fix, which was not pushed when this amendment was written (local head `a070e7f46`; the
pushed #2242 is `6349900b3`, where a host with no control plane and no configured vertical
reads as "no store" and fails open):

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
  - Otherwise the version the scope's deployment runs decides (§10.6), with unknown for the
    by-slug rung.
  - An unknown version, or a manifest that cannot be read, may hold a store.
  - A version with no manifest predates kept manifests, and so predates scope stores, and
    holds none.
  - A deployment that may hold a store and cannot be asked keeps the key and answers 503.

The #2242 fix asks the **vertical** (`scopeStoreErase`), which is an interim step: #2254
removes that `VerticalClient` method. After #2254, the shred route erases straight from the
control plane to the store script. The predicate that decides which stores it must reach
is the control-plane arm above. #2254's shred uses that arm, through the control plane's own
resolver and the same gate, and calls the store script itself (item (k)). The host arm stays
the rule for dev and self-host.

A bind that races an erase either sees the erase or fails (L19). The erase reads the
declared bindings and then destroys the key. A bind landing in between could add a binding
the erase never reached. So the erase runs under the same fence a bind takes on the scope,
or it re-reads the resolution after its store calls and starts over if the resolution moved.

PR #2285 takes the first form. Both arms, the orchestrated finalize and the direct shred, take one
atomic claim just before the key goes (`SUBJECT_ERASURE_CLAIM_SQL`). It requires the bound
version, the serving pin, the copy inventory and the serving pointer's exact (ref, version) pair
to still be what the erasure read, and it moves the erasure epoch every bind compares. A bind
that lands first fails the claim (412, key kept). One that lands after is refused. A version's
manifest does not change after publish, so the version identity fences its store set.

**Size and the meter.** The daily sweep calls `substrat.size` per declared binding. A store
that cannot answer leaves that day's store rows unsampled. It is never written as `0`.

### 10.6 Where the kind and the vertical come from

**The vertical** comes from the directory's scope record, `scopes.vertical`. That record
is the control plane's own, and no deployed vertical writes it.

**The version is one resolution, shared by the router and the control plane:** the version
the scope's deployment runs (L14).

- **When the scope rides the serving pin**, that is, the scope's `serving_ref` equals the
  vertical's current serving pointer's ref, it is the version that pointer names.
- **When the scope has a `serving_ref` that is not the pointer's current ref**, the
  pointer's version is not what the scope runs, so it is unknown. Provisioning stamps
  `serving_ref` when the scope is inserted, and the pointer moves on afterwards. A snapshot
  of a source resolved by slug is pinned to its copy's script.
- **When the scope has no `serving_ref`**, it is the bound version,
  `scopes.vertical_version_id`.
- **Otherwise** it is unknown.

Unknown fails closed: an erase may hold a store, a wipe or a restore stops, and the meter
reports the day as unsampled.

This matters because provisioning sets `serving_ref` and leaves `vertical_version_id` null.
Only a bind sets the version id. So an ordinary install has a serving pin and no bound
version.

**Both sides now resolve this way** (items (i) and (q)). Before, neither did:

- The router (`READ_ROUTE_SQL`) read `scopeStores` from the serving pointer's version
  whenever the scope's `serving_ref` was set, even when that ref was not the pointer's
  current one, so it could read a manifest for a scope that does not run it.
- The control plane read `vertical_version_id` only. `manifestStores`, the sweeper's
  `wipeDeclaredScopeStores` and the sweeper's meter read all treated a null id as "no stores".
- The #2242 fix's `mayHoldScopeStores` was the closest. It took the pointer's version only
  when the pointer's ref was the scope's ref, and otherwise read unknown as "may hold".

**The failure this closed, on the common path.** An install pinned to the serving script writes to a store
through the router. Its backup then carried no stores, its reap skipped the wipe, its restore
skipped the replay, and shred destroyed the key while the store still held the subject. That
broke L6, L7, L9, L12 and L15. Item (i) fixed it with one rule that the router and the
control plane both apply.

**The bindings and kinds** come from the resolved version's reviewed manifest record:
`vertical_versions.manifest_json`, field `scopeStores`, parsed by `storedDeployManifest`.
It was accepted at push against `STORE_KINDS` (D-63) and is not edited afterwards. The
router does not trust the vertical's claim about which bindings exist.

**Reading the record.** A missing manifest is "no stores" only where the version predates
kept manifests. An unreadable one fails closed: 503, or "may hold" on the erase arm.
`declaredStoresOf` in #2254 already does this.

**Bindings a later version dropped (L17).** Object names carry no version, and the script
is per (kind, vertical). A later version that drops a binding, or changes its kind (which
points it at another script), would leave the old objects holding data. Export, wipe, erase
and the meter would never reach them again, and an erase would destroy the key with the
subject still in the orphan.

A push is not the only way in. A bind, a promote, a rollback of the serving pointer, and a
serving re-upload onto an older version can each change a scope's resolved set of
(binding, kind) to one that lacks a binding or re-kinds it. The rule (L17) is that no
operation may change that set while objects of the old set may exist, unless the old
binding stays reachable.

The primary answer (Q5) makes "stays reachable" true by construction. The set the lifecycle
reaches (export, wipe, erase, size) is the vertical-wide union of every (binding, kind) any
version of the vertical has declared, computed from `vertical_versions`. An object that was
never written answers empty. The alternative is a refusal at every one of those doors.

PR #2292 implements that answer, the accepted Q5 answer. The union is a directory record,
`vertical_scope_stores`, kept by `publishVersion` in the transaction that inserts the version, and
read by its keys (`HostAdmin.verticalScopeStores`), with no per-version work once the vertical is
marked indexed. A version stored before the record, or loaded by a directory restore from an older
dump, leaves its vertical unmarked, and the first read or publish indexes every version of it,
oldest first. A re-kind is refused at publish (`conflict`), judged against every older version: a
binding keeps its kind for the life of its vertical, so the union holds one kind per binding and a
dump never names one binding twice. A manifest that declares one binding twice is refused there
too. Nothing retires a binding yet (item (v)). A
restore still imports only the running version's bindings (L8), so an export leaves out a binding
only an earlier version declared when its export is empty, and refuses one that holds data, naming
the binding and the way out.

Nothing here is per-vertical configuration that a worker carries. A deployed vertical with
no control plane is covered by the records the platform already keeps.

### 10.7 Rules

Each rule is one assertion a test can make. The follow-up issues cite these ids.

| Id | Rule |
|---|---|
| L1 | A hosted serving upload carries no binding named `SUBSTRAT_STORE_*`, whatever `STORE_KINDS` holds. With L18, that holds for every name in the upload, the vertical's own included |
| L2 | A hosted `getScopeStore` call leaves the worker only as `fetch` of `store.substrat.internal`. With no direct binding and no runner configured, the host never falls back to an ambient binding |
| L3 | The router refuses a `substrat.*` operation, a scope other than the routed one, and a binding the serving version does not declare, before it signs |
| L4 | The store refuses an envelope whose MAC fails, whose `digest` does not match the body, whose `aud` does not match `op`, whose `iat` is outside the window, or whose `name` differs from the first name it accepted. Each is checked before kind code runs |
| L5 | A signature for one object, operation or audience does not open another. A validly signed envelope for name Y is refused by an object that remembers X |
| L6 | Every scope-deletion path stops routing the scope, then calls `substrat.wipe` on each binding, then deletes the scope's storage, in that order |
| L7 | A failed or undecidable wipe stops the delete, and the scope's own storage is left for the retry. The delete never proceeds around the store |
| L8 | A restore imports only bindings the destination version declares with the same kind. Any other dump binding refuses the restore before any write, ahead of `host.restoreScope`. This is the recommended answer to Q4, pending its decision |
| L9 | A restore re-erases the union of the target's and the source's tombstoned subjects on every binding the target declares, each subject once |
| L10 | An unknown source never refuses a restore. It yields `storeErasureIncomplete` and `storeErasureSourceUnknown` |
| L11 | A failed replay erase yields `storeErasureIncomplete` without `storeErasureSourceUnknown`, and the same restore again converges |
| L12 | Subject erasure never destroys the key while a store that may hold the subject has not answered. "Cannot tell" counts as "may hold", on both arms of §10.5 |
| L13 | A store that cannot report its size is not recorded as size `0` |
| L14 | The kind, the bindings and the vertical for any store call, from the router or the control plane, come from one shared resolution: the scope record's vertical, and the manifest of the version the scope's deployment runs. That is the pointer's version only when the pointer's ref is the scope's `serving_ref`; the bound version when the scope has no `serving_ref`; unknown otherwise, which fails closed. Never from the vertical's environment |
| L15 | A masked export or pull carries no stores, and a failed store export fails the export |
| L16 | Store-envelope signing keys are scoped per store script and per audience. A store script never holds a key that can mint an envelope for another script, and no signer holds a key for an audience it does not sign |
| L17 | No operation (push, bind, promote, rollback of the serving pointer, serving re-upload) changes a scope's resolved set of (binding, kind) while objects of the old set may exist, unless the old binding stays reachable. Recommended (Q5): the lifecycle reaches the vertical-wide union of every (binding, kind) any version has declared |
| L18 | A vertical-declared name (store binding, static binding, Durable Object binding) starting with `SUBSTRAT_STORE_` is refused at push and again at upload |
| L19 | A bind that races a subject erasure either sees the erase or fails. The erase never destroys the key after a bind added a binding it did not reach |
| L20 | Store script names are injective: two different (kind, vertical) pairs never get one script name. The store-script name namespace is reserved: no vertical script name can fall in it. A kind id matches `[a-z0-9]+`. Each is refused at registration or at push, with a test |

### 10.8 What #2254 already does, and what is open

#2254 already does most of this decision, together with the stack it lands on: #2242 (the fail-closed erase arm), #2243 (dumps carry stores), #2246 (the store-call line) and #2247 (no store binding on any upload, injective store script names). The letters are kept stable, so a closed item keeps its letter in the first table.

| Already in #2254 and its base | Where |
|---|---|
| The control plane drives size, erase, export, import, wipe and replay straight to the store script through `DISPATCH` | `control-plane-api/src/platform-scope-stores.ts` |
| The vertical's `/internal/scope-store-*` routes and their `VerticalClient` methods are removed | vertical-host, control-plane-api |
| A vertical's call goes `store.substrat.internal`, then egress, then `ScopeStoreCalls`, which refuses `substrat.*`, a foreign scope and an undeclared binding | `contracts/src/scope-store-transport.ts`, `apps/router/src/store-calls.ts` |
| Restore erasure replay, with target and source marks and an unknown source reported | `replayStoreErasures`, `storeErasureSourceUnknown` |
| (d) No upload carries a store binding, and the injector is gone. The serving and per-version uploads build their bindings in one function, which a test holds to L1 | `verticalUploadBindings`, `scopeStoreUploadPlan(…).bindings` is `[]` (#2247) |
| (e) A host with ambient store bindings and no way to name the scope's objects refuses an erase (`unavailable`) rather than answering an empty list | `erasureStoreVertical` (#2242) |
| (g) A dump binding the destination does not declare, or declares as another kind, refuses the restore ahead of `host.restoreScope` | `refuseUndeclaredDumpStores` |
| (h) The snapshot route reports its erasure replay | `storeReplayFields` |
| (i) One resolver names a scope's stores, the rule of §8: the serving version when the scope is pinned to its vertical's current serving script, the bound version when it has no pin, and unknown otherwise. Backup, full pull, the full tenant export, snapshot, reap, restore, the import check, shred and the sweeper all use it | `scopeStoresOf` |
| (j) Every store path fails closed once a kind is registered: a version that cannot be named, a manifest that cannot be read, or a hosted control plane with no route to the store scripts refuses with 503, and the reap keeps the scope. The sweeper's wipe and meter go through the same resolver | `scopeStoresOf`, `unreachablePlatformScopeStores`, `wipeDeclaredScopeStores`, `declaredStoreSizes` |
| (k) Shred erases the stores through the same resolver and gate (`mayHoldScopeStores`), on the orchestrated and the direct paths, and refuses with 503 before the key goes. With no platform path, the host's own co-located stores are erased in its finalize | `platformStoresOf`, `finalizeSubjectShred` |
| (l) A vertical cannot declare a binding in the `SUBSTRAT_` namespace, so no declared binding reads as a store binding | `control-plane-api/src/deploy.ts` (declared-binding check) |
| (p) Store script names are injective over (kind, vertical), and the `substrat-store-` name space is reserved against vertical scripts | `scopeStoreScriptName`, `platformScriptCollision` (#2247) |
| (q) The router's route read applies the same rule as (i), so a scope pinned to another script gets no store | `READ_ROUTE_SQL` |
| (n) Export, wipe, erasure and the meter reach every binding any version of the vertical declared, a re-kind is refused at publish, and an export leaves out an empty binding only an earlier version declared and refuses one that holds data (#2292, the accepted Q5 answer) | `vertical_scope_stores`, `HostAdmin.verticalScopeStores`, `scopeStoreReachOf` |
| (m) Snapshot deletion, preview reap and the sweeper's snapshot reap decide their refusals, then unbind every hostname, then wipe, then delete. Erasure's two arms take one claim that fences the version, the pin and the serving pointer's pair before the key goes (#2285) | `unrouteScope`, `claimScopeScriptReap`, `SUBJECT_ERASURE_CLAIM_SQL` |

Still open:

| | Open item | Rule | Before #2210? |
|---|---|---|---|
| (a) | The MAC covers the name only. The audience header is unsigned, and nothing binds the operation, the time or a nonce | L4, L5 | **Yes** |
| (b) | First-name memory and the audience check exist as helpers and in a test fixture, not in a store script. No kind is registered to carry them | L4, L5 | **Yes**, in the test kind and in the registration requirements (D-63) |
| (c) | `transport: 'platform'` exists, but the host defaults to `'binding'` and nothing in production sets `'platform'` | L2 | **Yes** |
| (f) | Replay and wipe skip when the destination's manifest is null. That is correct for a version that predates kept manifests, and needs a test that says so | L9, L7 | No, later |
| (o) | The envelope checks are planned in the kind's script, which the kind controls. The platform has to supply the store script's entry module | L4, L5 | **Yes**, with #2210 |
| (r) | The erasure replay runs inside one request and starts again from the first subject on a retry, so it converges only while it fits one request's budget. Resuming needs a cursor of its own | L9 | No, later |
| (s) | The direct-path shred's audited receipt lacks the platform's store erasures, because the host's `shredSubject` takes no store list. The answer carries them | L12 | No, later |
| (t) | Peer dispatch carries no store list, so a vertical serving a peer call has its store calls refused | L3 | No, later |
| (u) | A store call works only during a request. A call from a Durable Object, a schedule included, does not pass egress and is refused (§9). The platform's own jobs are not affected | §9 | No, later |
| (v) | Nothing retires a binding from a vertical's record (`vertical_scope_stores`, #2292). The step Q5's decision names, export then wipe then delete the record row, does not exist yet. Until it does, each binding no version still declares costs one store call per scope on every export, wipe, erasure and meter run, and its name cannot be declared again as another kind. It is also the way out for a vertical whose record cannot be read | L17 | No, later |

Also open but not on #2254. The stack's `deleteScopeLocal` skips the store wipe when it is
not given a tenant id (#2243). That is in the Cloudflare host (`adapter-cloudflare/src/host.ts`),
reached by the vertical's `/internal/delete-scope`. `SqliteScopeHost` has no
`deleteScopeLocal`, and its `deleteSnapshot` wipes unconditionally. Hosted, the control
plane's wipe makes that path moot. It still breaks L6 on a Cloudflare host that holds a
direct binding, and is fixed before a kind runs anywhere outside the platform hop.

### 10.9 The migration path

In order. Steps 1–7 come before the first kind is registered (#2210). Step 9 does not
block it.

1. Land the stack through #2254, with the #2242 and #2254 review fixes. #2243 says "Closes
   #2211". It should say "Part of #2211", and #2211 stays open for (j) and L6/L7.
2. Done (#2247). Delete `scopeStoreScriptBindings`. Change the guard from "no kind while the injection
   exists" to L1, asserted on the serving upload with a test-registered kind. Reserve the
   prefix at push and at upload (L18, item (l)), and the store-script name space with
   injective names (L20, item (p)). The positive twin is that the same upload
   still carries the vertical's own declared bindings, none of which can now use the prefix.
3. Done on #2254, and unroute-then-wipe with the bind fence (m) on #2285. One version resolver (L14, items (i) and (q)), called by the router and by every
   control-plane store path, the sweeper included. With it: wipe fails closed on an unresolvable scope (j), the fail-closed
   erase arm on #2254's shred with `unavailable` as 503 (k), and unroute-then-wipe plus the
   bind fence (L6, L19, item (m)).
4. The orphaned-binding rule (L17, item (n)): the union, the accepted Q5 answer, on PR #2292.
5. The signed envelope (§10.3), signed by the router and by the control plane with keys
   scoped as L16 says. It replaces `signScopeStoreName`.
6. Make the hosted transport the platform hop. A host with no control plane, no direct
   binding and no runner sends a vertical's call to `store.substrat.internal`. The ambient
   path is taken only where a binding or runner was given explicitly (L2).
7. A platform-supplied store entry module that runs L4 and L5 in front of the kind's
   class (o). The trivial test kind runs behind it, and the contract suite
   asserts L4 and L5 on workerd. The spike's "Not yet evidenced" items move to FINDINGS
   Shown only when they pass.
8. #2210 itself: the store script upload. It is the first registration, reviewed against
   D-63, uploaded behind the step-7 entry module. The upload runs only a release the
   registration pins (sha256 and source commit): it hashes the bytes it is about to send,
   on every upload including restore and rollback, and refuses a sha256 that is not pinned.
   The commit is checked in review, not at upload.
9. Later: the null-manifest test (f), the Cloudflare host's wipe without a tenant id,
   per-object nonce memory if Q2 says so, and a door for schedules (§9).

What each open PR keeps:

| PR | Keeps | Loses |
|---|---|---|
| #2240 reserved ops | `callReservedStoreOperation`, and `HostAdmin.scopeStoreSizes` on the pure host | `/internal/scope-store-sizes` and `VerticalClient.scopeStoreSizes` (removed in #2254) |
| #2242 erasure | Ordering (redact, erase, then destroy the key), the host arm, and the control-plane arm's rules | `/internal/scope-store-erase`, and the fix's call to the vertical: superseded by the control-plane-direct erase on #2254 (item (k)) |
| #2243 dump, restore, reap | Stores in the dump; on reap and delete the stores are wiped before the scope's own storage (L6), and on restore and import the scope's tables load before its stores; masked exports without stores | `/internal/scope-store-export` and `-import`. `scopeStoreKind` / `scopeStores.kinds` become dev and test only. "Closes #2211" becomes "Part of #2211" |
| #2244 meter | The gauge table and the sweep | Its reader moves from the vertical's route to the control plane (in #2254) |
| #2246 invocation log | Everything | none |
| #2247 upload plan | `scopeStoreScriptName`, one script per (kind, vertical), made injective in step 2 | The name-only MAC, replaced in step 5 |
| #2249 docs | Its erasure, backup and meter prose, where it agrees with §10 | Wording that describes injecting a binding |
| #2254 platform hop | Almost all of it, (g) and (h) included | The open items (a)–(f), (i)–(q), done as steps 2–7 |
| #2266 CodeRabbit follow-up | Everything | Its note that `scopeStores.kinds` is unwired becomes "dev and test only, by design" |

### 10.10 Failure modes and compatibility

- **A vertical with no stores.** No version record declares one, so nothing is called and
  nothing changes. This is every vertical today.
- **A version that predates kept manifests.** It holds no store, by construction, and is
  treated as none.
- **Mixed versions during a carry.** The object name has no version, so the old and the new
  version address the same object. The kind migrates its schema when the object wakes
  (D-63). The router reads the declared bindings of the version it is serving, so a binding
  a newer version removed is refused from the moment that version serves. That covers access,
  not data: the objects under the removed binding are what L17 is for.
- **A store script older than the envelope.** It cannot exist hosted. The envelope (step 5)
  and the platform entry module that verifies it (step 7) land before the first
  registration (step 8).
- **A store script newer than the signer.** The store refuses an envelope `v` it does not
  know, and the call fails loudly. An envelope change is a new `v` that the store accepts
  before any signer sends it.
- **The control plane cannot reach the store script.** Export fails, restore is incomplete,
  wipe stops the delete, erase keeps the key, and the meter leaves the day unsampled. No
  path reads unreachable as empty.

### 10.11 Tests

- **The guard (L1, L18).** A test-registered kind, a serving upload plan, and no
  `SUBSTRAT_STORE_*` name in it. The positive twin: the vertical's own declared bindings are
  still there. A push and an upload declaring `SUBSTRAT_STORE_X` (as a store, a static binding
  and a Durable Object binding) are each refused, and the twin `STORE_X` is admitted.
- **Resolver (L14).** A serving-pinned scope with a null version id, a scope whose
  `serving_ref` is not the pointer's current ref, a bound scope, and a scope with neither:
  the router and the control plane resolve the same answer, and the second and fourth fail
  closed on every lifecycle path, the sweeper's wipe and meter included.
- **Ordering and races (L6, L19).** A route test where a call after the wipe is refused
  because the scope is unrouted. An erase whose bind lands mid-erase either retries or fails.
- **Orphans (L17).** A version that drops a binding: either the push is refused, or wipe and
  erase still reach the old object, whichever Q5 settles on. The same for a bind, a promote,
  a rollback and a re-upload onto an older version.
- **Script names (L20).** Distinct (kind, vertical) pairs give distinct store script names, a
  vertical whose script name would fall in the store name space is refused, and a kind id
  outside `[a-z0-9]+` is refused. Each has its admitted twin.
- **Router (L3).** `substrat.*`, a foreign scope and an undeclared binding are each refused
  before signing. The twin: a declared binding on the routed scope is signed and dispatched.
- **Envelope (L4, L5).** Unit tests over the canonical encoding. On workerd, through the test
  kind: a wrong audience, a stale `iat`, a validly signed other name, and a replayed
  envelope after the window are each refused. Each has its admitted twin.
- **Lifecycle (L6–L13, L15).** Control-plane route tests with a fake platform caller:
  ordering, a failed and an unresolvable wipe, the import check ahead of the scope's tables,
  the replay's three outcomes, and both erase arms with registered and unregistered kinds.
- **Contract suite.** The same lifecycle assertions on the pure adapter with the in-process
  runner, so dev and hosted agree on the rules.
- **Still owed** after these: a real dispatch-namespace upload (#2210), isolate sharing, and
  resource limits on rejected traffic.

### 10.12 Open questions

| | Question | Recommendation |
|---|---|---|
| Q1 | How long is the freshness window? | 60 seconds. The router and the control plane sign immediately before dispatch, and a long window only widens replay |
| Q2 | Does an object remember nonces inside the window? | Not in v1. The reserved operations are idempotent, a kind call is a vertical retry the window bounds, and nonce memory is a write on every call. Revisit if a kind registers a non-idempotent operation the platform itself calls |
| Q3 | The platform supplies the store script's entry module (§10.3). How does it hold the remembered name so the kind's class cannot rewrite it? | A platform-emitted entry module with its own re-emit check, as `lint:platform-entry` has. The entry module checks the remembered name before it constructs the kind's object. The kind's class shares the object's storage, so whether it can rewrite that name is held by the registration review until a platform mechanism can isolate it. A wrapper class the kind imports is not enough. **Decided 2026-10-15:** this answer stands. The registration review is a standing condition, to be revisited before any kind written outside this repo is registered. Whether an entry that routes by `idFromName` of the verified name makes the remembered name redundant is not yet shown on workerd and is checked in #2289 |
| Q4 | Does a dump binding the destination does not declare refuse the restore (L8), or get skipped and reported? | Refuse. A skipped binding is store data silently dropped, and the operator can restore into a version that declares it. L8 is written to this answer and changes if Q4 is decided otherwise |
| Q5 | A bind, promote, rollback, re-upload or push would drop or re-kind a binding while objects exist (L17). Drive the lifecycle over a union, or refuse at every door? | The vertical-wide union of every (binding, kind) any version has declared, computed from `vertical_versions`, as the set export, wipe, erase and size reach. It holds whatever moved the pointer. Refusals at every door are the alternative, and would need one at each of the five. **Decided 2026-10-15:** the union. Retiring a binding from it is an explicit step after export and wipe, and the union never shrinks as a side effect of a push. Implemented on PR #2292: a directory record kept at publish, which refuses a re-kind there |
| Q6 | Should a schedule or a connector reach a store? | Not in this amendment. When one needs it, it gets its own door, signed by the platform with audience `caller` for the scope it runs in (§9) |
| Q7 | Does the control plane sign `platform` envelopes for every tenant from one place? | Yes. It already operates every scope's lifecycle, and the envelope's `name` is built from its own record, which is the authority this amendment relies on |

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
