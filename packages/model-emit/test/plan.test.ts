/**
 * The journal planner: nobody writes the version number, and nothing rewrites
 * history.
 */
import { describe, expect, it } from 'vitest';
import { z, defineEntities } from '@substrat-run/contracts';
import { emitTables, journalColumns, planMigration, parseJournal, type Journal } from '../src/index.js';

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

describe('the reader follows a column rename', () => {
  it('reports the new name, not the old one', () => {
    // Without this the planner re-emits the same rename on every run, because
    // the journal keeps reporting the column it renamed away from.
    const cols = journalColumns(
      'CREATE TABLE t (\n  id TEXT PRIMARY KEY NOT NULL,\n  email TEXT NOT NULL\n);\n' +
        'ALTER TABLE t RENAME COLUMN email TO address;',
    );
    expect([...(cols.get('t') ?? [])].sort()).toEqual(['address', 'id']);
  });

  it('does not confuse a column rename with a table rename', () => {
    const cols = journalColumns(
      'CREATE TABLE t (\n  id TEXT PRIMARY KEY NOT NULL\n);\nALTER TABLE t RENAME TO u;',
    );
    expect(cols.has('u')).toBe(true);
    expect(cols.has('t')).toBe(false);
  });
});

describe('renamedFrom — the one declaration a diff cannot derive', () => {
  const renamed = defineEntities({
    ...base,
    owner: {
      table: 'app_owners',
      fields: z.object({ id: z.string(), address: z.string(), created_at: z.string() }),
      key: ['address'],
      renamedFrom: { address: 'email' },
    },
  });

  it('renames instead of dropping and re-adding', () => {
    const plan = planMigration(renamed, first(base));
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    expect(plan.entry.sql).toBe('ALTER TABLE app_owners RENAME COLUMN email TO address;');
    // The whole point: no DROP, and no ADD that would leave the data behind.
    expect(plan.entry.sql).not.toMatch(/DROP|ADD COLUMN/);
    expect(plan.entry.slug).toBe('rename-app_owners-email-to-address');
  });

  it('is spent once it has shipped — the model may delete the declaration', () => {
    // Apply the rename, then plan again with the SAME model: nothing left to do.
    const applied = planMigration(renamed, first(base));
    if (applied.kind !== 'append') throw new Error('expected an append');
    const journal = { entries: [...first(base).entries, applied.entry] };
    expect(planMigration(renamed, journal).kind).toBe('up-to-date');

    // And with the declaration removed, still nothing — it was a gravestone.
    const withoutDeclaration = defineEntities({
      ...base,
      owner: {
        table: 'app_owners',
        fields: z.object({ id: z.string(), address: z.string(), created_at: z.string() }),
        key: ['address'],
      },
    });
    expect(planMigration(withoutDeclaration, journal).kind).toBe('up-to-date');
  });

  it('...while WITHOUT the declaration the same change is still refused', () => {
    // The control. Without this, the rename test would pass just as happily if
    // the planner had quietly stopped refusing drops altogether.
    const undeclared = defineEntities({
      ...base,
      owner: {
        table: 'app_owners',
        fields: z.object({ id: z.string(), address: z.string(), created_at: z.string() }),
        key: ['address'],
      },
    });
    const plan = planMigration(undeclared, first(base));
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') return;
    expect(plan.reasons.join(' ')).toMatch(/renamedFrom/);
  });

  it('refuses a declaration naming a field the model does not have', () => {
    const wrong = defineEntities({
      ...base,
      owner: {
        table: 'app_owners',
        fields: z.object({ id: z.string(), email: z.string(), created_at: z.string() }),
        key: ['email'],
        // NOT a compile error, deliberately: see the note on `renamedFrom` in
        // contracts. The planner is what catches it, which is why this case is
        // here rather than in the type-level suite.
        renamedFrom: { postal: 'email' },
      },
    });
    const plan = planMigration(wrong, first(base));
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') return;
    expect(plan.reasons.join(' ')).toMatch(/names the field it renamed TO/);
  });
});
