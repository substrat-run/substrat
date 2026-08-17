/**
 * The README is published to npm, where nobody can run it. These assert that
 * what it claims is what the code does — a sample that has drifted is worse
 * than no sample, because it is read as authoritative.
 */
import { describe, expect, it } from 'vitest';
import { defineEntities, jsonColumn } from '@substrat-run/contracts';
import { z } from 'zod';
import { emitTables, journalColumns } from '../src/index.js';

const entities = defineEntities({
  customer: {
    table: 'acme_customers',
    fields: z.object({ id: z.string(), number: z.string(), name: z.string() }),
    key: ['number'],
  },
});

describe('the README is true', () => {
  it('the opening sample emits the columns it shows', () => {
    const sql = emitTables(entities);
    expect(sql).toContain('id TEXT PRIMARY KEY NOT NULL');
    expect(sql).toContain('number TEXT NOT NULL');
    expect(sql).toContain('name TEXT NOT NULL');
    expect(sql).toContain('UNIQUE (number)');
  });

  it('quotes the refusal message verbatim', () => {
    const bad = defineEntities({ thing: { table: 't', fields: z.object({ id: z.string(), blob: z.array(z.string()) }) } });
    expect(() => emitTables(bad)).toThrow(
      /cannot map thing\.blob \(zod kind 'array'\) to a column — map it explicitly/,
    );
  });

  it('jsonColumn emits TEXT, and a bare unknown still throws', () => {
    const ok = defineEntities({
      route: { table: 'r', fields: z.object({ id: z.string(), geometry: jsonColumn('a route geometry') }) },
    });
    expect(emitTables(ok)).toContain('geometry TEXT NOT NULL');
    const bare = defineEntities({ r: { table: 'r', fields: z.object({ id: z.string(), g: z.unknown() }) } });
    expect(() => emitTables(bare)).toThrow(/cannot map/);
  });

  it('journalColumns returns what the sample shows', () => {
    const journal = journalColumns(emitTables(entities));
    expect([...(journal.get('acme_customers') ?? [])].sort()).toEqual(['id', 'name', 'number']);
  });

  it('ifNotExists does what it says', () => {
    expect(emitTables(entities, { ifNotExists: true })).toContain('CREATE TABLE IF NOT EXISTS acme_customers');
  });
});
