# Todo (shared lists)

`demos/todo` — the smallest vertical that is still a real one: lists, the items on them, and
sharing a list with one person by email, or inviting an address that has not joined yet. No engine, no money, one role, two tenants.

## Overview

Todo exists for a shape none of the other demos show — a **record app with user-initiated
sharing** — and for a reason a todo app is usually a bad demo: the reader spends no attention
on the domain, so the platform is the only thing on the page. It proves:

- **Per-record sharing is two kernel calls.** Sharing "Groceries" with Björn is
  `ctx.grant(principal, 'list:contribute', listRef)` in `src/module.ts`; revoking it is
  `ctx.revoke(…)` with the same three arguments. The grant is **entity-narrowed** (this list,
  not all lists), **delegating** (the caller's own right to that list is re-checked), and
  **transactional** with the operation. Neither alternative fits: a `ctx.link` edge can be moved
  but never removed, and org membership is a whole org rather than one record — so Todo is the reference against
  minting an org per row to get a revoke. Read it before designing any "share this with a
  person" feature.
- **An address that has not joined gets an invitation, not an error.** `todo/share-list` needs
  the person to exist (`not_found` otherwise); `todo/invite` shares at once when they do, and when
  they do not, stores a `todo_invites` row, queues the email in the same transaction (a failed
  operation sends nothing) and returns `status: 'invited'`. A consumer of `todo.owner-joined`
  turns each open invitation for that address into the same share when the person joins — a
  consumer, because a grant delegates and the person joining holds nothing on the list yet — so
  `todo/invite` checks `list:contribute` as well as `list:manage`: what the invitation will hand
  on is asked of the inviter up front. An invitation to a binned list waits until it is restored.
  `todo/list-invites` shows who is still waiting and `todo/cancel-invite` withdraws one (all
  three need `list:manage`). On a local server the queued mail is a file in `.data/outbox`; see
  [Deploying](/guide/deploying).
- **Finding a list is a search, per hit.** `todo/search-lists` looks up `list.name` in the
  kernel's search index (declared as a `searchable` in `src/manifest.ts`, like `item.text`), then
  checks `list:contribute` on each hit, so a list you were never shared is not a result. Archived
  and binned lists are left out of the index; the table's search box is offered over the active
  view only. `todo/search-items` and `todo/search-list-items` do the same for items.
- **A 403 wall is not an empty list.** A list you were never shared reaches you neither in the
  listing nor by id — asking directly is *refused*, not answered with nothing — and the React
  app tells the two apart on screen.
- **No engine is a fact, not an omission.** An item is open or done and can go back; there are
  no stages to skip, so there is nothing for an engine to own. What Björn may do is decided by
  the share on *that list*, not by anything about Björn.
- **The whole process, as whole files.** [Walkthrough: the todo app](/guide/walkthrough-todo)
  shows this vertical end to end — brief, interview, approved concept, declared model, what is
  derived, and the one file of business logic — pulled from `demos/todo/` at build time.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/demo-todo` |
| **Engines composed** | *none* — kernel only |
| **Own tables** | `todo_owners` · `todo_lists` · `todo_items` · `todo_shares` · `todo_invites` |
| **Roles** | `member` (create lists) — everything else is an entity-narrowed grant: `list:contribute` on a list shared with you; `list:contribute` + `list:manage` on your own |
| **Permission surface** | [`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/todo/PERMISSIONS.md) — 3 keys, 1 module, 1 role |
| **Auth** | [OIDC only](/concepts/identity) — the dev issuer is a real provider you sign into by picking a name; there is no dev auth branch |
| **Apps** | API (`:8878`) + one React app (`:5278`) for owners and invitees alike — no separate portal |
| **Status** | Working — demo seed |

## The cast & what's denied

| Who | Holds | Cannot |
|---|---|---|
| **Ada** | `member`, tenant one — owns *Groceries* and *Work* | — |
| **Björn** | `member`, same tenant; *Groceries* is shared with him | **delete the list**, delete items, share it onward, or see *Work* — not in his listing, and refused by id |
| **Cleo** | `member` in a different tenant | anything of Ada's or Björn's — not by listing, not by id; the cross-tenant denial |

The control beside each closed door: Björn *can* add bread and tick milk off, so the denials
are not passing because every door is shut. Revoking his share takes effect immediately.

An invitation has one limit: it becomes a share only when the invitee signs in with an address the
issuer verified. `/api/me` joins them on sign-in (`todo/join` reads `ctx.verifiedEmail`), and a
person whose address is unverified is signed in but not joined, so their invitation keeps waiting.

## Run it

```bash
pnpm --filter @substrat-run/demo-todo dev
# API   http://localhost:8878
# web   http://localhost:5278   (sign in by picking Ada, Björn or Cleo)
```

`test/scenario.test.ts` replays the happy path and every denial above; `test/server.test.ts`
drives the HTTP layer; `test/entity-checks.test.ts` generates, from the declared model, the
behavioural pair that proves each handler honours its entity-scoped permission — Björn as the
probe, admitted to Ada's lists one grant at a time.

## Deliberately out of scope

Due dates, reminders and recurrence; sub-tasks, attachments, comments, re-sharing and public
links. A list is shared with a **person**, never a link. Search covers list names and item text,
not comments or attachments.
