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

The first kind is Ontomate: a Python schema and data engine, one repository per scope, called
synchronously from the operation the user is waiting on. The mechanism is generic. A new kind
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

So the vertical never chooses the name. `getScopeStore` takes a binding. The host builds
`<tenantId>/<vertical slug>/<scopeId>/<binding>` from the pair it has just checked against
the directory, the same check `getScope` makes (K-3).

A signature is the second half, for a worker that can see the binding anyway. The store
refuses a call whose `x-store-name` does not carry `HMAC-SHA256` under a key the platform
holds and the vertical does not. The spike showed the refusal, and showed that a signature
over one name does not open another. The object cannot read its own `idFromName`, so the
signed string is the name the host computed. A holder of the key can sign any name, which
is why the key stays in the host.

Isolates are a separate question, and the answer proposed here is one script per
(kind, version, vertical). A kind the platform did not write cannot be assumed to keep
per-object state off the module, and a tenant that exhausts the isolate should restart
that vertical's objects only. The alternative, one script per (kind, version), is cheaper
to deploy and is what the spike's shared script was. It is rejected for the first hosted
kind. A vertical does not pin the version: the platform deploys the next one beside the
old and moves objects on its own schedule, and the kind migrates its schema when an
object wakes.

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
`tenantStoreNeed` already has. `kind` is `z.literal('ontomate')` until a second kind
asks to widen it, which is an additive change, the same intent as the comment on
`tenantStoreNeed.kind`. No default: the kind is the choice.

`runtimeNeeds.scopeStores` and `deployManifest.scopeStores` are arrays defaulting to
`[]`. A binding declared twice, or declared as another store's binding, is refused at
push. `ATTACHMENTS` stays reserved.

The platform injects the binding. The vertical never writes it, and
`ADMISSIBLE_BINDING_TYPES` does not grow. The name is `SUBSTRAT_STORE_<BINDING>`,
under the `SUBSTRAT_` prefix the platform already keeps (`PLATFORM_BINDING_PREFIX`).
The host reads it the way it reads the attachment bucket, off the worker's own `env`.
An undeclared binding has nothing to read, which is the refusal.

A push that names a kind with no registration is refused. A declaration the platform
cannot run is not stored as if it could. See D-63.

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

| operation | what it does |
|---|---|
| `substrat.export` | the kind's dump, as `scopeDumpTable` rows |
| `substrat.import` | load that dump into this object |
| `substrat.size` | the object's whole storage. The spike read `databaseSize` |
| `substrat.wipe` | remove all of it |
| `substrat.erase` | the kind's answer to subject erasure (#2068, D-45) |

The vertical's stub refuses every `substrat.*` name before the fetch. The spike's
caller did, and the counter did not move. The store itself answers them: the platform
caller, with the flag unset, exported, wiped and imported.

`substrat.erase` is required of a kind before a hosted deploy stores tenant data. What
it deletes is specified with #2068. This RFC only reserves the name and requires the
operation to exist, so a kind cannot ship without a place for erasure to land.

The kind decides what a dump holds. For Ontomate that is the repository. Open sessions
and unsaved drafts are not part of it, so a fork or a restored scope starts without
them. The dump format is `scopeDumpTable` (`packages/contracts/src/introspection.ts`):
name, DDL, columns, rows. Nothing in the four lifecycle operations is specific to Ontomate.

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

A store stub writes nothing by itself. The invocation log today is the HTTP request, and
`buildStub` does not append to it. The host records the store call on the invocation
already open for that request: the binding, the operation name, the outcome code, the
duration. Not the input. The input is the kind's business and may be large. The principal
is the one the invocation already has. The store does not evaluate it.

## 7. The local runner

D-14 requires the pure adapter to implement the same contract. It does not own an
external process. A runner is handed to `SqliteScopeHost` and satisfies:

- `kind`
- `start` and `stop`
- `invoke(address, request)` where `address` is `(tenant, vertical, scope, binding)` and
  `request` is the envelope, answered with the same envelope
- the reserved operations, on the platform path only

The kind ships the runner. Ontomate's is a local process with one repository per address.
The contract suite uses an in-process runner of the trivial kind, on both adapters.

## 8. Not in this RFC

Hosted deploy, version rollout and the Python worker in production are #2210. Snapshot,
fork, preview, backup and reap are #2211. The storage meter is #2212. They consume the
reserved operations above and do not change them.

A real dispatch-namespace upload, as §1 says. Jurisdiction: every scope is `global`
today, and a store object follows its scope when per-jurisdiction ids exist. No placement
hint. No keep-alive. No permission model inside the store.

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
