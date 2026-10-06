import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { errorCodeOf, permissionKey } from '@substrat-run/contracts';
import {
  assertNoReservedColumnWrite,
  entityStateMigrations,
  entityStatePlans,
  entityStateWhere,
  listIndexDdl,
  listIndexPlans,
  moduleMigrations,
  addStatePlans,
  createTrashedReads,
  assertEntityStateColumns,
  afterRuntimeDdl,
  derivesAnything,
  repairDerivedObjects,
  StateColumnLost,
  assertNoStatefulDdl,
  changesSchema,
  cursorOf,
  listQuery,
} from '../src/index.js';

/**
 * The declaration-to-DDL half of archive and trash (#119), and the column guard's grammar.
 * The behaviour — that the DDL runs and the planner uses it — is the contract suite's, on
 * both adapters; this pins the refusals and the exact spelling the partial index depends on.
 */
const ARCHIVE = permissionKey.parse('doc:archive');
const TRASH = permissionKey.parse('doc:trash');
const both = { entityType: 'doc', archivePermission: ARCHIVE, trashPermission: TRASH, table: 'docs', idColumn: 'id' };

describe('entityStatePlans: refuses', () => {
  it('a declaration with no table — the registry is what supplies it', () => {
    expect(() => entityStatePlans('@m', [{ entityType: 'doc', archivePermission: ARCHIVE }])).toThrow(/no table/);
  });
  it('a declaration with neither key', () => {
    expect(() => entityStatePlans('@m', [{ entityType: 'doc', table: 'docs' }])).toThrow(/neither/);
  });
  it('an entity declared twice in one module, or by two modules', () => {
    expect(() => entityStatePlans('@m', [both, both])).toThrow(/twice/);
    const keys = [{ key: 'doc:archive' }, { key: 'doc:trash' }];
    const plans = new Map();
    addStatePlans(plans, '@a', [both], keys);
    expect(() => addStatePlans(plans, '@b', [both], keys)).toThrow(/both '@a' and '@b'/);
  });
  it('a table name that is not a plain identifier', () => {
    expect(() => entityStatePlans('@m', [{ ...both, table: 'docs; DROP TABLE x' }])).toThrow(/identifier/);
  });
});

describe('entityStateMigrations', () => {
  it('adds one column per declared state, each its own version, run once', () => {
    const migrations = entityStateMigrations('@m', [both]);
    expect(migrations.slice(0, 2)).toEqual([
      { version: 'state/doc:archive', sql: 'ALTER TABLE docs ADD COLUMN _substrat_archived_at TEXT;' },
      { version: 'state/doc:trash', sql: 'ALTER TABLE docs ADD COLUMN _substrat_trashed_at TEXT;' },
    ]);
    // Then the trigger, after the columns it names, guarding both.
    expect(migrations[2]!.version).toBe('state/doc:guard:archive+trash');
    expect(migrations[2]!.sql).toContain(
      'BEFORE INSERT ON docs WHEN NEW._substrat_archived_at IS NOT NULL OR NEW._substrat_trashed_at IS NOT NULL',
    );
    expect(migrations[2]!.sql).toContain('BEFORE UPDATE OF _substrat_archived_at, _substrat_trashed_at ON docs');
    expect(migrations[2]!.sql).toContain("FROM _substrat_state_moves WHERE entity_type = 'doc' AND entity_id = OLD.id");
    expect(entityStateMigrations('@m', [{ ...both, trashPermission: undefined }]).map((m) => m.version)).toEqual([
      'state/doc:archive',
      'state/doc:guard:archive',
    ]);
  });

  it('runs after the authored and search DDL and before the list indexes that name the columns', () => {
    const versions = moduleMigrations({
      manifest: {
        id: '@m',
        searchables: [{ entityType: 'doc', fields: ['title'], table: 'docs', idColumn: 'id' }],
        lists: [{ entityType: 'doc', sortable: ['title'], table: 'docs', idColumn: 'id' }],
        entityStates: [both],
      },
      migrations: [{ version: '0001', sql: 'CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT)' }],
    }).map((m) => m.version.split(/[/:]/)[0]);
    expect(versions).toEqual(['0001', 'search', 'state', 'state', 'state', 'list']);
  });
});

