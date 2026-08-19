---
status: built
layer: plan
description: Content types that compile to reviewed migrations.
---

# Manyfold — content types that compile to reviewed migrations

Status: **built** — `demos/manyfold` ships content types as reviewed migrations

> **Relationship to canon.** This proposes; it doesn't decide. It sits on rails that already
> exist: [generated-verticals](../strategy/generated-verticals.md) (authored `migrations` reach prod only
> through CI admission), [builder-plane](./builder/plane.md) (tenant-owned verticals; prod
> promotion is a human staff gate), [engine-protocol](../engines/protocol.md) (version-pinned
> templates, freeze→immutable, opaque content the engine only hashes), and
> [self-serve-deploy](self-serve-deploy.md) (the push seam + channels). It reuses those rather
> than inventing a schema mechanism. The demo vertical is **Manyfold** — a generic multi-scope
> content platform (model anything; connected, typed content types). "Many" is the thesis: one
> tenant, many sites, **each site a scope**. The niche lives only in the seed *world* (an agency,
> Nordlys Studio, running its clients' sites — a café, a padel club, a law firm), never in the
> product surface.

## 1. What this is

A generic headless CMS demo whose distinguishing claim is: **a content type is a real, typed,
indexed SQL table — and every change to the model is a reviewed `SqlMigration`, never a
runtime `ALTER`.** "Model whatever" happens through a bounded `defineContentType` DSL that
*compiles to migrations*; the migrations flow through the normal push → admit → promote seam,
so the migration-diff checkpoint stays load-bearing. This is Payload's posture (schema from
code, deployed as migrations) expressed in Substrat's grain.

The alternative — a JSON/document store with per-type Zod schemas — was considered and is the
cheaper build (schema evolution is nearly free, no data movement on additive changes). It is
recorded here as the fallback (§9). This document pursues the typed-table option because it is
the one that plays to Substrat's benefits: the typed SDK, the reviewed migration, lazy
per-scope apply, and append-only schema evolution all become the CMS's content model directly.

## 2. Placement (decision 27)

Decision 27 forbids designing the engine ahead of the second vertical. So the build order is
the discipline:

1. **Milestone A — `demos/manyfold` owns everything.** Content-type compilation, the versioned
   typed tables, the draft→review→publish state machine, revisions, freeze-on-publish, and the
   two API surfaces all live in the vertical. No new package.
2. **Milestone B — a second content-shaped vertical forces extraction.** Only then does
   `engines/content` appear: the lifecycle spine + freeze/hash invariant move to the engine;
   both verticals' *content types* stay behind as vocabulary. The extraction diff is the proof.

Everything below describes the eventual engine/vertical seam so Milestone A is written to fall
along it — but the seam is not a package until B.

## 3. The seam (engine owns lifecycle; vertical owns the typed tables)

The three-layer rule draws the line exactly as in Callout:

