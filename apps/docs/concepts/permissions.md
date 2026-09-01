# Permissions

The permission **model** is kernel-owned — it is enforcement input, never delegated to
an auth provider. The **evaluation engine** is an adapter behind one interface, with a
built-in relationship-tuple engine as the default.

## The authored surface

Humans (and agents, under review) write three kinds of things:

### Permission keys

Module-namespaced strings declared in the [manifest](/concepts/modules) with
human-readable descriptions:

```
workorder:create   Create work orders
workorder:report   Start work, report time and material
invoicing:export   Export an invoice basis (makes it immutable)
```

### Roles @ nodes

A role bundles permissions; an assignment binds a principal to a role **at a node of the
tenancy tree** — the tenant root or a specific scope — with inheritance down the tree:

```ts
host.admin.defineRole(tenantId, {
  key: 'technician',
  permissions: ['workorder:read', 'workorder:report'],
  source: 'vertical',
});

host.admin.assignRole({
  principalId: tech,
  roleKey: 'technician',
  node: { tenantId, scopeId: stockholmBranch }, // or scopeId: null = whole tenant
});
```

### Capability grants

Narrow, direct, time-boxable grants — one permission, one node, optionally **narrowed to
one entity** and its declared descendants:

```ts
host.admin.grant({
  principalId: portalCustomer,
  permission: 'workorder:read',
  node: { tenantId, scopeId: branch },
  entity: { entityType: 'facility', entityId: theirBuilding },
  expiresAt: nextMonth,      // optional
  grantedBy: adminPrincipal,
});
```

Entity-narrowed grants are how portal users (a customer, a board member, a
subcontractor) see only *their* facilities and orders inside a shared scope. Grants can
also target an **organization**; members reach them via membership.

A **connection** is a first-class grant subject too — not only principals and orgs. A
connector (an external provider acting through a connection) can hold a capability grant
without pretending to be a person: `host.admin.grantToConnection(...)`, and a check's
subject is polymorphic (`{ kind: 'principal' | 'connection' | 'system', id }`). A
connection is keyed `(tenant, vertical, provider)`, so granting it one permission reaches
only that tenant's scopes running that vertical — the blast radius of a leaked provider
token is one permission on one vertical's data, readable in a diff.

