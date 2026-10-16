---
status: accepted
layer: kernel
description: A tenant-level store instance that several verticals of one tenant connect to, weighed against the per-scope store of K-49/K-50. Four options, three authorization shapes, the lifecycle a shared object needs, and what it does to the open scope-store stack. Records the maintainer's direction of 2026-10-15: named tenant-level instances with explicit connections and platform-addressed partitions (B), a script per partition as the upgrade for stronger separation (B′), and per-scope stores kept for scope-grain kinds. Accepted: its 22 questions were answered on 2026-10-15 and the direction is K-53.
---

# RFC: store instances

**Status: accepted** (the 22 questions of §12 answered 2026-10-15, §12.1; the direction
recorded as [K-53](../decisions/K-053-a-tenant-level-store-is-a-named-instance-that-a-tenant-s-verticals-connect-to-explicitly.md);
open: the background-write record of Q14, the quota numbers, and the isolation requirements
of §11.1). It weighs an alternative to the per-scope store of
[scope-stores.md](scope-stores.md) (K-49, K-50, D-63) for one requirement that the per-scope
store cannot meet.

> **Maintainer direction (2026-10-15).** The first kind's requirement is accepted: a
> tenant-wide store shared by the verticals of one tenant. Option B is the direction: named
> tenant-level instances, explicit connections, and platform-addressed partitions (§4, §5,
> §6 (ii)). B′, a script per partition, is the upgrade when stronger separation is wanted.
> A stays for scope-grain kinds, and the kind declares its grain (§9). The 22 open questions
> of §12 were answered one by one on 2026-10-15 (§12.1). The structural isolation requirements the maintainer wants pursued before any
> third-party kind is allowed are §11.1.

Written against `origin/main` at `02a72f0e8`. References are to sections and symbols, not
lines. Issues and PRs are cited by number only.

---

## 1. The requirement

The first kind's consumer is **a tenant-wide data layer over the verticals**: one store that
the verticals of **one** tenant all reach, so that what one vertical writes another can read,
and that no other tenant can reach at all. It is the first kind of scope-stores.md, a
graph-shaped store with its own runtime, called synchronously from the operation a user is
waiting on.

A store per (tenant, vertical, scope, binding) cannot be that. Two verticals of one tenant
never name the same object: the vertical slug is in the object name (K-49), and the script
is per (kind, vertical), so even the same name in two scripts is two objects
(spike finding 5, `spikes/scope-store-binding/FINDINGS.md`).

The maintainer's proposal is the subject of this RFC:

- The unit of ownership becomes a tenant-level **store instance**, identified by a kind and
  a name, and created by the tenant.
- A vertical **connects** its declared binding to an instance explicitly, the way a
  connection is made for a connector.
- A tenant can hold more than one instance, with some verticals connected to one and some
  to another.

**The invariant is strict tenant isolation.** Every option below is judged first on how it
keeps one tenant's instance unreachable from every other tenant, *mechanically*: by who
builds the object name, what the envelope binds, which script holds the object, and which
isolate runs it. Review is named where review is the only control.

**Non-goals.**

- Anything across tenants. A tenant never shares an instance with another tenant, and no
  option here reads two tenants' data in one call.
- Replacing the scope's own database or the event spine. The scope stays the unit of
  consistency, permission and audit (kernel-design §3, §4).
- A general shared database for vertical authors. An instance is a registered kind
  (D-63), not a SQL handle.
- Read-your-writes across verticals. Within one call, the store answers as it answers.
  Across verticals, nothing here promises an order.
- Deciding the first kind's schema or its operation catalog.

## 2. What exists, and why none of it is this

Nothing on `main` is shared by two verticals of one tenant. Even the per-tenant stores
are per vertical.

