/**
 * The journal planner: nobody writes the version number, and nothing rewrites
 * history.
 */
import { describe, expect, it } from 'vitest';
import { z, defineEntities } from '@substrat-run/contracts';
import {
  emitTables,
  journalColumns,
  journalPrimaryKeys,
  journalUniques,
  planMigration,
  parseJournal,
  type Journal,
} from '../src/index.js';

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

describe('a key is a composite, and one added later cannot be applied in place', () => {
  it('emits one UNIQUE over all the key fields', () => {
    const composite = defineEntities({
      share: {
        table: 'app_shares',
        fields: z.object({ id: z.string(), list_id: z.string(), principal: z.string() }),
        key: ['list_id', 'principal'],
      },
    });
    const plan = planMigration(composite, empty);
    if (plan.kind !== 'append') throw new Error('expected an append');
    // One constraint, not two: "one share per person per list" — NOT "a list may
    // be shared once, ever" and "a person may receive one share, ever".
    expect(plan.entry.sql).toContain('UNIQUE (list_id, principal)');
    expect(plan.entry.sql.match(/UNIQUE/g)).toHaveLength(1);
  });

  it('refuses a key added to a table that already exists', () => {
    const before = defineEntities({
      share: {
        table: 'app_shares',
        fields: z.object({ id: z.string(), list_id: z.string(), principal: z.string() }),
      },
    });
    const after = defineEntities({
      share: {
        table: 'app_shares',
        fields: z.object({ id: z.string(), list_id: z.string(), principal: z.string() }),
        key: ['list_id', 'principal'],
      },
    });
    const plan = planMigration(after, first(before));
    // Reporting "up to date" over a missing uniqueness guarantee is how a
    // duplicate gets in — so this refuses rather than shrugs.
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') return;
    expect(plan.reasons[0]).toMatch(/cannot add a UNIQUE constraint/);
  });

  it('...while a key that shipped with the table is up to date', () => {
    const withKey = defineEntities({
      share: {
        table: 'app_shares',
        fields: z.object({ id: z.string(), list_id: z.string(), principal: z.string() }),
        key: ['list_id', 'principal'],
      },
    });
    expect(planMigration(withKey, first(withKey)).kind).toBe('up-to-date');
  });

  it('reads a composite constraint back out of a journal', () => {
    const u = journalUniques(
      'CREATE TABLE t (\n  a TEXT NOT NULL,\n  b TEXT NOT NULL,\n  UNIQUE (a, b)\n);',
    );
    expect([...(u.get('t') ?? [])]).toEqual(['a, b']);
  });
});

/**
 * #804 — the primary key, which the planner could not see at all.
 *
 * It compared columns and UNIQUE constraints. A table keyed differently than the
 * journal keyed it passed as "up to date", which is the same silence that let 15
 * of one production vertical's 63 tables emit with no primary key.
 */
describe('the primary key', () => {
  const keyed = defineEntities({
    budget: {
      table: 'app_budgets',
      fields: z.object({ customer_id: z.string(), year: z.number(), hours: z.string() }),
      primaryKey: ['customer_id', 'year'],
    },
  });

  it('is part of the CREATE for a new table', () => {
    const plan = planMigration(keyed, empty);
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    expect(plan.entry.sql).toContain('PRIMARY KEY (customer_id, year)');
  });

  it('round-trips — the journal it just wrote is up to date', () => {
    expect(planMigration(keyed, first(keyed)).kind).toBe('up-to-date');
  });

  it('refuses a key that moved, because SQLite cannot change one in place', () => {
    const widened = defineEntities({
      budget: {
        table: 'app_budgets',
        fields: z.object({ customer_id: z.string(), year: z.number(), hours: z.string() }),
        primaryKey: ['customer_id', 'year', 'hours'],
      },
    });
    const plan = planMigration(widened, first(keyed));
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') return;
    expect(plan.reasons.join('\n')).toContain(
      "'app_budgets' is keyed by (customer_id, year) in the journal and by (customer_id, year, hours) in the model",
    );
  });

  it('refuses a key over a table the journal built without one', () => {
    // A hand-written journal from before the model could express this. Adding
    // the key is a rebuild and a decision about the duplicate rows already in
    // there — not a diff.
    const keyless: Journal = {
      entries: [
        {
          version: '0001',
          slug: 'legacy',
          sql: 'CREATE TABLE app_budgets (\n  customer_id TEXT NOT NULL,\n  year INTEGER NOT NULL,\n  hours TEXT NOT NULL\n);',
        },
      ],
    };
    const plan = planMigration(keyed, keyless);
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') return;
    expect(plan.reasons.join('\n')).toContain("exists in the journal with NO primary key");
  });

  it('follows a rename rather than reading it as a moved key', () => {
    // SQLite rewrites the primary key when a column is renamed, so the reader
    // has to as well. Comparing untranslated would refuse the very change that
    // performs the rename.
    const renamed = defineEntities({
      budget: {
        table: 'app_budgets',
        fields: z.object({ client_id: z.string(), year: z.number(), hours: z.string() }),
        primaryKey: ['client_id', 'year'],
        renamedFrom: { client_id: 'customer_id' },
      },
    });
    const plan = planMigration(renamed, first(keyed));
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    expect(plan.entry.sql).toBe('ALTER TABLE app_budgets RENAME COLUMN customer_id TO client_id;');
  });

  it('sees an id-keyed table exactly as it did before', () => {
    expect(planMigration(base, first(base)).kind).toBe('up-to-date');
  });
});

