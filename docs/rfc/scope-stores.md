---
status: proposed
layer: kernel
description: A platform-run object per scope, declared as a kind and reached through its own door. #2207.
---

# RFC: scope stores

**Status:** proposed · **Tracking:** [#2207](https://github.com/substrat-run/substrat/issues/2207)
· **Evidence:** [spikes/scope-store-binding/FINDINGS.md](../../spikes/scope-store-binding/FINDINGS.md)
· **Decisions:** [K-49](../decisions/K-049-a-scope-store-is-a-platform-run-object-per-scope-reached-by-its-own-door.md),
[D-63](../decisions/D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md)

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
inert while no store kind is registered. It must be removed, or replaced by the signed
router hop of §1, before the first kind is registered, and a test will enforce that.

A push that names a kind with no registration is refused twice: by the CLI's push check,
and again by the control plane on upload. A declaration the platform cannot run is not
stored as if it could. See D-63.

The vertical slug is not a field of the Cloudflare host today. It comes from the scope
record when the control plane is present, and from the host option the pure adapter
takes for dev and tests. The host needs it to build the object name.

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
the caller that holds the binding can leave the flag unset.

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
live in the directory. A copy that did not bring them uses the source scope's marks.

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
- **Folding the store into `tenantStores`.** Wrong level. A scope store is per scope.
  The per-tenant lists being split into `tenantStores` and `blobStores` is a separate
  defect, [#2221](https://github.com/substrat-run/substrat/issues/2221).