| Mechanism | Unit | Shared across a tenant's verticals? |
|---|---|---|
| Scope store (K-49, K-50) | (tenant, vertical, scope, binding); one script per (kind, vertical) (D-63) | No. The router refuses a store call addressed to any scope other than the dispatch's own (`handleStoreCall`), and the name carries the vertical |
| `tenantStores` / `blobStores` | (tenant, vertical, binding): the ledger's key is `(tenant_id, vertical, binding)`, and the D1 and bucket names are built from all three (`tenantStoreDatabaseName`, `blobStoreBucketName`) | No. Each tenant's store is bound to the one vertical's serving script as `<BINDING>__<TENANTID>` |
| Connections (`_substrat_connections`) | (tenant, vertical, provider, account); authority is grants on `connection:<id>`, scope-level or tenant-level | No. `getConnectorScope` refuses a scope whose vertical is not the connection's |
| Peer calls (#1706) | Directional and same-tenant. The caller declares `calls`; the target declares `peers` and seats `vertical:<slug>` at provisioning; `admitPeer` runs in the target scope | Reaches another vertical's *operations*, with the vertical's authority. It is not shared storage |
| Cross-vertical events (#1705) | A pull per (consumer, producer) inside one tenant, with authority on the receiver's `vertical:<slug>`. Only `piiClass: 'none'` events cross | A copy, after the fact. It is not shared storage |
| Lake query gateway (#2277) | One tenant's events, envelope-only, staff-only, and off until configured | Not a tenant-facing surface (kernel-design §5.6: *"never a UI list view"*) |

The closest precedent for **explicit tenant consent to a cross-vertical edge** is the peer
binding (`peer_bindings`, `setPeerBinding`, behind `dashboard:provision-app`) together with
the peer kill switch (`switchPeer`). The closest precedent for **a tenant-made thing a
vertical uses through a door** is the connection (`relayConnectionUpsert`, behind
`dashboard:manage-integrations`). §5 borrows from both.

### 2.1 A precedent: the auth-server as a tenant-level instance

The nearest thing on `main` to "a tenant-level instance that scopes connect to explicitly" is
the auth-server (`demos/auth-server`) in hosted mode.

**Where the shapes match:**

- **An instance with a recorded identity.** Each issuer is a dispatch instance. The platform
  records what it is at provision: `provisionInstance` in `demos/auth-server/src/auth-do.ts`
  writes an `InstanceMeta` (`tenantId`, `scopeId`, `slug`, `name`, in `do-contract.ts`). An
  issuer that was never provisioned has no record.
- **Several instances per tenant.** An issuer is an installed scope of the auth-server
  vertical, so a tenant can hold several, and different verticals' scopes can trust
  different ones.
- **Explicit connection, per scope.** A vertical's scope trusts an issuer through its
  delivered relying-party wiring: the scope's `substrat:auth` config, which names the issuer
  and the client. The wiring is read per scope through `IdentityDO.authWiring`
  (`packages/vertical-auth/src/identity-do.ts`). One issuer can serve several apps of a team,
  with each credential bound to the client it was issued to (#1683).
- **Previews get their own connection.** A preview is not handed the app's client. It gets
  its own client minted at the issuer, and that client is retired with the preview (#1704,
  `demos/auth-server/src/preview-clients.ts`). §7.3's rule for instances points the same way.
- **The instance checks the platform's call against its own record.** Every platform-gated
  call names a tenant and a scope, and `foreignCall` refuses it unless both are what
  `provisionInstance` recorded. That is the store's "first name accepted" rule (L4) in
  another form: the instance knows whose it is and refuses everyone else's call.

**Where they differ:**

- **Whose code it is.** The auth-server is code in this repo, reviewed as a vertical. A store
  kind is code the platform runs for a party it did not write (D-63), and that is why the
  checks in front of it must be platform code (§3).
- **What the connection is.** An auth connection is configuration plus standard OIDC: the
  relying party verifies the issuer's tokens against its published keys, and nothing routes
  the vertical's traffic through the platform. A store connection is a platform-routed,
  signed binding: the router resolves it and signs every call (§5.4, §5.5).
- **Where trust comes from.** In OIDC it is the issuer's signature, checked by the relying
  party. In a store call it is the platform's envelope, checked by the instance.

**The requirement this precedent gives the store connection.** A connection carries its own
identity binding: which instance, which tenant, which installation scope and vertical, which
binding, and which partition and reads (§5.1). The instance checks every call against that
binding. What a
connection grants is therefore bounded by the connection itself, not by the tenant the
caller belongs to. "Caller is in the same tenant" is never enough to reach an instance. This
holds whether or not the two mechanisms are unified (§12 Q15).

## 3. The isolation properties at stake

Four layers hold a store apart from everything that should not reach it. The options in §4
differ in which layers they keep, so they are named first.

1. **Who builds the object name.** Today the router builds
   `<tenantId>/<vertical>/<scopeId>/<binding>` (`scopeStoreObjectName`) from
   `OUTBOUND_POLICY`, which it set at dispatch and which the vertical cannot write. The
   vertical names a binding, never an object (K-49).
2. **What the envelope binds.** The signed envelope (scope-stores §10.3; open PR #2293) puts
   the version, the audience, the name, the operation, a body digest, the issue time and a
   nonce inside the signature. The store script holds verification keys only (open PR #2293).
   So nothing that runs in a store script can mint an envelope.
3. **Which script holds the object.** `idFromName` is per script. Two scripts never share an
   object. Open PR #2295's entry module also refuses a name whose vertical is not the
   script's own.
4. **Which isolate runs the code.** Objects of one class in one script may share an isolate
   and its memory (#2210; not exercised, §13). Objects in different scripts never do.

**An isolation property of today's design, stated neutrally.** A store script runs the
kind's code. The entry module checks every envelope before the kind's class is constructed,
but it runs in the same interpreter as that class. Within its object, the kind's code is
trusted by review alone (D-63; scope-stores Q3, recorded on open PR #2302). The open stack
has one script per (kind, vertical). So the code of one kind release runs, in one script,
for **every tenant that installed that vertical**. If the kind misbehaves, through a defect
or otherwise, the reach is everything in that script and isolate: every tenant of the
vertical. The envelope keeps one *object* from opening another's name, and that check runs
in platform code. What the kind's code does inside its isolate is not held by a platform
mechanism. D-63 accepts this for the first kind on the reasoning that *"a tenant that exhausts
an isolate should restart that vertical's objects only"*. That bounds the blast radius by
vertical. It does not bound it by tenant.

**What layer 3 and layer 4 together mean for any partition inside one script.** Objects that
share a script share a class and may share an isolate. Code in that isolate can therefore
carry data from one object to another through memory, without any envelope. D-63's rule of
"no per-object state at module level" exists for exactly this reason, and it is enforced by
the registration review. So **the envelope makes addressing mechanical, and only a separate
script makes the data of two objects mechanically separate.** Everything this RFC says
about partitions (§6) is bounded by that.

**A requirement of every option.** The environment the platform hands the kind's class
leaves out the store's own Durable Object namespace binding and the envelope's
verification-key bindings. The entry module holds them, and the kind receives only what its
operations need. This narrows what the kind's code can address without relying on review.
Whether it can be guaranteed for every runtime a kind uses, including any route the runtime
offers module code to reach the script's bindings, is unverified (§13).

Each option in §4 is graded on these four layers and on that exposure.

## 4. The options

### A. Keep per-scope stores (the status quo)

One object per (tenant, vertical, scope, binding), one script per (kind, vertical), built by
#2207's stack.

- **Isolation.** All four layers, with the §3 exposure: the kind's code spans every tenant of
  the vertical.
- **Meets the requirement?** No. Two verticals never name one object, and one vertical's
  scopes never share one either. A tenant-wide layer built on A would be a fan-out over N
  objects by each reader, and a write by vertical X would never be visible to vertical Y.
- **Cost.** The scripts number (kinds × verticals that declare a kind). One release fans out to
  that many uploads.
- **When A is right.** For a kind whose data really is per scope: a scope's working copy, a
  scope-local index. Nothing in this RFC argues against A for such a kind. §9 and §12 Q9 are how a
  kind says which grain it is.

### B. A tenant-level instance, explicit connections, one script per (kind, tenant)

The tenant creates an instance of a kind. A tenant admin connects a vertical's declared
binding to it. The router resolves the binding to the instance through the directory, builds
the instance's object name, signs it, and addresses the store script of that (kind, tenant).
This is the auth-server's shape (§2.1): an instance with a recorded identity, several per
tenant, connected to explicitly. Here the connection is a binding the platform routes and
signs, rather than configuration the relying party verifies.

- **Isolation.**
  - Layer 1: the name is built by the router from the dispatch's tenant and the directory's
    connection row. Neither comes from the vertical.
  - Layer 2: the envelope is unchanged in shape (§5.5).
  - Layer 3: the script is the tenant's, and the entry module's own-vertical check becomes an
    own-tenant check.
  - Layer 4: the isolate holds one tenant's objects only. Inside the tenant, every instance
    and every partition of that kind shares the script and may share the isolate.
- **The §3 exposure.** A kind's code can reach only objects in its own script, and in B that
  is one tenant's instances. A misbehaving kind affects one tenant's layer, which is the data
  that tenant chose to share across its verticals anyway. That is strictly narrower than A. It
  is the strongest argument for a script per tenant, and it holds whichever authorization shape
  §6 settles on. **Within the tenant, separation between partitions and between instances is
  held by review**, for the reason §3 gives, unless the variant below is chosen.
- **Variant B′: a script per (kind, tenant, partition).** Each partition (§6 (ii)) is its own
  script, so two partitions never share an isolate, and moving data between them takes a
  platform-signed call. This is the only form in which separation inside a tenant does not rest
  on review. It costs a script per partition, and with partitions keyed by (instance,
  scope, binding) (§5.1, §12 Q16) that is a script per installation scope × binding, not per
  tenant. It also costs:
  - an upload on every first connect of a pair;
  - a release that fans out to every partition;
  - a cold isolate per partition;
  - reads across partitions that become calls between scripts, each signed by the router.

  K-28's first-deploy window of about 15 seconds opens on **every** first connect, not only at
  instance creation. A connect therefore cannot be reported live when the upload returns. The
  control plane must hold the connection as pending until the new script answers. A
  vertical's first call after a connect meets either "not connected yet" or that window,
  which makes connect a slow, asynchronous step under B′. The Workers for Platforms
  script-count question of §13 applies to B′ at its own, much larger, count.
- **Meets the requirement?** Yes: one object (or one object per partition, §6) per instance,
  reached by every connected vertical.
- **Cost (§10).**
  - Store scripts number (kinds × tenants that hold an instance). That is a different curve:
    it grows with the customer base, where A grows with the catalogue.
  - A kind release fans out to every tenant script. The release model (D-63's pin, §8.2)
    carries over, with its canary and rollback, but the set they walk is tenants.
  - Each new script has its own first-deploy window. K-28 records one of about 15 seconds
    during which a new script can answer `Worker not found.` in colos it has not reached.
    That window opens at instance creation as well as on every release.
  - Cold starts: fewer objects share an isolate, so more isolates are cold. The kind's
    cold start is the kind's latency (scope-stores §9) and is paid more often.
  - Workers for Platforms limits on scripts per namespace and on uploads are not recorded in
    this repo (§13).

### C. A tenant-level instance on the per-(kind, vertical) scripts

The instance is a tenant-level record, but the object lives in the existing store script of
one vertical.

C is listed because it is the obvious first try. It does not stand on its own:

- An object lives in exactly one script, because `idFromName` is per script. So a C instance
  lives in **one** vertical's store script, and every other connected vertical's calls must
  be routed into that script. In practice that is B with the instance placed in a script
  chosen by whichever vertical connected first.
- The isolation is then A's at its worst. That script runs for every tenant of its vertical,
  and it now also serves the other verticals' data for this tenant. The §3 exposure covers
  all of them.
- The instance's home depends on one vertical staying installed. Uninstalling that vertical,
  or retiring its kind binding, strands an instance the other verticals still use.
- The only other way to share one script across verticals is one script per kind for the
  whole fleet. D-63 rejects that already ("a script shared by every vertical is also
  rejected for the first hosted kind").

So C collapses into B (if the instance gets its own script) or into the rejected
fleet-wide script. It is not recommended, and §10 grades it only for completeness.

### D. Platform-side ingestion

Verticals do not call the instance. The platform feeds it from what the connected verticals
already emit, and a separate read surface serves it.

- **Writes.** A platform job, the platform sweep's shape (`packages/control-plane-api/src/cross-vertical.ts`
  already walks one tenant's producers), reads each connected vertical's exported events
  since a watermark and calls the kind's ingest operation with audience `platform`. What a
  vertical contributes is exactly what it declared as exported, so the producer's own
  declaration is the write authorization.
- **Reads.** These come from a read surface the platform serves, with each vertical reading
  through a read-only connection (hybrid D+B), or from a platform surface such as the
  dashboard or an agent tool.
- **Isolation.** Layer 1 is the control plane's own record, as K-50 has it for reserved
  operations. Layers 3 and 4 depend on the script grain, which is B's question again: D on a
  per-(kind, vertical) script has the same problem as C. D therefore implies B's script per
  (kind, tenant) as well.
- **Meets the requirement?** Partly. It gives a tenant-wide layer without any vertical
  writing into it, and its write authorization is the platform's. It gives up the synchronous
  write from the user's operation, because ingestion is after the fact, at the sweep's
  cadence. It also widens what crosses: #1705 lets only `piiClass: 'none'` events cross,
  because subject keys are per (scope, subject). A layer fed with personal data needs the
  erasure fan-in of §7.1 before that limit can be lifted.
- **Cost.** A new platform job per tenant and a per-producer watermark per instance. No
  vertical-facing write door, so no write authorization inside the store.

### Hybrids

- **D for writes, B for reads.** The platform ingests, and verticals connect read-only. This
  removes every write-authorization question from §6 and keeps synchronous reads. It costs
  the synchronous write.
- **B now, with D added later.** Verticals write synchronously to their own partition, and a
  platform job later adds derived, cross-vertical views. The recommendation (§11) is close to
  this.
- **A and B side by side.** Grain is a property of the kind (§9 and §12 Q9). A scope-grain kind keeps
  A unchanged, and a tenant-grain kind takes B. Nothing in B removes A.

## 5. The connection model (B, and D's read side)

### 5.1 Records

Both records live in the directory, where the tenant, scope, connection and peer-binding
rows already are. The names are illustrative.

- **An instance:** `(id ULID, tenant_id, kind, display_name, jurisdiction, status, created_by,
  created_at)`. `status` follows the scope's vocabulary: `active`, `deleting`, `reaped`.
- **A store connection:** `(id, tenant_id, instance_id, scope_id, vertical, binding,
  created_by, created_at, ended_at)`.
  - At most one live connection per `(tenant_id, scope_id, binding)`. A connection is per
    **installation scope**, not per vertical. Two installations of one vertical in a tenant
    are two connections, and so are two bindings of one installation. This follows the
    precedents: `peer_bindings` is keyed by the caller's scope, a connector's grants are
    seated at a scope, and the auth wiring is delivered per scope (§2.1). A vertical whose
    installation spans many scopes is connected scope by scope, and the dashboard may do that
    in one act that writes one row each (§12 Q16).
  - An ended connection's row is kept while its partition holds data. That is the
    connection-history counterpart of the union rule of L17 (§7.4).
- **A partition:** `(tenant_id, instance_id, scope_id, binding, vertical, shareable,
  shareable_recorded_at, status)`, keyed by `(instance_id, scope_id, binding)`.
  - The partition is **not** the connection. It is created on the first connect of that
    `(scope, binding)` to that instance, and it outlives the connection.
  - A disconnect followed by a reconnect of the same `(scope, binding)` to the same instance
    **revives the same partition**, with its data, and every `reads` entry that names it keeps
    working. A disconnect without a delete leaves the partition holding its data, unwritable
    and readable only through existing grants (§12 Q10).
  - Two installations of one vertical, or two bindings of one installation, are two
    partitions. Connecting to a *different* instance creates a different partition there, and
    the old one stays where it was.
  - `shareable` is the producer's declared list of read operations others may be granted
    (§6), copied from the version the producer's scope runs at connect, and again whenever that
    scope's resolved version changes while connected (the L14 resolution). When the producer's
    connection ends, the last recorded list stands, and the admin may narrow it, never widen
    it, until the producer reconnects (§12 Q22).
- **A read grant:** `(tenant_id, reader_connection_id, alias, partition (instance_id,
  scope_id, binding), operations, granted_by, granted_at, revoked_at)`. This is the `reads`
  of §6, as rows. Its constraints are in §6 (ii).

### 5.2 Who creates, who connects

- **Creating an instance** is a tenant-admin act on the dashboard. It is audited as
  `recordAdmin(…, 'createStoreInstance', …)`, the way `provisionTenantStore` and
  `createConnection` are. The kind must be registered with grain `tenant` (§9 and §12 Q9). Whether a
  vertical's provisioning may also create one is §12 Q6.
- **Connecting** a vertical's binding is a tenant-admin act behind a dashboard permission
  key. Today `dashboard:manage-integrations` (owner, admin) gates connections, and
  `dashboard:provision-app` (owner, admin, member) gates peer bindings. A new key, held by
  owner and admin, is the lean (§12 Q2), because a connection here grants one vertical's
  code access to what other verticals wrote. The key reaches `apps/dashboard/PERMISSIONS.md`
  through `lint:permissions`, so the human permission-diff checkpoint sees it.
- **Every connect, disconnect and change to `reads`** writes an admin-log row naming the
  instance, the vertical and the binding.
- **A connect is refused** when:
  - the binding's declared kind is not the instance's kind;
  - the scope is non-primary (§7.3);
  - the vertical is not installed in the tenant;
  - the instance is not `active`.

### 5.3 What the vertical declares and sees

- **The declaration does not change shape.** `runtimeNeeds.scopeStores: [{ binding, kind }]`.
  Whether a binding is per scope or per instance is the kind's registered grain, not the
  vertical's choice (§9 and §12 Q9). A vertical cannot name an instance, a tenant, or another
  vertical's binding.
- **The door does not change shape either.** The call is still made from an operation in a
  scope, through `getScopeStore(principal, tenantId, scopeId, binding)`, and the vertical
  never sees an instance id. Whether a tenant-grain binding deserves its own door name is
  §12 Q13.
- **A source is named by an alias the reading vertical declares.** A binding that may read
  other partitions declares its aliases beside it, in the same SCREAMING_SNAKE grammar, for
  example `{ binding: 'GRAPH', kind: 'graph', sources: ['PEOPLE'] }`. The call names the alias
  on the stub it already holds (`store.source('PEOPLE').invoke(op, input)`; the spelling is
  illustrative). When a tenant admin grants a read, they map an alias to a partition. The
  vertical never sees the partition, the instance or the other installation. An alias with no
  live grant is a named refusal, as an unconnected binding is.
- **An unconnected binding is a named refusal, never an empty store.** The router refuses
  before it signs. The vertical gets a `StoreError` it can show as "not connected; ask an
  admin". A binding that silently answered empty would read as "no data" to every screen built
  on it.

### 5.4 Resolution at call time: the directory, never the manifest

The router already reads, per dispatch, the scope's stores from the version record
(`READ_ROUTE_SQL`, column `scope_stores_json`) and hands them to egress in
`OUTBOUND_POLICY.stores`. Under B the same read gains a join:

1. The scope's version declares `(binding, kind)`, exactly as today (L14).
2. For a tenant-grain kind, the live store connection for `(tenant, scope, binding)` names
   the instance, which must be `active` and of the same kind. Its `vertical` must be the
   scope record's.
3. The caller's own partition is `(instance, scope, binding)` from that same row.
4. For each alias the binding declares, the live read grant on that connection names a
   target partition. It is kept only if that partition's `tenant_id` is the dispatch's tenant,
   its `instance_id` is the reader connection's instance, its status is not deleted, and the
   granted operations are within its recorded `shareable` list.
5. The result in `OUTBOUND_POLICY.stores` carries the instance id, the caller's partition, and
   the surviving aliases with their target `(scope, binding)` and operations, alongside the
   binding.

Every step fails closed:

- no connection, an ended connection, an instance that is not `active`, or a kind mismatch
  means the binding is absent and the call is refused;
- a non-primary scope resolves no connection at all (§7.3).

A disconnect takes effect on the next dispatch, because the policy is set per dispatch.

### 5.5 The name and the envelope

- **The object name** for an instance is built by the router from its own records:
  `<tenantId>/i/<instanceId>/p/<scopeId>/<binding>` under §6 shape (ii), and
  `<tenantId>/i/<instanceId>` under shape (i). The partition key is `(instance, scope,
  binding)`, so two bindings or two installations never resolve to one object, and a
  reconnect of the same pair revives the same object (§5.1). The display name
  never appears in the name.
- **The script name** is a new reserved form, `substrat-store-<kind>-t-<tenantId>`. It must
  be injective against the per-(kind, vertical) names of L20, with a prefix no vertical slug
  can produce.
- **The envelope** keeps every field of scope-stores §10.3. It adds, inside the signature, the
  caller's vertical, scope and connection id, under a new `v`, so the kind can attribute a
  write and the entry module can check that the partition in the name is the caller's own
  (§6). The rollout order is what makes it safe: every store script accepts the new `v`
  before any signer sends it (scope-stores §10.10, "a store script newer than the signer").
  A store refusing an unknown `v` is what makes the wrong order fail loudly rather than
  silently.
- **The audience** is `caller` for a vertical's call, as now. A read of another partition
  (§6 (ii)) is `reader`, a third audience whose operations the registration lists as
  read-only. The audience is inside the signature.
- **Platform operations** (`substrat.*`) for an instance are signed by the control plane with
  audience `platform`, built from the instance record rather than from a scope record.

### 5.6 Several instances

- One instance has many connections.
- One `(tenant, scope, binding)` has at most one live connection. A vertical that wants two
  layers declares two bindings, and each binding is its own partition even when both point
  at one instance.
- Moving an installation from one instance to another is a disconnect followed by a connect.
  Its old partition stays in the old instance. Copying a partition across instances is a later
  platform operation (§12 Q10).

## 6. Authorization inside a cross-vertical layer

A per-scope store has no permission model of its own. The vertical's operation checks first
(`assertAllowed(await ctx.check(…))`), and the store trusts the call because the call can
only come from that scope (scope-stores §9). A shared instance breaks that premise twice:

- the caller may write into data another vertical depends on;
- the caller may read data another vertical wrote under its own permission model.

The person reading through vertical Y may not be someone vertical X would have shown that
data to. Principals are per scope, the same `sub` under two issuers is two subjects
(cross-scope-read §7, invariant 2), and nothing in a row carries X's decision about who may
see it.

Three shapes are possible. They differ in who enforces the partition between verticals, and
two things have to be kept apart when grading them:

- **Addressing.** Which object a *caller* can name. The router and the envelope can make this
  mechanical.
- **Data separation against the kind's own code.** Whether the kind, running inside a
  partition, can move data into another partition. §3 shows this is mechanical only across
  scripts.

### (i) Kind-enforced partitions

- **How it works.** One object per instance. The envelope carries the caller's vertical. The
  kind tags every row with it and applies the connection's `reads` itself.
- **What holds it.** The kind's code alone. The entry module verifies the envelope and can
  pass the caller's vertical along, but it runs in the same interpreter as the kind's class
  (§3). Whether the kind honours `reads` is a review question under D-63 and nothing else.
- **For it.** Cross-vertical queries are native: a traversal or a join across what X and Y
  wrote is one call to one object. For a graph-shaped layer, those relationships are much of
  the point.
- **Against it.** The tenant's admin grants a read list that no platform mechanism enforces.
  A defect in the kind leaks across verticals inside the tenant without any signal.

### (ii) Platform-addressed partitions

- **How it works.** One object per (instance, connection), the connection being the
  partition (§5.1). The router builds the name with the partition taken from the connection
  it resolved for the dispatch's own scope (§5.4). So a vertical's `caller` call reaches its
  own partition by construction. It can name nothing else.
- **Reading another partition** takes an explicit read grant (`reads`, §5.1). The vertical
  names a declared alias (§5.3). The call takes the same hop, is signed with audience
  `reader` for the other partition's name, and only for an operation that is both listed
  read-only in the kind's registration and in the producer's recorded `shareable` list. The
  router refuses an unknown alias, an unlisted operation and an ungranted partition before it
  signs. The entry module in the target object refuses a `reader` envelope for a non-read
  operation before the kind runs.
- **A read grant cannot leave the reader's tenant or instance.** This is the isolation edge of
  `reads`, and it is held twice:
  - **At grant.** The control plane refuses a grant whose target partition does not have the
    reader connection's `tenant_id` and `instance_id`.
  - **At resolution.** The router keeps a grant only when the target partition's `tenant_id`
    is the dispatch's tenant and its `instance_id` is the reader connection's (§5.4 step 4).
    A row edited past the grant-time check is therefore still dropped.
  - **In the name.** The tenant and the instance in a `reader` envelope's name come from the
    reader's own resolution: the dispatch's tenant (`OUTBOUND_POLICY`) and the instance of the
    reader's connection. Neither comes from the call, from the alias or from the text of the
    grant. The grant contributes only the target's `(scope, binding)`, checked to exist in
    that instance.
- **What holds it: addressing, mechanically.** A caller cannot name another partition, and
  cannot run a non-read operation on one. Router and envelope enforce both, in platform code,
  before any kind code runs. A store script holds no key that mints an envelope (open PR
  #2293).
- **What does not hold mechanically: data separation against the kind.** Every partition of
  every instance of the tenant is an object of one class in the one (kind, tenant) script.
  The objects may share an isolate, and the kind's code can carry data between them through
  isolate memory with no envelope at all (§3). Storage being per object does not stop that.
  **Within a tenant, partition separation against the kind's own code is review-only**, as it
  is under (i). That holds unless the variant B′ cost is paid: a script per (kind, tenant,
  partition), where partitions never share an isolate (§4).
- **What also rests on review.** That a `reader` operation the registration calls read-only
  really does not write. Inside the read partition's object, the kind runs, so a misbehaving
  read operation can change the partition it reads. That stays within one tenant's instance.
- **What (ii) still buys over (i), even on one script.**
  - Caller addressing does not depend on the kind being correct.
  - The partition is the platform's unit of wipe, export, size and erasure (§7), so those
    never depend on the kind filtering its own rows.
  - The read list is checked by the router rather than by the kind.
- **Against it.**
  - Every cross-vertical query is a fan-out by the caller: the calling vertical, or a
    platform read surface, reads N partitions and combines them.
  - The kind cannot traverse across partitions in one call.
  - Partitions multiply objects: one per connected (scope, binding).
  - A shared, vertical-neutral partition (tenant reference data every vertical writes) needs
    its own rule. Either it is a partition with several writers, which is (i) inside that
    partition, or it is platform-fed, which is (iii).

### (iii) A read model the platform decides

- **How it works.** D's shape. The platform writes partition-tagged data from what each
  vertical exported, and a platform-run read surface decides what a reader sees.
- **What holds it.** Platform code on both sides, and the producer's export declaration,
  which already carries a `readPermission` (#1705).
- **For it.** No vertical-written data enters without the producer's declaration, and no
  read is decided by kind code.
- **Against it.**
  - The layer is eventually consistent.
  - The synchronous write is gone.
  - The read surface's own permission model has to be designed. #1705's model is vertical
    to vertical (`vertical:<slug>` holds a key at the producer's scope), not person to row.

### Where the checks live, in every shape

- **The operation checks first.** It is unchanged and still the first line of every
  operation that calls a store. Under B the calling vertical's own permission model decides
  which of its people may trigger a read of another partition.
- **The exposure a read grant creates, said plainly.** A read of another partition runs with
  the *reading vertical's* authority, not the person's standing in the producing vertical.
  The cross-scope-read RFC **rejects** that shape for its own case (§2, candidate A) because
  it would show a person more than they may read, and it had an alternative: each scope
  checks the person itself. Here no such alternative exists. The store has no permission
  model, principals are per scope, and nothing in a partition says who in the producing
  vertical may see a row. So this RFC does not claim the exposure away. It bounds it, and
  leaves avoiding it as a live option (§12 Q3):
  - **Bounded by the producer.** A partition is readable by others only for read operations
    the producing installation's binding declares shareable, the way #1705's `exports`
    names a `readPermission`. Nothing is readable by default.
  - **Bounded by consent.** A tenant admin grants each `reads` entry. The grant is audited, and
    it is the admin accepting that the reading vertical's model governs that data.
  - **Bounded by classification.** Reads across partitions are limited to non-personal
    shapes (§7.1 says why the erasure fan-in cannot lift this).
  - **Avoided entirely** if no partition is readable by another, and cross-vertical views come
    only from a platform-run read model, shape (iii). That is the honest alternative if the
    bounds above are judged not enough.

  Peer calls and cross-vertical events already run with this vertical authority (#1706,
  #1705). The second limits what crosses to `piiClass: 'none'`, and the bounds above take the
  same line.
- **Classification and PII.**
  - The kind's data is opaque to the platform. A masked export carries no instance, as it
    carries no store today (L15).
  - A partition may hold personal data written by its own installation, because the fan-in
    of §7.1 reaches it. What is *read across* partitions is limited to non-personal shapes,
    because no erasure reaches a reader's copy (§7.1, §12 Q3).
- **What the platform can enforce:**
  - the tenant, in every shape, down to the script and isolate under B;
  - which partition a caller *addresses*, under shape (ii) only;
  - which partitions a caller reads, and with which operations, under shape (ii) only and by
    operation name;
  - who connected what, with the audit trail, in every shape;
  - data separation between partitions against the kind's own code, only under B′.
- **What the platform cannot enforce:**
  - what the kind does inside an object or, on one script, across the objects of its isolate;
  - what a reading vertical does with data after it has read it, including copying it into
    its own partition or its own scope;
  - whether person P in vertical Y "should" see a row written in vertical X.

  The last one is a product decision, which the read grant makes explicit and auditable
  instead of implicit.

## 7. Lifecycle of a shared instance

These are requirements. They hold for B under either authorization shape, and for D.

### 7.1 Subject erasure reaches the instance from every vertical (fan-in)

- **Why a fan-in is needed.** Subject keys are per (scope, subject)
  (`_substrat_subject_keys`, keyed `(scope_id, subject_id)`). The shred route
  (`POST /tenants/:tenantId/scopes/:scopeId/subjects/:subjectId/shred`) names one scope and
  resolves that scope's stores (`platformStoresOf`). A shared instance holds subjects from
  every connected scope.
- **The requirement.** A shred in a scope calls `substrat.erase` on every partition that
  scope's connections name, live **or ended while the partition still holds data**. The key is
  destroyed only after each of those has answered.
  Fail closed as L12 does:
  - an unreadable connection history is "may hold";
  - an unreachable instance keeps the key and answers 503.
- **The erase input.** Under (ii) the partition is the scope's own, so `subjectId` within that
  partition's object is unambiguous. Under (i) it carries `(vertical, scopeId, subjectId)`. A
  subject id means something in its own scope only. The same person in another vertical is
  another subject, and is erased by that vertical's shred.
- **Copies across partitions are beyond this erasure.** Suppose vertical Y reads X's
  partition and keeps what it read, in its own partition or its own scope. That copy is keyed,
  if at all, by X's subject id, which means nothing in Y. Erasing the subject in X never
  reaches Y's copy, and Y's own shreds name Y's subjects, not X's. This is the reason #1705
  lets only `piiClass: 'none'` events cross between verticals. **The fan-in does not lift this
  limit:** it reaches the partitions the erased scope wrote, never what others derived from
  them. Lifting it would need a subject identity shared across verticals, which no part of
  the platform has. So reads across partitions stay limited to non-personal shapes (§6,
  §12 Q3). Under (i), a kind that derives rows across verticals *inside the store* must
  record where they came from, so that an erase reaches the derivations. That is a
  registration requirement, and it is reviewed.
- **The fence (L19's counterpart).** A connect or reconnect that races a shred either sees it
  or fails.
- **The restore replay (L9's counterpart).** Restoring an instance re-erases every subject
  whose key row in **any scope of the tenant** has `shredded_at` set, on the partitions of that
  scope's connections. The rows are in the directory with their `tenant_id`, so the source
  is the whole tenant and never unknown. This closes, for instances, the gap scope-stores §8
  leaves open for scopes (a tenant-level ledger), as far as subjects erased on this host are
  concerned. A deleted snapshot's rows are still lost (scope-stores §8).

### 7.2 Scope wipe and reap never wipe an instance

- **Scope deletion.** Every path of L6 (tenant reap, scope storage deletion, preview reap,
  snapshot deletion, the sweeper's reap) wipes the scope's **scope-grain** stores only. An
  instance is not the scope's to wipe.
- **Data a deleted scope wrote into an instance** is a decision, not a default (§12 Q11).
  Under (ii) that data is the deleted scope's partitions: it is kept, or it is
  wiped by the disconnect-then-wipe order. Under (i), a reserved
  `substrat.forgetScope { vertical, scopeId }` would remove the rows that scope wrote, which
  needs every write to carry its scope, as the §5.5 envelope does.
- **A scope archived while connected.** It is not routed, so it makes no calls. Its data
  stays, and erasure still reaches it (§7.1).
- **A vertical uninstalled while connected.** The uninstall ends every connection of its
  scopes in the tenant. Their partitions stay, readable only through grants other
  connections already hold. It stays reachable by erasure and by tenant deletion through the
  kept connection rows. Deleting it is an explicit tenant-admin step: export, wipe, then drop
  the row, the L17 retirement order.

### 7.3 Previews, forks and snapshots

A preview, fork or snapshot scope must not write to a tenant's live instance. Previews are
inert by rule (#2005), and the connection relay already refuses non-primary scopes
(`PREVIEW_CONNECTIONS_REFUSAL`: "previews and forks cannot change a tenant's connections"). The router therefore resolves **no** store connection for a
non-primary scope (§5.4). The alternatives, read-only access to the live instance or a
copied instance per preview, are §12 Q12. A snapshot's dump carries no instance, so neither
restoring a scope nor forking one touches an instance.

### 7.4 Tenant offboarding, export and restore

- **Tenant deletion** wipes, then deletes, every instance of the tenant and its script
  (unroute first: end every connection, then wipe, then drop). This has to be built.
  Tenant reap does not delete `tenantStores`, `blobStores` or their ledger rows today
  (self-serve-deploy.md calls store deletion at tenant reap a tracked follow-up), so an
  instance cannot inherit a teardown that does not exist.
- **The full tenant export** gains an `instances` section beside `data`: each instance's
  kind, its connections, and one dump per partition (shape ii) or one for the instance
  (shape i). It uses `substrat.export` through the platform, as K-50 has it for scopes. A
  masked export carries none.
- **The scope dump format is unchanged.** `scopeDump.stores` stays per scope and carries
  scope-grain stores only. An instance is never in a scope dump, because it is not the
  scope's.
- **Restore of an instance** is a tenant-level operation of its own. It imports only
  partitions that have a connection row (live or ended) of the same kind on the instance (the
  L8 counterpart). It then runs the replay of §7.1.

### 7.5 Metering and attribution

`substrat.size` is called per instance object. Under (ii) that is per partition, so a
tenant's store bytes are attributable to the installation that wrote them, because each
partition's object is one (scope, binding)'s. Under (i) attribution is only what the kind reports
about itself. The gauge table (`_substrat_scope_store_storage`, #2212) is keyed by scope and
binding today, so instances need their own key. L13 carries over: a size that cannot be read
is never recorded as `0`.

### 7.6 The kind's schema and versions

- **Schema.** Each object migrates when it wakes (D-63). That is unchanged.
- **Releases.** With a script per tenant, a release reaches tenants one script at a time
  (D-63's canary, §8.2), so two tenants may run different kind releases during a
  rollout. Within one tenant, every connected vertical meets the same release, whatever
  version each vertical runs.
- **The operation catalogue** therefore evolves additively, the engine rule from CLAUDE.md:
  new inputs are optional, and an operation is not renamed. A vertical compiled against one
  catalogue may call a store one release ahead or behind.

### 7.7 The open stack's machinery, per instance

- **Unroute, then wipe (L6) becomes disconnect, then wipe.** Ending the instance's
  connections stops the router resolving them, and only then is `substrat.wipe` called.
- **The union of bindings (L17, scope-stores Q5) has a connection-history counterpart.**
  Erasure, export, wipe and the meter reach every partition any connection row has named,
  not only the live ones.
- **Calls outside a request (scope-stores §9, item (u)).** A store call from a consumer or a
  schedule is refused, because it does not pass egress. A layer that verticals feed from
  background work hits that limit at once. Under D it does not arise.

## 8. What carries over, and what is superseded

**Carries over unchanged, or with a parameter changed:**

- `getScopeStore` and `StoreStub`, the envelope `{ operation, input }`, `StoreError`, and the
  reserved operations, with `substrat.erase` gaining `(vertical, scopeId)` for instances.
- The invocation log line (#2246).
- The router hop: `store.substrat.internal`, egress, `ScopeStoreCalls`.
- The signed envelope (#2293). Its name grammar gains the instance form, and the envelope
  gains a `v` that carries the caller's vertical, scope and connection.
- The platform transport as the default (#2294).
- The platform-supplied entry module, JS and Python (#2295, #2296). The own-vertical check
  becomes an own-tenant check on a tenant-grain script, and a partition check under (ii).
- Registration and a pinned release with a canary and a rollback (D-63, as it is being
  ratified, §8.2).
- Key scoping per script and audience (L16), with `reader` as a third audience.
- The reserved script name space and injectivity (L20), with the tenant-grain form added.
- The local runner and its contract suite (#2213). The runner's `address` gains the instance
  form.

**Superseded for a tenant-grain kind (and kept for a scope-grain kind):**

- The object name `<tenantId>/<vertical>/<scopeId>/<binding>`.
- Resolution of a store from the version manifest alone (L14), which is joined to the
  connection directory instead.
- The scope as the unit of wipe, export and import of the store.
- The script per (kind, vertical), and the upload of a store script at the vertical's push
  (#2299). Under B it happens at instance creation.

### 8.1 The open PRs

These are by another contributor and carry a `dibs` claim. This RFC proposes nothing to
change on them. The table says only what each would mean if B were chosen.

| PR | Issue | Under B (tenant-grain kind) | Under A (scope-grain kind) |
|---|---|---|---|
| #2291 unroute before wipe; erasure fenced against a bind | #2285 | Kept. Its counterpart is disconnect before wipe, and a fence against connect | Unchanged |
| #2292 the union of every declared (binding, kind) | #2286 | Kept. A connection-history union is added beside it | Unchanged |
| #2293 Ed25519 envelope | #2287 | Kept. A new `v` with caller vertical, scope, connection and the `reader` audience | Unchanged |
| #2294 the platform hop as the default | #2288 | Unchanged | Unchanged |
| #2295 platform entry module | #2289 | Kept. The own-vertical check becomes own-tenant, plus the partition check | Unchanged |
| #2296 Python entry | #2290 | As #2295 | Unchanged |
| #2298 D-64: published releases | #2297 | D-64 is not accepted as written (§8.2). The rollout set of whatever release model is ratified is tenants | Unchanged |
| #2299 upload the store script before the vertical | #2210 | Retargeted: upload at instance creation, per (kind, tenant), and not on a vertical's push | Unchanged |
| #2300 publish, canary, rollback | #2297 | Kept. The canary is one tenant | Unchanged |
| #2301 register the first kind | #2210 | Gains a grain field. The first kind registers as `tenant` | `scope` |

### 8.2 Statements that would change

The decisions are cited as they stand on `main` (K-49, K-50 and D-63 `proposed`), and as
open PR #2302 would ratify them (K-49 and K-50 `accepted`, with Q3 and Q5 answered). #2302
is open.

- **K-49, "one per (tenant, vertical, scope, binding)", and the object name.** Under B these
  become true of a scope-grain kind only. A tenant-grain kind is one object per instance, or
  per (instance, partition). The rest of K-49 (the door, the envelope, the reserved names,
  the router as signer, the log line) stands.
- **K-49, "the door checks the (tenant, scope) pair … and that the binding is declared."**
  For a tenant-grain kind it also requires a live connection.
- **K-50, "the bindings and kinds come from that version's reviewed manifest record."** For a
  tenant-grain kind they come from the manifest *and* the connection directory. The vertical
  still comes from the scope record.
- **K-50's fail-closed list**, in the counterpart form of §7.7:
  - unroute-then-wipe becomes disconnect-then-wipe;
  - the union of bindings gains a union of connections;
  - a restore that "imports only bindings the destination declares" does not apply to an
    instance, which is never in a scope dump;
  - erasure of a scope fans in to every partition its connections name or named.
- **#2302's Q3 answer** (a platform-emitted entry module; registration review holds the
  remembered name) stands in B and D. Under B on one (kind, tenant) script, the separation
  between partitions is held by the same review (§6 (ii)). Only under B′ does an object
  boundary that is also a script boundary carry it.
- **#2302's Q5 answer** (the vertical-wide union; a push never shrinks it) stands for
  scope-grain kinds. A tenant-grain kind needs the connection-history counterpart.
- **D-63, "one script per (kind, vertical)"**, and its reason ("a tenant that exhausts an
  isolate should restart that vertical's objects only"). Under B, for a tenant-grain kind,
  this becomes one script per (kind, tenant), and an exhausted isolate restarts one tenant's
  objects only.
- **D-63's release pin, as it is being ratified.** D-63 is being ratified with a
  hash-and-commit pin, in a separate docs PR that is open and not merged. The parts:
  - the registration pins the exact sha256 of the release bundle and the source commit it
    was built from, and the bytes may live outside the repo;
  - only a human staff credential publishes a release, never the automation's service token;
  - the canary asserts every reserved operation, `substrat.erase` included;
  - rollback returns to the previous good release.

  Under B the pin is unchanged. A tenant-grain kind adds its grain to the registration, and
  the canary and the rollout walk tenants (B) or partitions (B′) instead of verticals.
- **D-64 (#2298, unpinned releases) is not accepted as written.** The statements this RFC
  makes about releases therefore rest on D-63 with the pin above, not on D-64.
- **Under D**, K-49's door is not used for a tenant-grain kind's writes. K-50's
  platform-driven lifecycle extends to the ingestion job.

### 8.3 If per-scope objects ship first

Grain is per kind, so A and B coexist, and nothing in B requires removing A. The hard case
is the first kind shipping as scope-grain, holding tenant data, and then being wanted at
tenant grain. There is no platform migration between the two today:

- `substrat.import` replaces a whole object (scope-stores §4);
- object names carry the scope;
- the data's identifiers are scope-local.

A move would be an explicit tenant-admin job: export each scope's store, import it into that
scope's partition with a merge-capable import the kind would have to add, replay erasures
(§7.1), then retire the scope-grain binding by the L17 order. That is possible, but it is a
second import contract and a per-tenant migration run.

D-63 already says the isolate default "is decided before any tenant data is stored". The
same holds for grain: **decide the first kind's grain before #2210 registers it** (§12 Q9).

## 9. How a kind declares its grain

The grain is the kind's, recorded in its registration (`STORE_KINDS`, open PR #2301), and
reviewed with it: `grain: 'scope' | 'tenant'`. The vertical's declaration does not change.

A vertical cannot choose the grain, because that would let a vertical decide that its data
lives in a store other verticals reach. A kind cannot be both, because its envelope, script
and lifecycle differ. A kind that wants both registers twice, under two kind ids.

## 10. Cost and complexity

| | A per scope | B instance, script per (kind, tenant) | B′ script per (kind, tenant, partition) | C instance on per-(kind, vertical) scripts | D platform ingestion |
|---|---|---|---|---|---|
| Meets the requirement | No | Yes | Yes | Only by becoming B or a fleet-wide script | Reads yes; synchronous writes no |
| Store scripts | kinds × verticals | kinds × tenants with an instance | kinds × partitions (scope × binding) | kinds × verticals | kinds × tenants (as B) |
| Release fan-out | per vertical | per tenant | per partition | per vertical | per tenant |
| Kind-code exposure (§3) | every tenant of the vertical | one tenant | one partition | every tenant of the hosting vertical, plus others' data | one tenant |
| Isolate shared with | other tenants of the vertical | the tenant's other partitions | nothing else | other tenants and verticals | the tenant's other partitions |
| Caller addressing of a partition | n/a | (i) kind; (ii) router | router | kind | platform |
| Data separation between partitions, against kind code | n/a | review | script boundary | review | review for the kind; ingestion is platform code |
| Synchronous write | yes | yes | yes | yes | no |
| Cross-partition traversal in one call | n/a | (i) yes; (ii) no | no | yes | in the platform's read model |
| New directory records | none | instances, connections | as B | instances, connections, a placement | instances, connections, watermarks |
| New dashboard surface | none | create, connect, read grants | as B | as B | create, connect |
| Erasure | per scope (built) | fan-in per partition (§7.1) | as B | as B | as B, plus ingestion replay |
| Tenant teardown | per scope (built) | new | new, per partition script | new | new |
| Reuse of the open stack | all | most, with the §8.1 changes | as B | most | envelope, entry, release; not the vertical door |

## 11. Recommendation

**B, with named instances and a script per (kind, tenant), and shape (ii) for the partition
between verticals.** Keep A for any kind registered at scope grain.

- **B is the only option that meets the requirement with synchronous writes.** Its script
  grain is also what makes strict tenant isolation hold below the envelope: a kind's code
  never runs where another tenant's objects are. That is a stronger isolation property than
  the status quo, at the price of a script count that grows with tenants.
- **Within a tenant, partition separation is review-only on one (kind, tenant) script.**
  That holds for (i) and (ii) alike (§3, §6). (ii) does not make the kind unable to move data
  between partitions. What it makes mechanical is caller addressing: which partition a call
  names, and which reads the router signs. It also makes the partition the platform's unit of
  wipe, export, size and erasure. That is why it is still the lean over (i). The gap between
  them is narrower than "platform-enforced against review-enforced", and (i)'s native
  traversal weighs more for that reason.
- **The first slice** is:
  - tenant-admin connections, per installation scope, behind a new key;
  - a write reaches only the caller's own partition;
  - reads of another partition only where the producer declares them shareable, read-only,
    by named operation, with an explicit grant per connection, and for non-personal shapes
    only (§6, §7.1).
- **Cross-partition traversal** is the main cost of (ii). If it proves necessary, add it as a
  platform-fed view, the D side of the hybrid, before considering (i).
- **Every option** hands the kind an environment without the store namespace and the
  verification keys (§3).

**Choose otherwise when:**

- **A**: the first kind's data turns out to be per scope after all, and the tenant-wide layer
  is a later, separate kind.
- **D, or the D+B hybrid**: no screen needs a synchronous write into the layer, or B's script
  count fails on a real Workers for Platforms account (§13). D then still needs B's script
  grain for its instance.
- **(i) over (ii)**: cross-vertical traversal in one call is the kind's core value, and the
  maintainer accepts registration review as the control for caller addressing too, as well as
  for data separation, which is review-held in both shapes. That should be written down as a
  standing condition, the way #2302 records Q3.
- **B′ over B**: the maintainer wants separation between partitions inside a tenant held by
  the platform rather than by review, and accepts a script per (scope, binding): an upload
  and a first-deploy window on every first connect, a per-partition release fan-out, more
  cold isolates, and cross-script reads.
- **Not C** in any case (§4).

### 11.1 Isolation requirements before third-party kinds

The maintainer wants these pursued under B and B′ before any kind written outside this repo
is registered. They are requirements, not designs. Each is marked where the repo cannot show
that Workers for Platforms supports it.

1. **A script per tenant.** A kind's code never runs in a script that holds another tenant's
   objects: one script per (kind, tenant) under B, and one per (kind, tenant, partition)
   under B′ (§4). The script-count limits are unverified (§13).
2. **No outbound access from a kind script.** A store script reaches nothing outside itself:
   no network, and no binding beyond what its own operations need. *Unverified.* A store
   object is a Durable Object. D-58 and D-61 record that the dispatch namespace's outbound
   worker (`apps/vertical-egress`) does not see Durable-Object-originated egress, so the
   mechanism verticals rely on cannot be shown to hold here. Whether a store script can be
   uploaded with outbound access denied at the platform level is not established in the repo.
3. **Verification outside the kind's reach.** The envelope and the remembered name are
   checked where the kind's code cannot alter them. Today the entry module runs in the kind's
   own interpreter (§3; #2302's Q3 answer holds it by review). The requirement is a check the
   kind cannot reach, for example in a separate script in front of the store's. *Unverified*,
   including what each extra hop costs.
4. **No platform bindings handed to the kind.** The environment the kind receives leaves out
   the store namespace and the verification keys (§3). *Unverified* for both runtimes.

## 12. Open questions

Each one is for the maintainer. The lean is stated so it can be rejected cleanly.

1. **Granularity.** One instance per tenant (per kind), or named instances, several per
   tenant? *Lean:* named instances. The maintainer's proposal asks for more than one, and a
   single implicit instance is the special case.
2. **The connection permission.** Reuse `dashboard:manage-integrations` (owner, admin), reuse
   `dashboard:provision-app` (owner, admin, member), or add a new key? *Lean:* a new key held
   by owner and admin. A connection here exposes one vertical's writes to another vertical's
   code, and that is wider than an integration.
3. **Cross-vertical read authorization.** Shape (i), (ii) or (iii) (§6). Within it, the
   options are:
   - no reads across partitions at all, with cross-vertical views only from a platform read
     model;
   - a read list per connection, over what the producer declares shareable;
   - all connected partitions readable.

   *Lean:* (ii), with a per-connection read list over producer-declared shareable operations,
   limited to non-personal shapes. The limit is permanent rather than "until the fan-in": the
   fan-in cannot reach a reader's copy (§7.1). If vertical authority over another vertical's
   data is judged unacceptable (the reason cross-scope-read rejects its candidate A), the
   first option is the one to take.
4. **Is the first slice ingestion-only (D)?** *Lean:* no, unless B's script count or upload
   behaviour fails on a real account. D cannot give the synchronous write.
5. **Residency.** Is the instance's jurisdiction fixed at creation, and must every connected
   scope match it? *Lean:* yes to both. A connect across jurisdictions is refused. Every
   scope is `global` today, so this is a rule to write down, not to build.
6. **Who may create instances.** Only a tenant admin, or also a vertical's provisioning when it is
   installed? *Lean:* tenant admin only. An instance is the
   tenant's shared thing, and no single vertical should mint one by being installed.
7. **Quotas.** How many instances per tenant, how many connections per instance, and how many
   bytes? *Lean:* a small platform ceiling on instances per tenant (each is a script under
   B), and a ceiling on connections per instance (each is an object, and a script under B′).
   Bytes are metered per partition (§7.5). The numbers come from a real account.
8. **Naming.** *Lean:*
   - a ULID id in every name, and the display name in the directory only;
   - script names `substrat-store-<kind>-t-<tenantId>`, held injective against L20's form.
9. **How a kind declares its grain.** *Lean:* `grain: 'scope' | 'tenant'` in the
   registration (§9), decided for the first kind before #2210 registers it.
10. **What disconnect does to the data.** Keep the partition, or wipe it? *Lean:* keep it,
    unwritable and readable only through existing grants. A reconnect of the same
    `(scope, binding)` to the same instance revives it (§5.1). Deleting it is an explicit
    tenant-admin step in the export, wipe, drop order. Copying a partition to another instance
    is later work.
11. **What a deleted scope's rows in an instance become.** Keep them, or remove them with a
    reserved `substrat.forgetScope`? *Lean:* remove them for a reaped scope, keep them for an
    archived one. It needs every write to carry its scope (§5.5).
12. **Preview, fork and snapshot reach.** None, read-only to the live instance, or a copied
    instance per preview? *Lean:* none in v1, matching `PREVIEW_CONNECTIONS_REFUSAL` and #2005.
13. **The door's name.** Keep `getScopeStore` for both grains, or add a door for a
    tenant-grain binding? *Lean:* keep it. The call is still made from a scope, and the grain
    is the kind's fact, not the caller's.
14. **Background writes.** Does a tenant-grain kind need a door for consumers and schedules
    (scope-stores Q6, item (u)) before its first tenant? *Lean:* it is likely needed, and it
    is a separate decision. The platform would sign it with audience `caller` for the scope
    the job runs in.
15. **One tenant-level instance mechanism, or two?** Should auth-server-style instances
    (§2.1) and store instances share one mechanism (one directory table of instances, one
    connection permission, one dashboard door), or stay separate? *Lean:* share the
    tenant-facing half (the list of instances, the connection permission and the door, so a
    tenant admin sees one place where verticals are connected to tenant-level things) and
    keep the transports separate. OIDC verification and the platform-routed envelope do not
    become one protocol, and the auth-server's per-scope wiring already ships.
16. **The connection's grain.** Per installation scope (§5.1), or per (tenant, vertical) so
    that every installation of a vertical shares one partition? *Lean:* per scope. It matches
    `peer_bindings`, connector grants and the auth wiring, and two installations of one
    vertical are separate data. A multi-scope installation is connected in one act that writes
    a row per scope.
17. **Per-call audit of `reader` calls.** A read of another partition is today one invocation
    log line in the reading vertical's request (scope-stores §6). Is that enough, or does each
    `reader` call also leave a row the producing installation's admin can see? *Lean:* the log
    line plus a per-connection read counter the dashboard shows, not a K-24 row per call. A row
    per read would be an audit class no other tenant read has (cross-scope-read §8.2 makes the
    same argument).
18. **Who sees the connection graph.** Which instances exist, which installations are
    connected, and who reads whom. Only tenant admins, every member with `dashboard:read`, or
    also the connected verticals? *Lean:* tenant admins, plus a read-only view for
    `dashboard:read`. A vertical sees only its own bindings' state (connected or not), never
    the graph.
19. **Deleting an instance that still has live connections.** Refuse until every connection is
    ended, or end them as the first step of the delete? *Lean:* refuse, and name the live
    connections in the refusal. Deletion then runs in the disconnect, wipe, drop order (§7.4),
    so a vertical never meets an instance vanishing under a live connection.
20. **Noisy neighbours within a tenant.** On one (kind, tenant) script, one installation's load
    or memory can restart every partition of the tenant. Accept it, add per-partition limits in
    the entry module, or take B′? *Lean:* accept it for the first kind and measure it. The
    isolate is the tenant's own, and B′ is the remedy if it bites.
21. **The script grain inside a tenant.** B (per kind and tenant) or B′ (per kind, tenant and
    partition)? *Lean:* B, with separation inside the tenant written down as review-held. B′ is
    to be revisited before a kind written outside this repo is registered at tenant grain,
    which is the same condition #2302 sets for Q3.
22. **The shareable list after the producer's connection ends.** The last recorded list
    stands, and the admin may only narrow it (§5.1). Or the ended partition becomes unreadable
    to everyone, or its grants lapse with the connection? *Lean:* the last recorded list stands,
    narrowable. The data is unchanged, so the producer's last declaration about it is still the
    right bound, and a reconnect replaces it with the producer's current declaration.

### 12.1 The maintainer's answers (2026-10-15)

All 22 questions were answered on 2026-10-15. The load-bearing ones are recorded as
[K-53](../decisions/K-053-a-tenant-level-store-is-a-named-instance-that-a-tenant-s-verticals-connect-to-explicitly.md).
The answers use the maintainer's new word **driver** for what this RFC calls a kind: the
platform-registered, pinned code that backs a store. The code, this RFC's body and the
ratified K-49, K-50, K-52 and D-63 text still say "kind" until a separate rename lands.

| Q | Topic | Answer |
|---|---|---|
| Q1 | Granularity | The lean: named instances, several per tenant |
| Q2 | The connection permission | A new connection permission key, held by owner and admin |
| Q3 | Cross-vertical reads | Shape (ii), with reads **opt-in**: a connection reads nothing from another partition until a tenant admin enables reads for that connection, and then only over the read operations the producer declared shareable. Limited to non-personal shapes, permanently |
| Q4 | Ingestion-only first slice (D) | The lean: no |
| Q5 | Residency | The lean: fixed at creation, and a connect across jurisdictions is refused |
| Q6 | Who creates instances | The lean: a tenant admin only, never a vertical's provisioning |
| Q7 | Quotas | The lean: a ceiling on instances per tenant and on connections per instance, bytes metered per partition, numbers from a real account |
| Q8 | Naming | The lean: a ULID in every name, the display name in the directory only, script names held injective against L20 |
| Q9 | How grain is declared | The driver declares it in its registration, `grain: 'scope' \| 'tenant'`, decided for the first driver before it is registered |
| Q10 | Disconnect | The lean: keep the partition, unwritable, readable only through existing grants; a reconnect revives it; deletion is an explicit step |
| Q11 | A deleted scope's rows | The lean: removed for a reaped scope, kept for an archived one |
| Q12 | Preview, fork and snapshot reach | The lean: none in v1 |
| Q13 | The door's name | The lean: `getScopeStore` for both grains |
| Q14 | Background writes | Decided in a **separate record**, which must be settled before a tenant-grain driver's first tenant. Deferred, not open-ended |
| Q15 | One instance mechanism or two | Share the tenant-facing half with auth-server-style instances (one directory of tenant-level instances, one connection permission, one dashboard door). The transports stay separate: OIDC verification and the platform-routed envelope do not become one protocol |
| Q16 | The connection's grain | The lean: per installation scope |
| Q17 | Per-call audit of `reader` calls | The lean: the log line plus a per-connection read counter |
| Q18 | Who sees the connection graph | The lean: tenant admins, a read-only view for `dashboard:read`, and a vertical sees only its own bindings' state |
| Q19 | Deleting an instance with live connections | The lean: refused, naming the live connections |
| Q20 | Noisy neighbours within a tenant | Option B: accepted for the first driver, and measured |
| Q21 | The script grain inside a tenant | Option B: one script per (driver, tenant), with separation inside a tenant held by review. B′ (a script per partition) is **required** before any driver written outside this repo is registered at tenant grain, the same condition #2302 sets for scope-stores Q3 |
| Q22 | The shareable list after a connection ends | The lean: the last recorded list stands, and the admin may only narrow it |

**Still open after these answers:**

- the separate record on background writes (Q14);
- the quota numbers (Q7) and the Workers for Platforms limits behind them (§13);
- the isolation requirements of §11.1, which gate any driver written outside this repo,
  B′ among them;
- the rename of "kind" to "driver" in the code and the ratified records.

## 13. Unverified

Not in this repository, or not shown by anything in it:

- **Workers for Platforms limits.** No figure for scripts per dispatch namespace, upload rate
  or script size is recorded in the repo. K-28 says a script-cap lift exists, gives no
  number, and records the first-deploy window of about 15 seconds. B's script count (one per
  kind and tenant) has to be checked against a real account before it is chosen. So does B′'s
  count (one per kind and partition, that is per installation scope × binding), together with
  the window it opens on every first connect.
- **A real dispatch-namespace upload of a store script, Python or JS.** It has not been run.
  Open PRs #2299, #2300 and #2301 say the same.
- **Isolate sharing between objects of one script.** It has not been exercised (spike
  FINDINGS, "Not shown"). The §3 exposure is argued from the design, not measured.
- **A filtered environment for the kind (§3).** Whether the entry module can hand the kind's
  class an environment without the namespace and verification-key bindings, with no other
  route left to them, has not been shown for either runtime (JS, or Python through its FFI).
- **Script isolation as the boundary for B′.** B′ rests on objects in different scripts never
  sharing an isolate. That is the Workers model every vertical already relies on, but it is
  not exercised for store scripts in this repo.
- **Read-only storage access for one call.** Whether a store object can run a `reader`
  operation under storage that refuses writes is not established. §6 (ii) therefore holds
  "read-only" by operation name and review, not by the storage layer.
- **D-64 and the D-63 amendment.** D-64 exists only on open PR #2298 and is not accepted as
  written. D-63's hash-and-commit pin is in a separate docs PR that is not merged. Neither is
  on `main`.
- **The ratification of K-49 and K-50, and the Q3 and Q5 answers.** These are open PR #2302,
  at head `68d47b39f`. They are not on `main`.
- **Cold-start cost per tenant script for the first kind's runtime**, and the bundle size it
  uploads per script. No measurement exists.

## Alternatives rejected

- **C as a standalone option** (§4). It is either B or the fleet-wide script D-63 rejects.
- **A vertical choosing the grain.** It would let one vertical decide that its data is
  reachable by others (§9).
- **The display name in the object name.** A rename would move the object, and names are not
  injective.
- **Folding instances into `tenantStores`.** Those are per (tenant, vertical, binding) and
  bound to the vertical's own serving script. They share nothing across verticals, and they
  are SQL handles, not a registered kind.
