/**
 * The DDL emitter — plan §9 step 2, the first deterministic emitter.
 *
 * The assertions are exact strings on purpose. A migration is append-only and a
 * shipped version is never edited, so a change in what this emits is a change
 * nobody can undo — it should be impossible to make without seeing it here.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities, jsonColumn } from '@substrat-run/contracts';
import { emitTables, journalColumns, journalPrimaryKeys } from '../src/index.js';

const entities = defineEntities({
  customer: {
    table: 'acme_customers',
    fields: z.object({
      id: z.string(),
      number: z.string(),
      name: z.string(),
      org_ref: z.string().nullable(),
      created_at: z.string(),
    }),
    key: ['number'],
  },
  site: {
    table: 'acme_sites',
    fields: z.object({
      id: z.string(),
      customer_id: z.string(),
      status: z.enum(['open', 'closed']),
      seats: z.number(),
      active: z.number(),
      note: z.string().nullable(),
    }),
    parents: ['customer'],
  },
});

describe('emitTables', () => {
  const sql = emitTables(entities);

  it('emits a table per entity, in sorted order', () => {
    expect(sql.indexOf('acme_customers')).toBeLessThan(sql.indexOf('acme_sites'));
  });

  it('writes the columns the model declares', () => {
    expect(sql).toContain(`CREATE TABLE acme_customers (
  id TEXT PRIMARY KEY NOT NULL,
  number TEXT NOT NULL,
  name TEXT NOT NULL,
  org_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (number)
);`);
  });

  it('makes the id NOT NULL — stricter than a hand-written schema', () => {
    // In SQLite a non-INTEGER PRIMARY KEY does NOT imply NOT NULL, so
    // `id TEXT PRIMARY KEY` accepts a NULL id. Every hand-written vertical_*
    // table in this repo has that hole; the emitter closes it by construction.
    expect(sql).toContain('id TEXT PRIMARY KEY NOT NULL');
  });

  it('turns an enum into a CHECK constraint', () => {
    expect(sql).toContain("status TEXT NOT NULL CHECK (status IN ('open','closed'))");
  });

  it('maps a numeric flag to INTEGER — SQLite has no boolean', () => {
    expect(sql).toContain('active INTEGER NOT NULL');
  });

  it('refuses z.boolean() in a stored field, and says why', () => {
    // INTEGER is the right column; `boolean` is the wrong type to promise,
    // because SQLite hands back 0/1 and `EntityRow` would infer a boolean the
    // database can never return.
    const entities = {
      thing: {
        table: 'acme_things',
        fields: z.object({ id: z.string(), done: z.boolean() }),
      },
    };
    expect(() => emitTables(entities)).toThrow(/is z.boolean\(\), which stores as INTEGER/);
    expect(() => emitTables(entities)).toThrow(/declare it z.number\(\)/);
  });

  it("...while an operation's input keeps z.boolean(), which is correct", () => {
    // The asymmetry that makes this subtle: an app takes `done: z.boolean()`
    // across JSON and stores `done: z.number()`, and both are right. Nothing
    // here should discourage the first.
    const entities = {
      thing: {
        table: 'acme_things',
        fields: z.object({ id: z.string(), done: z.number() }),
      },
    };
    expect(() => emitTables(entities)).not.toThrow();
  });

  it('makes a parent edge a real foreign key when its id column exists', () => {
    expect(sql).toContain('customer_id TEXT NOT NULL REFERENCES acme_customers(id)');
  });

  it('leaves nullable fields nullable', () => {
    // Last column in its table, so no trailing comma — assert the shape, not
    // an incidental separator.
    expect(sql.split('\n')).toContain('  note TEXT');
    expect(sql).not.toContain('note TEXT NOT NULL');
    expect(sql).toContain('org_ref TEXT,');
  });

  it('is deterministic', () => {
    expect(emitTables(entities)).toBe(sql);
  });

  it('round-trips: what it emits is what the journal reader sees', () => {
    // The emitter and journalColumns are the two halves of the same claim, so
    // they are held to each other rather than each to a hand-written string.
    const parsed = journalColumns(sql);
    expect([...(parsed.get('acme_customers') ?? [])].sort()).toEqual(
      Object.keys(entities.customer.fields.shape).sort(),
    );
    expect([...(parsed.get('acme_sites') ?? [])].sort()).toEqual(
      Object.keys(entities.site.fields.shape).sort(),
    );
  });

  it('honours ifNotExists', () => {
    expect(emitTables(entities, { ifNotExists: true })).toContain('CREATE TABLE IF NOT EXISTS acme_customers');
  });
});

describe('it refuses rather than guesses', () => {
  it('throws on a shape it cannot map', () => {
    const bad = defineEntities({
      thing: { table: 't', fields: z.object({ id: z.string(), blob: z.array(z.string()) }) },
    });
    // #695's 18 broken events came from an emitter DEFAULTING rather than
    // refusing — applied uniformly, silently, 18 times.
    expect(() => emitTables(bad)).toThrow(/cannot map thing\.blob/);
  });

  it('throws when key names a field that does not exist', () => {
    const bad = defineEntities({
      thing: { table: 't', fields: z.object({ id: z.string() }) },
    }) as unknown as Record<string, { table: string; fields: z.ZodObject<z.ZodRawShape>; key: string[] }>;
    bad.thing!.key = ['nope'];
    expect(() => emitTables(bad as never)).toThrow(/names 'nope'/);
  });
});

describe('jsonColumn', () => {
  const withJson = defineEntities({
    activity: {
      table: 'acme_activities',
      fields: z.object({
        id: z.string(),
        machine_req: jsonColumn('a requirement document the vertical parses itself'),
        geometry: jsonColumn('a route geometry — modelling its interior says nothing useful').nullable(),
      }),
    },
  });

  it('becomes TEXT — SQLite has no JSON type', () => {
    const sql = emitTables(withJson);
    expect(sql).toContain('machine_req TEXT NOT NULL');
    expect(sql).toContain('geometry TEXT');
    expect(sql).not.toContain('geometry TEXT NOT NULL');
  });

  it('a bare z.unknown() is still an error', () => {
    // Deliberately opaque and not-yet-modelled must stay distinguishable, or the
    // first quietly becomes cover for the second.
    const bare = defineEntities({
      thing: { table: 't', fields: z.object({ id: z.string(), blob: z.unknown() }) },
    });
    expect(() => emitTables(bare)).toThrow(/cannot map thing\.blob/);
  });

  it('demands a reason', () => {
    expect(() => jsonColumn('  ')).toThrow(/needs a reason/);
  });
});

/**
 * #804 — the table whose identity is not an `id`.
 *
 * `vertical_workorder_ext` is the side table the design rules prescribe for
 * extra data on an engine's entity: keyed by the work order's id, with no id of
 * its own to have. `vertical_time_budget` is the ordinary value-keyed shape.
 * Before this, both emitted with NO primary key at all — silently, and a
 * column-wise parity check reported them matching.
 */
