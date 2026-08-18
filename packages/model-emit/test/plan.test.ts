/**
 * The journal planner: nobody writes the version number, and nothing rewrites
 * history.
 */
import { describe, expect, it } from 'vitest';
import { z, defineEntities } from '@substrat-run/contracts';
import { emitTables, planMigration, parseJournal, type Journal } from '../src/index.js';

const base = defineEntities({
  owner: {
    table: 'app_owners',
    fields: z.object({ id: z.string(), email: z.string(), created_at: z.string() }),
    key: ['email'],
  },
  list: {
    table: 'app_lists',
    fields: z.object({ id: z.string(), owner_id: z.string(), name: z.string() }),
    parents: ['owner'],
  },
});

const empty: Journal = { entries: [] };
const first = (entities: Parameters<typeof emitTables>[0]): Journal => {
  const plan = planMigration(entities, empty);
  if (plan.kind !== 'append') throw new Error(`expected an append, got ${plan.kind}`);
  return { entries: [plan.entry] };
};

describe('the first entry', () => {
  it('creates every table, numbered 0001 without anyone saying so', () => {
    const plan = planMigration(base, empty);
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    expect(plan.entry.version).toBe('0001');
    expect(plan.entry.sql).toContain('CREATE TABLE app_owners');
    expect(plan.entry.sql).toContain('CREATE TABLE app_lists');
  });

  it('is a no-op the second time — a diff that found nothing appends nothing', () => {
    expect(planMigration(base, first(base)).kind).toBe('up-to-date');
  });
});

describe('an additive change', () => {
  const withNote = defineEntities({
    ...base,
    list: {
      table: 'app_lists',
      fields: z.object({
        id: z.string(),
        owner_id: z.string(),
        name: z.string(),
        note: z.string().nullable(),
      }),
      parents: ['owner'],
    },
  });

  it('appends exactly one entry, numbered next', () => {
    const plan = planMigration(withNote, first(base));
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    expect(plan.entry.version).toBe('0002');
    expect(plan.entry.sql).toBe('ALTER TABLE app_lists ADD COLUMN note TEXT;');
    expect(plan.entry.slug).toBe('add-app_lists-note');
  });

  it('leaves the entry it followed untouched', () => {
    const journal = first(base);
    const before = journal.entries[0]!.sql;
    planMigration(withNote, journal);
    expect(journal.entries[0]!.sql).toBe(before);
  });

  it('adds a whole new table when the model grows one', () => {
    const withItems = defineEntities({
      ...base,
      item: {
        table: 'app_items',
        fields: z.object({ id: z.string(), list_id: z.string(), text: z.string() }),
        parents: ['list'],
      },
    });
    const plan = planMigration(withItems, first(base));
    if (plan.kind !== 'append') throw new Error('expected an append');
    expect(plan.entry.sql).toContain('CREATE TABLE app_items');
    expect(plan.entry.sql).toContain('REFERENCES app_lists(id)');
  });
});

describe('what it refuses, because guessing would cost data', () => {
  it('a required column with no default, on a table that may hold rows', () => {
    const withRequired = defineEntities({
      ...base,
      list: {
        table: 'app_lists',
        fields: z.object({
          id: z.string(),
          owner_id: z.string(),
          name: z.string(),
          colour: z.string(),
        }),
        parents: ['owner'],
      },
    });
    const plan = planMigration(withRequired, first(base));
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') return;
    expect(plan.reasons[0]).toMatch(/required and has no default/);
  });

  it('...while the same field made nullable is fine — the refusal is about the data, not the column', () => {
    const nullable = defineEntities({
      ...base,
      list: {
        table: 'app_lists',
        fields: z.object({
          id: z.string(),
          owner_id: z.string(),
          name: z.string(),
          colour: z.string().nullable(),
        }),
        parents: ['owner'],
      },
    });
    expect(planMigration(nullable, first(base)).kind).toBe('append');
  });

  it('a column the model dropped — a diff cannot tell a rename from a drop', () => {
    const withoutName = defineEntities({
      ...base,
      list: {
        table: 'app_lists',
        fields: z.object({ id: z.string(), owner_id: z.string() }),
        parents: ['owner'],
      },
    });
    const plan = planMigration(withoutName, first(base));
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') return;
    expect(plan.reasons[0]).toMatch(/cannot tell a rename from a drop/);
  });

  it('a table the model dropped', () => {
    const onlyOwner = defineEntities({ owner: base.owner });
    const plan = planMigration(onlyOwner, first(base));
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') return;
    expect(plan.reasons[0]).toMatch(/expand\/contract/);
  });
});

describe('parseJournal', () => {
  it('accepts a well-formed journal', () => {
    expect(parseJournal(first(base)).entries).toHaveLength(1);
  });

  it('catches the collision hand-numbering produces', () => {
    // The real failure this replaces: a production journal shipping two entries
    // numbered 0010, because two people numbered by hand in two branches.
    expect(() =>
      parseJournal({
        entries: [
          { version: '0001', slug: 'a', sql: 'CREATE TABLE a (id TEXT);' },
          { version: '0001', slug: 'b', sql: 'CREATE TABLE b (id TEXT);' },
        ],
      }),
    ).toThrow(/bad merge/);
  });
});
