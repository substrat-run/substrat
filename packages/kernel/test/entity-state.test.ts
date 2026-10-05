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
    expect(migrations[2]!.version).toBe('state/doc:born:archive+trash');
    expect(migrations[2]!.sql).toContain(
      'BEFORE INSERT ON docs WHEN NEW._substrat_archived_at IS NOT NULL OR NEW._substrat_trashed_at IS NOT NULL',
    );
    expect(entityStateMigrations('@m', [{ ...both, trashPermission: undefined }]).map((m) => m.version)).toEqual([
      'state/doc:archive',
      'state/doc:born:archive',
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

  it('within the scan budget, returns what it found and continues from it', async () => {
    const { reads } = setup(ten);
    // Budget 4: the first call reads d0–d3 and finds d1; the next, continued from d1, reads
    // d2–d5 and finds d4. Each returned cursor is a visible row's.
    const r = reads(new Set(['d1', 'd4']), 4);
    const first = await r.pageTrashed('doc', { limit: 5 });
    expect(first.entries.map((e) => (e as { id: string }).id)).toEqual(['d1']);
    expect(first.nextCursor).not.toBeNull();
    const rest = await r.pageTrashed('doc', { limit: 5, cursor: first.nextCursor! });
    expect(rest.entries.map((e) => (e as { id: string }).id)).toEqual(['d4']);
  });

  it('refuses rather than lie or leak when the budget runs out on refused rows alone', async () => {
    const { reads } = setup(ten);
    await expect(reads(new Set(['d9']), 4).pageTrashed('doc', { limit: 5 })).rejects.toMatchObject({
      message: expect.stringMatching(/without finding one this caller may see/),
    });
    // The twin: the whole bin inside the budget is answered, and the end is null.
    expect(await reads(new Set(), 50).pageTrashed('doc', { limit: 5 })).toEqual({ entries: [], nextCursor: null });
  });
});