describe('the view predicate', () => {
  const cols = { archive: true, trash: true };
  it('is spelled the same in the index and the query — the partial index depends on it', () => {
    const [plan] = listIndexPlans('@m', [{ entityType: 'doc', sortable: ['title'], table: 'docs', idColumn: 'id' }], [both]);
    const ddl = listIndexDdl(plan!);
    for (const view of ['active', 'archived', 'trashed'] as const) {
      expect(ddl).toContain(`WHERE ${entityStateWhere('doc', cols, view)};`);
    }
    expect(entityStateWhere('doc', cols, 'active')).toBe('_substrat_archived_at IS NULL AND _substrat_trashed_at IS NULL');
    expect(entityStateWhere('doc', cols, 'archived')).toBe('_substrat_archived_at IS NOT NULL AND _substrat_trashed_at IS NULL');
    expect(entityStateWhere('doc', cols, 'trashed')).toBe('_substrat_trashed_at IS NOT NULL');
    expect(entityStateWhere('doc', { archive: true, trash: false }, 'active', 'src')).toBe('src._substrat_archived_at IS NULL');
  });

  it('refuses a view the entity does not declare, rather than answering it empty', () => {
    const err = (() => {
      try {
        entityStateWhere('doc', { archive: true, trash: false }, 'trashed');
      } catch (e) {
        return e;
      }
    })();
    expect(errorCodeOf(err)).toBe('validation_failed');
  });

  it('leaves an entity with no state exactly as it was — no partial indexes, no new versions', () => {
    const [plan] = listIndexPlans('@m', [{ entityType: 'doc', sortable: ['title'], table: 'docs', idColumn: 'id' }]);
    expect(listIndexDdl(plan!)).not.toContain('WHERE');
  });
});

