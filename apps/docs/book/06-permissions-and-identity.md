---
description: "Authentication is a seam; authorization is kernel-owned. Permission keys, roles at nodes, entity-narrowed grants, the fixed four-rule tuple algebra, and why a check never leaves the scope."
---

# 6. Permissions and identity

Two questions that look like one and are not.

**Authentication** asks who someone is. It happens at the edge, it involves an issuer, and
Substrat has an opinion about none of it beyond the shape of the seam.

**Authorization** asks what they may do. It is kernel-owned, it is enforcement input, and
it is never delegated to an auth provider — because an authorization model that lives in
your identity vendor is a model you cannot reason about, version, diff, or take with you.

## Authenticate: the neutral seam

A vertical is an OIDC relying party. Sign-in is a redirect to an issuer and back; the
vertical runs no credential store, holds no passwords, and implements no reset flow.

What comes back is a `sub` — a subject identifier from the issuer. That is not yet
anything. The per-tenant identity directory maps `sub` → `PrincipalId`, and a `sub` with
no mapping is a person who has authenticated perfectly and may do **nothing**. The two
halves are genuinely independent: proving who you are gets you no authority at all.

Every demo vertical in the repo is OIDC-only, and the local development story is a real
OIDC provider (`@substrat-run/dev-issuer`) whose only shortcut is that `/authorize` lists
names instead of asking for a password. So the local login *is* the production round-trip,
and changing issuer is a change of `OIDC_ISSUER` rather than a change of code. There is no
dev-auth branch to diverge.

[Authentication & identity](/concepts/identity) is the detail — issuers, adapters, first-login
sync, and the owner-claim flow for a freshly provisioned instance.

## Authorize: three authored things

Humans, and agents under review, write exactly three kinds of thing.

**Permission keys** — module-namespaced strings, declared in the manifest with
human-readable descriptions:

```
workorder:create   Create work orders
workorder:report   Start work, report time and material
invoicing:export   Export an invoice basis (makes it immutable)
```

**Roles at nodes** — a role bundles permissions; an assignment binds a principal to a role
**at a node of the tenancy tree** (the tenant root, or one scope), inheriting downward.

```ts
host.admin.assignRole({
  principalId: tech,
  roleKey: 'technician',
  node: { tenantId, scopeId: stockholmBranch },  // scopeId: null = whole tenant
});
```

**Capability grants** — one permission, one node, optionally narrowed to **one entity** and
its declared descendants, optionally time-boxed:

```ts
host.admin.grant({
  principalId: portalCustomer,
  permission: 'workorder:read',
  node: { tenantId, scopeId: branch },
  entity: { entityType: 'facility', entityId: theirBuilding },
  expiresAt: nextMonth,
  grantedBy: adminPrincipal,
});
```

Entity-narrowed grants are how a customer, a board member or a subcontractor sees only
*their* things inside a shared scope. A grant can also target an organization, and members
reach it through membership.

That is the entire *administrative* surface, and there is no fourth kind of thing to
author. What arrives later in this chapter is not a fourth kind but a fourth *author*: a
user sharing one record from inside an operation, which mints a capability grant of exactly
the shape above.

## How a check is answered

<PermissionPipeline />

Internally the checker compiles those three things into relationship tuples
(`subject → relation → object`) and evaluates with a **fixed four-rule algebra**:

1. **Role expansion** — principal has role, role carries permission.
2. **Tenancy-tree inheritance** — a permission at a node flows down to child scopes.
3. **Entity parent edges** — declared in manifests (`workorder → facility`) and written at
   runtime by `ctx.link`; entity-narrowed grants flow along them, depth-capped.
4. **Org membership** — grants to an organization reach its members.

No negation. No configurable rewrite rules. Verticals never see or author tuples.

The fixed algebra is the point. A policy language rich enough to express anything is rich
enough to express a policy nobody can predict the behaviour of, and "why can this person
see this?" stops having an answer. Four rules have an answer, always.

## The check does not leave the scope

This is the design decision with the widest consequences, so it is worth stating plainly.

Scope and entity tuples (rules 2 and 3) live in the scope's own database and evaluate
inside its serialization domain. Tenant-level facts — role definitions, role assignments,
tenant grants, org membership (rules 1 and 4) — are tenant-wide, so the control-plane
directory is their authority.

But **the checker never reads the directory on a request.** The control plane *projects*
those facts into scope-local tables (`_substrat_roles`, `_substrat_tenant_tuples`) at
**write** time, and the checker reads the projection exactly as it reads scope tuples.

> The control plane is a **write-time authority that projects into scopes**. It is never a
> read-time dependency on the request path.