const keyed = defineEntities({
  budget: {
    table: 'vertical_time_budget',
    fields: z.object({
      customer_id: z.string(),
      year: z.number(),
      month: z.number(),
      hours: z.string(),
    }),
    primaryKey: ['customer_id', 'year', 'month'],
    key: ['hours'],
  },
  ext: {
    table: 'vertical_workorder_ext',
    fields: z.object({ workorder_id: z.string(), route_note: z.string().nullable() }),
    primaryKey: ['workorder_id'],
  },
});

describe('a primary key that is not `id` (#804)', () => {
  const sql = emitTables(keyed);

  it('writes a single-column key inline, exactly as it writes an id', () => {
    expect(sql).toContain(`CREATE TABLE vertical_workorder_ext (
  workorder_id TEXT PRIMARY KEY NOT NULL,
  route_note TEXT
);`);
  });

  it('writes a composite key as a table-level constraint, after the columns', () => {
    // Order preserved, not sorted: a composite primary key is also the index its
    // columns are searched by, left to right.
    expect(sql).toContain(`CREATE TABLE vertical_time_budget (
  customer_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  hours TEXT NOT NULL,
  PRIMARY KEY (customer_id, year, month),
  UNIQUE (hours)
);`);
  });

  it('keeps `primaryKey` and `key` as two separate facts', () => {
    // SQL's own distinction: identity, and an additional uniqueness rule. A
    // table legitimately has both, which is why `key` was not overloaded.
    expect(sql).toContain('PRIMARY KEY (customer_id, year, month)');
    expect(sql).toContain('UNIQUE (hours)');
  });

  it('round-trips: the journal reader sees the key the emitter wrote', () => {
    const read = journalPrimaryKeys(sql);
    expect(read.get('vertical_time_budget')).toEqual(['customer_id', 'year', 'month']);
    expect(read.get('vertical_workorder_ext')).toEqual(['workorder_id']);
  });

  it('still reports the key columns as columns', () => {
    expect([...(journalColumns(sql).get('vertical_workorder_ext') ?? [])].sort()).toEqual([
      'route_note',
      'workorder_id',
    ]);
  });

  it('leaves an id-keyed entity byte-identical to what it emitted before', () => {
    expect(emitTables(entities)).toContain('  id TEXT PRIMARY KEY NOT NULL,');
    expect(emitTables(entities)).not.toContain('PRIMARY KEY (');
  });
});

