# Todo — a shared list app

## 1. What we're building & who uses it

A todo app. Anyone with an account owns lists; a list is private until its owner
shares it with someone by email. There are two kinds of people, and they use the
same app: the person who owns a list, and the person it was shared with.

## 2. The thing that moves through the system

Two nouns — a **list**, and the **items** on it. An item is open or done, and it
can go back; that is the entire lifecycle. There are no stages to skip because
there are no stages.

This is a record, not a workflow. It composes no engine, and that is a fact about
the app rather than an omission.

## 3. What already exists vs. what's yours

**Free from the platform:** accounts and login, invitations, isolation between
accounts, a permission check on every operation, an audit trail of every change,
the database and its migrations, hosting.

**Yours to build:** lists, items, sharing.

That is the whole build. No engine is composed — nothing here has invariants
beyond "you cannot touch a list nobody shared with you", and that is the
platform's own.

## 4. Who can do what

**The owner** does everything to their own list: create it, rename it, delete it,
add items, complete them, delete them, share it, revoke a share.

**Someone the list is shared with** can see it, add items, and tick items off —
including un-ticking. They cannot delete items, delete the list, or share it
onward.

**Everyone else** sees nothing. A list you have not been shared with is invisible:
not its contents, not its name, not the fact that it exists. Asking for it
directly by id is refused, not answered with an empty result.

**Another account entirely** reaches nothing at all.

Nobody can see money, because there is none.

## 5. Money & sign-off

Neither. Nothing is invoiced, quoted or paid for, and nothing needs approving
before a step can happen.

## 6. The cast, roles, tenancy

**Two tenants, always** — the second exists to be attacked, which is how
isolation is proven rather than claimed.

| who | where | what they are |
|---|---|---|
| Ada | tenant one | owns lists |
| Björn | tenant one | Ada shares a list with him |
| Cleo | tenant two | unrelated account; must reach nothing |

One role: **member** — anyone with an account can own lists. Sharing is per-list,
not a role, which is the interesting part of this app's permission model: what
Björn may do is decided by the share on *that list*, not by anything about Björn.

## 7. The data we'll store

- **People** — one row per person with an account here: who they are, when they
  joined. Lists hang off it, which is how "your lists" is a fact the system can
  follow rather than a filter the code has to remember.
- **Lists** — name, who owns it, when it was created.
- **Items** — which list they are on, what they say, done or not, who added them,
  when.
- **Shares** — which list, which person, and the email it was sent to.

The email is load-bearing. The sharing screen promises "shared with
björn@example.com", and accounts are opaque ids, so the address needs a table of
its own to come from. A promised human-readable string with no source table is a
missing table.

## 8. The screens

- **Your lists** — the ones you own and the ones shared with you, marked which is
  which.
- **A list** — its items, tick to complete, add an item.
- **Sharing** — enter an email, see who the list is shared with, revoke.

## 9. The scenario the test will replay

**The happy path.** Ada creates "Groceries" and adds milk. She shares it with
Björn. Björn sees the list, adds bread, and ticks milk off. Ada sees both
changes.

**The denials that prove it.**

- Björn cannot delete the list, and is refused when he tries.
- Ada's other list, "Work", is not shared. It does not appear in Björn's lists,
  and asking for it directly by id is refused.
- Cleo reaches nothing at all — not Ada's lists, not Björn's, not by id.
- A control alongside each: Björn *can* add and tick, so the closed doors are not
  passing because every door is shut.

## 10. Assumptions

Decisions taken on the builder's behalf. Each is cheap to reverse now and
expensive later.

- The product is called **Todo**.
- People you share with can add and complete, but cannot delete items or the
  list, and cannot share it onward.
- Ticking is reversible — completing something is not final.
- One role: anyone with an account can own lists. Sharing is per-list.
- Everyone uses the same app; there is no separate portal for people you share
  with.
- A list is shared with a **person**, not with a public link.
- Revoking a share is possible, and takes effect immediately.
- Item text is ordinary personal data — nothing needing erasure beyond deleting
  it.
- English only.

## 11. Out of scope

Due dates, reminders and recurrence (the builder said no). Sub-tasks,
attachments, comments, re-sharing, public links, search, and a mobile app.