Cost moves from the read path (every request) to the write path (rare role and grant
changes), which is the correct direction for a read-heavy multi-tenant system. And it is
what makes a scope genuinely isolated: a vertical can run as its own Worker with **no
control-plane binding at all**, which is the shape a customer-pushed vertical ships in.

The consistency consequence is small and one-directional. Scope-level grants and roles stay
synchronous and immediately consistent — the checker runs in the scope's own serialization
domain, so there is no "did my write land" question. Only *tenant-level* changes are
eventually consistent across a tenant's scopes, bounded by the write-time fan-out and a
reconciliation sweep.

And the failure direction is safe: **an absent or empty projection is a deny**, byte for
byte the normal deny path. Missing data can only ever remove authority, never grant it.

## Revocation tombstones

Access is withdrawn by **tombstoning** a tuple: it keeps its row, gains a `revokedAt`, and
the checker's walk skips it. Nothing deletes a tuple, ever.

A tuple that once granted access is the evidence of *why* an access was allowed. Deleting
it destroys the audit trail exactly where it is most needed — a deleted row can show
neither that access was revoked nor that it was ever granted.

"Ever" means for as long as the scope does. Reaping is the one thing that takes a tuple
away, because reaping takes the whole database the projection lives in; what outlives it is
the admin log, which is never swept (chapter 10).

Liveness is therefore one predicate applied identically everywhere: a tuple grants only
while it is **unexpired and unrevoked**. Expiry and revocation are siblings, not separate
mechanisms.

## Decisions carry proof

```ts
type Decision =
  | { allowed: true; proof: RelationTuple[] }   // the chain that granted access
  | { allowed: false; checked: PermissionKey; node: Node };
```

An allow **always** carries the chain that produced it. An unexplained allow is
unrepresentable — which is a strong statement, and it is what makes three features possible
rather than aspirational: **explain** ("why does this user see this?"), **view-as-user**
(render any screen as any principal, with real decisions), and the human-readable
**permission diff** that the merge checkpoint reads.

The proof also travels. When an operation emits, the kernel stamps onto the envelope which
permissions it checked and passed, and — when the allow came through a capability grant
rather than a role — a reference to the granting tuple. `explain` can re-derive the chain
later, but it cannot recover *which* grant was consulted at write time once the tuples have
moved since. That pointer is what the envelope keeps, so a mutation carries its own proof
of authority.

## Denials are recorded

An allow leaves its trace on the event it authorized. A denial has no event to ride, so it
is captured on its own: a row in the scope-local `_substrat_denials` table with the actor,
the permission, the node, the operation, the impersonation session, and the time.

This is the one moment where an actor's intent and the permission model visibly disagree,
and no other log witnesses it — the admin log records changes, the outbox records *allowed*
mutations.

The mechanical detail from chapter 3 matters here: because a denial rolls its operation
back, the row is written **after** the rollback, as its own write. Only an *enforced* denial
is recorded — one that went through `assertAllowed` and therefore carries the checked key
and node. A module's own hand-thrown `PermissionDenied` is its policy, carries no key, and
is left alone.

## Sharing at runtime

Everything above is administrative. The same capability grant has a second author, and it
is the user rather than the admin: **`ctx.grant` and `ctx.revoke`**, called from inside an
operation.

```ts
await ctx.grant(theirPrincipal, 'todo:read', { entityType: 'list', entityId: listId });
await ctx.revoke(theirPrincipal, 'todo:read', { entityType: 'list', entityId: listId });
```

Both are entity-required and **delegating** — the caller's own decision on that entity is
re-checked, so you cannot share what you cannot see. Both are transactional with the
operation: if it rolls back, so does the share.

This is the primitive for "share this record with a person", and neither alternative is it.
A `ctx.link` edge is permanent and not revocable at all. Org membership is revocable but
coarse — a whole org, not one record — and minting an org per domain row to obtain a revoke
is a known anti-pattern with an issue number attached to it.

`demos/todo/src/module.ts` shows both in one line each, and is worth reading before you
design any sharing feature.

## The permission checkpoint

New permission keys and role definitions are one of the two things an agent may never
self-approve. The mechanism: each vertical exports `MODULES` and `ROLES` from its seed,
`pnpm lint:permissions` renders `demos/*/PERMISSIONS.md` from those same objects, the file
is checked in, and CI re-emits with `--check`.

So a widened role cannot merge without appearing in the PR diff as a table of key →
description → which roles hold it. CI going red is what makes the reading unskippable; it
is not itself the approval. A human reads the diff.

---

**Next:** [Engines, verticals, composition →](/book/07-engines-and-verticals)
