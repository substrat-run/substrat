# Building well — patterns and truths for the project's whole life

The gates that must pass every turn: `pnpm typecheck`, boundary-lint, and the
scenario test.

## Code patterns

- Import `z` from `@substrat-run/contracts`, **never add `zod` as a
  dependency** — a second zod copy fails at runtime with `expected a Zod
  schema`, pointing nowhere near the cause.
- Migrations are append-only forever: never edit a shipped version, only
  append the next entry.
- The **pricing moment**: read engine lines (`getReportedLines`) → apply the
  vertical's price list (minimum-billing, dropped internal articles — whatever
  the concept says) → call the engine's `completeWorkOrder` — one transaction,
  invariants intact.
- Engine data is reached ONLY through exported in-scope functions; another
  module's tables are private even for SELECT. Need more fields on an engine
  entity? Add your own side table keyed by the engine's id — never a column
  upstream.
- Portal listing is a proof walk, not UI filtering: iterate candidates and
  `await ctx.check(perm, entityRef)` per entity; entity-narrowed grants plus
  declared `entityRelations` edges make the walk reach the owner.
- Every link edge you traverse must be declared in some registered manifest's
  `entityRelations` — including edges engines create from refs you hand them.
- User-authored config is DATA, not code: if users shape schema/settings
  (content types, pricing rules), store rows + lazy idempotent defaults behind
  an admin permission — never user input into live DDL.
- Money/decimals are strings via contracts helpers; IDs are `ulid()`; dates
  are ISO-8601 TEXT.

## test/scenario.test.ts

Replay the concept's scenario headlessly against a temp dir via
`buildHost`/`stub.invoke`: migrations journal → happy path → **denials hold**
(wrong role; portal isolation between two customers; the cross-tenant attacker
gets `unknown scope`/`permission denied`) → pricing math exact → events
consumed → state machine can't skip. Truths that decide whether it's worth
anything:

- **Never a bare `.rejects.toThrow()`** — pin the message, or a typo'd
  operation name passes as a "denial". Pair every closed-door assertion with a
  control proving a neighbouring door is open, or the test passes just as
  happily with the engine unregistered.
- **Compute money literals with the real helpers** (`mulMoney`/`addDecimal`),
  never by hand: `fromMicro` strips trailing zeros, so 34 894,80 serialises as
  `'34894.8'` — asserting `'34894.80'` fails on a correct number.
- Do not re-test engine invariants (state machines, append-only) — verified in
  the engines, inherited by you.
