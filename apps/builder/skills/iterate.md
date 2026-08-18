# Building well — patterns and truths for the project's whole life

The gates that must pass every turn: `pnpm typecheck`, boundary-lint,
`pnpm lint:tests`, and the test suite (the scenario AND the server smoke —
vitest runs every file under `test/`). The gates only measure what a test drives: green gates over an
undriven surface prove nothing, so every surface you build gets a test the same
turn, never later.

## Code patterns

- Zod comes from `@substrat-run/contracts`, which re-exports it. Importing `z`
  from there is the shortest path and always correct. Declaring `zod` directly
  is fine **and is what every demo and engine does** — but only at the range
  contracts uses (`^4.4.3` today). The hazard is a *second instance*, not a
  direct dependency: a schema built by one copy is not recognised by another, so
  a different major fails at runtime with `expected a Zod schema`, pointing
  nowhere near the cause. Match the range and there is one copy.
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

**Written in the scenario phase, BEFORE this code existed, and not yours to
edit** — the build's job is to make it pass. It is the concept's independent
claim about the app, and a build that may rewrite its own oracle has none. If an
assertion is genuinely wrong, say so and stop rather than softening it;
`pnpm lint:tests` additionally refuses any scenario suite that imports `spec/`,
because a test built from the model cannot disagree with the model.

What it contains, and why each rule earns its place: migrations journal → happy path → **denials hold**
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
- **Principal ids are `ulid()`-minted, never hand-written**: the kernel
  Zod-validates the actor on every invoke/`ctx.emit`, so a readable string like
  `usr-admin-001` fails deep inside the first mutation with a ZodError pointing
  nowhere near the seed. Readability lives in the cast's `name` field, not the id.
- **Grant every permission you check in the same edit that introduces it**: an
  operation whose perm key no role holds fails only at scenario time, as a
  baffling happy-path denial. New `ctx.check(APP_PERM.x)` → `x` appears in a
  role in `ROLES` before the test runs.
- **Qualify every column in a JOIN** (`app_task.id`, never bare `id`): the
  second table's `id` makes SQLite error with "ambiguous column name" — write
  queries qualified from the start rather than after the gate says so.
- **Know which door the denial closes**: an op-level `assertAllowed` THROWS —
  the attacker/wrong-role step asserts the pinned permission-denied rejection.
  Only a portal proof-walk listing (per-entity `ctx.check`) returns a filtered —
  possibly empty — list. Expecting `[]` from a throwing op, or a throw from a
  walk, both read as "access control broken" when the code is right.

## test/server.test.ts

The scenario bypasses HTTP, so this file is the only thing standing between
"gates green" and a server that does not actually serve. Build the same host +
seed the scenario uses (temp dir), construct the Hono app via `mountApi` with
the real `resolveStub`, and drive it with `app.request(path, { headers })` — no
port, no process spawn. Minimum coverage, one assertion each:

- happy path: a seeded persona's `x-principal` on one real route → 200 with a
  body from the operation (proves boot wiring: host, seed, cast, stub);
- no header → 401; unknown principal → 401; wrong-role persona on a guarded
  route → 403 (proves the error mapping, not just the kernel);
- a second request sees the first one's write (proves the host is built once
  and persistent — a per-request or `:memory:` host fails exactly here).