describe('assertNoReservedColumnWrite', () => {
  const refused = [
    'UPDATE docs SET _substrat_trashed_at = NULL',
    'UPDATE docs SET title = ?, _substrat_archived_at = ? WHERE id = ?',
    'UPDATE OR REPLACE docs SET _substrat_archived_at = NULL',
    'UPDATE docs SET title = (SELECT t FROM x WHERE y = 1), _substrat_trashed_at = NULL',
    'UPDATE docs SET (title, _substrat_trashed_at) = (?, ?)',
    'UPDATE docs SET "_substrat_trashed_at" = NULL',
    'UPDATE docs SET _SUBSTRAT_TRASHED_AT = NULL',
    'INSERT INTO docs (id, _substrat_archived_at) VALUES (?, ?)',
    'INSERT OR IGNORE INTO docs AS d (id, _substrat_trashed_at) VALUES (?, ?)',
    'REPLACE INTO docs (id, _substrat_trashed_at) VALUES (?, ?)',
    'INSERT INTO docs (id) VALUES (?) ON CONFLICT (id) DO UPDATE SET _substrat_trashed_at = NULL',
    'ALTER TABLE docs ADD COLUMN _substrat_archived_at TEXT',
    'ALTER TABLE docs DROP COLUMN _substrat_trashed_at',
    'ALTER TABLE docs RENAME COLUMN _substrat_trashed_at TO gone',
    'CREATE TRIGGER t AFTER INSERT ON docs BEGIN UPDATE docs SET _substrat_trashed_at = NULL; END',
    // Chained after a legitimate statement.
    'UPDATE docs SET title = 1; UPDATE docs SET _substrat_trashed_at = NULL',
  ];
  for (const sql of refused) {
    it(`refuses: ${sql}`, () => {
      expect(() => assertNoReservedColumnWrite(sql)).toThrow(/platform's column/);
    });
  }

  const allowed = [
    'SELECT _substrat_archived_at FROM docs',
    'UPDATE docs SET title = ? WHERE _substrat_trashed_at IS NULL',
    'UPDATE docs SET title = (SELECT title FROM docs WHERE _substrat_archived_at IS NOT NULL) WHERE id = ?',
    'UPDATE docs SET title = _substrat_archived_at',
    'INSERT INTO docs (id, title) VALUES (?, ?)',
    'INSERT INTO docs SELECT id, title FROM other WHERE _substrat_trashed_at IS NULL',
    'INSERT INTO docs (id) VALUES (?) ON CONFLICT (id) DO UPDATE SET title = excluded.title',
    'ALTER TABLE docs ADD COLUMN extra TEXT',
    // A string that merely contains the name is data, not a column.
    "UPDATE docs SET title = '_substrat_trashed_at = NULL'",
    "INSERT INTO docs (id, title) VALUES (?, '_substrat_archived_at')",
  ];
  for (const sql of allowed) {
    it(`allows: ${sql}`, () => {
      expect(() => assertNoReservedColumnWrite(sql)).not.toThrow();
    });
  }
});

describe('addStatePlans', () => {
  it('refuses a key the module does not declare, and admits one it does', async () => {
    expect(() => addStatePlans(new Map(), '@m', [both], [{ key: 'doc:archive' }])).toThrow(/does not declare/);
    const plans = new Map();
    addStatePlans(plans, '@m', [both], [{ key: 'doc:archive' }, { key: 'doc:trash' }]);
    expect(plans.get('doc')).toMatchObject({ archivePermission: 'doc:archive', trashPermission: 'doc:trash' });
  });
});

describe('keywords that are legal identifiers do not switch the scanners (#2070 r5)', () => {
  it('reads END as a column, not the end of a SET list', () => {
    for (const sql of [
      'UPDATE docs SET end = 1, _substrat_trashed_at = NULL',
      'UPDATE docs SET a = end, _substrat_trashed_at = NULL',
      'UPDATE docs SET a = CASE WHEN end THEN 1 ELSE 2 END, _substrat_trashed_at = NULL',
      'CREATE TRIGGER t AFTER INSERT ON mine BEGIN UPDATE docs SET end = 1, _substrat_archived_at = NULL; END',
    ]) {
      expect(() => assertNoReservedColumnWrite(sql), sql).toThrow(/platform's column/);
    }
    expect(() => assertNoReservedColumnWrite('UPDATE docs SET end = 1, begin = end')).not.toThrow();
  });

  it('finds the INSERT target by the grammar, even a table named like a modifier', () => {
    for (const table of ['replace', 'ignore', 'abort', 'rollback', 'fail']) {
      const stateful = new Set([table]);
      expect(() => assertNoReservedColumnWrite(`INSERT INTO ${table} VALUES (1, NULL, '2026')`, stateful), table).toThrow(
        /cannot write/,
      );
      expect(() => assertNoReservedColumnWrite(`INSERT OR IGNORE INTO ${table} VALUES (1)`, stateful), table).toThrow(/cannot write/);
      expect(() => assertNoReservedColumnWrite(`INSERT INTO ${table} (id) VALUES (1)`, stateful), table).not.toThrow();
    }
  });
});

describe('assertNoReservedColumnWrite on a stateful table', () => {
  const stateful = new Set(['docs']);
  const refused = [
    "INSERT INTO docs VALUES ('x', 't', '2026', NULL)",
    "INSERT INTO DOCS VALUES ('x', 't', NULL, '2026')",
    "INSERT INTO main.docs VALUES ('x', 't', NULL, NULL)",
    "INSERT INTO docs SELECT id, title, archived, trashed FROM other",
    "INSERT OR IGNORE INTO docs VALUES ('x', 't', NULL, NULL)",
    "REPLACE INTO docs (id, title) VALUES ('x', 't')",
    "INSERT OR REPLACE INTO docs (id, title) VALUES ('x', 't')",
    "REPLACE INTO docs VALUES ('x', 't', NULL, NULL)",
  ];
  for (const sql of refused) {
    it(`refuses: ${sql}`, () => {
      expect(() => assertNoReservedColumnWrite(sql, stateful)).toThrow(/cannot write/);
      // …and only because the table is stateful: the same text into another table passes.
      expect(() => assertNoReservedColumnWrite(sql.replace(/docs/i, 'other_t'), stateful)).not.toThrow();
    });
  }
  const allowed = [
    "INSERT INTO docs (id, title) VALUES ('x', 't')",
    "INSERT INTO docs (id, title) SELECT id, title FROM other",
    'INSERT INTO docs DEFAULT VALUES',
    "INSERT INTO docs (id, title) VALUES ('x', 't') ON CONFLICT (id) DO UPDATE SET title = excluded.title",
    "SELECT replace(title, 'a', 'b') FROM docs",
    "UPDATE docs SET title = replace(title, 'a', 'b')",
  ];
  for (const sql of allowed) {
    it(`allows: ${sql}`, () => {
      expect(() => assertNoReservedColumnWrite(sql, stateful)).not.toThrow();
    });
  }
});

describe('ctx.pageTrashed walks past refused rows without handing out their positions', () => {
  const setup = (rows: { id: string; title: string }[]) => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT, _substrat_archived_at TEXT, _substrat_trashed_at TEXT)');
    for (const r of rows) db.prepare("INSERT INTO docs VALUES (?, ?, NULL, '2026')").run(r.id, r.title);
    const statePlans = new Map();
    addStatePlans(statePlans, '@m', [both], [{ key: 'doc:archive' }, { key: 'doc:trash' }]);
    const [plan] = listIndexPlans('@m', [{ entityType: 'doc', sortable: ['title'], table: 'docs', idColumn: 'id' }], [both]);
    return {
      reads: (visible: ReadonlySet<string>, scanBudget?: number) =>
        createTrashedReads({
          query: (sql, params) => db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
          listPlans: new Map([['doc', plan!]]),
          searchPlans: new Map(),
          statePlans,
          check: async (_key, entity) =>
            (visible.has(entity!.entityId) ? { allowed: true } : { allowed: false }) as never,
          ...(scanBudget !== undefined ? { scanBudget } : {}),
        }),
    };
  };
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, title: `t${i}` }));

  it('fills the page from visible rows only, and continues from the last one it returned', async () => {
    const { reads } = setup(ten);
    const r = reads(new Set(['d2', 'd7']));
    const first = await r.pageTrashed('doc', { limit: 1 });
    expect(first.entries.map((e) => (e as { id: string }).id)).toEqual(['d2']);
    const second = await r.pageTrashed('doc', { limit: 1, cursor: first.nextCursor! });
    expect(second.entries.map((e) => (e as { id: string }).id)).toEqual(['d7']);
    const third = await r.pageTrashed('doc', { limit: 1, cursor: second.nextCursor! });
    expect(third).toEqual({ entries: [], nextCursor: null });
  });

  it('answers a short page the same at the end and at the budget: what it found, and no cursor', async () => {
    // The visible prefix [d0], either side of a budget of 4: a bin of 3 ends inside the budget,
    // bins of 4 and 5 spend it. A cursor on any of them would tell which.
    const page = (size: number) => setup(ten.slice(0, size)).reads(new Set(['d0']), 4).pageTrashed('doc', { limit: 5 });
    const expected = { entries: [expect.objectContaining({ id: 'd0' })], nextCursor: null };
    for (const size of [3, 4, 5]) expect(await page(size), `bin of ${size}`).toEqual(expected);
  });

  it('answers a budget spent on refused rows exactly as it answers the end of the bin', async () => {
    // Either side of the budget, for a caller who may see none of it: the same response, so
    // nothing tells them how many rows they could not see.
    const below = await setup(ten.slice(0, 3)).reads(new Set(), 4).pageTrashed('doc', { limit: 5 });
    const at = await setup(ten.slice(0, 4)).reads(new Set(), 4).pageTrashed('doc', { limit: 5 });
    const past = await setup(ten).reads(new Set(), 4).pageTrashed('doc', { limit: 5 });
    expect(below).toEqual({ entries: [], nextCursor: null });
    expect(at).toEqual(below);
    expect(past).toEqual(below);
  });
});