describe('journalPrimaryKeys', () => {
  it('reads the inline spelling', () => {
    expect(
      journalPrimaryKeys('CREATE TABLE t (\n  id TEXT PRIMARY KEY NOT NULL,\n  a TEXT\n);').get('t'),
    ).toEqual(['id']);
  });

  it('reads the table-level spelling, in declaration order', () => {
    expect(
      journalPrimaryKeys(
        'CREATE TABLE t (\n  a TEXT NOT NULL,\n  b TEXT NOT NULL,\n  PRIMARY KEY (b, a)\n);',
      ).get('t'),
    ).toEqual(['b', 'a']);
  });

  it('distinguishes a table with no key from a table that does not exist', () => {
    const keys = journalPrimaryKeys('CREATE TABLE t (\n  a TEXT NOT NULL\n);');
    expect(keys.get('t')).toEqual([]);
    expect(keys.get('other')).toBeUndefined();
  });

  it('is not fooled by a PRIMARY KEY inside a multi-line CHECK', () => {
    expect(
      journalPrimaryKeys(
        "CREATE TABLE t (\n  id TEXT PRIMARY KEY NOT NULL,\n  note TEXT NOT NULL CHECK (\n    note <> 'PRIMARY KEY (a, b)'\n  )\n);",
      ).get('t'),
    ).toEqual(['id']);
  });

  it('follows a rebuild: create _new, copy, drop, rename onto the name', () => {
    const sql = [
      'CREATE TABLE t (\n  a TEXT NOT NULL\n);',
      'CREATE TABLE t_new (\n  a TEXT NOT NULL,\n  b TEXT NOT NULL,\n  PRIMARY KEY (a, b)\n);',
      'DROP TABLE t;',
      'ALTER TABLE t_new RENAME TO t;',
    ].join('\n');
    expect(journalPrimaryKeys(sql).get('t')).toEqual(['a', 'b']);
    expect(journalPrimaryKeys(sql).get('t_new')).toBeUndefined();
  });

  it('follows a renamed key column', () => {
    const sql = [
      'CREATE TABLE t (\n  a TEXT NOT NULL,\n  b TEXT NOT NULL,\n  PRIMARY KEY (a, b)\n);',
      'ALTER TABLE t RENAME COLUMN a TO c;',
    ].join('\n');
    expect(journalPrimaryKeys(sql).get('t')).toEqual(['c', 'b']);
  });
});

/**
 * #807 — the readers parsed LINES, not statements.
 *
 * Every case here is ordinary SQL that a real journal contains and the readers
 * disagreed with. The first four are the reporter's, measured against a
 * production vertical whose 63 entities produced 64 refusals, none of which was
 * the model being wrong. The rest turned up probing the same cause.
 *
 * A journal is under no obligation to format itself for a parser. Whitespace is
 * not semantics, and asking an adopter to reformat 38 shipped entries — history
 * that is never rewritten — to satisfy a reader is the wrong side of the trade.
 */
