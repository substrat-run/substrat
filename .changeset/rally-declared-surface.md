---
'@substrat-run/demo-rally': minor
---

RallyPoint declares its operation surface, and its ten list reads page

Rally's isolation IS its narrowed grants: a player's `booking:read` is granted per member
record and per reservation, never at the scope, precisely so a player cannot read the club's
book — who holds which court, and who they play with. Eight of rally's checks narrow that way,
and undeclared they were not merely untested but **undeclarable**: thirty-eight handlers
registered as `'rally/wallet': walletOp as never` described nothing, and to a compiler
`ctx.check(BK.read, memberRef(id))` and `ctx.check(BK.read)` are the same (#865/#891).

`src/operations.ts` declares all thirty-eight, `src/inputs.ts` and `src/schemas.ts` carry the
shapes they accept and answer, and `test/entity-checks.test.ts` drives the kit over the six
checks it can reach. All six were already honoured; they are now guarded rather than merely
correct today.

`reservation` belongs to **engine-booking**, so three of those checks narrow to an entity the
engine owns — `defineOperations`' composed-engine parameter is what allows it.

**Two checks the format cannot state**, declared as what they are:

- `rally/cancel-subscription` narrows to the member the SUBSCRIPTION row names, and the input
  carries only a subscription id. It declares `resolved`, and the kit reports it as uncovered
  rather than skipping it quietly.
- `rally/portal-bookings` declares `narrows` — a per-row proof walk, not one entity check.

`rally/timeline` declares the constant every call site passes for its caller-named
`entityType`. That is #890, and rally is its fourth instance.

**Breaking at the operation seam:** declaring an operation means declaring its `output`, and a
bare-array output with no `paged` beside it is refused (#811). Ten reads now return `Page<T>`.
`rally/list-members` is the one plain table walk and is kernel-composed; the rest are folds —
a slot grid derived from opening hours and the engine's free intervals, a partner tally over
every reservation, a price matrix computed per hour — so the fold runs and the page is taken
off it. `rally/portal-bookings` filters per ROW, which cannot use `ctx.page` at all: a page of
20 filtered to 3 is not a page, so it keeps its over-fetch and pages after the walk.

`rally/played-with` now publishes **`partyRef`**. It was always the tally's own key; it simply
was not in the answer, and a page needs a unique field to walk. Additive.

Over HTTP nothing renames: a page's body is still the entries and the walk rides in a `Link`
header (#829), so both front-ends are untouched. The `?all=1` match search is the one place
that reads entries directly — it merges several clubs into one body, so there is no single
walk to hand a cursor for.

Known gap, flagged rather than smuggled in: **most of rally's handlers still do not parse their
input.** Only the booking pair called `.parse()`; the other thirty-six trusted inline TypeScript
types. `src/inputs.ts` now writes those shapes down and the compiler holds `idFrom` to them,
which is what #891 needs — but turning thirty-six trusting handlers into validating ones is a
behaviour change to a live demo, not a declaration, and belongs in its own change. The same is
true of the operations `engines/booking` declared in this series.