describe('a cursor names its view (#119)', () => {
  const [plan] = listIndexPlans('@m', [{ entityType: 'doc', sortable: ['title'], table: 'docs', idColumn: 'id' }], [both]);
  const legacy = 'beta|01ARZ3NDEKTSV4RRFFQ69G5FAV';

  it('continues a legacy cursor only in the active rows it was minted over', () => {
    expect(() => listQuery(plan!, { limit: 5, cursor: legacy })).not.toThrow();
    expect(() => listQuery(plan!, { limit: 5, cursor: legacy, view: 'archived' })).toThrow(/predates|restart/);
  });

  it('leaves the view out of an active cursor, so one minted before #119 reads the same', () => {
    const row = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', title: 'beta' };
    expect(cursorOf(row, 'title', 'id', 'asc')).toBe(cursorOf(row, 'title', 'id', 'asc', 'active'));
    expect(cursorOf(row, 'title', 'id', 'asc', 'archived')).not.toBe(cursorOf(row, 'title', 'id', 'asc'));
  });
});

describe('runtime DDL on a stateful table (#119, Codex r3)', () => {
  const stateful = new Set(['docs']);
  const refused = [
    'ALTER TABLE docs RENAME TO x',
    'ALTER TABLE "DOCS" RENAME TO x',
    'ALTER TABLE main.docs RENAME COLUMN a TO b',
    'ALTER TABLE docs DROP COLUMN a',
    'ALTER TABLE other RENAME TO docs',
    'DROP TABLE docs',
    'DROP TABLE IF EXISTS temp.docs',
    'CREATE TABLE docs AS SELECT 1',
    'CREATE TEMP TABLE docs (id TEXT)',
    'CREATE TEMPORARY VIEW IF NOT EXISTS docs AS SELECT 1',
    'CREATE TABLE temp.docs (id TEXT)',
    'CREATE TRIGGER t AFTER INSERT ON docs BEGIN SELECT 1; END',
    'CREATE TEMP TRIGGER t BEFORE DELETE ON main.docs BEGIN SELECT 1; END',
    'DROP TRIGGER _substrat_state_docs_born',
    'DROP INDEX IF EXISTS _substrat_list_m_doc_title',
    "ATTACH DATABASE 'x.db' AS x",
    'DETACH DATABASE x',
    'CREATE TABLE ok (id TEXT); ALTER TABLE docs RENAME TO x',
    // CodeRabbit on #2070: `begin` as an identifier must not open a "trigger body" that hides
    // the statements after it.
    'SELECT 1 AS begin; ALTER TABLE docs DROP COLUMN a',
    'SELECT 1 AS begin; CREATE TRIGGER t BEFORE UPDATE OF _substrat_trashed_at ON docs BEGIN SELECT RAISE(IGNORE); END',
    // Keywords SQLite accepts as identifiers, in the positions that switch the splitter's mode.
    'CREATE TRIGGER begin AFTER INSERT ON mine BEGIN UPDATE mine SET end = 1; END; ALTER TABLE docs RENAME TO x',
    'SELECT end FROM mine; DROP TABLE docs',
    'CREATE TABLE temp.docs (id TEXT)',
  ];
  for (const sql of refused) {
    it(`refuses: ${sql}`, () => expect(() => assertNoStatefulDdl(sql, stateful)).toThrow(/cannot/));
  }
  const allowed = [
    'CREATE TABLE IF NOT EXISTS mine (id TEXT)',
    'ALTER TABLE mine RENAME TO yours',
    'ALTER TABLE docs ADD COLUMN extra TEXT',
    'CREATE INDEX docs_owner ON docs (owner)',
    'DROP TABLE mine',
    'CREATE TRIGGER t AFTER INSERT ON mine BEGIN UPDATE mine SET a = 1; END',
    'CREATE VIEW v AS SELECT * FROM docs',
  ];
  for (const sql of allowed) {
    it(`allows: ${sql}`, () => expect(() => assertNoStatefulDdl(sql, stateful)).not.toThrow());
  }
  it('knows a schema change from DML, statement by statement', () => {
    expect(changesSchema('CREATE TABLE x (id TEXT)')).toBe(true);
    expect(changesSchema("UPDATE t SET a = 'CREATE'; DROP TABLE y")).toBe(true);
    expect(changesSchema("INSERT INTO t VALUES ('ALTER TABLE x')")).toBe(false);
    expect(changesSchema('SELECT 1')).toBe(false);
  });
});

