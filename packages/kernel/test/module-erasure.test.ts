import { describe, expect, it } from 'vitest';
import { errorCodeOf, moduleManifest, type SubjectErasureDeclaration } from '@substrat-run/contracts';
import {
  assertWithinErasureReach,
  eraseSubjectFromModules,
  moduleErasurePlan,
  SECURE_DELETE_MIN_SQLITE,
  type ModuleRegistration,
  type ScopedSql,
} from '../src/index.js';

/**
 * #2068 — the registration-time refusals and the hook's reach, which the contract suite drives
 * through a whole erasure on both adapters. These pin the grammar: which claims a module cannot
 * register, and which statements a hook cannot run.
 */
const erasure = (mode: 'blank' | 'custom'): SubjectErasureDeclaration => ({
  tables: ['notes', 'ratings'],
  entities: [
    mode === 'blank'
      ? { entityType: 'note', table: 'notes', mode, subjects: ['author'], fields: [{ name: 'body', blank: '' }] }
      : { entityType: 'rating', table: 'ratings', mode, fields: [{ name: 'comment', blank: null }] },
  ],
});
const registration = (declared?: SubjectErasureDeclaration, hook?: ModuleRegistration['onSubjectErased']): ModuleRegistration => ({
  manifest: moduleManifest.parse({
    id: '@test/m',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './m', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'm',
    ...(declared ? { erasure: declared } : {}),
  }),
  ...(hook ? { onSubjectErased: hook } : {}),
});

describe('moduleErasurePlan (#2068)', () => {
  it('is absent for a module with nothing erasable and no hook', () => {
    expect(moduleErasurePlan(registration())).toBeUndefined();
  });

  it('refuses a hook with no erasure block — it would have no reach declared', () => {
    expect(() => moduleErasurePlan(registration(undefined, () => undefined))).toThrow(/declares no `erasure`/);
  });

  it('refuses a custom entity with no hook to reach it — and accepts it with one', () => {
    expect(() => moduleErasurePlan(registration(erasure('custom')))).toThrow(/no onSubjectErased hook/);
    expect(moduleErasurePlan(registration(erasure('custom'), () => undefined))?.hook).toBeTypeOf('function');
  });

  it('accepts a declared erasure with no hook', () => {
    expect(moduleErasurePlan(registration(erasure('blank')))?.declaration.entities[0]?.mode).toBe('blank');
  });
});

describe('assertWithinErasureReach (#2068)', () => {
  const foreign = new Set(['other_secrets', 'ticket0_messages']);
  const refused = (sql: string) => {
    try {
      assertWithinErasureReach('@test/m', sql, foreign);
    } catch (e) {
      return errorCodeOf(e);
    }
    return undefined;
  };

  it('lets the module read and write its own tables', () => {
    expect(refused('UPDATE ratings SET comment = NULL WHERE note_id IN (SELECT id FROM notes WHERE author = ?)')).toBeUndefined();
    expect(refused('WITH mine AS (SELECT id FROM notes) DELETE FROM ratings WHERE note_id IN mine')).toBeUndefined();
    expect(refused('INSERT INTO ratings (note_id) VALUES (?)')).toBeUndefined();
  });

  it("refuses another module's table anywhere in the statement — quoted, qualified, in a subquery", () => {
    expect(refused('SELECT * FROM other_secrets')).toBe('forbidden');
    expect(refused('SELECT * FROM notes WHERE id IN (SELECT id FROM "Other_Secrets")')).toBe('forbidden');
    expect(refused('SELECT * FROM main.other_secrets')).toBe('forbidden');
    expect(refused('UPDATE notes SET body = (SELECT body_text FROM ticket0_messages LIMIT 1)')).toBe('forbidden');
  });

  it('refuses the spine and SQLite’s own tables, reads included', () => {
    expect(refused('SELECT payload FROM _substrat_outbox')).toBe('forbidden');
    expect(refused('SELECT name FROM sqlite_master')).toBe('forbidden');
  });

  it('refuses anything but SELECT, WITH, UPDATE, DELETE, INSERT and REPLACE — in every chained statement', () => {
    expect(refused('PRAGMA table_info(notes)')).toBe('forbidden');
    expect(refused('DROP TABLE notes')).toBe('forbidden');
    expect(refused("ATTACH DATABASE 'x' AS y")).toBe('forbidden');
    expect(refused('SELECT 1; PRAGMA writable_schema = 1')).toBe('forbidden');
    // A semicolon inside a string literal starts no statement.
    expect(refused("UPDATE notes SET body = 'a; PRAGMA x'")).toBeUndefined();
  });
});

describe('the SQLite floor for FTS5 secure-delete (#2068)', () => {
  /** A handle that finds a matching row, records every write, and — on an old SQLite — has no secure-delete. */
  const handle = (secureDelete: boolean) => {
    const writes: string[] = [];
    const sql: ScopedSql = {
      query: <T>(q: string) => (q.startsWith('SELECT 1') ? [{ one: 1 }] : [{ n: 1 }]) as T[],
      exec: (q: string) => {
        if (!secureDelete && q.includes('secure-delete')) throw new Error('SQL logic error');
        writes.push(q);
        return { changes: 1 };
      },
    };
    return { sql, writes };
  };
  const plan = moduleErasurePlan(registration(erasure('blank')))!;
  const searchPlans = [
    {
      moduleId: '@test/m',
      entityType: 'note',
      table: 'notes',
      idColumn: 'id',
      fields: ['body'],
      tokenizer: 'prefix' as const,
      indexTable: '_substrat_search_m_note',
    },
  ];
  const run = (sql: ScopedSql) =>
    eraseSubjectFromModules({ sql, plans: [plan], searchPlans, subjectId: 'S', at: '2026-10-06T00:00:00.000Z' });

  it(`refuses an erasure over a search index on a SQLite without secure-delete (< ${SECURE_DELETE_MIN_SQLITE}), before writing anything`, () => {
    const { sql, writes } = handle(false);
    const err = (() => {
      try {
        run(sql);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(errorCodeOf(err)).toBe('precondition_failed');
    expect(String((err as Error).message)).toMatch(/needs FTS5 secure-delete/);
    expect(writes).toEqual([]);
  });

  it('runs on a SQLite that has it, switching secure-delete on before the write and off after', () => {
    const { sql, writes } = handle(true);
    run(sql);
    expect(writes[0]).toMatch(/'secure-delete', 1/);
    expect(writes[1]).toMatch(/^UPDATE notes/);
    expect(writes.at(-1)).toMatch(/'secure-delete', 0/);
  });

  it('touches no index — and needs no secure-delete — when the erasure holds nothing for the subject', () => {
    const writes: string[] = [];
    const sql: ScopedSql = {
      query: <T>() => [] as T[],
      exec: (q: string) => {
        writes.push(q);
        return { changes: 0 };
      },
    };
    expect(run(sql).verticalRows).toEqual([{ module: '@test/m', entityType: 'note', mode: 'blank', rows: 0 }]);
    expect(writes).toEqual([]);
  });
});
