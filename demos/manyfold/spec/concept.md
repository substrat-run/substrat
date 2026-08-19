# Manyfold — concept spec

> A generic multi-scope headless CMS on Substrat. **Site = scope.** Content types are
> real, typed, connected models; the editorial lifecycle is the invariant. Design corpus:
> [../../../docs/architecture/cms-content.md](../../../docs/architecture/cms-content.md) (the data model,
> the compile-to-migration mechanism) and
> [../../../docs/briefs/manyfold-ui.md](../../../docs/briefs/manyfold-ui.md) (the 13 views).

## The firm

**Nordlys Studio** — a small content agency (one tenant) that runs published sites for its
clients. Each client site is a **scope**. Editors switch between sites; roles are held **per
site**, so an editor on one site is a nobody on another.

Three sites (scopes): `cafe`, `padel`, `law`.

## The cast (who does what, who is denied what)

| Person | cafe | padel | law |
|---|---|---|---|
| **Maja Lindqvist** | Admin | — | — |
| **Emil Berg** | Publisher | Author | Viewer |
| **Sofia Ruiz** | Author | — | — |
| *jonas@nordlys.studio* | *pending invite* | — | — |

The denials the demo exists to prove:
- An **Author** (Sofia on cafe, Emil on padel) can draft and submit, but **cannot approve or
  publish** — the workflow gate.
- A **Viewer** (Emil on law) can read but **cannot write** anything.
- Emil is a Publisher on cafe but only an Author on padel — the **same login, different
  authority per scope** (K-22). Acting on `law` as a Viewer is denied where he could publish on
  `cafe`.
- **Scope isolation**: publishing on `cafe` leaves `padel` and `law` untouched; a principal with
  no role in a scope is denied every write there.

## Vocabulary → the platform

The vertical owns **content types, the editorial roles, the price of nothing** (it's a CMS).
The lifecycle state machine, revisions, and freeze-on-publish are the invariants — Milestone A
holds them in the vertical (decision 27; the `engines/content` extraction waits for a second
content vertical).

**Content types** (fixed for Milestone A, authored as `defineContentType` definition objects so
the model-builder views have real data and the typed-table migrations can be generated later —
see cms-content.md §9). Milestone A persists bodies as a validated JSON revision; the operations
are identical to the typed-table form, so the storage can swap underneath without touching them.

- **Page** — `title`, `slug`, `body` (richText), `hero` (assetRef), `blocks` (refMany→Snippet),
  `seoTitle`, `seoDescription`.
- **Post** — Page's fields **plus** `author` (ref→Author), `publishedAt` (date), `tags` (text[]),
  `category` (enum: news | guide | release).
- **Snippet** — `name`, `kind` (enum: banner | cta | quote), `body` (richText).
- **Author** — `name`, `bio` (richText), `avatar` (assetRef). Exists so `Post.author` and the
  reference/linking beats have a real target.

**Vertical tables** (all `manyfold_`): `manyfold_entry` (the lifecycle spine — type, status,
slug, which revision is draft/published), `manyfold_revision` (append-only bodies + freeze
hash), `manyfold_status_log` (append-only transition audit), `manyfold_delivery` (the published
projection a `content.published` consumer maintains — the fat-event → consumer beat).

**Roles** (per site): `viewer` (read) · `author` (draft + submit + restore) · `editor` (+ review)
· `publisher` (+ publish/unpublish/archive) · `admin` (+ manage members/models).

## References (the "connected" part)

References are stored by **stable entry id** (the spine `manyfold_entry.id`), never by table or
revision — so a reference survives the target's edits. At **delivery** a reference resolves to
the target's *published* revision; a reference to a still-draft or archived entry comes back
**unresolved** (`{"$unresolved": true, "reason": "not_published"}`) — a broken link the delivery
surface shows honestly rather than hiding.

## The scenario the test replays

1. **Provision** Nordlys Studio + three sites; all journals apply per scope.
2. Sofia (Author@cafe) **creates a Post**, saves a second draft revision (append-only).
3. **Denials hold**: Sofia can't approve or publish; Emil (Viewer@law) can't create on `law`;
   a principal with no cafe role is denied.
4. Emil (Publisher@cafe) **approves then publishes** → the current revision **freezes** with a
   content hash; `content.published` emits; the delivery projection updates.
5. **Delivery** serves the frozen published revision; a `blocks` reference to a *draft* Snippet
   comes back **unresolved**; after that Snippet is published, delivery resolves it.
6. **Scope isolation**: `padel` and `law` have no entries; the cafe publish changed nothing there.
7. **Restore** an earlier revision → a new revision (history intact, never mutated).
8. **Archive** the Post → it leaves the delivery projection.
9. **State machine can't skip**: publishing a fresh draft (never approved) fails;
   re-publishing/again-freezing a frozen revision fails.
