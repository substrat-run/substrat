# @substrat-run/model-emit

Build-time tooling over a vertical's [model](/concepts/model): the DDL your entities
already describe, the reader that checks a migration journal against them, and the planner
that says what one new journal entry would have to contain.

```sh
pnpm add -D @substrat-run/model-emit
```

It is a **dev dependency**. Nothing here runs inside a scope — it produces text you commit.

## Why it exists

A vertical declares its entities once:

```ts
export const entities = defineEntities({
  customer: {
    table: 'acme_customers',
    fields: z.object({ id: z.string(), number: z.string(), name: z.string() }),
    key: ['number'],
  },
});
```

…and then, without this package, writes the same thing again by hand as SQL. Two
descriptions of one schema, nothing holding them together — so they drift, and the drift is
invisible until a query returns `undefined` for a column somebody renamed on one side.

`emitTables` derives the second from the first.

## `emitTables` — the DDL

```ts
import { emitTables } from '@substrat-run/model-emit';
import { entities } from './spec/model.js';

const sql = emitTables(entities);                     // CREATE TABLE …
const sql = emitTables(entities, { ifNotExists: true }); // CREATE TABLE IF NOT EXISTS …
```

| declared | emitted |
|---|---|
| `id` | `id TEXT PRIMARY KEY NOT NULL` |
| `z.string()` / `.nullable()` | `TEXT NOT NULL` / `TEXT` |
| `z.number()` | `INTEGER` |
| `z.boolean()` | **refused** — SQLite stores 0/1, so declare `z.number()` and keep the row type honest. `z.boolean()` stays right for an operation's *input* |
| `z.enum(['a','b'])` | `TEXT NOT NULL CHECK (col IN ('a','b'))` |
| `key: ['number']` | `UNIQUE (number)`; composite over all its fields — `key: ['a','b']` is one `UNIQUE (a, b)` |
| `parents: ['customer']` | `REFERENCES acme_customers(id)` on the matching `customer_id` |
| `jsonColumn('because…')` | `TEXT` |

`columnsOf(entities)` and `uniqueConstraints(name, entity)` expose the same derivation
piecewise, for a tool that wants the parts rather than the statement.

### It is stricter than a hand-written schema, in exactly one way

An `id` becomes `TEXT PRIMARY KEY **NOT NULL**`. In SQLite a non-INTEGER primary key does
*not* imply `NOT NULL`, so a hand-written `id TEXT PRIMARY KEY` accepts a NULL id — and
every hand-written `vertical_*` table in this repo had that hole. The emitter cannot
produce it.

### It refuses rather than guesses

A Zod shape it cannot map to a column throws, naming the field:

```
emit-sql: cannot map thing.blob (zod kind 'array') to a column —
  map it explicitly, or model the field as one this understands
```

This is deliberate. A production vertical once shipped 18 events carrying
`entityId: undefined` because its emitter *defaulted* instead of refusing — applied
uniformly, silently, eighteen times. For anything reaching a migration, absent has to be
loud.

A column that genuinely holds a document is declared, with a reason:

```ts
fields: z.object({
  id: z.string(),
  geometry: jsonColumn('a route geometry — modelling its interior says nothing useful'),
});
```

`jsonColumn` lives in [`@substrat-run/contracts`](/reference/contracts), because you *write*
it in your model. A bare `z.unknown()` is still an error: deliberately opaque and
not-yet-modelled have to stay distinguishable, or the first becomes cover for the second.

## `journalColumns` / `journalUniques` — the other half

```ts
import { journalColumns } from '@substrat-run/model-emit';

const journal = journalColumns(migrations.map((m) => m.sql).join('\n'));
journal.get('acme_customers'); // Set { 'id', 'number', 'name' }
```

Columns per table, replayed from a migration journal: `CREATE TABLE`, `ADD COLUMN`,
`DROP TABLE`, and `RENAME TO`. That last one matters — append-only journals rebuild a table
by creating a `_new`, copying, dropping the original and renaming onto its name, and a
reader that misses that reports the pre-rebuild columns forever. `journalUniques` does the
same for unique constraints and `journalPrimaryKeys` for the key.

**Your journal is not parsed — it is replayed.** The readers run it into a throwaway
in-memory SQLite and read the schema back through `PRAGMA table_info` / `index_list` /
`index_info`. So the answer is the one your production database would give, and every SQL
spelling works because SQLite is the thing reading it: several columns on one line, a
`CREATE TABLE` on one line, a `) STRICT;` suffix, a quoted `"order"` identifier, a wrapped
`PRIMARY KEY (` list, a comma inside a literal, a `--` or `/* */` comment. Reformatting a
journal never changes an answer, which matters because history is the one thing an
append-only journal may not rewrite.

Only **schema** statements are replayed. Your `INSERT`s do not change your schema, and
skipping them is what lets a vertical's journal be read on its own when it hands data to an
engine whose tables live in a different journal. Foreign keys stay off, so a `REFERENCES`
pointing at another module's table is created rather than refused.

A journal whose schema statements **do not apply** now throws, naming the statement. That
is deliberate: a journal that cannot be replayed will not apply to a scope either, and the
old parser answered anyway.

::: warning Node only
The readers use `node:sqlite`, so they need **Node 22.5+**. That is not a new restriction in
practice — this package is a build-time devDependency and nothing in it runs inside a scope.
:::

`journalUniques` reads all three spellings of a uniqueness rule, because real journals use
all three:

| in the journal | read as |
|---|---|
| `UNIQUE (a, b)` — table-level | `a, b` |
| `b TEXT NOT NULL UNIQUE` — column-level | `b` |
| `CREATE UNIQUE INDEX ux ON t (b)` | `b` |
| `CREATE UNIQUE INDEX ux ON t (b) WHERE deleted_at IS NULL` | **nothing** — a partial index constrains a subset of the rows, so reading it as a key would claim a guarantee the database does not make |

