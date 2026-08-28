# Manyfold (headless CMS)

`demos/manyfold` — a **multi-scope headless CMS**: content types authored as data, a
draft → review → publish editorial lifecycle, append-only revisions, and a frozen
published projection served by (type, slug) — one tenant running **many sites, each its
own scope**, in a single content-studio app over one API.

## Overview

Manyfold is the demo that puts two ideas in one place: a **content lifecycle** and
**multi-scope tenancy where the scope *is* the site**. A publishing studio runs several
client sites from one account; each site is a scope, and the same login is a different
principal — with a different role — in each. Café Nordlys, Padel Nordic and a law firm
share one codebase and one tenant, and nothing published on one is visible from another.

Like [Meridian](/verticals/meridian), it is a **shape-breaker: its core domain composes no
engine at all.** There is no CMS engine to lean on — the editorial state machine,
append-only revisions, the freeze-on-publish hash, and reference resolution are all
**vertical code on the kernel**. That is deliberate (decision 27): the engine extraction
waits for a *second* content vertical to force it, the same "second consumer, different
shape" signal every other engine was extracted on. So the invariants are written cleanly
in the vertical now — a state machine that can't skip, revisions that only ever append, a
projection kept consistent inside the publish transaction — positioned so the later
extraction is mechanical rather than a rewrite. Until then, Manyfold is the proof that the
kernel's guarantees (nested tenancy, permissions, the event spine, per-scope isolation)
carry a whole domain with **zero engine support**.

It is interesting for reasons the field-service demos can't show:

- **Site = scope.** One tenant, many scopes, and the multi-tenancy is *within* a single
  customer rather than across them. Provisioning creates one tenant and N sites; a login is
  granted a role per site, and reachability — not a `WHERE site = ?` filter someone
  remembered — is what keeps one site's content out of another.
- **A lifecycle that freezes.** Publishing takes a content hash over the exact revision and
  marks it immutable; any later edit is a *new* revision, never a mutation of history. The
  published projection serves that frozen body, so what a reader sees can't drift out from
  under the hash.
- **Content types are data, not code.** The four default types are seeded on first use; an
  admin authors new ones at runtime, and each save bumps the type's version. A `ref` field
  is resolved **at delivery** against the published projection — a link to a draft comes
  back as an explicit *unresolved* marker, a broken link shown honestly rather than hidden.

## At a glance

| | |
|---|---|
| **Package** | `demos/manyfold` (private) |
| **Tenancy shape** | 1 tenant — Nordlys Studio · **3 sites, each its own scope**: Café Nordlys · Padel Nordic · Lindqvist & Ruiz |
| **Engines composed** | *none* — the editorial lifecycle is vertical code on the kernel alone (decision 27; the CMS-engine extraction waits for a second content vertical) |
| **Own tables** | `manyfold_entry` · `manyfold_revision` (append-only) · `manyfold_status_log` (append-only) · `manyfold_delivery` (published read model) · `manyfold_content_type` (types are data) |
| **Roles** | `admin` (owner, tenant-wide) · `publisher` / `editor` / `author` / `viewer` (per site) — a role ladder, no entity-narrowed grants |
| **Permission surface** | [`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/manyfold/PERMISSIONS.md) — 5 keys · 5 roles |
| **App** | one content-studio React app over one API, signed in through OIDC (locally, the dev issuer's persona picker) with a **site** switcher (`x-site`) that selects the scope — never the caller |
| **Status** | Working — a 10-case scenario green on the pure-SQLite adapter |

## No engine, and why that's the point

Every other demo borrows an invariant from an engine — a work-order state machine, an
allocation arbiter, an invoice basis. Manyfold's central invariant is the **editorial
lifecycle**, and there is no engine that owns it. So the vertical does, and it does so
under exactly the discipline an engine would enforce:

- a **state machine** that rejects any transition not on the allowed graph;
- **append-only** revisions and an append-only status log — a correction is a new row;
- **immutable-after-publish**: the published revision is frozen with a content hash;
- **every mutation emits a fat event** on the spine.

That the same four properties keep reappearing — here, in Callout's work orders, in
Meridian's ledgers — is the extraction signal itself. The line Manyfold draws for a future
`content` / editorial engine is visible in `module.ts`: the lifecycle helpers
(`transition`, the `ALLOWED` graph, `contentHash`, the delivery projection) are the piece
that would move; the content-type *modelling* and the vocabulary would stay in the
vertical. It isn't extracted yet **on purpose** — a single consumer is a guess, and D-27 is
the rule against designing an engine off one demo's wishlist.

## The editorial state machine

An entry's `status` moves along a fixed graph; `transition` refuses anything off it and
writes an append-only `manyfold_status_log` row for every hop:

```
draft ──▶ in_review ──▶ approved ──▶ published ──▶ unpublished
  │           │            │             │              │
  │           ▼            ▼             ▼              ▼
  └────────▶ archived (terminal) ◀───────────────────────
        (in_review can bounce back to draft; unpublished re-enters at in_review)
```

The guards **move with state**, which is the property the scenario pins:

- `publish` requires an entry to be **`approved`** — a fresh draft can't skip straight to
  published, and neither can one merely submitted for review.
- Only a `draft` or `unpublished` entry takes a new revision; editing a `published` one is
  refused, because its revision is frozen.
- `approve` / `reject` are `content:review` acts; a rejection **requires a note**, which
  lands on the `draft` transition it causes.

### Freeze on publish

`publish` computes a SHA-256 over `(typeKey, revNo, canonical body)` — Web Crypto,
never `node:crypto` — flips the revision's `frozen` flag, records the hash, and upserts the
**delivery** projection in the *same transaction*. From then on the published body is
immutable; any change authors a new revision against a new number. `unpublish` and
`archive` remove the entry from delivery. The read model can never show content that
disagrees with the frozen hash, because it's only ever written from the freeze.

## Content types are data

The four defaults — `author`, `page`, `post`, `snippet` — are seeded lazily on first use,
and a `content:admin` may author more at runtime (`manyfold/save-type`). A type names its
fields, its title field, an optional slug field, and `ref` / `refMany` fields that target
other types. Every save **bumps the type's version** (schema evolution is a new version);
an entry body is validated against its type's generated Zod schema at the boundary, so an
unknown field is rejected. Milestone A persists bodies as JSON, so adding a field is free —
the typed-table migration each type *compiles to* (`compileTypeToSql`) is kept as the
reviewable artifact, not run as a live `ALTER`.

### Delivery, and references resolved late

`manyfold_delivery` is the public read model: **only published, frozen content**, keyed by
`(type, slug)`. `manyfold/deliver` reads it and resolves each reference field against the
projection — a target that is published comes back as `{ $ref, type, slug, title }`; a
target still in draft (or archived) comes back as `{ $unresolved: true, reason:
'not_published' }`. A broken link is shown honestly rather than silently dropped, and a
reference "heals" the moment its target is published, without touching the referring entry.

## Roles & permissions

Authority is a **role ladder**, held per site (K-22: the same login is a different
principal, with a different role, in each scope). There are **no entity-narrowed grants** —
this vertical's access is node-level, not per-entity, which is itself a contrast with
RallyPoint and Meridian:

| Role | Holds | Can |
|---|---|---|
| `viewer` | `content:read` | read entries, revisions, models |
| `author` | + `content:author` | create/edit drafts, submit for review, restore revisions |
| `editor` | + `content:review` | approve or reject entries in review |
| `publisher` | + `content:publish` | publish, unpublish, archive |
| `admin` | + `content:admin` | manage members, roles, and content **models** |

The five keys are `content:read` · `content:author` · `content:review` ·
`content:publish` · `content:admin`. The installing owner holds `admin` tenant-wide
(`scopeId: null`) — admin of every site from day one; everyone else is assigned a role
**per site**. The full surface — every key and which role holds it — is the checked-in
[`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/manyfold/PERMISSIONS.md),
re-emitted by CI so it can't drift from what runs.

