---
status: historical
layer: plan
description: UI design brief for Manyfold. Consumed.
---

# Manyfold — UI design brief (a prompt for Claude Code)

Status: **historical** — design brief dated 2026-07-24, consumed; Manyfold ships

> **How to use this.** This is a self-contained prompt. Read [cms-content.md](../architecture/cms-content.md)
> first (the data model, the two surfaces, the operations, the field DSL) — this file adds the
> *views*. Deliverable: a **navigable, designed mock** of the screens below, seeded with the
> demo world, not a wired-up backend. Design against the operations named in cms-content.md;
> don't invent new engine surface. When a decision isn't pinned here, ask rather than guess.

## 1. What Manyfold is (context for the design)

A generic multi-scope headless CMS on Substrat. **Site = scope**: one tenant owns many sites,
each an isolated scope with its own content, roles, and delivery. Content types are real typed
SQL tables authored through a bounded `defineContentType` DSL that **compiles to reviewed
migrations** — so schema changes are diffs, never instant live edits. Two audiences:

- **Editors** work *content* inside one site (scoped): draft → in_review → approved → published
  → archived, revisions, references between entries.
- **Builders** shape the *content model* (tenant-wide, above the site switcher) and review the
  migrations their changes generate.

Seed world (flavor only, never in the product chrome): the agency **Nordlys Studio**, one
tenant, three sites/scopes — `cafe`, `padel`, `law`.

## 2. Constraints

- React SPA in the shape of `demos/callout/app` and `demos/shop/app`; build on the shared
  `@substrat-run/ui` primitives (don't hand-roll buttons/inputs/tables the kit already has).
- `VITE_DEV_MOCK` drives it without OIDC — the mock seed is how the design is navigable.
- Theme-aware (light/dark) and responsive; wide content (tables, the relationship map) scrolls
  in its own container, never the page body.
- Roles gate the chrome: a view must render the *permission-denied* and *read-only* states, not
  assume the actor can do everything.

## 3. Navigation & chrome

Two nesting levels, and the switcher between them is load-bearing:

- **Product level** (tenant-wide): **Models** (the content-model builder) and **Migrations**
  (pending/applied schema changes). Not scoped to a site — the schema is uniform across a
  tenant's sites.
- **Site level** (scoped): a **site switcher** in the top bar picks the active scope; below it,
  **Content**, **Media**, **Settings** all operate on that one site. Show the actor's role *in
  the current site* next to the switcher (it can differ per site).

## 4. Field-type catalog (the heart of the editor + builder)

Every field type needs an **edit control** (content editor), a **config form** (model builder),
and a known **column mapping** (from cms-content.md §4). Design all of these:

| Field type | Edit control | Config options | Compiles to |
|---|---|---|---|
| `text` | single-line input | required, unique, default, min/max len | `TEXT` |
| `richText` | rich-text / markdown editor | required | `TEXT` |
| `int` / `number` | numeric input | required, min, max, default | `INTEGER` / `REAL` |
| `bool` | toggle | default | `INTEGER` (0/1) |
| `date` / `datetime` | date(-time) picker | required, index | `TEXT` (ISO) + index |
| `enum` | select / segmented control | options[], required, default | `TEXT` + `CHECK` |
| `slug` | slug input (auto from a source field, editable, uniqueness check) | source field, per-site unique | `TEXT` |
| `assetRef` | single media picker (opens asset library) | required | ULID column |
| `assetRefMany` | media gallery (add/reorder/remove) | min/max | child join table |
| **`ref(Type)`** | **single reference picker (see §6)** | **target type, required** | **ULID → entry spine** |
| **`refMany(Type)`** | **multi reference picker (chips, reorderable)** | **target type, min/max** | **join table** |

## 5. Content types (seed)

Ship three, authored via the DSL, so the editor has something to render:

- **Page** — `title:text*`, `slug:slug(from title)`, `body:richText`, `hero:assetRef`,
  `blocks:refMany(Snippet)`, `seoTitle:text`, `seoDescription:text`.
- **Post** — Page's fields **plus** `author:ref(Author)`, `publishedAt:date(index)`,
  `tags:text[]`, `category:enum(news|guide|release)`.
- **Snippet** — `name:text*`, `kind:enum(banner|cta|quote)`, `body:richText`.
- **Author** — `name:text*`, `bio:richText`, `avatar:assetRef` (exists so `Post.author` and the
  reference/linking UX have a real target).

## 6. Views to design

### Group A — Content (site-scoped) · Milestone A, the demo core

1. **Content home** — per active site: cards/counts per content type, a "needs review" callout,
   recent activity. Entry point after the site switcher.
2. **Entry list** (per type) — table: title, status badge, slug, author, updated. Filter by
   status, text search, sort. Bulk select. Empty state per type. "New {Type}".
3. **Entry editor** — the field-driven form (renders §4 controls from the type). Persistent
   **workflow bar**: current status + the allowed transitions for the actor's role (Submit for
   review / Approve / Publish / Unpublish / Archive), disabled-with-reason when the role or state
   forbids it. **Revision sidebar** (history, view, restore). Read-only when viewing a frozen
   published revision. Validation errors inline per field.
