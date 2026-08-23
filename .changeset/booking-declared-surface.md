---
'@substrat-run/engine-booking': minor
'@substrat-run/demo-rally': patch
---

engine-booking declares its operation surface, and its three list reads page

Seven of booking's checks narrow to a reservation — `ctx.check(PERM.cancel,
reservationRef(input.reservationId))`. Undeclared, they were not merely untested but
**undeclarable**: `entityCheckConformanceSuite` derives its behavioural pair from an
operation's `permission`, and booking had no declared operations to read. To a compiler
`ctx.check(PERM.cancel, ref)` and `ctx.check(PERM.cancel)` are the same, and the second
lets anyone holding `booking:cancel` anywhere in the scope cancel anyone's booking. On the
engine behind a club's court schedule, where a member's whole access to a reservation IS a
grant on that one row, that is the check worth having a machine verify (#865/#891).

`src/operations.ts` declares all seventeen, `src/schemas.ts` carries the shapes they accept
and answer, and `test/entity-checks.test.ts` drives the kit. All seven narrowed checks were
already honoured; they are now guarded rather than merely correct today.

**Breaking at the operation seam:** declaring an operation means declaring its `output`, and
a bare-array output with no `paged` beside it is refused (#811) — so `booking/list`,
`booking/list-resources` and `booking/availability` now return `Page<T>` rather than `T[]`.

- `booking/list-resources` is kernel-composed (`paged.over`), sorted by `name` as it shipped.
- `booking/list` is handler-composed with a cursor on **`id`**. Its window is an overlap test
  (`starts_at < to AND ends_at > from`), which the kernel's equality-only filter vocabulary
  cannot express; and a keyset cursor on `starts_at` would skip and repeat rows wherever two
  reservations share a start, which on a court schedule is every hour. A caller rendering a
  calendar sorts the page it got.
- `booking/availability` is a computed fold, paged on `startsAt` — its segments are disjoint,
  so that field is unique among them where it is not among reservation rows.

The **in-scope** `listResources` / `listReservations` / `availability` are unchanged. Those
are folds a vertical calls inside its own transaction, where the bound is the vertical's;
#811 is about the invocable endpoint. `listResourcesPage` / `listReservationsPage` /
`availabilityPage` are the paged siblings the operations use.

Over HTTP nothing renames: a page's body is still the entries and the walk rides in a `Link`
header (#829), which is what let rally adopt this without changing its API's responses.

Also: `bookingLifecycles` moved to `src/lifecycle.ts` and now checks itself against the
declared registry instead of the handler map — the cycle that kept it at the bottom of
`index.ts` is gone.
