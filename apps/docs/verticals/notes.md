# Notes (a plugin of Todo)

`demos/notes` — a second vertical in the same tenant as Todo that owns no people. It keeps a
workspace notepad and notes on Todo's items, and has no owner seat, invitations or members of its
own: who gets in is decided in Todo, and who sees an item's notes too.

## Overview

Notes exists to show one shape: **an app that takes its people from another app**. A shared
notepad is the whole product, so the only thing on the page is who is let in. It proves:

- **A plugin is its own vertical.** Its own scope, its own database, its own deploys. It cannot
  read a Todo table and Todo cannot read a note. The two cooperate through one
  [peer call](/concepts/cross-vertical).
- **The other app answers who a login is.** When someone Notes has not seen signs in, its door
  asks Todo's `todo/resolve-person` and gets back an id, a status and role keys, or nobody. That
  question and answer are the person contract, `identity.person@1`; see
  [People owned by another app](/concepts/identity#people-owned-by-another-app).
- **One person is one id in both apps.** The id Todo answers becomes the person's principal in
  Notes, so a note's `author_id` is the member's id in Todo.
- **The answer is kept for five minutes, and that is the bound.** Within it a request costs no
  call. After it the door asks again, so access given or taken away in Todo reaches Notes within
  five minutes, in both directions.
- **It fails closed.** With the kept answer expired and Todo unreachable, Notes admits nobody
  and answers `503`. An outage shorter than five minutes goes unnoticed.
- **It has no screens of its own.** A person sees one app, Todo. When the plugin lets them in,
  Todo's app shows what it adds: notes under each item on the list screen, and a **Notes** tab
  beside Active, Archived, Trash and Table. Someone not switched on sees Todo as it is without the
  plugin.
- **A note depends on an item it does not own.** The plugin keeps the note and the item's id;
  Todo keeps the item. The Notes tab reads each item from Todo as it is now, so a ticked item's
  notes show it done, a deleted item's notes stay the plugin's and say their item is gone, and a
  binned list's notes leave the tab, because Todo stops vouching for it.
- **A note on a Todo item follows the item's sharing.** Notes keeps the note; Todo knows who may
  see the item. So before showing or adding one, Notes asks Todo (`todo/vouch-access`) whether the
  person may see that list or item, and answers `403` otherwise, the same for an item that does not
  exist.
- **Nothing personal is copied.** The answer carries no name and no address. Notes keeps which
  login is which id, and the roles it seated.
- **Todo can call Notes as the person signed in to it.** The call carries a token the issuer
  exchanged for that person, Notes' door checks it, and the call runs as them, capped to the
  notepad's keys. See [Todo calling Notes as a person](#todo-calling-notes-as-a-person).

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/demo-notes` |
| **Engines composed** | *none* — kernel only |
| **Own tables** | `notes_notes` · `notes_item_notes` |
| **Roles** | `writer` (read and write notes, on the notepad and on items), seated only by the door: Todo's `member` answer maps to it |
| **Permission surface** | [`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/notes/PERMISSIONS.md) — 4 keys, 1 module, 1 role, 1 delegation (`todo`, notepad keys, `peer`) |
| **Calls** | `todo`, for `todo/resolve-person` and `todo/vouch-access`, and nothing else |
| **Auth** | [OIDC only](/concepts/identity), at the same issuer as Todo |
| **Apps** | API only (`:8881`). The dev command runs a copy of Todo's API (`:8882`) and Todo's web app (`:5278`), which draws the plugin |
| **Status** | Runs locally. The hosted door and the call made as a person are built (`workerDoor({ people })`, `peerAs`); this pair is not deployed |

## The cast & what's denied

The cast is Todo's. Nobody is seeded into Notes.

| Who | In Todo | In Notes |
|---|---|---|
| **Ada** | `admin` — decides which members may use plugins | let in once she gives herself plugin access |
| **Björn** | `member`, same tenant | `403` on every operation until Ada gives him plugin access; reads and writes notes after |
| **Cleo** | `member` in a different tenant | `403` — Todo in this tenant has nobody for her login |

