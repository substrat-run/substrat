# Todo (shared lists)

`demos/todo` — the smallest vertical that is still a real one: lists, the items on them, and
sharing a list with one person by email. No engine, no money, one role, two tenants.

## Overview

Todo exists for a shape none of the other demos show — a **record app with user-initiated
sharing** — and for a reason a todo app is usually a bad demo: the reader spends no attention
on the domain, so the platform is the only thing on the page. It proves:

- **Per-record sharing is two kernel calls.** Sharing "Groceries" with Björn is
  `ctx.grant(principal, 'list:contribute', listRef)` in `src/module.ts`; revoking it is
  `ctx.revoke(…)` with the same three arguments. The grant is **entity-narrowed** (this list,
  not all lists), **delegating** (the caller's own right to that list is re-checked), and
  **transactional** with the operation. Neither alternative fits: a `ctx.link` edge is permanent,
  and org membership is a whole org rather than one record — so Todo is the reference against
  minting an org per row to get a revoke. Read it before designing any "share this with a
  person" feature.
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
| **Own tables** | `todo_owners` · `todo_lists` · `todo_items` · `todo_shares` |
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

Due dates, reminders and recurrence; sub-tasks, attachments, comments, re-sharing, public
links and search. A list is shared with a **person**, never a link.