describe('#807 — a journal is read as SQL, not as lines', () => {
  const read = (sql: string) => ({
    columns: [...(journalColumns(sql).get('t') ?? [])],
    key: journalPrimaryKeys(sql).get('t'),
    uniques: [...(journalUniques(sql).get('t') ?? [])],
  });

  it('reads a table with several columns on one line', () => {
    // The reporter's case 1, and the one that cost 59 of the 64 refusals:
    // splitting the SAME table onto one column per line used to change the
    // answer, which is a reader disagreeing with itself about one schema.
    expect(read('CREATE TABLE t (\n  a TEXT NOT NULL, b TEXT NOT NULL UNIQUE, PRIMARY KEY (a, b)\n);')).toEqual({
      columns: ['a', 'b'],
      key: ['a', 'b'],
      uniques: ['b'],
    });
  });

  it('...and agrees with itself when the same table is written one column per line', () => {
    // The control: reformatting must not change a single answer.
    expect(read('CREATE TABLE t (\n  a TEXT NOT NULL,\n  b TEXT NOT NULL UNIQUE,\n  PRIMARY KEY (a, b)\n);')).toEqual(
      { columns: ['a', 'b'], key: ['a', 'b'], uniques: ['b'] },
    );
  });

  it('reads all three spellings of a uniqueness rule', () => {
    // Table-level was the only one read. Column-level and CREATE UNIQUE INDEX
    // are the same constraint by a different route, and both appear in real
    // journals — they were the other 4 refusals, the ones no reformatting fixes.
    expect(journalUniques('CREATE TABLE t (\n  a TEXT NOT NULL,\n  b TEXT NOT NULL,\n  UNIQUE (b)\n);').get('t')).toEqual(
      new Set(['b']),
    );
    expect(journalUniques('CREATE TABLE t (\n  a TEXT NOT NULL,\n  b TEXT NOT NULL UNIQUE\n);').get('t')).toEqual(
      new Set(['b']),
    );
    expect(
      journalUniques(
        'CREATE TABLE t (\n  a TEXT PRIMARY KEY NOT NULL,\n  b TEXT NOT NULL\n);\nCREATE UNIQUE INDEX ux_t_b ON t(b);',
      ).get('t'),
    ).toEqual(new Set(['b']));
  });

  it('does NOT read a partial unique index as a constraint', () => {
    // `… WHERE deleted_at IS NULL` constrains a subset of the rows. Reading it
    // as a whole-table key would claim a guarantee the database does not make —
    // and the planner would then report "up to date" over a missing one.
    const sql =
      'CREATE TABLE t (\n  a TEXT PRIMARY KEY NOT NULL,\n  b TEXT\n);\n' +
      'CREATE UNIQUE INDEX ux ON t(b) WHERE deleted_at IS NULL;';
    expect(journalUniques(sql).get('t')).toEqual(new Set());
  });

  it('sees a CREATE TABLE written entirely on one line', () => {
    // The worst of the family: an invisible table is not a refusal. The planner
    // read it as new and emitted a SECOND `CREATE TABLE` for a table that
    // already existed — a wrong migration, generated silently.
    expect(read('CREATE TABLE t (a TEXT PRIMARY KEY NOT NULL, b TEXT NOT NULL);')).toEqual({
      columns: ['a', 'b'],
      key: ['a'],
      uniques: [],
    });
  });

  it('sees a table with a STRICT or WITHOUT ROWID suffix', () => {
    // Invisible the same way, because the body matcher required `);` to end a
    // line. Both are ordinary SQLite that a journal is entitled to use.
    for (const suffix of ['STRICT', 'WITHOUT ROWID']) {
      expect(read(`CREATE TABLE t (\n  a TEXT NOT NULL,\n  b TEXT NOT NULL,\n  PRIMARY KEY (a, b)\n) ${suffix};`)).toEqual(
        { columns: ['a', 'b'], key: ['a', 'b'], uniques: [] },
      );
    }
  });

  it('reads a primary key whose column list wraps over lines', () => {
    expect(journalPrimaryKeys('CREATE TABLE t (\n  a TEXT NOT NULL,\n  b TEXT NOT NULL,\n  PRIMARY KEY (\n    a,\n    b\n  )\n);').get('t')).toEqual(['a', 'b']);
  });

  it('reads a quoted identifier as the column it declares', () => {
    expect(read('CREATE TABLE t (\n  "order" TEXT PRIMARY KEY NOT NULL,\n  b TEXT NOT NULL\n);')).toEqual({
      columns: ['order', 'b'],
      key: ['order'],
      uniques: [],
    });
  });

  it('does not read a constraint out of a comment', () => {
    // The inverse error, and the dangerous direction: believing a uniqueness
    // guarantee that nothing enforces is how a duplicate gets in.
    const sql =
      'CREATE TABLE t (\n  a TEXT PRIMARY KEY NOT NULL,\n' +
      '  -- b is UNIQUE (b) per the spec, enforced elsewhere\n  b TEXT NOT NULL\n);';
    expect(journalUniques(sql).get('t')).toEqual(new Set());
    expect(journalColumns(sql).get('t')).toEqual(new Set(['a', 'b']));
  });

  it('does not read syntax out of a string literal or a CHECK body', () => {
    const sql =
      "CREATE TABLE t (\n  a TEXT PRIMARY KEY NOT NULL,\n" +
      "  b TEXT NOT NULL DEFAULT 'x, y' CHECK (b <> 'UNIQUE'),\n  c TEXT NOT NULL\n);";
    expect(journalColumns(sql).get('t')).toEqual(new Set(['a', 'b', 'c']));
    expect(journalUniques(sql).get('t')).toEqual(new Set());
  });

  it('plans nothing new for a journal reformatted onto one line', () => {
    // The end-to-end statement of the defect, and the one an adopter feels:
    // formatting must not change a plan. Built by collapsing the EMITTER's own
    // journal rather than by hand, so the fixture cannot drift from what
    // `emitTables` actually produces.
    const shipped = first(base);
    const collapsed: Journal = {
      entries: shipped.entries.map((e) => ({ ...e, sql: e.sql.replace(/\s+/g, ' ') })),
    };
    expect(collapsed.entries[0]?.sql).not.toContain('\n');
    expect(planMigration(base, shipped).kind).toBe('up-to-date');
    expect(planMigration(base, collapsed).kind).toBe('up-to-date');
  });
});