## Run it

```bash
pnpm --filter @substrat-run/demo-notes dev
# Todo    http://localhost:5278   (with the plugin; Plugins is in the account menu)
```

Both APIs run in one process, because locally the peer call goes through an in-process broker.
The Todo served here is this process's own copy, not the one `pnpm todo-demo dev` serves, so
stop that one first: both use port 5278.

To see the plugin at work:

1. Sign in as **Ada**, open **Plugins** from the account menu, and switch yourself on.
2. Within 30 seconds a **Notes** tab appears beside the lists' views, and each item on a list
   gets **Add note**. Add one, then tick the item off or delete it, and look at the Notes tab.
3. Share the list with **Björn**, and switch user to him. He sees the list and no notes: he is
   not switched on.
4. As Ada, switch him on. Within 30 seconds he sees the note on the shared item, and can add his own.
   A list nobody shared with him is not his to open, and its notes are refused alike.
5. As Ada, switch him off. Within 30 seconds the notes are gone from his Todo again.

The dev server keeps an answer from Todo for 30 seconds so this can be watched; the door's own
default is five minutes. `PEOPLE_TTL_SECONDS=300 pnpm --filter @substrat-run/demo-notes dev` runs it
with the real bound.

`test/people.test.ts` drives both apps over HTTP as several people, with the door's clock in the
test's hands: a member with access is let in as the same id, another tenant's member is refused,
access taken away is lost when the kept answer expires and not before, and nobody is admitted
on an expired answer while Todo is down.

## Todo calling Notes as a person

Todo also calls Notes **as the person signed in to Todo**. Todo's API, as this pair serves it,
has two routes that do it:

```bash
GET  http://localhost:8882/api/plugins/notes/notes       # the notepad, read as you
POST http://localhost:8882/api/plugins/notes/notes       # {"text": "..."}, written as you
```

Todo keeps the refresh token of your session, trades it at the issuer for a token addressed to
Notes, and the broker carries the call with it. Notes' door checks that token (issued for Notes,
on the `peer` channel, by Todo) and lets you in as your own sign-in would, so a note written this
way has your id as its author. What it may do is capped by Notes' manifest:

```ts
delegations: [{ actor: 'todo', permissions: ['note:read', 'note:write'], channels: ['peer'] }],
```

**Item notes are left out on purpose.** `notes/add-item-note` and `notes/list-item-notes` trust
Notes' door to have asked Todo whether you may see the list or item, and a call made for a person
does not pass that door. If they checked the notepad's keys, Todo could write a note on any item id,
or read every item note, as anyone signed in. So they have keys of their own, `item-note:read` and
`item-note:write`, which `writer` holds and the delegation does not: through Todo they are `403`
even for Ada.

The routes need a session from Todo's own sign-in (a `/dev/token` bearer has none, and is `401`).
Each app signs in as its own client, `todo` and `notes`, and the issuer the dev command starts takes
Notes' delegation with `--delegations src/delegations.ts`, read off the manifest.

`test/delegated.test.ts` signs Ada and Björn in at Todo through the real login round-trip and drives
these routes: Ada writes and reads a note and Notes records her as its author; the same call cannot
reach an item note though she holds those keys; Björn is refused, admitted once given access, and
refused again once his kept answer expires after it is taken away.

## Deliberately out of scope

Names (a note shows its author's id), access per plugin (Todo keeps one flag per member for all
plugins), and deploying this pair. Todo's app draws the plugin's features in its own code and
reaches its API through the dev proxy, so both are one origin; deployed, a plugin is another
origin, and how a plugin ships screens for the app it belongs to is still open. Notes trusts its own door for whether an item may be seen: the
operation behind the route cannot ask Todo itself, since module code has no network.
