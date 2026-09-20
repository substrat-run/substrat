---
status: canonical
layer: kernel
description: How canopy's user/space/drive model maps onto tenant, scope and vertical — and the five places it does not.
---

# Canopy on the scope model

Canopy is Substrat **consumer #2** under [D-17](../DECISIONS.md): the document product's
engine extracts into the kernel, and the product re-platforms onto the kernel piecemeal.
This document is the mapping that makes both halves estimable. It is written against
canopy `bc73c53` and this repository at `a67c59b7`, and it is kept current rather than
dated — where the two repos move, this page moves with them.

> **What this is for.** Every other ticket on canopy's convergence rail currently costs
> "we'd have to look." The July 2026 mapping was written against a Substrat with two
> scaffolded engines and no Cloudflare adapter, and is wrong in most of its particulars.
> This one is written against the kernel that exists.
>
> **What this is not.** It decides nothing. Where the two models genuinely disagree, the
> disagreement is filed as an open question in
> [kernel-design.md §13](kernel-design.md#13-open-design-questions-technical-siblings-of-11-in-the-plan)
> and argued there, not settled here. Three such questions (18, 19, 20) were filed from
> this mapping.

## 1. The three-line mapping

| Canopy | Substrat | Fit |
|---|---|---|
| user | **tenant** (one personal tenant each) | Good, with one hole — §4 |
| space (`personal` \| `group` \| connected) | **scope** — `kind: 'space'`, Shape A | Good; the shape choice is the easy part |
| portal + plugins | **vertical** | Good for the portal, wrong for the plugins — §7 |

**Shape A is the right shape and was chosen for this case.** `kernel-design` §5.2's own
table names "document-spaces product (consumer #2, D-17)" as what Shape A is *for*: the
scope DO is the database, PITR is the ops path, and the per-tenant-D1 option (#301) is an
additional store rather than a replacement. Nothing in canopy's data model argues against
it — the largest space is a connected NAS index, which is rows-about-bytes, not bytes.

**`jurisdiction: 'eu'` is not available, and the rail should stop saying it is.** K-32
made the storable vocabulary `eu | us | global`, non-null, defaulting to `global` — but it
also added `provisionableJurisdiction = z.enum(['global'])`, and the provisioning boundary
refuses `eu` with a 400 until DO jurisdiction subnamespaces and Regional Services are
bought and built ([`packages/contracts/src/tenancy.ts:120`](../../packages/contracts/src/tenancy.ts#L120)).
A canopy space provisioned today is `global`, and because jurisdiction is immutable (K-7)
that is a decision, not a default: an `eu` space is a re-provision later, never a flag
flip. Say `global` and plan the migration, or buy the enforcement first.

## 2. The crux, quantified

The rail states the crux as "shared DB with `spaceId` columns vs scope isolation." That is
right in direction and misleading in size, in both directions. The actual shape of
canopy's store is worth stating precisely, because it changes what the port costs.

Canopy has **29 tables** (plus `_migrations`). Only **12** carry a space discriminator —
and one of those, `files`, carries it in a column named `tenant_id`, whose value has been
a space id since schema v2. Five more inherit a space transitively through a foreign key.
The remaining twelve do not belong to a space at all:

| Plane | Tables | Where it goes |
|---|---|---|
| **Scope-plane, direct** (12) | `connections` `events` `files` `folders` `principals` `shares` `space_invites` `space_plugins` `space_prefs` `space_seq` `tasks` `tombstones` | Into the scope. Mechanical |
| **Scope-plane, transitive** (5) | `file_versions`→`files`, `file_comments`→`files`, `ai_search_items`→`files`, `index_runs`→`connections`, `event_participants`→`events` | Into the scope with their parent |
| **User-plane** (5) | `app_passwords` `plugin_installs` `plugin_settings` `custom_plugins` `mcp_clients` | **No home** — the kernel has no tenant-level module storage. §4 |
| **Platform-plane, solved** (3) | `users` `spaces` `kv_cache` | The identity directory and the scope directory already exist; `kv_cache` is per-scope or deleted |
| **Platform-plane, unsolved** (2) | `blobs` `relation_tuples` | §5 and §6 — the two that have no answer |
| Dead | `file_permissions` (superseded by tuples at v2, left in place) | Delete |

So the re-platform is not "add a scope hop to 29 tables." **Seventeen of twenty-nine move
without an argument.** The work is concentrated in five tables and one read pattern, and
that is the honest scope of S10.

The encouraging half: `changesSince`
([`files.ts:2118`](https://github.com/markusahlstrand/canopy/blob/main/packages/store/src/files.ts#L2118))
is **already written as a per-space loop** over a shared database. Each iteration issues
its own `WHERE tenant_id = ?` query. The port replaces a local query with a stub call
inside a loop that already exists. Several of canopy's reads are shaped like this, which
is what two months of `spaceId`-discipline bought.

The discouraging half is everything that is *not* inside that loop, which is §3.

## 3. Mismatch 1 — the cross-scope read, which has no path at all

This is the largest finding in this document and it is not the one the rail predicted.

A canopy user belongs to N spaces. The first screen they see is a sidebar of all of them.
`/api/changes` takes a `{spaceId: seq}` cursor **across every space the caller can read**
and returns one merged page. `/api/spaces`, `/api/shared-folders`, `/api/invites/pending`,
`/api/people` and `/api/search` are cross-space by construction. Under space → scope, every
one of those becomes a read across N scopes.

The kernel has **three** read paths (§5.6) and none of them serves this:

1. **In-scope reads** — one scope, one hop. By definition not this.
2. **Outbox-fed external read model** — possible, and it carries §5.6's stated cost:
   read-your-writes does not survive the crossing. For a sidebar that is survivable; for
   an offline mirror's delta feed, a client that writes a file and pulls a delta that does
   not contain it will re-sync forever.
3. **Tier 2 (Iceberg / R2 SQL)** — explicitly *"never a UI list view. It is a history
   tier, not a read tier, and treating it as the latter is a category error."*

And §5.4 closes the remaining door: *"Fleet questions never fan out. Cross-scope queries go
to Tier 2."*

The vertical can of course fan out itself — N stub calls from its worker, merged in the
host. That works, it is what the existing loop becomes, and it is bounded by the number of
spaces a person has. But it is unbounded *in principle*, it is uncached, it serializes
behind each scope's write queue (K-6), and nothing in the kernel names it as a sanctioned
pattern, gives it a page contract, or bounds its fan-out. A vertical inventing it per
screen is how one of them ships a 40-scope first paint.

**Filed as open question 18.** This is not a canopy quirk either: any vertical with a
"things shared with me" screen has it, and `demos/todo`'s shared lists only avoid it because
every list lives in one scope.

### 3a. The live channel has no primitive at all

`/api/changes/stream` is an SSE nudge backed by a per-space `SpaceChannel` Durable Object:
when a space's sequence advances, connected clients get a `bump` and pull. It carries no
data, so its permission question is only "may you listen to this space."

Substrat has no equivalent. There is no `WebSocket`, no `text/event-stream` and no
subscribe surface anywhere in `packages/kernel`, `packages/adapter-cloudflare` or
`packages/vertical-host`. The ScopeDO is a Durable Object and therefore *could* hold
hibernatable WebSockets, but nothing in the contract exposes that, and a vertical cannot
reach the namespace itself (K-8). Any canopy port either drops live updates for polling or
stands up a second DO class beside the scope — which is exactly the "vertical builds its
own coordination plane" shape the kernel exists to prevent.

Folded into question 18 rather than filed separately: the answer to "who composes a
cross-scope read" and "who pushes when a scope changes" is likely one mechanism.

## 4. Mismatch 2 — user → tenant works until a table is per-user

`user → tenant` is a clean line for identity: canopy's `users` table is an OIDC-`sub`
directory upserted on login, which is what the identity pools (K-23/K-25) and
`vertical-auth` already are.

It breaks on storage. Five canopy tables are keyed by `user_sub` and belong to no space:
app passwords, plugin installs, plugin settings, custom plugins, MCP clients. In the
kernel, **module code has no tenant-level table**. `ctx` exposes `tenantId` and a
scope-bound `ctx.sql`, and the tenant-root DO is *"lightweight by rule — it holds
control-plane state only"* (§3.2). There is nowhere for a per-user, cross-space row to live
that module code can write.

Two workable answers, neither free:

- **Put them in the user's personal scope.** Correct for ownership — but reading them from
  inside a *group* scope is a cross-scope read, which is §3 again.
- **Make them a directory fact via the K-22 seam.** The engine emits, a privileged executor
  outside module code effects it through the host admin surface. This is the sanctioned
  pattern for tenant-wide facts and the one membership already uses. It costs an executor
  per fact type and it is eventually consistent.

This is not an open question — the mechanism exists and K-22 settled the shape. It is a
cost line for S10 that the rail does not currently carry.

There is a second, sharper hole. A canopy **group space** has members from different
users, i.e. from different tenants. A scope belongs to exactly one tenant. So either
group spaces live in a tenant that is not any member's (a "space tenant", and then
`user → tenant` is only true of personal spaces), or they live in the creator's tenant and
every other member reaches them by **cross-tenant capability grant** (§4.1's `CapabilityGrant`
is explicitly *"also the cross-tenant mechanism"*). The second is the model's intended
answer and it works — but it means the creator's tenant is load-bearing forever, and
"what happens when the creator leaves" becomes a product question with a tenancy answer.

## 5. Mismatch 3 — folder grants, and the one canopy solved that the kernel has not

The rail frames this as "canopy folder grants vs the kernel's path-based model." That is
backwards: canopy's model is the path-based one, and the kernel's is not.

**Canopy.** A folder is *virtual* — derived from a file's `metadata.path`. A folder tuple's
object id is `${spaceId}${path}`, and a grant on a path covers that path and
everything under it, checked by expanding the path's ancestors
([`authz.ts:26–37`](https://github.com/markusahlstrand/canopy/blob/main/packages/store/src/authz.ts#L26)).

**The kernel.** Containment is a **manifest-declared entity parent edge** — a real tuple
in `_substrat_tuples`, written by `ctx.link`, expanded by the checker at depth ≤ 4 (§4.2
rule 3).

The two are close enough to look equivalent and differ on exactly one property, which is
the one that matters for a filing product:

> **Canopy can move a file. The kernel cannot move an entity.**

Moving a canopy file rewrites a string; its grants follow because they were never attached
to it. Moving a kernel entity would require unlinking a parent edge — and there is no
`unlink`, anywhere, in the kernel or either adapter. Linking a new parent **adds** a second
path rather than replacing the first, so a "moved" entity stays reachable from where it
used to be, permanently.

This is [open question 15](kernel-design.md#13-open-design-questions-technical-siblings-of-11-in-the-plan),
and canopy is named in it — it was found by asking a filing product's most basic question,
*"can I move a document to the right matter?"*. K-21 has since narrowed the answer to
tombstone-versus-`relink`, with the tombstone settled as the substrate. **Canopy is the
consumer that makes that question concrete rather than hypothetical**, and it should be
cited as such when the question is closed: a documents product where a folder grant cannot
survive a reorganisation is not shippable, and "model containment as vertical data rather
than as a parent edge" — the cheapest of the rejected options — is precisely what canopy
already does and what the kernel would be asking it to keep doing outside the permission
model.

Two smaller frictions in the same area, both convergences rather than questions:

- **Role rank.** Canopy compares roles numerically: `owner ⊇ editor ⊇ viewer` by
  `ROLE_RANK`. The kernel has no ordering over roles — a role is a bundle of permission
  keys, deny-by-default, no negation (K-2). The port expresses the hierarchy as bundle
  containment (`editor`'s keys ⊇ `viewer`'s). Expressible, and it makes the implication
  visible in `PERMISSIONS.md` instead of hidden in a `CASE` expression.
- **D-47's registry.** Canopy's permission surface is implicit in its SQL. The kernel
  requires a typed `definePermissions()` discovered from a declared entry, derived into
  the wire registry at push, with a missing surface a hard error at the CLI *and* the trust
  boundary. This is a real authoring step that does not exist today on the canopy side, and
  it is the step that makes the permission diff reviewable.
- **Email subjects.** A canopy tuple's subject may be an `email` — a grant that pre-binds
  an address before anyone holds it. The kernel's answer is `engines/invites` plus the
  identity-pool seam, and it is a better one: the invite has a state machine, an expiry
  and an audit trail where a dangling email tuple has none.

## 6. Mismatch 4 — two tables with nowhere to go

### `relation_tuples`: a subject that is another scope

Canopy's tuple store nests spaces. `USER_SPACES` is a recursive CTE in which *a member of
space S is a member of any space that grants membership to `S#member`*
([`authz.ts:65–76`](https://github.com/markusahlstrand/canopy/blob/main/packages/store/src/authz.ts#L65)).
The edge's object is one space and its subject is another.

Kernel tuples are **scope-local** — *"stored scope-locally, with the tenant-level slice
cached from the tenant-root DO"* (§4.2). A tuple whose subject is a different scope belongs
to neither scope's serialization domain. K-22 answered the same question for *membership*
by moving it to the directory and reaching it through a connector; whether a scope-as-subject
edge gets the same answer, becomes an org (K-22's `OrgId`), or is refused outright is not
decided anywhere.

**Filed as open question 19.** The `explain` and proof-path guarantees (§4.2) are what make
this non-trivial: a proof chain that crosses a scope boundary has to be assembled from two
stores, and a revocation on one side has to be visible to the other's very next operation —
the property §4.2 gets for free *because* tuples are scope-local.

Canopy also has `deleteTuple`. The kernel has `ctx.revoke` for grants, and nothing for
edges — which is question 15 again, from the other side.

### `blobs`: content-addressed dedup does not survive scope isolation

Canopy stores bytes once per `sha256` with a refcount, globally across every space. The
same PDF in twenty spaces is one object.

The kernel's attachment key is
`scope/<scopeId>/<attachmentId>` — scope-prefixed by construction, with a fresh ULID per
upload, so keys are **write-once**
([`packages/kernel/src/scope-host.ts:3101`](../../packages/kernel/src/scope-host.ts#L3101)).
There is no dedup, and not only across scopes: the same bytes uploaded twice into the same
scope are stored twice. That is deliberate — write-once keys are what the attachment
integrity story rests on, and a content-addressed key would make a delete in one scope a
question about another.

For a work-order product that is a rounding error. For a documents product it is the
storage bill, and it is the kind of number that is discovered in production. The trade
(dedup versus write-once keys versus cross-scope delete semantics) has never been written
down, because nothing has needed it.

**Filed as open question 20.**

## 7. Mismatch 5 — the plugin runtime, which is a deliberate divergence

Canopy composes UI at **runtime**: sandboxed iframes, a capability broker, a plugin browser,
per-user installs. K-15 **rejects runtime microfrontends** — composition is build-time into
one React app per vertical, with a web-component slot kept as the only future escape hatch.

This is not a mismatch to resolve. It is a product decision canopy made and the kernel
declined, and both remain defensible: K-15's reasons (theming, versioning, agent ergonomics,
a proof-path checker that wants to see the whole surface) are about a vertical a team owns;
canopy's are about a drive whose users install things. The rail already books the plugin
runtime under "stays in canopy," and this document agrees.

What it costs is worth naming: `space_plugins`, `plugin_installs`, `plugin_settings` and
`custom_plugins` do not converge onto `contracts/manifest.ts`, because a manifest describes
what a *deployment* contains and these describe what a *user* switched on. S7's convergence
is therefore partial by design — the permission and operation halves converge, the
installation half does not.

## 8. Mismatch 6 — list endpoints and K-41

Canopy's API has **42 `GET /api/…` endpoints. One takes a cursor.** The rest return whole
result sets.

K-41 says a read answering with rows from a table declares that it is a page and declares
which columns a caller may sort and filter by; the kernel composes the `WHERE`, the
`ORDER BY`, the composite keyset comparison, the `LIMIT`, the `COUNT` and the indexes
behind them. Filters are equality-only by design.

Most of canopy's reads convert cleanly — `paged.over` with a declared entity. Three classes
do not, and they are the same three classes K-41 already carved out for the platform's own
reads:

- **The merged cross-space reads** (§3). Not a page over one table in one scope at all.
- **Search.** `/api/search` walks the FTS index and, with AI search, an external one. That
  is `sortKey` — the handler composes, names the cursor field, and still pages.
- **The proof-walk reads** — `/api/shared-folders` decides visibility by expanding tuples,
  not by a column. K-41's own examples (`todo/my-lists`, `callout/portal-orders`) are this
  shape and page fine with `sortKey`.

So this mismatch is real but bounded: it is authoring work, on a shipped contract, with a
mechanical gate (`listsDeclaredBy`, compile-checked against the entity registry) that makes
a missed one impossible to merge quietly. The genuinely new thing is that a filter
vocabulary makes *sorting a drive by size* a declaration rather than a hard-coded
`ORDER BY`, which canopy does not have today.

## 9. What the change feed converges onto, and what it gives back

`space_seq` + `tombstones` is a per-space monotonic sequence with delete markers, which is
what the outbox already is: transactional with the write, ordered within the scope, and
carrying an envelope that records what authorized it (K-34) and which invocation it
belonged to (#1237). The mirror becomes a spine consumer, and audit arrives free — S8's
claim, and this mapping confirms it at the data level rather than by analogy.

One primitive is missing on the kernel side, and it is small. `readTimeline` and
`readHistory` are **per-`EntityRef`**
([`packages/kernel/src/timeline.ts:217`](../../packages/kernel/src/timeline.ts#L217)). There
is no sanctioned "everything in this scope since watermark N" read — the outbox is walked
scope-wide only by the platform drain. That read is what an offline mirror is, and it is
also what `callout/timeline` hand-rolls today under rule 3's projection permission. It is
noted under question 18 rather than filed separately, because its permission story is the
hard part and that story is the same one the cross-scope read needs.

What canopy gives back here is the thing the kernel's own open questions ask for: the
master plan's *"offline scope for fältpersonal: which flows must work offline, and is
append-only capture sufficient?"* has a shipped answer on the canopy side — read-only
offline against a real delta feed with a per-space cursor, self-healing on a corrupt
cursor, and a live nudge that carries no data. That belongs in `docs/architecture/` as a
design contribution before any code moves, and it is the cheapest genuinely-new thing on
the rail.

## 10. Summary — the honest position

- **Seventeen of twenty-nine tables move without an argument.** The crux is real but it is
  concentrated, not diffuse.
- **The blocking unknown is not the store, it is the read.** A user with N spaces has a
  first screen with no sanctioned read path, and an offline mirror makes it a hot path
  rather than a landing page. Question 18 is the one that gates an estimate for S10.
- **Two tables have no home** (`relation_tuples` across scopes, `blobs` under write-once
  keys) — questions 19 and 20.
- **One kernel question gets a concrete consumer.** Question 15's re-parenting problem stops
  being a thought experiment the moment a drive with folder grants runs on the kernel.
- **One divergence is permanent and fine.** The plugin runtime stays in canopy; S7's
  convergence is partial by design.
- **The direction of contribution has inverted since July** and this document does not
  change that. Canopy arrives with a domain and five specific mechanisms, not with
  infrastructure. What it still has that the kernel does not is documents — tree,
  versioning, retention, content extraction — plus the offline design above and the
  semantic-search adapter that answers kernel-design §947's deferral from outside the
  scope DB.

## Design log

| When | What | Why |
|---|---|---|
| 2026-09-20 | First revision. Written against canopy `bc73c53` and substrat `a67c59b7`, superseding the July 2026 mapping in all particulars. Filed open questions 18, 19, 20 | The July mapping was written against a Substrat with two scaffolded engines and no Cloudflare adapter; every rail estimate downstream of it was guesswork |
