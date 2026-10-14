---
status: proposed
layer: kernel
description: A read for the screen that lists a principal's scopes — declared, run by the host, checked by every scope it touches. #1581.
---

# RFC: a cross-scope read

**Status:** proposed — argued, not agreed · **Tracking:** [#1581](https://github.com/substrat-run/substrat/issues/1581)
· **Answers:** [kernel-design.md §13](../architecture/kernel-design.md), open question 18

A principal who belongs to N scopes has a first screen that lists all of them: the sidebar,
"shared with me", search across spaces, pending invites. That screen is cross-scope by
construction. The kernel names no read path for it. Every vertical whose unit of sharing is
the scope will therefore build one for itself, with its own cursor, its own bound or none,
and its own behaviour when one scope in the set cannot answer.

This RFC proposes a single sanctioned shape: a **declared cross-scope read, run host-side in
`vertical-host`**. It invokes one declared read-only paged operation in each scope of a
bounded set, as the requesting principal, and merges the pages under one cursor. Two
questions are left open for a human (§7): where the scope set comes from, and whether the
merged read is audited as one.

## 1. What exists, and why none of it is this

Every mechanism below crosses a scope or tenant boundary. Each one is shaped for a different
question.

| Mechanism | What it crosses | Why it is not this read |
|---|---|---|
| In-scope reads, `ctx.page` (§5.6 path 1, K-41/K-44) | nothing: one scope | One hop, one scope, by definition. Its keyset cursor is the discipline this RFC reuses (§4.2). |
| Outbox-fed external read model (§5.6 path 2) | scope → external store | Read-your-writes does not survive the crossing. Acceptable for a sidebar, but fatal for a screen re-read after its own write. |
| Tier 2 and the lake query gateway (§5.6 path 3, #2277) | the whole tenant's history | Staff-only and columnar. §5.6 says it is *"never a UI list view"*. |
| Peer calls (#1706) | vertical → vertical, same tenant | The target runs the call as the vertical's own subject (`vertical:<slug>`), holding what the target seated for that peer, not as the person. A vertical cannot peer-call itself. |
| Scope stores ([scope-stores.md](scope-stores.md), K-49) | scope → its own store | The router refuses a store call addressed to any scope other than the dispatch's own. |
| `readScopeTimeline` / `readScopeHistory` (#1582) | nothing: one scope's spine | A scope-wide walk since a watermark, within one scope. |
| The live change feed, `GET /api/live` (#938) | nothing: one scope | Push for one scope. A subscription over the set is out of scope here (§9). |
| `HostAdmin.listIdentityMemberships` (#1540) | every tenant a person belongs to | A staff-actor directory read that only the privileged dashboard may call. It is the escape hatch #1581 describes. |
| The platform's bounded fan-outs (`mapBounded`, the scope sweeper, the storage meter) | every scope of a tenant or of the fleet | Platform code that sweeps for the platform, not a read for a person. |

§5.4 closes the remaining door: *"Fleet questions never fan out."* That rule is about the
**fleet**: unbounded, cross-tenant and operator-shaped. The read here is bounded by one
person's memberships in one tenant's installation of one vertical, and the two must not be
confused. §8 keeps them apart mechanically.

## 2. Candidates

**A. Extend peer calls to address scopes of the same vertical.** Rejected. A peer call's
authority is the vertical's: the target admits it against the peers it declares and checks it
against permissions seated for `vertical:<slug>`. A person's sidebar built on it would show
whatever that subject may read in every scope, which is more than the person may read. That
is a widening of authority, and the purpose of this RFC is to make that impossible.

**B. A per-principal read model fed by the outbox.** Each scope's membership-relevant events
feed an external projection (D1/KV, or a per-tenant index object), and the screen reads that.
It is cheap and constant-time per page. It also brings §5.6 path 2's whole cost:
- no read-your-writes, so a list created a moment ago is missing;
- a second store holding a copy of every scope's listed fields;
- a residency question for every field it copies (K-7).

That is right for a staleness-tolerant surface. It is wrong as the default, because the screen
it would serve is the one a user returns to straight after a write.

**C. Platform-mediated fan-out.** The router or the control plane resolves the set and merges.
Rejected: it puts the shared platform on a vertical's per-request read path, against the
CP-less deploy every vertical has, and it grows the platform surface (K-20). The merge needs
nothing the vertical's own host cannot already do.

**D. A declared cross-scope read, run by `vertical-host` (recommended).** The vertical
declares, beside its operations, a cross-scope read:
- one existing read-only paged operation;
- the source of the scope set (open, §7.1);
- a bound.

The host resolves the set, invokes that operation once per scope as the requesting principal,
merges the pages, and answers one page with a typed account of every scope that did not answer.

D is the only candidate that adds no store, no subject and no permission. Each scope answers
the same operation it already answers alone, under the check it already runs. The merge is
host code: it is not module code, it already parses input and applies guards (the issue's own
"where it runs"), and it can hold a concurrency limit.

## 3. The declaration

```ts
export const crossScope = defineCrossScopeReads(spacesOperations)({
  'spaces/my-documents': {
    operation: 'spaces/list-documents',  // must be declared `paged`, and read-only
    set: 'memberships',                   // §7.1 — where the scope set comes from
    bound: 50,                            // at most this many scopes; above it, refused (§5)
  },
});
```

The name and the exact surface are illustrative. The properties are not:

- **The operation is an existing declared operation.** No second handler is written for the
  cross-scope case, so a scope can never answer differently inside a fan-out than alone.
- **It is paged** (K-41), so every scope answers with a keyset cursor the merge can hold.
- **It is read-only.** §5.6 already reserves `readonly: true` on an operation as the hook a
  later read path needs; this is that later path. A fan-out of a write is not this RFC.
- **The bound is declared** and capped by a platform ceiling, so the 40-scope caller is
  discovered when the bound is chosen, not in production.

## 4. The merged page

### 4.1 Running it

The host resolves the set (§7.1) to `(scope, principal)` pairs. A person's principal is
per-scope: the identity directory maps a `sub` to a principal **per scope**. The host then
invokes the declared operation in each scope as that scope's principal, with
`mapBounded`-style concurrency.

Each invocation is an ordinary invocation:
- parsed by the operation's declared input;
- guarded;
- checked by the operation's first line;
- logged by the invocation log as if called alone.

K-6 is untouched: each scope sees one read per merged page, queued like any other.

### 4.2 The cursor

The merged cursor is an opaque, versioned envelope in the same style as K-44's. It carries:
- the walk it belongs to (the cross-scope read's name, `order`, `sort`);
- the set it was minted over, as a digest;
- one per-scope K-44 cursor, or a marker that the scope is exhausted.

The merge is a k-way merge under the same total order the per-scope keyset uses, `(sort, id)`,
with the scope id as the final tie-break. A cursor replayed under another walk, or over a set
that has changed, is refused with K-44's `cursor_restart`, whose remedy is always the first
page.

That is K-41's tie-break discipline, extended by one key rather than reinvented. Each page
over-reads by at most `limit` rows per scope. That is the price of a merge with no shared
index, and it is bounded by the declared bound.

### 4.3 The answer

```ts
{
  entries: Array<{ scope: ScopeId; entry: T }>,
  nextCursor: string | null,
  unavailable: Array<{ scope: ScopeId; reason: 'suspended' | 'migrating' | 'archived' | 'timeout' | 'error' }>,
}
```

A partial page is a **stated** result: `unavailable` names every scope that did not answer, and
why. A scope that refuses the principal is **not** listed there. It is dropped as if it were not
in the set, so that membership in the set cannot be probed through the answer. §5 gives the full
behaviour.

## 5. Failure modes, named

| Condition | Behaviour |
|---|---|
| A scope is suspended, archived or mid-migration | Not invoked and not woken. Listed in `unavailable` with its reason. It is read from the lifecycle the scope already holds, the same gate a single call meets. |
| A scope is cold, or slow | Invoked under a per-scope timeout. If the timeout passes it is listed as `timeout`, and the page answers without it. |
| A scope refuses the principal (`forbidden`, `not_found`) | Dropped silently, as above. This is also how a stale set entry fails closed (§7.1). |
| The set exceeds the declared bound | Refused before any scope is invoked: `validation_failed`, reason `bound_exceeded`. Never truncated silently, because a truncated sidebar looks like a complete one. |
| Any other error in a scope | Listed in `unavailable` with reason `error`. The page still answers. |

## 6. Invariants any design must keep

1. **One tenant, one vertical.** The scope set and every scope in it belong to the tenant the
   router signed for this request, and to this vertical's installation. The set is never
   taken from an argument wider than that. Cross-tenant lists stay a privileged-surface
   concern (K-20), and the dashboard keeps its own.
2. **Authority is per scope, held by the scope.** Every invocation runs the operation's own
   `ctx.check` as the requesting principal. No new permission key, no aggregate role, no
   service subject, no grant. The merged answer can never contain a row that the N separate
   reads would not have returned.
3. **The set is a hint, never an authority.** Whatever source §7.1 picks may be stale. A stale
   entry is denied by the scope and dropped. A missing entry hides a scope and exposes nothing.
4. **Lifecycle is respected.** A scope the platform has suspended, archived or is migrating is
   reported, never woken to answer.
5. **The bound is enforced by the host** under a platform ceiling, and its refusal is named.
6. **Module code gains nothing.** No namespace, no other scope's `ctx`, no new import. The
   capability lives entirely in host code.
7. **Audit stays at least what it is now.** Every per-scope invocation leaves the record it
   leaves today. Whether the merge adds one more is §7.2.

## 7. Open questions

These are for a human. Each has a recommendation, and neither is settled by this document.

### 7.1 Where the scope set comes from

**(i) A hint index in the vertical's own identity directory.** The identity directory already
holds one link per `(scope, sub)` → principal. What it lacks is a read by `sub`. The index is:
- per tenant and per vertical, so no new isolation boundary is crossed;
- maintained the way K-22 maintains membership: the scope's own transaction emits a fat event,
  and a host-side executor updates the directory after commit, with the outbox as its
  durability backstop.

*For:* it answers discovery, which is the whole sidebar, and it reuses a store and a seam that
exist. *Against:*
- It is eventually consistent. "I was just invited" can lag by one dispatch. A write-through
  when the seat is granted narrows that but does not make it transactional, for K-22's own
  reason: a cross-DO write inside a scope transaction.
- A seat granted before the person's first sign-in to that scope has no link yet. The index
  must decide whether it records seats or only links.

**(ii) A caller-supplied subset.** The client names the scope ids it wants merged (a
saved sidebar, a "search these spaces" picker). The host checks only that each one is in the
routed tenant and installation, and the bound.

*For:* no index and no staleness. *Against:* it does not answer discovery, so on its own it
leaves the first screen unsolved.

**(iii) A `ctx` read, "which scopes may I reach".** This is a new capability with its own
permission question, and it puts a tenant-wide fact behind an in-scope API: the shape K-22
rejected for membership writes. Not recommended.

**Recommendation:** (i) as the default source, with (ii) also accepted as an explicit subset
under the same bound and the same per-scope checks. Both fail closed by invariant 3.

### 7.2 Is the merged read audited as one?

Today an operation read writes no audit row. The invocation log line is its record, and a read
emits no event. K-24's access log records staff reads through the host admin surface, not
tenant-facing operation reads.

**(a) One K-24-style row per merged read.** *For:* a single record of "this person listed
across these scopes". *Against:* it creates an audit class for one kind of tenant read that
no single-scope read has, and the row would sit outside every scope, so in the directory, for a
read that touched only scopes.

**(b) None beyond today, plus a `fanoutId`.** Each per-scope invocation line carries the
merged read's id, so the merged read can be reconstructed from the lines it already writes.
*For:* no new audit class, and nothing is lost. *Against:* reconstruction is a query, not a
row.

**Recommendation:** (b). If (a) is chosen, K-24 needs an amendment that says why this tenant
read is audited when the others are not.

## 8. Where it runs, and what it does not touch

- **`vertical-host`**, beside `mountOperations`: it derives a route for each declared
  cross-scope read, as it derives one for each operation. The scope-host contract gains at most
  the per-scope invocation the host already makes for a single call.
- **The kernel** gains no `ctx` surface and no table. If §5.6's `readonly` flag is not yet
  carried, it becomes carried. It is additive, and the section already reserves it.
- **The identity directory** gains the index of §7.1 (i), if chosen.
- **§5.4's rule stands.** A fleet question is unbounded and operator-shaped, and still goes to
  Tier 2. This read is bounded by declaration, scoped to one tenant and one installation, and
  checked per scope. The difference is held by invariants 1, 2 and 5, not by convention.

## 9. Not in this RFC

- **A subscription over the set.** The per-scope live feed (#938) exists. Merging N feeds into
  one socket is the push half of open question 18 and needs its own argument (connection
  budget, fan-in, revocation mid-stream).
- **A per-scope filtered spine walk.** The half of #1582 that is still open: a walk that visits
  only the events a caller may read. Related, but it is an in-scope question.
- **Cross-tenant lists.** The privileged dashboard keeps its own surface. A vertical
  never reads across tenants.
- **Writes across scopes.** A fan-out of a write is a distributed transaction, and nothing here
  argues for one.
- **Open question 19** (a tuple whose subject is another scope). It is adjacent, but it concerns
  where an authorization edge is stored, not how a list is read.

## 10. If accepted

The work splits into PRs that are each reviewable alone:

1. **The decision**: a K-number for the shape, and the two answers to §7.
2. **The scope set**: the §7.1 source, with a contract test on both adapters that a stale entry
   is denied and dropped, and that a missing entry exposes nothing.
3. **The merge**: the declaration, the host-side merge, the cursor and the failure modes, with a
   contract suite on both adapters. The suite must include its positive twin: a set the
   principal holds in full returns exactly the union of the single-scope pages.
4. **A demo exercising it**, since no demo does today. `demos/todo` lives in one scope.

## Alternatives rejected

- **Peer calls (A).** They read with the vertical's authority, not the person's (§2).
- **An outbox read model as the default (B).** It gives up read-your-writes on the screen that
  needs it most (§2). It remains available per surface under §5.6 path 2.
- **Platform-run merge (C).** It puts the shared platform on a vertical's read path (§2).
- **Truncating at the bound.** A truncated list is indistinguishable from a complete one. It is
  refused instead (§5).
- **Listing a refusing scope in `unavailable`.** That would let a caller probe set membership.
  It is dropped instead (§4.3).