describe('an entity with no identity is refused, not emitted keyless', () => {
  it('throws, naming the entity and what to declare', () => {
    // THE bug: this used to emit `CREATE TABLE t (a TEXT NOT NULL, b TEXT NOT
    // NULL);` — no primary key, duplicate rows accepted, and nothing said so.
    const orphan = { thing: { table: 't_thing', fields: z.object({ a: z.string(), b: z.string() }) } };
    expect(() => emitTables(orphan)).toThrow(/thing has no 'id' field and declares no `primaryKey`/);
  });

  it('refuses a nullable key column — the hole it exists to close', () => {
    // SQLite lets a NULL into a non-INTEGER primary key, so the database would
    // not catch this either.
    const nullableKey = {
      ext: {
        table: 't_ext',
        fields: z.object({ workorder_id: z.string().nullable(), note: z.string() }),
        primaryKey: ['workorder_id'],
      },
    };
    expect(() => emitTables(nullableKey)).toThrow(/part of the primary key but is nullable/);
  });
});

describe('a foreign key follows the parent\'s own key, not an assumed `id`', () => {
  it('references the parent key column by name', () => {
    // Emitting `REFERENCES vertical_workorder_ext(id)` here parses fine — SQLite
    // does not check a foreign key target at CREATE time — and then rejects
    // every valid child row at INSERT with "foreign key mismatch". Verified
    // against a real database.
    const withSideParent = defineEntities({
      ext: {
        table: 'vertical_workorder_ext',
        fields: z.object({ workorder_id: z.string(), note: z.string().nullable() }),
        primaryKey: ['workorder_id'],
      },
      line: {
        table: 'vertical_ext_line',
        fields: z.object({ id: z.string(), ext_id: z.string(), text: z.string() }),
        parents: ['ext'],
      },
    });
    expect(emitTables(withSideParent)).toContain(
      'ext_id TEXT NOT NULL REFERENCES vertical_workorder_ext(workorder_id)',
    );
  });

  it('still says `(id)` where the parent is keyed by id', () => {
    expect(emitTables(entities)).toContain('REFERENCES acme_customers(id)');
  });

  it('refuses to point a single column at a composite-keyed parent', () => {
    const compositeParent = defineEntities({
      budget: {
        table: 'vertical_time_budget',
        fields: z.object({ customer_id: z.string(), year: z.number() }),
        primaryKey: ['customer_id', 'year'],
      },
      note: {
        table: 'vertical_budget_note',
        fields: z.object({ id: z.string(), budget_id: z.string(), text: z.string() }),
        parents: ['budget'],
      },
    });
    expect(() => emitTables(compositeParent)).toThrow(
      /a single column cannot reference a composite key/,
    );
  });
});