It ships with the emitter because the two are one claim: the emitter says *what the database
ends up with*, and this is how that gets checked. Until your migrations are derived, use it
to hold your registry and your journal to each other:

```ts
it('the registry agrees with the journal', () => {
  const journal = journalColumns(migrations.map((m) => m.sql).join('\n'));
  for (const entity of Object.values(entities)) {
    expect(Object.keys(entity.fields.shape).sort())
      .toEqual([...(journal.get(entity.table) ?? [])].sort());
  }
});
```

## `planMigration` — nobody writes the version number

```ts
import { planMigration, parseJournal } from '@substrat-run/model-emit';

const plan = planMigration(entities, parseJournal(JSON.parse(raw)));
```

The model states the current shape; the journal states what has already been applied.
`planMigration` reconstructs the second, diffs against the first, and returns one of three
things:

| result | meaning |
|---|---|
| `{ kind: 'up-to-date' }` | the journal already describes the model |
| `{ kind: 'append', entry }` | exactly one new entry, with a **derived** monotonic `version` (`0003`) and a slug from what changed |
| `{ kind: 'refused', reasons }` | the diff is not a diff — see below |

It is pure: same model + same journal → same plan, every time. It reads no clock and mints
no id, which is what lets the result be committed and reviewed as a diff.

**Declaring a version is declaring a fact a diff already knows** — and hand-numbering has
failed in practice: a production journal in a real app ships two entries numbered `0010`,
because two people numbered by hand in two branches. Two branches both deriving `0003`
collide in `journal.json`, which is the right signal on an ordered append-only list, and the
resolution is mechanical: merge the model, re-run, it renumbers.

### What it refuses

Anything that would rewrite history or lose data: a dropped table or column, a retyped
column, or a **required** column added to a table that may already hold rows. Those are real
decisions — expand/contract, a backfill, a
[`renamedFrom`](/concepts/model) declaration — and a generator that guessed at them would be
guessing with somebody's data. A refusal names each reason in the vocabulary of your model,
not in raw table names.

### A vertical composed of surfaces has more than one journal

A vertical assembled from surfaces ships one concatenated migration list built from several
journals, and the kernel runs it in the order it is handed — it never sorts by version. So
**which journal an entry goes into is the execution order**, and the counter belongs to the
vertical rather than to any one journal. Say so:

```ts
const journals = {
  core: parseJournal(read('core'), { surface: 'core' }),
  billing: parseJournal(read('billing'), { surface: 'billing' }),
};

const plan = planMigration(entities, journals.billing, { journals, surface: 'billing' });
```

`entities` stays the **whole** model — parent edges resolve against the full registry, and a
one-surface slice would read every other surface's tables as dropped. Three things change,
and nothing changes for a vertical that passes no options:

| | one journal | a set |
|---|---|---|
| applied schema | that journal | **every** journal, so a table another surface created is not diffed as missing |
| next version | position in the journal | **the highest version seen anywhere, plus one** — the count is not the number, and a version another surface already holds is a boot failure |
| a new table | numbered and appended | **refused unless `surface` names one of the journals** — a `parents` edge emits a `REFERENCES`, and SQLite will create a child before its parent without complaining |

That last refusal is the planner declining to pick an execution order it cannot read off the
model. It does not check the order you picked; naming the surface is you saying you picked
it. An `ALTER` makes no such choice and is never asked.

The set has to be **whole**, and a partial one is refused rather than repaired: it must hold
the journal you are appending to (pass the member — `journals.billing` — not a second parse of
the same file), and a surface you are only now *starting* is one of them too, as an empty
journal. The order you write the record in is the order the kernel runs it, so a planner that
slotted a stray journal in somewhere would be choosing that order for you — and putting it
last replays an `ALTER` from a later surface before the `CREATE` it depends on.

`parseJournal` takes the same `surface`, and it relaxes exactly one thing. A shared counter
puts gaps in every journal it feeds (`0043`, then `0055`, because the numbers between went to
other surfaces), so position can no longer derive the counter; what a surface's journal must
still do is **climb, and never repeat**. Two entries numbered `0010` in one surface is the bad
merge it always was. `0010` in two different surfaces is history, from when they numbered
independently, and parses.

## It reads the TypeScript, never `model.json`

`z.toJSONSchema` keeps the declarative constraints (`.min`, `.regex`, `.enum`, `.nullable`,
`.default`) and **silently drops the programmatic ones** — `.refine()` and `.brand()` both
emit as a bare `{"type":"string"}`. An emitter reading the JSON would produce a schema weaker
than your model declares.

`model.json` is for consumers that must *not* execute your code (a hosted console drawing
your model) or that want diffability rather than validators (a breaking-change classifier).
Those are different jobs, and the [model page](/concepts/model#model-json) keeps them apart.

## What it is not

It emits a **schema, not a migration history**. Freezing released entries and running
expand/contract across a live scope are the
[deploy model's](/concepts/deploying) problem, and this does not pretend to solve them. Use
`emitTables` for a scope that has never run, and `journalColumns` + `planMigration` to hold
an existing journal to your registry.

## Licence

Apache-2.0, unlike the AGPL runtime packages. Substrat's line is whether a package is the
substrate you *run to serve* (kernel, adapters, engines) or something you *build with*
(contracts, templates, the CLI). A generator is the second.

## See also

- [The model](/concepts/model) — what a vertical declares, and what the compiler checks
- [`@substrat-run/contracts`](/reference/contracts) — `defineEntities`, `jsonColumn`, `emitModel`
- [The deploy model](/concepts/deploying) — where migrations actually run
