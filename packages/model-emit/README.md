# @substrat-run/model-emit

Build-time tooling over a Substrat [model](https://substrat.net/concepts/model) — the DDL
your entities describe, and the reader that holds it honest.

```sh
pnpm add -D @substrat-run/model-emit
```

**Full documentation: https://substrat.net/concepts/model**

## Why this exists

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

…and then writes the same thing again, by hand, as SQL:

```sql
CREATE TABLE acme_customers (
  id     TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  name   TEXT NOT NULL
);
```

Two descriptions of one schema. Nothing holds them together, so they drift — and the drift
is invisible until a query returns `undefined` for a column somebody renamed on one side.

`emitTables` derives the second from the first.

## Usage

```ts
import { emitTables } from '@substrat-run/model-emit';
import { entities } from './spec/model.js';

const sql = emitTables(entities);
```

| declared | emitted |
|---|---|
| `id` | `id TEXT PRIMARY KEY NOT NULL` |
| `z.string()` / `.nullable()` | `TEXT NOT NULL` / `TEXT` |
| `z.number()` | `INTEGER` |
| `z.boolean()` | `INTEGER` — SQLite has no boolean |
| `z.enum(['a','b'])` | `TEXT NOT NULL CHECK (col IN ('a','b'))` |
| `key: ['number']` | `UNIQUE (number)` |
| `parents: ['customer']` | `REFERENCES acme_customers(id)` on the matching `customer_id` |
| `jsonColumn('because…')` | `TEXT` |

Pass `{ ifNotExists: true }` to emit `CREATE TABLE IF NOT EXISTS`.

## It is stricter than a hand-written schema, in one way

An `id` becomes `TEXT PRIMARY KEY **NOT NULL**`. In SQLite a non-INTEGER primary key does
*not* imply `NOT NULL`, so `id TEXT PRIMARY KEY` accepts a NULL id:

```
hand-written  id TEXT PRIMARY KEY          → ACCEPTED a NULL id
emitted       id TEXT PRIMARY KEY NOT NULL → rejected
```

Every hand-written `vertical_*` table in the Substrat repo had that hole. The emitter cannot
produce it.

## It refuses rather than guesses

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

`jsonColumn` lives in `@substrat-run/contracts`, because you *write* it in your model. A
bare `z.unknown()` is still an error — deliberately opaque and not-yet-modelled have to stay
distinguishable, or the first becomes cover for the second.

## `journalColumns` — the other half

```ts
import { journalColumns } from '@substrat-run/model-emit';

const journal = journalColumns(migrations.map((m) => m.sql).join('\n'));
journal.get('acme_customers'); // Set { 'id', 'number', 'name' }
```

Columns per table, replayed from a migration journal: `CREATE TABLE`, `ADD COLUMN`,
`DROP TABLE`, and `RENAME TO` — append-only journals rebuild a table by creating a `_new`,
copying, dropping the original and renaming onto its name, and a reader that misses that
reports the pre-rebuild columns forever.

It ships with the emitter because the two are one claim: the emitter says *what the database
ends up with*, and this is how that gets checked. Until your migrations are derived, use it
to hold your registry and your journal to each other:

```ts
it('the registry agrees with the journal', () => {
  const journal = journalColumns(migrations.map((m) => m.sql).join('\n'));
  for (const [name, entity] of Object.entries(entities)) {
    expect(Object.keys(entity.fields.shape).sort())
      .toEqual([...(journal.get(entity.table) ?? [])].sort());
  }
});
```

## It reads the TypeScript, never `model.json`

`z.toJSONSchema` keeps the declarative constraints (`.min`, `.regex`, `.enum`, `.nullable`,
`.default`) and **silently drops the programmatic ones** — `.refine()` and `.brand()` both
emit as a bare `{"type":"string"}`. An emitter reading the JSON would produce a schema weaker
than your model declares.

`model.json` is for consumers that must not execute your code (a hosted console drawing your
model) or that want diffability rather than validators (a breaking-change classifier).

## What it is not

It emits a **schema, not a migration history**. Version numbers, freezing released entries,
and expand/contract are a separate problem, and this does not pretend to solve it. Use it for
a scope that has never run, or to check an existing journal against your registry.

## Licence

Apache-2.0, like the rest of the build surface. Substrat's line is whether a package is the
substrate you *run to serve* (AGPL — kernel, adapters, engines) or something you *build with*
(Apache — contracts, templates, the CLI). A generator is the second. See
[LICENSING.md](https://github.com/substrat-run/substrat/blob/main/LICENSING.md).