## Events

Every lifecycle transition emits a fat event and consumes none:
`content.submitted` · `content.approved` · `content.rejected` · `content.published` ·
`content.unpublished` · `content.archived`. `content.published` is the fat event a
**webhook connector** would consume to purge a CDN or trigger a static rebuild — that
consumer is host code, the documented next step, not module code.

## The app

One content-studio React app, composed over the vertical's single API. The twist over the
other demos is **multi-scope**: *who* you are comes from the login — an ordinary OIDC
session, which locally is [`@substrat-run/dev-issuer`](/reference/dev-issuer) rendering the
personas in `src/personas.ts` as a picker — and *where* you are working comes from the
in-app **site switcher**, which sends `x-site` (a site slug the server resolves to one of the
tenant's scopes). Selection is not authentication: the login says who, the site says where,
and the kernel re-checks your authority in that scope either way — a slug can only ever
reach a scope of the tenant you are linked to. There is no `x-principal` header; the one
that stood here defaulted the app to "already signed in as somebody", which is the one thing
a hosted instance never does. The app gates its own chrome on `manyfold/whoami`, which reports what the
current principal may do *in this site* — so the same login sees author tools on one site
and read-only on another. The seeded personas make that concrete:

| Persona | cafe | padel | law |
|---|---|---|---|
| **Maja Lindqvist** (owner) | admin | admin | admin |
| **Emil Berg** | publisher | author | viewer |
| **Sofia Ruiz** | author | — | — |

Switching Emil between sites is the demo: the same human, a different role — and on a site
where he holds nothing, denied even to read.

## Run it

```sh
pnpm --filter @substrat-run/demo-manyfold dev
```

Starts the dev issuer on `:8879`, the API on `:8876` and the app on `:5276` (all in the
private `887x` / `527x` block; override with `ISSUER_PORT=… PORT=… WEB_PORT=…`). Two
different controls do two different things: the in-app **site switcher** changes which
scope the *current* OIDC session works in — same person, possibly a different role — while
**Switch user** goes back to the issuer and signs in as a different subject. Sign in as a
persona, then move between sites to watch one login's authority change scope by scope;
switch user to see another person's. A script acts as someone
by minting a bearer at the issuer (`POST http://localhost:8879/dev/token {"sub":"dev|emil"}`),
never by telling the vertical who it is.

The executable spec is the scenario test — ten cases replayed headlessly on the
pure-SQLite adapter:

```sh
pnpm --filter @substrat-run/demo-manyfold test
```

It asserts the module journal applied per scope; that an admin can model a new content type
(with a reference) and it drives `create-entry` immediately while an author cannot model;
append-only revisions and a restore that copies an old body into a *new* revision without
mutating history; the workflow denials (author can't approve or publish, a viewer can't
write, a login with no role on a site is denied even to read); publish freezing a revision
with a verifiable hash and filling the delivery projection; immutability and the
no-state-machine-skips guards; references resolving late (draft = unresolved, then resolved
once the target publishes); scope isolation (publishing on one site leaves the others with
no delivered content); and that every mutation landed on the spine, in order.

The `PERMISSIONS.md` and the append-only migrations (`0001-init`, `0002-content-types`) are
the human checkpoints the platform makes unskippable.