- **Engine (eventual) owns the spine and the invariant.** One `content_entry` per logical
  document: its `status`, which revision is the working draft, which is published, and the
  content **hash** of the frozen published revision. The engine treats the content bytes as
  **opaque** — it holds the hash, never the columns (engine-protocol's "opaque document" rule).
  This keeps the star topology and the private-tables rule intact: the engine never reads the
  vertical's typed tables.
- **Vertical owns the typed content tables.** `ct_post_v2(entry_id, rev_no, title, body, …)` —
  generated from a `defineContentType`, real columns, real indexes. The vertical's operation
  writes the typed row via `ctx.sql`, then calls the engine's in-scope function to record the
  lifecycle transition and freeze the revision — **same transaction**, engine does the
  permission-independent invariant, vertical did `assertAllowed(await ctx.check(PERM))` first.

### 3.1 Spine tables (engine-owned)

```
content_entry     (id TEXT PK, scope_id, type_key, type_version INT,
                   status, draft_rev INT, published_rev INT, slug, created_at, updated_at)
content_status_log(id TEXT PK, entry_id, from_status, to_status, actor, at)   -- append-only audit
content_freeze    (entry_id, rev_no, hash, frozen_at, PRIMARY KEY(entry_id, rev_no))
```

State machine, no skipping: `draft → in_review → approved → published → archived`
(+ `published → unpublished`). `published_rev` is pinned and its row in `content_freeze`
records the hash; any write to a frozen (entry, rev) fails — the immutability guarantee that
becomes the delivery cache-safety guarantee (§6).

### 3.2 Typed content tables (vertical-owned, generated)

One table per **(type, version)**. Rows are **append-only per revision** — a `saveDraft` inserts
`(entry_id, rev_no+1, …)`, never updates a prior row; history is audit material.

```
ct_post_v2 (entry_id TEXT, rev_no INT, title TEXT NOT NULL, body TEXT,
            hero TEXT, published_at TEXT, PRIMARY KEY(entry_id, rev_no))
CREATE INDEX ct_post_v2_published_at ON ct_post_v2(published_at)
```

Query power lives here: the delivery surface and the admin list/filter/sort hit native typed
columns and native indexes — the thing the document store gives up.

## 4. defineContentType → SqlMigration (the mechanism)

A bounded DSL. Its *only* outputs are content-shaped table migrations plus the generated CRUD/
read bindings — it cannot emit arbitrary SQL or code. That boundedness is the whole safety
argument (§7).

```ts
defineContentType({
  key: 'post', version: 2,
  fields: {
    title:       text({ required: true }),
    body:        richText(),
    hero:        assetRef(),                  // a ULID into the asset side table
    publishedAt: date({ index: true }),
    tags:        text({ array: true }),       // → child table ct_post_v2_tags(entry_id,rev_no,value)
  },
})
```

compiles to an append-only migration (`version` is journaled per module in `_substrat_migrations`,
never edited once shipped):

```
{ version: '0007-post-v2',
  sql: `CREATE TABLE ct_post_v2 (entry_id TEXT NOT NULL, rev_no INTEGER NOT NULL,
          title TEXT NOT NULL, body TEXT, hero TEXT, published_at TEXT,
          PRIMARY KEY (entry_id, rev_no));
        CREATE INDEX ct_post_v2_published_at ON ct_post_v2 (published_at);` }
```

The **generated SQL is what a human reviews** in the PR (Milestone A) or what CI/staff admits
(builder-plane productization). The author writes a type; the checkpoint reads a table.

## 5. Schema evolution = new versioned table + backfill (append-only)

Never `ALTER` a shipped table; supersede it — SQLite's own recommended path for non-trivial
changes, and Substrat's append-only personality (protocol's version-pinned templates,
"never edit a shipped migration"). A field retype is a new `(type, version+1)`:

1. Author edits the type → DSL emits `0011-post-v3` (create `ct_post_v3`) **plus** a backfill
   step copying `ct_post_v2 → ct_post_v3` with the transform.
2. Applied **lazily per scope**: each site's DO, on next open, runs pending migrations inside
   its serialization domain (the `IdentityDO` already initializes this way in
   [identity-do.ts](../../packages/vertical-auth/src/identity-do.ts)). New entries write v3;
   existing entries are backfilled; the spine's `type_version` cuts over per entry.
3. **Cost, stated honestly:** backfill *moves data*, per scope, on every structural change —
   including additive ones the document store would do for free. This is the price of native
   query power. For a large tenant the backfill is a resumable background pass, not a
   synchronous op; new-table + dual-read until cutover means no write is blocked.

## 6. Two surfaces, one dataset (the router payoff)

The interesting Substrat demonstration is not a protocol but that **authoring and delivery are
two router surfaces over the same scope**:

- **Authoring** (the editor SPA): Substrat operations — typed, `ctx.check`'d, event-emitting.
  Sees all revisions and statuses.