A **module's system principal** is the third such subject — the caller behind
[scheduled work](/concepts/modules#recurring-work-schedules). A schedule runs an operation
on a timer, and it is not a person either; `host.admin.grantToSystem(...)` gives
`{ kind: 'system', id: moduleId }` exactly the permissions the schedule declared, so the
operation's own `ctx.check` resolves the same way it does for anyone — the gate stays the
check, never a bypass — and the emitted events read as `{ system: '@your/module' }`. Like a
connection it holds no memberships; its authority is exactly the grants written against
`system:<moduleId>`, projected at provisioning and revocable per scope.

Organizations are a real directory record, not a string you make up at the call site:

```ts
await host.admin.createOrg(actor, {
  id: orgId,          // branded ULID — slug and name are attributes, not identity
  tenantId,
  slug: 'acme',       // unique within the tenant
  name: 'Acme AB',
});
```

`addMember`, `removeMember`, `listMembers` and `grantToOrg` all **fail closed on an org
that does not exist in that tenant**. That refusal is the point of the record: a grant to
an org nobody registered would otherwise look applied, resolve for nobody, and still show
up in the permission diff as though access had been conferred. Because the id is a ULID
rather than a name, renaming an org cannot orphan the tuples that reference it.

## From declaration to enforcement

The **keys and role templates** are declared in TypeScript — the same objects the host
registers ([module manifests](/concepts/modules) declare the keys, provisioning declares the
roles). That declared surface is not trusted to stay honest by convention; it passes three
successive gates on its way to a running scope:

<PermissionPipeline />


Three kinds of honesty, at three altitudes:

- **Review-time.** `PERMISSIONS.md` is the human-readable render of the surface — the artifact
  for the [permission checkpoint](/concepts/modules). Because CI regenerates it with `--check`
  and fails on any difference, a role that gains a key cannot merge without showing up in the
  diff a reviewer must approve. The check reads the *same* declared objects the host registers,
  so the artifact cannot drift from what is enforced.
- **Deploy-time.** The surface is carried in the version's deploy manifest and content-hashed
  as `digests.permission`, so **admission** can compute a genuine permission diff between the
  running version and the incoming one. The declared surface is **immutable per version** — it
  is a property of the code, frozen when that version is built.
- **Request-time.** Roles and grants are *projected* into each scope's own tables at write
  time; the checker reads only that local projection (see below), and an absent or empty
  projection is a **deny**. Missing data can only ever remove authority, never confer it.

This is the same layering the rest of the model rests on: the **declared** surface is a
per-version code fact, **operator** state (a tenant's live roles) is a runtime-mutable table,
and **minted** grants are scope-local tuples. None is a copy that can silently diverge from the
others — each is the authority for its own layer.

## Evaluation: relationship tuples with a fixed algebra

Internally, the built-in checker compiles the authored surface into relationship tuples
(`subject → relation → object`) and evaluates checks with a **fixed, four-rule
derivation algebra**:

1. **Role expansion** — principal has role, role carries permission.
2. **Tenancy-tree inheritance** — permission at a node flows down to child scopes.
3. **Entity parent edges** — declared in module manifests (`workorder → facility`) and
   written at runtime via `ctx.link`; entity-narrowed grants flow along these edges,
   depth-capped.
4. **Org/group membership** — grants to an organization reach its members.

No negation, no configurable rewrite rules. Verticals never see or author tuples — roles
and grants remain the only authored surface.

**Where tuples live — a scope reads only its own state.** Scope and entity tuples (rules 2
and 3) live in the scope's own database and are evaluated inside its serialization domain, so
there is no distributed-consistency problem for them. Tenant-level facts — role *definitions*,
role assignments, tenant grants, and org membership (rules 1 and 4) — are tenant-wide, so the
**directory** (the control plane) is their authority. But the checker never reads the directory
on a request: the control plane **projects** those facts into scope-local tables
(`_substrat_roles`, `_substrat_tenant_tuples`) at *write* time, and the checker reads the
projection exactly as it reads scope tuples.

This is the important shift, and it is deliberate: **the control plane is a write-time
authority that projects into scopes; it is never a read-time dependency on the request path.**
Cost moves from the read path (every request) to the write path (rare role/grant changes) —
the correct direction for a read-heavy multi-tenant system, and what makes a scope genuinely
isolated: it can run as its own Cloudflare Worker with *no* control-plane binding at all. (For
the earlier per-request model and why it was replaced — scaling, isolation, and the
untrusted-vertical requirement — see the
[scope-local permissions design note](https://github.com/substrat-run/substrat/blob/main/docs/architecture/scope-local-permissions.md).)

The consistency consequence is small and one-directional. Scope-level grants/roles stay
synchronous and immediately consistent ("no zookies") — the checker runs in the scope's own
serialization domain. Only **tenant-level** changes are now eventually consistent across a
tenant's scopes, bounded by the write-time fan-out and a reconciliation sweep. An **absent or
empty projection is a deny**, byte-for-byte the normal deny path, so missing data can only ever
*remove* authority, never grant it. Revocation still fans out as tombstones (below) — now into
every scope the tuple was projected to.

## Revocation: tuples tombstone, they never disappear

Access is withdrawn by **tombstoning** a tuple — it keeps its row, gains a `revokedAt`,
and the checker's walk skips it. Nothing deletes a tuple.

That is deliberate. A tuple that once granted access is the evidence of *why* an access
was allowed, so deleting it destroys the audit trail exactly where it is most needed: a
deleted row can show neither that access was revoked nor that it was ever granted. Every
revocation path in the kernel works this way — `removeMember` is the first of them — and
`listMembers({ includeRevoked: true })` is the evidence view over the result.

Liveness is therefore one predicate, applied identically everywhere: a tuple grants only
while it is **unexpired and unrevoked**. Expiry (`expiresAt` above) and revocation are
siblings, not separate mechanisms. The checker interface is deliberately swappable (an OpenFGA-backed adapter is
the designated alternative), and any implementation must pass the same contract tests.

## Decisions carry proof

```ts
type Decision =
  | { allowed: true; proof: RelationTuple[] }   // the chain that granted access
  | { allowed: false; checked: PermissionKey; node: Node };
```

An allow **always** carries the tuple chain that produced it — an unexplained allow is
unrepresentable. This powers:

- **explain** — why does this user see this?
- **view-as-user** — render any screen as any principal, with real decisions;
- **the human-readable permission diff** — the review artifact for the permission
  checkpoint: who gains what, where in the tree.

And it carries past the request: when an operation emits, the kernel stamps onto the event
envelope which permission(s) it checked-and-passed and — when the allow came through a
capability grant rather than a role — a ref to the granting tuple (`authorization`, K-34).
The full chain is re-derivable by `explain`; what re-derivation cannot recover once tuples
have since changed is *which* permission and grant were consulted at write time. That pointer
is what the envelope keeps, so a mutation carries its own proof of authority
([Events & audit](/concepts/events)). Decisions carry proof forward, not only at the instant
they are made.

## Denials are recorded

An allow leaves its trace on the event it authorized; a **denial** has no event to ride, so
it is captured on its own. When an enforced check refuses, the kernel writes a row to a
scope-local `_substrat_denials` table (`id`, `actor`, `permission`, `tenant_id`, `scope_id`,
`operation`, `impersonation`, `at`, `drained_at`) — the one moment where an actor's intent and
the permission model visibly disagree, and which no other log witnesses (the admin log records
changes, the outbox records *allowed* mutations). Because a denial rolls its operation back,
the row is written **outside** that transaction, at the operation boundary after the rollback,
so the record survives the very failure it describes. `impersonation` is the same
`{ session, by }` stamp the event envelope carries, and null for the same reason — see
[Impersonation](/concepts/events#impersonation): `actor` is the principal the check answered
about, and this is the staff member who was acting as them, when one was.

This is **not** the K-24 staff-directory read log (`_substrat_access_log`): that records
control-plane *reads* against the directory; `_substrat_denials` records refused checks inside
a scope. Two different tables for two different facts. Both *drain* rather than expire —
`drained_at` marks a row shipped onward, and only a drained row may be pruned.

### Reading them back

Two staff reads on `HostAdmin`, served by the control plane as
`GET /tenants/:t/scopes/:s/denials` and `…/denials/summary`, and rendered per scope in the
console:

- **`summarizeDenials`** buckets the log per (actor, permission) with a count, the number of
  distinct operations, and first/last occurrence. This is the view to open first, and the
  ordering is **by count** on purpose: the volume of this log is attacker-influenceable — a
  probing client mints unlimited rows — so a newest-first page would let whoever wrote the
  last hundred rows push every other actor off the screen.
- **`listDenials`** returns the raw rows behind a bucket, newest first, narrowed by `actor`,
  `permission`, `operation`, and a `since`/`until` window.

The summary also carries the log's own **window** — its oldest and newest held rows, computed
*ignoring* the filter. That is what keeps an empty result honest: because rows drain rather
than expire, absence before the window's floor means "no longer held", not "never happened".

Both reads are actor-stamped and recorded to the K-24 access log, so reading the denial log is
itself logged, and both cross-check the `(tenantId, scopeId)` pair and fail closed on a
mismatch — a confused-deputy scope id resolves to nothing, never another tenant's refusals.

## In operations

The standard first line of every operation:

```ts
import { assertAllowed } from '@substrat-run/kernel';

const handler: OperationHandler<Input, Output> = async (ctx, input) => {
  assertAllowed(await ctx.check('workorder:read', orderRef(input.orderId)));
  // ...
};
```

`ctx.check` evaluates the ambient principal at the ambient node. Pass an `EntityRef` for
per-entity checks: the checker tries node-level first (staff see everything in the
scope), then walks the declared parent edges against entity-narrowed grants (portal
users see their own things).

## Sharing at runtime: `ctx.grant` and `ctx.revoke`

Entity-narrowed grants are minted at seed time by a platform actor (`HostAdmin.grant`).
When a **user** shares their own record with another person — and takes them off it
again — the operation does it itself, on `OperationContext`:

```ts
await ctx.grant(principal, PERM.listContribute, listRef(listId));   // share
await ctx.revoke(principal, PERM.listContribute, listRef(listId));  // un-share
```

Three guardrails make this non-escalating by construction:

- **Entity-required** — module code can never write a scope- or tenant-wide grant, only
  narrow one onto a thing.
- **Delegating** — the caller's own decision on that entity is re-checked, so an operation
  can only hand out what it was itself given. Delegation, never elevation.
- **Transactional** — a grant made by an operation that then throws never happened, the
  same as its rows and its events.

Every later `ctx.check` reads the grant, so nothing else in the app has to remember who
may touch what. Neither alternative is this: a `ctx.link` parent edge is **not revocable
at all** — it is permanent — and org membership is revocable but coarse-grained (a whole
org, not one record). The mistake this section exists to prevent is minting an org per domain row — or keeping a
membership table consulted by hand in every handler — to get a revoke the kernel already
has. The [todo demo](https://github.com/substrat-run/substrat/tree/main/demos/todo)
(`src/module.ts`, `todo/share-list` and `todo/revoke-share`) is the two-line reference.

### The screen outlives the grant

A revoke has a client-side half. The app follows three rules, and the first two are the
ones every vertical here already keeps: it **never filters for access** — a list nobody
shared is not hidden, it never comes back from the server at all — and it **renders what
the server returned**, so a 403 is a wall with the server's own message, never an empty
list. The third is the one a permission-centric app cannot skip: it **re-asks**. Someone
sitting on a list they were just removed from keeps seeing it until something refetches.
Nothing leaks — the server refuses every subsequent action — but they are looking at data
they no longer have access to, and for an app whose pitch is "you see only what you may",
that is the worst-looking failure available, and exactly what a revocation demo shows on
stage. So a view revalidates on focus, on visibility and on a slow poll
(`useAutoRefresh(load)` from `@substrat-run/ui`), a click on the nav item already selected
refetches instead of being a no-op same-route link, and a read that comes back 403
**replaces** the content with the wall rather than leaving it underneath — every read the
screen makes, the next page of a walk and the detail of one row as much as the refetch.
`demos/todo/app/src/App.tsx` (`ListView`) and `demos/shop/app/src/App.tsx` (the nav tabs)
are the reference.

## Assigning a role: `ctx.canAssign`

Reviewing role *definitions* protects nothing on its own. Nothing in a checkpoint over
`defineRole` stops an `admin` from assigning someone — or themselves — to `owner`: no
role was widened, no `defineRole` was called, and no permission diff shows anything. The
moment a vertical defines any role carrying role-assignment permission, assignment
becomes an escalation path.

So there is a bound, and it is a mechanism rather than a convention:

> A principal may assign role `R` at node `N` only if the assigner already holds every
> permission `R` carries at `N`.

```ts
'team/invite': async (ctx, input) => {
  assertAllowed(await ctx.check(MEMBER_MANAGE));      // may you manage members at all
  const bound = await ctx.canAssign(input.roleKey);   // may you confer THIS much
  if (!bound.covered) {
    throw substratError('forbidden', `cannot assign ${input.roleKey}: you do not hold ${bound.missing.join(', ')}`);
  }
  …
}
```

Two checks, in that order, answering different questions. `canAssign` is a bound, never a
substitute for the operation's own permission check.

**Removal takes the same bound.** A junior admin who can strip a role they could not have
granted can lock the owner out of their own tenant. Revocation is the mirror of
assignment, not a lesser act — so gate both sides on it.

**It is narrowing-aware, and that is the load-bearing part.** Only authority held at the
*node* counts. A principal whose `workorder:read` is narrowed to one entity does not
thereby hold `workorder:read` for the purposes of this comparison — otherwise sharing a
single record would launder into authority over every record, by way of assignment.
Membership does expand: authority held through an org is authority that can be conferred.

**One resolution, not N checks.** `ctx.check` answers about one permission and walks the
tuples to do it, so asking it twenty times for a twenty-permission role walks them twenty
times on every invite acceptance. The kernel resolves the effective set once and compares
— which is also why the comparison lives in the kernel rather than in each vertical:
enumerating "who can do what" is the kernel's job, and this is that enumeration turned
inward.

**Bootstrap.** The rule implies a tenant's first admin cannot assign themselves, and does
not need to: the initial owner is seeded platform-side during provisioning, which is
out-of-band host code that already holds the authority. Self-service begins at the second
member.

## Defaults

- `denyAllChecker` — the secure default. A host without an explicit checker allows
  nothing.
- `UNSAFE_allowAllChecker` — grants everything to everyone via a synthetic proof tuple.
  For tests and scratch scripts; the name is deliberately alarming. Never wire it into
  anything a tenant can reach.
