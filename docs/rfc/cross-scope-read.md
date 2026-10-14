---
status: proposed
layer: kernel
description: A read for the screen that lists a principal's scopes — declared, run by the host, checked by every scope it touches. #1581.
---

# RFC: a cross-scope read

**Status:** proposed — argued, not agreed · **Tracking:** [#1581](https://github.com/substrat-run/substrat/issues/1581)
· **Answers:** [kernel-design.md §13](../architecture/kernel-design.md), open question 18 (the read half)

A principal who belongs to N scopes has a first screen that lists all of them: a sidebar of
spaces, "shared with me", recent work across spaces, search across spaces. That screen is
cross-scope by construction, and the kernel names no read path for it. Every vertical whose
unit of sharing is the scope will therefore build one for itself, with its own cursor, its own
bound or none, and its own behaviour when one scope in the set cannot answer.

This RFC proposes one sanctioned shape: a **declared cross-scope read, run host-side**. It
invokes one declared read-only paged operation in each scope of a bounded set, as the
requesting person, and answers with each scope's page.

It is built in two slices:
- the first answers **per-scope sections** and needs no global order (§4);
- a later, globally merged page needs things a scope does not return today, and §5 states them
  rather than assuming them.

Nine questions are left open for a human (§8). Two of them are the original ones: where the
scope set comes from, and whether the read is audited as one.

## 1. What exists, and why none of it is this

Every mechanism below crosses a scope or tenant boundary. Each one is shaped for a different
question.

| Mechanism | What it crosses | Why it is not this read |
|---|---|---|
| In-scope reads, `ctx.page` (§5.6 path 1, K-41; K-44 pending ratification) | nothing: one scope | One hop, one scope. Its keyset cursor is what each section in §4 carries. |
| Outbox-fed external read model (§5.6 path 2) | scope → external store | Read-your-writes does not survive the crossing. Acceptable for a sidebar, but fatal for a screen re-read after its own write. |
| Tier 2 and the lake query gateway (§5.6 path 3, #2277) | the whole tenant's history | Staff-only and columnar. §5.6 says it is *"never a UI list view"*. |
| Peer calls (#1706) | vertical → vertical, same tenant | The target runs the call as the vertical's own subject (`vertical:<slug>`), holding what the target seated for that peer, not as the person. A vertical cannot peer-call itself. |
| Scope stores ([scope-stores.md](scope-stores.md), K-49) | scope → its own store | The router refuses a store call addressed to any scope other than the dispatch's own. |
| `readScopeTimeline` / `readScopeHistory` (#1582) | nothing: one scope's spine | A scope-wide walk since a watermark, within one scope. |
| The live change feed, `GET /api/live` (#938) | nothing: one scope | Push for one scope. A subscription over the set is out of scope here (§10). |
| `vertical-auth`'s **site registry** (`listSites`, `resolveSiteScope`; [multi-scope-manyfold.md](../architecture/multi-scope-manyfold.md), #365) | every scope of one installation | The closest prior art. It is a per-tenant, per-vertical list of an installation's scopes, kept in the identity directory, and the multi-scope demo's site switcher reads it. It lists **every** site of the installation, with no notion of which ones a person holds. It is a directory of scopes, not a read across them. |
| `HostAdmin.listIdentityMemberships` (#1540) | every tenant a person belongs to | A staff-actor directory read that only the privileged dashboard may call. It is the escape hatch #1581 describes. |
| The platform's bounded fan-outs (`mapBounded`, the scope sweeper, the storage meter) | every scope of a tenant or of the fleet | Platform code that sweeps for the platform, not a read for a person. |

§5.4 closes the remaining door: *"Fleet questions never fan out."* That rule is about the
**fleet**: unbounded, cross-tenant and operator-shaped. The read here is bounded by one
person's memberships in one tenant's installation of one vertical. §9 keeps the two apart and
says where each part of that separation is enforced.

## 2. Candidates

**A. Extend peer calls to address scopes of the same vertical.** Rejected. A peer call's
authority is the vertical's: the target admits it against the peers it declares and checks it
against permissions seated for `vertical:<slug>`. A person's screen built on it would show
whatever that subject may read in every scope, which is more than the person may read.

**B. A per-principal read model fed by the outbox.** Each scope's membership-relevant events
feed an external projection, and the screen reads that. It is cheap and constant-time per page.
It also brings §5.6 path 2's whole cost:
- no read-your-writes;
- a second store holding a copy of every scope's listed fields;
- a residency question for every field it copies (K-7).

It is right for a staleness-tolerant surface. It is wrong as the default for a screen a user
returns to straight after a write.

**C. Platform-mediated fan-out.** The router or the control plane resolves the set and merges.
Rejected: it puts the shared platform on a vertical's per-request read path, against the CP-less
deploy every vertical has, and it grows the platform surface (K-20).

**D. A declared cross-scope read, run by the host (recommended).** The vertical declares, beside
its operations:
- one existing read-only paged operation;
- the source of the scope set (§8.1);
- the input forwarded to each scope;
- a bound.

The host resolves the set, invokes the operation once per scope as the person, and answers with
each scope's section and a typed account of what did not answer.

D adds no store, no subject and no permission. Each scope answers the same operation it already
answers alone, under the check it already runs. Whether it keeps that promise across scopes
depends on the invariants in §7, one of which, issuer equality, is not obvious.

## 3. The declaration

```ts
export const crossScope = defineCrossScopeReads(spacesOperations)({
  'spaces/my-documents': {
    operation: 'spaces/list-documents',  // must be declared `paged`, and read-only
    set: 'memberships',                   // §8.1: where the scope set comes from
    forward: ['status'],                  // the declared filters whose values mean the same in every scope
    bound: 50,                            // at most this many scopes (§8.3)
  },
});
```

The name and the exact surface are illustrative. The properties are not:

- **The operation is an existing declared operation.** No second handler is written for the
  cross-scope case.
- **It is paged** (K-41) and **read-only**. §5.6 reserves `readonly: true` on an operation as the
  hook a later read path needs; this is that path. A fan-out of a write is not this RFC.
- **The forwarded input is fixed by the declaration**, and everything else is refused when the
  declaration is registered, not at request time:
  - forwarded: `limit` (the same per-scope limit for every section); `order` and `sort`, from the
    operation's declared sortable set; each scope's own `cursor`, taken from the merged cursor
    (§4.2); and the filters named in `forward`.
  - refused: an input field that carries an entity id or any other scope-local value, since an id
    from scope A means nothing in scope B; a filter not named in `forward`; and `total`, since a
    sum of per-scope totals over a set that is partly unavailable is a number nobody can read
    correctly. A per-section total is a later, separate question.
- **The bound is declared** and capped by a platform ceiling (§8.6).

## 4. The first slice: per-scope sections

### 4.1 Running it

The host resolves the set (§8.1) to `(scope, principal)` pairs. A person's principal is
per-scope: the identity directory maps an authenticated subject to a principal **per scope**.
Only scopes that pass the issuer check (§7, invariant 2) are kept.

The host then invokes the declared operation in each scope as that scope's principal, with
`mapBounded`-style concurrency. Each invocation is an ordinary one:
- parsed by the operation's declared input;
- guarded;
- checked by the operation's first line;
- logged by the invocation log as if called alone.

K-6 is untouched: each scope sees one read per page, queued like any other. The lifecycle a
CP-less scope enforces is the one delivered **into** the scope (#1713); the router's directory
gate covers only the routed scope. The host therefore learns a scope's lifecycle by asking that
scope, which wakes it. Answering lifecycle without a wake would need a lifecycle hint beside the
set, and that is left to §8.1.

### 4.2 The answer and the cursor

```ts
{
  sections: Array<{ scope: ScopeId; entries: T[]; nextCursor: string | null }>,
  unavailable: Array<{ scope: ScopeId; reason: 'suspended' | 'archived' | 'frozen' | 'timeout' | 'error' }>,
  nextCursor: string | null,
}
```

Each section is exactly the page the scope returned alone, in the scope's own order, with the
scope's own cursor. Since no rows from different scopes are compared, none of §5's ordering
problems arise.

The merged cursor is an opaque, versioned envelope that holds:
- the walk it belongs to (the cross-scope read's name, `order`, `sort`, forwarded filters);
- the set it was minted over, as a digest;
- for each scope, its own cursor (K-44, pending ratification), or a marker that it is exhausted,
  or a marker that it has not answered yet.

A scope that did not answer keeps its last position. The next page retries it from there, so a
timeout never skips that scope's rows. A cursor replayed under another walk is refused, with
the same remedy K-44 gives (the first page). The set changing mid-walk is the same: a new scope
cannot be spliced into a walk that has already passed its first page.

The screens this serves: a sidebar of spaces with each space's latest items, "shared with me"
grouped by space, and search across spaces with results grouped by space.

### 4.3 What is reported, and to whom

`unavailable` must not become an oracle. Under a caller-supplied set (§8.1 (ii)) the caller can
name any scope id. So the rule is: **a scope the principal is not known to hold is
indistinguishable, in the answer, from a scope that does not exist.** Concretely:

- A scope is listed in `unavailable` only when the set source records **this** authenticated
  subject as holding it (§8.1 (i)). A caller-supplied id that the source does not record is
  dropped silently, whatever its state.
- A scope that refuses the principal (`forbidden`, `not_found`), a scope of another tenant or
  installation, a scope whose issuer differs (§7, invariant 2), and a scope that is
  `provisioning` or `reaped` are all **dropped**, the same way and with the same timing class.
  None of them appears in the answer.
- The reasons map onto `scopeStatus` and the migration freeze:
  - `suspended` is `suspended`;
  - `archived` covers `archiving` and `archived`;
  - `frozen` is a migration in progress (a freeze, not a status);
  - `timeout` is a scope that did not answer in time;
  - `error` is anything else the scope answered with that is not a refusal.
- Everything dropped is recorded for the vertical's operator in the host's invocation log line,
  never in the answer.

## 5. A later slice: one globally merged page

A single list ordered across scopes ("recent across all spaces") needs a k-way merge. That
cannot be built from what a scope returns today, for four reasons, each of which becomes a
requirement:

1. **Per-entry positions.** A scope returns a cursor only at the end of its page. A merge usually
   emits part of a scope's page and must resume after the last emitted row. The K-44 envelope is
   kernel-minted and opaque, and "skip n" is an offset, which K-41 rejected for live data.
   *Requirement:* the kernel mints a resumable position **per entry** for a merge-capable read. A
   handler-composed (`sortKey`) read is ineligible until it does the same.
2. **The merge key is in the entry.** For a kernel-composed read the sort is a database column,
   while the entry is the module's projection, so the sort value may not be in `T` at all.
   *Requirement:* a merge-capable operation declares a **merge key** that is projected into the
   entry and validated by the host.
3. **One collation.** The scope orders with SQLite and the host would merge in JS, and the two
   disagree. SQLite's BINARY collation compares UTF-8 bytes while JS compares UTF-16 code units,
   so the two order U+FFFD and U+1F600 differently. A column holding mixed integer and text
   values also sorts by storage class. *Requirement:* a merge key is restricted to types whose
   orders agree on both sides: an integer, or text limited to ASCII (a ULID, an ISO 8601
   timestamp). A value outside the declared type fails that scope as `error` rather than
   misordering the page.
4. **A scope that times out on page k.** Its next row may sort before rows already emitted.
   *Requirement:* the merged cursor keeps that scope's position, and the page is marked
   incomplete. When the scope answers again its rows are delivered, never skipped. Whether they
   are delivered marked as late or the walk halts at the boundary until they arrive is an open
   question (§8.7).

None of this is needed for §4. That is why §4 ships first and §5 waits for a demonstrated screen
that cannot be served by sections.

## 6. Failure modes, named

| Condition | Behaviour |
|---|---|
| A scope the source records the person as holding is suspended, archiving, archived or frozen | Listed in `unavailable` with its reason (§4.3). Its cursor position is kept. |
| A scope is cold or slow | Invoked under a per-scope timeout. If the timeout passes it is listed as `timeout` and its position is kept. |
| A scope refuses the principal, is `provisioning` or `reaped`, belongs elsewhere, or trusts another issuer | Dropped. Indistinguishable from a scope that does not exist (§4.3). |
| A scope answers under a different declared version of the operation | Open (§8.4). Until it is decided: `error`. |
| The set exceeds the declared bound | Open (§8.3). The recommendation is a named refusal, never a silent truncation. |
| Any other error in a scope | `error`. The other sections still answer. |

## 7. Invariants any design must keep

1. **One tenant, one installation.** The set and every scope in it belong to the tenant the router
   signed for this request, and to this vertical's installation in that tenant. The set is never
   wider than that, whatever the caller supplies.
2. **One issuer.** Auth wiring is per scope: each scope's delivered `substrat:auth` config decides
   which issuer it trusts, so two scopes of one tenant can trust different issuers. The same
   `sub` from two issuers is two subjects. A scope joins the set **only if its auth wiring trusts
   the issuer that authenticated this request**. Any index of a person's scopes is keyed by
   `(issuer, sub)`, never by `sub`. A scope that disagrees is excluded, recorded for the operator,
   and never merged (§4.3).
3. **Authority is per scope, held by the scope.** Every invocation runs the operation's own
   `ctx.check` as that scope's principal. No new permission key, no aggregate role, no service
   subject, no grant.
4. **The set is a hint, never an authority.** A stale entry is denied by the scope and dropped. A
   missing entry hides a scope and exposes nothing.
5. **No oracle.** A scope the principal is not known to hold cannot be told apart from a scope
   that does not exist (§4.3).
6. **The bound is enforced**, under a platform ceiling, and its refusal is named.
7. **Module code gains nothing.** No namespace, no other scope's `ctx`, no new import.
8. **Audit stays at least what it is now.** Every per-scope invocation leaves the record it leaves
   today. Whether the read adds one more is §8.2.

With invariants 2 to 4 together, the answer can never contain a row that the N separate reads,
each authenticated against its own scope, would not have returned.

## 8. Open questions

These are for a human. Each has a recommendation, and none is settled by this document.

### 8.1 Where the scope set comes from

**(i) A hint index in the identity directory, keyed by `(issuer, sub)`.** The identity directory
already holds one link per `(scope, sub)` → principal, and the site registry already holds the
installation's scopes. What is missing is a read by subject. The index is:
- per tenant and per installation, so no new isolation boundary is crossed;
- maintained the way K-22 maintains membership: the scope's own transaction emits a fat event,
  and a host-side executor updates the directory after commit, with the outbox as its durability
  backstop.

It could also carry a lifecycle hint per scope, which would let §4.1 report a suspended scope
without waking it.

*For:* it answers discovery, which is the whole sidebar, and it reuses a store and a seam that
exist. It is also what makes §4.3's rule possible: a status is only reported for a scope recorded
against this subject. *Against:*
- It is eventually consistent. "I was just added" can lag by one dispatch. A write-through when
  the seat is granted narrows that but does not make it transactional, for K-22's own reason.
- A seat granted before the person's first sign-in to that scope has no link yet. The index must
  decide whether it records seats or only links.

**(ii) A caller-supplied subset.** The client names the scope ids it wants (a saved sidebar, a
"search these spaces" picker). *For:* no index and no staleness. *Against:* it does not answer
discovery. Without (i) beside it, §4.3 forces every non-answering scope to be dropped silently,
including one the person really holds.

**(iii) The site registry, filtered by the per-scope check.** *For:* it exists today. *Against:*
it is every scope of the installation, so the set is tenant-sized, the bound is reached by the
tenant's size rather than the person's, and every scope is woken to learn that the person holds
nothing there.

**(iv) A `ctx` read, "which scopes may I reach".** This is a new capability with its own
permission question, and it puts a tenant-wide fact behind an in-scope API: the shape K-22
rejected for membership writes.

**Recommendation:** (i) as the source, with (ii) accepted only as a **filter over (i)**. The site
registry supplies names, not the set. Pending invites are not served by this read at all: an
invitee holds no principal in the scope yet. If they belong on the same screen, they come from
the identity directory beside the index.

### 8.2 Is the read audited as one?

Today an operation read writes no audit row. The invocation log line is its record, and a read
emits no event. K-24's access log records staff reads through the host admin surface, not
tenant-facing operation reads.

**(a) One K-24-style row per cross-scope read.** *For:* a single record of "this person listed
across these scopes". *Against:* it creates an audit class for one kind of tenant read that no
single-scope read has, and the row would sit outside every scope.

**(b) None beyond today, plus a `fanoutId`.** Each per-scope invocation line carries the
cross-scope read's id, so the read can be reconstructed from the lines it already writes. *For:*
no new audit class, and nothing is lost. *Against:* reconstruction is a query, not a row.

**Recommendation:** (b). If (a) is chosen, K-24 needs an amendment that says why this tenant read
is audited when the others are not.

### 8.3 Above the bound

A person with `bound + 1` scopes loses the whole screen if the read refuses. A truncated list is
indistinguishable from a complete one, so truncation is not an answer. **Recommendation:** refuse
with `bound_exceeded` and name the remedy in the refusal: an explicit subset under §8.1 (ii). The
vertical's screen offers the picker.

### 8.4 Version skew between scopes

During a promote, scopes of one installation can run different versions (#1677), so the declared
operation's input, output or sortable set can differ between scopes in one walk. The guarantee
that each scope answers as it would alone holds per scope, and says nothing about consistency
across scopes. **Recommendation:** the cursor names a digest of the operation's declaration, and
a scope answering under another digest is reported as `error` for the rest of that walk, with a
dedicated reason once one is named. This needs the deployment version to be readable from the
answer.

### 8.5 Callers other than a signed-in person

The callers to decide are:
- impersonation (K-42), where support acts as a principal;
- capability principals (#1672);
- service principals;
- MCP-delegated bearers (#1824).

Each of these is minted against one scope, or carries an authority that is not "this person in
every scope". **Recommendation:** only a session principal authenticated by an issuer may fan out
in the first slice. Every other kind is refused with a named reason, and each is argued
separately before it is admitted.

### 8.6 Cost

One request can wake up to `bound` scopes and read up to `bound × limit` rows. **Recommendation:**
- a platform ceiling on `bound`;
- a per-request ceiling on `bound × limit`;
- a per-principal rate limit on cross-scope reads, separate from the single-scope limit.

The numbers are for the implementation PR, measured on workerd rather than chosen here.

### 8.7 Late rows in a merged page (§5 only)

When a scope that timed out answers on a later page, are its rows delivered marked late, or does
the walk halt at the boundary until they arrive? This is relevant only if §5 is built.

## 9. Where each invariant is enforced

| Invariant | Enforced by | Where it sits |
|---|---|---|
| 1. One tenant, one installation | The router, which signs the tenant for the request; the host, which holds the set to it | Router: the platform. Host: the `vertical-host` library inside the vertical's deployment. |
| 2. One issuer | The host's set resolution, against the identity directory's per-scope auth wiring | `vertical-host` and `vertical-auth`, inside the vertical's deployment |
| 3. Authority per scope | Each scope's own `ctx.check`, in the operation's first line | The kernel's scope door |
| 4. Hint, not authority | Follows from 3 | The kernel's scope door |
| 5. No oracle | The host's construction of the answer (§4.3) | `vertical-host` |
| 6. The bound | The host, under a ceiling the platform publishes | `vertical-host`; the ceiling's value is the platform's |
| 7. Module code gains nothing | `boundary-lint` and the absence of a `ctx` surface | Build-time lint, and the kernel |

The invariants held by `vertical-host` are a library's guarantees: they hold for every vertical
that serves the read through it, and the contract suite (§11) holds the library to them. Moving
any of them behind the platform, so that it holds independently of the vertical's own code, is a
later hardening and is not proposed here. §5.4's rule stands: a fleet question is unbounded and
operator-shaped, and still goes to Tier 2.

## 10. Not in this RFC

- **A subscription over the set.** The per-scope live feed (#938) exists. Merging N feeds into one
  socket is the push half of open question 18.
- **A per-scope filtered spine walk.** The half of #1582 that is still open.
- **Cross-tenant lists.** The privileged dashboard keeps its own surface.
- **Writes across scopes.** A fan-out of a write is a distributed transaction.
- **Open question 19** (a tuple whose subject is another scope).

## 11. If accepted

The work splits into PRs that are each reviewable alone:

1. **The decision**: a K-number for the shape, and the answers to §8.
2. **The scope set**: the §8.1 source, keyed by `(issuer, sub)`, with a contract test on both
   adapters covering:
   - a stale entry is denied and dropped;
   - a missing entry exposes nothing;
   - a scope trusting another issuer never joins.
3. **Sections (§4)**: the declaration, its registration-time refusals, the host-side fan-out, the
   cursor and the failure modes, with a contract suite on both adapters. The suite must include:
   - the positive twin: a set the principal holds in full returns exactly each scope's own page;
   - the oracle cases of §4.3, asserting identical answers for an absent scope and a forbidden one;
   - a timed-out scope resumed from its kept position.
4. **A demo exercising it.** The multi-scope demo ([multi-scope-manyfold.md](../architecture/multi-scope-manyfold.md))
   already has several scopes per installation and a site switcher.
5. **The merged page (§5)**: only once a screen needs it, with the kernel's per-entry position
   and the declared merge key, and a suite that hits each of §5's four cases.

## Alternatives rejected

- **Peer calls (A).** They read with the vertical's authority, not the person's (§2).
- **An outbox read model as the default (B).** It gives up read-your-writes on the screen that
  needs it most. It remains available per surface under §5.6 path 2.
- **Platform-run merge (C).** It puts the shared platform on a vertical's read path.
- **A global merge in the first slice.** It needs per-entry positions, a projected merge key and
  one collation, none of which a scope returns today (§5).
- **Indexing by `sub` alone.** One `sub` under two issuers is two subjects (§7, invariant 2).
- **Reporting any non-answering scope in `unavailable`.** That is an existence and lifecycle
  oracle (§4.3).
- **Truncating at the bound.** A truncated list is indistinguishable from a complete one.
