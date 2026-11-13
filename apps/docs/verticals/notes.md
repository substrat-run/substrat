# Notes (a plugin of Todo)

`demos/notes` — a second vertical in the same tenant as Todo that owns no people. It has one
table, two operations, and no owner seat, invitations or members of its own: who gets in is
decided in Todo.

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
- **Nothing personal is copied.** The answer carries no name and no address. Notes keeps which
  login is which id, and the roles it seated.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/demo-notes` |
| **Engines composed** | *none* — kernel only |
| **Own tables** | `notes_notes` |
| **Roles** | `writer` (read and write notes), seated only by the door: Todo's `member` answer maps to it |
| **Permission surface** | [`PERMISSIONS.md`](https://github.com/substrat-run/substrat/blob/main/demos/notes/PERMISSIONS.md) — 2 keys, 1 module, 1 role |
| **Calls** | `todo`, for `todo/resolve-person` and nothing else |
| **Auth** | [OIDC only](/concepts/identity), at the same issuer as Todo |
| **Apps** | API (`:8881`), and a copy of Todo's API (`:8882`) in the same process. No screen |
| **Status** | Runs locally — the hosted door does not take this option yet |

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
# issuer      http://localhost:8879
# notes API   http://localhost:8881
# its Todo    http://localhost:8882
```

Both apps run in one process, because locally the peer call goes through an in-process broker.
The Todo served here is this process's own copy, not the one `pnpm todo-demo dev` serves.

There is no screen, so sign in as a persona with the issuer's shortcut and call the API:

```bash
TOKEN=$(curl -s localhost:8879/dev/token -H 'content-type: application/json' \
  -d '{"sub":"dev|bjorn"}' | jq -r .access_token)
curl -s localhost:8881/api/notes -H "authorization: Bearer $TOKEN"
```

`test/people.test.ts` drives both apps over HTTP as several people, with the door's clock in the
test's hands: a member with access is let in as the same id, another tenant's member is refused,
access taken away is lost when the kept answer expires and not before, and nobody is admitted
on an expired answer while Todo is down.

## Deliberately out of scope

Names (a note shows its author's id), a screen, access per plugin (Todo keeps one flag per
member for all plugins), and anything deployed.