/**
 * A `docs` table carrying everything its declaration derives, with a journal of the migrations
 * that derived it — the journal is what says which objects the table is owed (#2090).
 */
const derivedFixture = (journaled: (version: string) => boolean = () => true) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE _substrat_migrations (module_id TEXT, version TEXT)');
  const decl = { id: '@m', lists: [{ entityType: 'doc', sortable: ['title'], table: 'docs', idColumn: 'id' }], entityStates: [both] };
  for (const m of moduleMigrations({ manifest: decl })) {
    db.exec(m.sql);
    if (journaled(m.version)) db.prepare('INSERT INTO _substrat_migrations VALUES (?, ?)').run('@m', m.version);
  }
  const sql = {
    query: (q: string, p: readonly unknown[] = []) => db.prepare(q).all(...(p as never[])) as never[],
    exec: () => ({ changes: 0 }),
  } as never;
  const state = new Map();
  addStatePlans(state, '@m', [both], [{ key: 'doc:archive' }, { key: 'doc:trash' }]);
  const plans = { state, lists: new Map(listIndexPlans('@m', decl.lists, [both]).map((p) => [p.entityType, p])), search: new Map() };
  /** The kernel-prefixed triggers and indexes, by name. */
  const derived = () =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type <> 'table' AND name LIKE '\\_substrat\\_%' ESCAPE '\\' ORDER BY name`).all() as { name: string }[]).map(
      (r) => r.name,
    );
  /** Every kernel-prefixed trigger and index, name → its stored CREATE statement. */
  const definitions = () =>
    Object.fromEntries(
      (db.prepare(`SELECT name, sql FROM sqlite_master WHERE type <> 'table' AND name LIKE '\\_substrat\\_%' ESCAPE '\\'`).all() as {
        name: string;
        sql: string;
      }[]).map((r) => [r.name, r.sql]),
    );
  return { db, sql, plans, derived, definitions, check: () => afterRuntimeDdl(sql, (ddl) => db.exec(ddl), plans) };
};

describe('afterRuntimeDdl', () => {
  it('is wanted on any scope that derives anything — a search index alone included', () => {
    const none = { state: new Map(), lists: new Map(), search: new Map() };
    expect(derivesAnything(none)).toBe(false);
    expect(derivesAnything({ ...none, search: new Map([['doc', {} as never]]) })).toBe(true);
    expect(derivesAnything({ ...none, lists: new Map([['doc', {} as never]]) })).toBe(true);
    expect(derivesAnything({ ...none, state: new Map([['doc', {} as never]]) })).toBe(true);
  });
  const build = () => derivedFixture();
  it('changes nothing on a table carrying everything the kernel derived', () => {
    const { definitions, check } = build();
    const before = definitions();
    check();
    expect(definitions()).toEqual(before);
  });
  for (const [what, ddl] of [
    ['born trigger', 'DROP TRIGGER _substrat_state_docs_born'],
    ['moved trigger', 'DROP TRIGGER _substrat_state_docs_moved'],
    ['list index', 'DROP INDEX _substrat_list_m_doc_title_archived'],
  ] as const) {
    it(`puts back its ${what}`, () => {
      const { db, definitions, check } = build();
      const before = definitions();
      db.exec(ddl);
      check();
      expect(definitions()).toEqual(before);
    });
  }
  it('fails closed without a state column — it cannot be derived again', () => {
    const { db, check, derived } = build();
    // SQLite will not drop a column a trigger or partial index names, so those go first.
    for (const name of derived()) db.exec(`DROP ${name.startsWith('_substrat_state_') ? 'TRIGGER' : 'INDEX'} ${name}`);
    db.exec('ALTER TABLE docs DROP COLUMN _substrat_trashed_at');
    expect(check).toThrow(/runtime DDL left 'docs' without _substrat_trashed_at/);
  });
});

describe('repairDerivedObjects / assertEntityStateColumns (#2090)', () => {
  const build = derivedFixture;
  const rebuild = 'CREATE TABLE d2 AS SELECT * FROM docs; DROP TABLE docs; ALTER TABLE d2 RENAME TO docs;';

  it('puts back what a create-copy-rename rebuild dropped', () => {
    const { db, sql, plans, derived } = build();
    const before = derived();
    expect(before).toHaveLength(5);
    db.exec(rebuild);
    expect(derived()).toEqual([]);
    repairDerivedObjects(sql, (ddl) => db.exec(ddl), plans, { after: 'migration x' });
    expect(derived()).toEqual(before);
  });

  it('owes a table only what its journal says was derived', () => {
    // The trash column and everything after it have not run yet: mid-upgrade, not broken.
    const { db, sql, plans, derived } = build((v) => v === 'state/doc:archive');
    for (const name of derived()) db.exec(`DROP ${name.startsWith('_substrat_state_') ? 'TRIGGER' : 'INDEX'} ${name}`);
    db.exec('ALTER TABLE docs DROP COLUMN _substrat_trashed_at');
    expect(() => assertEntityStateColumns(sql, plans, 'migration x')).not.toThrow();
    repairDerivedObjects(
      sql,
      () => {
        throw new Error('nothing is owed');
      },
      plans,
      { after: 'migration x' },
    );
    // The journaled column is owed, and its loss fails closed.
    db.exec('ALTER TABLE docs DROP COLUMN _substrat_archived_at');
    expect(() => assertEntityStateColumns(sql, plans, 'migration x')).toThrow(/migration x left 'docs' without _substrat_archived_at/);
  });

  it('derives nothing onto a table missing a state column it is owed, and names the migration that added it', () => {
    const { db, sql, plans } = build();
    db.exec('CREATE TABLE d2 AS SELECT id, title, _substrat_archived_at FROM docs; DROP TABLE docs; ALTER TABLE d2 RENAME TO docs;');
    const ran: string[] = [];
    const err = (() => {
      try {
        repairDerivedObjects(sql, (ddl) => ran.push(ddl), plans, { after: 'migration x' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(StateColumnLost);
    expect((err as StateColumnLost).migration).toBe('@m@state/doc:trash');
    expect(String((err as Error).message)).toMatch(/migration x left 'docs' without _substrat_trashed_at/);
    expect(ran).toEqual([]);
    expect(() => assertEntityStateColumns(sql, plans, 'migration x')).toThrow(/without _substrat_trashed_at/);
  });

  it('skips a table a restored dump did not carry, and still refuses one it carried without its column', () => {
    const { db, sql, plans } = build();
    db.exec('DROP TABLE docs');
    expect(() => repairDerivedObjects(sql, () => undefined, plans, { after: 'the dump', absentTable: 'skip' })).not.toThrow();
    expect(() => repairDerivedObjects(sql, () => undefined, plans, { after: 'the dump' })).toThrow(/without its table/);
    db.exec('CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT, _substrat_archived_at TEXT)');
    expect(() => repairDerivedObjects(sql, () => undefined, plans, { after: 'the dump', absentTable: 'skip' })).toThrow(
      /the dump left 'docs' without _substrat_trashed_at/,
    );
  });

  it('compares the text exactly: a guard keyed on another spelling of the entity type is re-created (Codex r2 on #2091)', () => {
    // Two spaces in the entity type: a whitespace-folding comparison would take the one-space
    // spelling for the same guard, which checks another authorization row.
    const spaced = { ...both, entityType: 'doc  x' };
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT)');
    db.exec('CREATE TABLE _substrat_migrations (module_id TEXT, version TEXT)');
    for (const m of moduleMigrations({ manifest: { id: '@m', entityStates: [spaced] } })) {
      db.exec(m.sql);
      db.prepare('INSERT INTO _substrat_migrations VALUES (?, ?)').run('@m', m.version);
    }
    const sql = {
      query: (q: string, p: readonly unknown[] = []) => db.prepare(q).all(...(p as never[])) as never[],
      exec: () => ({ changes: 0 }),
    } as never;
    const state = new Map();
    addStatePlans(state, '@m', [spaced], [{ key: 'doc:archive' }, { key: 'doc:trash' }]);
    const plans = { state, lists: new Map(), search: new Map() };
    const stored = () =>
      (db.prepare(`SELECT sql FROM sqlite_master WHERE name = '_substrat_state_docs_moved'`).get() as { sql: string }).sql;
    const emitted = stored();
    expect(emitted).toContain("entity_type = 'doc  x'");
    db.exec(`DROP TRIGGER _substrat_state_docs_moved; ${emitted.replace("'doc  x'", "'doc x'")}`);
    expect(stored()).toContain("entity_type = 'doc x'");
    const ran: string[] = [];
    repairDerivedObjects(sql, (ddl) => (ran.push(ddl), db.exec(ddl)), plans, { after: 'x' });
    expect(ran).toHaveLength(1);
    expect(stored()).toBe(emitted);
  });

  it('judges a derived object by its definition: a same-named index on other columns is re-created, a matching one is not', () => {
    const { db, sql, plans } = build();
    const ran: string[] = [];
    repairDerivedObjects(sql, (ddl) => ran.push(ddl), plans, { after: 'x' });
    expect(ran).toEqual([]);
    db.exec('DROP INDEX _substrat_list_m_doc_title_archived; CREATE INDEX _substrat_list_m_doc_title_archived ON docs (id)');
    repairDerivedObjects(sql, (ddl) => ran.push(ddl), plans, { after: 'x' });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatch(/CREATE INDEX _substrat_list_m_doc_title_archived ON docs \(title, id\) WHERE/);
  });
});
