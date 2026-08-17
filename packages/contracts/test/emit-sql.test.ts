/**
 * The DDL emitter — plan §9 step 2, the first deterministic emitter.
 *
 * The assertions are exact strings on purpose. A migration is append-only and a
 * shipped version is never edited, so a change in what this emits is a change
 * nobody can undo — it should be impossible to make without seeing it here.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities, emitTables, journalColumns } from '../src/index.js';

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
      active: z.boolean(),
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

  it('maps booleans to INTEGER — SQLite has none', () => {
    expect(sql).toContain('active INTEGER NOT NULL');
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