4. **Reference picker** (the linking UX — nail this) — invoked by `ref`/`refMany` fields. A
   searchable modal listing entries of the **target type** (title + status), single- or
   multi-select, selected items shown as chips (reorderable for `refMany`), each chip opens the
   linked entry. States to design: *linked entry is still draft* (warn: won't resolve at
   delivery), *linked entry archived/unpublished* (broken-link indicator), *create-and-link*
   inline. References are by stable entry id, so they survive the target's schema changes — the
   picker shows the entry, never a table/version.
5. **Review queue** — site-wide list of `in_review` entries across types, for Editors: who
   submitted, when, quick approve/reject with a note.
6. **Delivery preview** — what the public read API serves for a published entry (the frozen
   revision), with the resolved references inlined; a peek at the raw REST/JSON response.

### Group B — Model builder (product-level) · phase 2, but design it

7. **Models list** — all content types, entry counts across sites, "New model".
8. **Model editor** — one type: its fields as a reorderable list, add/edit/remove field, mark
   the title field and the slug field. Changing anything stages a **pending migration** (see 12)
   rather than saving live.
9. **Field editor** — the §4 type picker + that type's config form. For `ref`/`refMany`: a
   **target-type selector** (this is where linking is *declared*).
10. **Relationship map** — a graph of content types as nodes and `ref`/`refMany`/`assetRef` as
    directed edges (Post→Author, Page→Snippet…). The "connected content types" picture; click a
    node to open its model. Scrolls/pans in its own container.
11. **Migration preview & admission** (the view that makes Manyfold ≠ DatoCMS) — when model
    edits are staged: render the generated `SqlMigration` (`CREATE TABLE ct_post_v3…`, backfill
    step) as a **reviewable diff**, its admission state (pending review / admitted / applied
    per scope), and a per-site apply progress list. "Save" here means *propose a schema change*,
    and the UI must make that legible — this is the whole point.

### Group C — Media & Settings

12. **Asset library** — grid, upload, per-asset "used by" (which entries/fields reference it).
13. **Members & roles** (per site) — list members with their role in this site, invite by email
    (the per-scope `assignScopeRole` + invite model), change/revoke. This is the permission-diff
    surface made interactive.

## 7. Cross-cutting states (design once, apply everywhere)

Empty · loading/skeleton · field validation · **permission-denied** (role lacks the op — show
*why*, don't hide silently) · **frozen/read-only** (published revision) · reference broken/unresolved
· mock/offline banner (`VITE_DEV_MOCK`).

## 8. The two things to get right (everything else is table stakes)

- **Linking** — references are cross-type, by stable id, and have a *publish-resolution* story:
  a published entry that references a draft/archived entry yields a broken or unresolved link at
  delivery. The picker (4) and the delivery preview (6) must both show that honestly.
- **Schema-as-diff** — the model builder never mutates a live table; it stages a migration a
  human reviews (11). If the design makes model editing feel instant/live, it's wrong.

## 9. Deliverable & sequencing

1. **First pass: Group A**, navigable, seeded with the café/padel/law world — the demo surface.
2. Then **Group B** (esp. 10 and 11 — the differentiators) and **Group C**.
3. Format: an Artifact mock or a `VITE_DEV_MOCK` Vite skin on `@substrat-run/ui`. If unsure
   which, ask; default to the Vite skin so it lands where the real app will live.