- **Delivery** (public read): a **read-only** surface that can *only* resolve
  `published_rev`. `GET /sites/:site/posts/:slug` returns the frozen revision → ETag is the
  content hash → CDN-cacheable. The immutable-after-export invariant **is** the cache-safety
  guarantee.

REST, not GraphQL, for the MVP: the read path is fetch-published + list, which is exactly what
caches well and what the hash/ETag story wants. GraphQL is a phase-3 delivery option if a
relational content graph earns it.

### 6.1 The event + connector

`content.published` is a **fat** event (the published columns, the hash, the slug — no consumer
needs a cross-module read). A consumer calls a **webhook connector** to purge the CDN / trigger
a site rebuild. This is the fat-event-through-a-connector beat nothing else in the demo set
shows.

## 7. The checkpoint, per deployment mode

The migration is the same object in every mode; only *who admits it* changes.

- **Milestone A / first-party Manyfold:** the generated migration is committed code. Ordinary PR
  review = the migration-diff checkpoint. Same schema for every scope of the vertical.
- **Tenant-authored types (builder-plane):** a tenant editing its *own* content model is a
  **builder** of its tenant-owned vertical variant (`<tenant>/manyfold`). The DSL emits the
  migration; the builder ships it to `dev`/`staging` self-serve; **prod promotion stays a human
  staff gate** (builder-plane model B). Because the DSL is bounded (§4), an *inspecting* admit
  pipeline (builder-plane model A) is far more tractable than for free-form generated verticals
  — a genuine open question worth pursuing (§8).

Divergence is resolved cleanly: within one tenant, all sites (scopes) share one content schema,
applied lazily per scope. Different tenants diverge only by owning different vertical variants —
which is exactly what builder-plane already models.

## 8. Open questions

1. **Bounded-DSL admission.** Can a content-type migration skip the *staff* gate because the DSL
   provably emits only table-shaped SQL (builder-plane model A, narrowed)? Or does any prod
   schema change stay staff-gated regardless of how it was authored?
2. **Backfill orchestration across scopes.** Lazy-on-open is simple but leaves cold scopes
   un-migrated indefinitely; do we need an eager fan-out for a type retype, and who drives it?
3. **Cross-type references.** `assetRef`/entity references across types — resolved at delivery by
   join (native, fast) vs. by a second fetch. Affects whether GraphQL ever earns its place.
4. **Multi-scope roles in the catalog.** The current [catalog](../../apps/dashboard/src/catalog.ts)
   hands the owner a flat per-principal grant in one scope; Manyfold wants Meridian's per-scope
   `assignScopeRole` + invites replicated per site. Confirm that is a vertical concern, not a
   catalog change.

## 9. Fallback: the document store

If the backfill cost or the DSL/compiler build proves not worth it, the same lifecycle spine
runs over an opaque JSON body validated by per-type Zod (engine-protocol's opaque-document
model exactly), with generated columns / a vertical side table for the few filtered fields.
Additive evolution is then free. The spine, the two surfaces, the event, and the connector are
**identical** either way — only §3.2/§4/§5 change. So Milestone A can start on the document
store and swap in typed tables behind the same operations if the query power is wanted.

## 10. Build order

1. Manyfold seed: one tenant, sites `cafe` / `padel` / `law` as scopes; roles Author/Editor/
   Publisher/Admin (the `PERMISSIONS.md` artifact).
2. `defineContentType` for Page/Post/Snippet → generated migrations (checked-in) → lazy per-scope.
3. Operations: `createEntry / saveDraft / submitForReview / approve / publish / unpublish /
   archive / restoreRevision`, each `assertAllowed` first, each composing the (in-vertical for
   now) lifecycle function in one transaction.
4. Delivery surface (read-only, published-only, ETag) + `content.published` → webhook connector.
5. Scenario test: two sites, wrong-role approval fails, publish freezes + delivery serves it,
   the other site untouched, restore a prior revision, archive.
```
