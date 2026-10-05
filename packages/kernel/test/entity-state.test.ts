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
  statePlansByEntityType,
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
    expect(() =>
      statePlansByEntityType([
        { id: '@a', entityStates: [both] },
        { id: '@b', entityStates: [both] },
      ]),
    ).toThrow(/both '@a' and '@b'/);
  });
  it('a table name that is not a plain identifier', () => {
    expect(() => entityStatePlans('@m', [{ ...both, table: 'docs; DROP TABLE x' }])).toThrow(/identifier/);
  });
});

describe('entityStateMigrations', () => {
  it('adds one column per declared state, each its own version, run once', () => {
    expect(entityStateMigrations('@m', [both])).toEqual([
      { version: 'state/doc:archive', sql: 'ALTER TABLE docs ADD COLUMN _substrat_archived_at TEXT;' },
      { version: 'state/doc:trash', sql: 'ALTER TABLE docs ADD COLUMN _substrat_trashed_at TEXT;' },
    ]);
    expect(entityStateMigrations('@m', [{ ...both, trashPermission: undefined }]).map((m) => m.version)).toEqual([
      'state/doc:archive',
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
    expect(versions).toEqual(['0001', 'search', 'state', 'state', 'list']);
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
    const { addStatePlans } = await import('../src/index.js');
    expect(() => addStatePlans(new Map(), '@m', [both], [{ key: 'doc:archive' }])).toThrow(/does not declare/);
    const plans = new Map();
    addStatePlans(plans, '@m', [both], [{ key: 'doc:archive' }, { key: 'doc:trash' }]);
    expect(plans.get('doc')).toMatchObject({ archivePermission: 'doc:archive', trashPermission: 'doc:trash' });
  });
});
