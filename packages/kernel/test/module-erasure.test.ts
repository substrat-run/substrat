import { describe, expect, it } from 'vitest';
import { errorCodeOf, moduleManifest, type SubjectErasureDeclaration } from '@substrat-run/contracts';
import {
  eraseSubjectFromModules,
  moduleErasurePlan,
  SECURE_DELETE_MIN_SQLITE,
  type ModuleRegistration,
  type ScopedSql,
  type SqlValue,
} from '../src/index.js';
import { assertWithinErasureReach, tablesCreatedBy } from '../src/module-erasure.js';

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
/** The module's own DDL: it creates both tables its erasure names. */
const OWN_DDL = 'CREATE TABLE notes (id TEXT PRIMARY KEY, author TEXT, body TEXT NOT NULL); CREATE TABLE ratings (note_id TEXT, comment TEXT);';
const registration = (
  declared?: SubjectErasureDeclaration,
  hook?: ModuleRegistration['onSubjectErased'],
  ddl = OWN_DDL,
): ModuleRegistration => ({
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
  migrations: [{ version: '0001', sql: ddl }],
  ...(hook ? { onSubjectErased: hook } : {}),
});

/**
 * Run the erasure over a fake handle as a scope that records every table as `@test/m`'s: the
 * ownership check is `table-ownership.test.ts`'s subject, on a real SQLite; here it must pass.
 */
const erase = (input: Omit<Parameters<typeof eraseSubjectFromModules>[0], 'migrationSqlOf'>) => {
  const inner = input.sql;
  const sql: ScopedSql = {
    query: <T>(q: string, p?: readonly SqlValue[]) =>
      q.includes('_substrat_table_owners') ? ([{ module_id: '@test/m' }] as T[]) : inner.query<T>(q, p),
    exec: (q: string, p?: readonly SqlValue[]) => inner.exec(q, p),
  };
  return eraseSubjectFromModules({ ...input, sql, migrationSqlOf: () => undefined });
};

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

  it("refuses an erasure on a table its own migrations do not create — another module's", () => {
    // `notes` is created by somebody else; this module's migration makes only `ratings`.
    const ddl = 'CREATE TABLE ratings (note_id TEXT, comment TEXT);';
    expect(() => moduleErasurePlan(registration(erasure('blank'), undefined, ddl))).toThrow(
      /'notes', which its own migrations do not create/,
    );
    // A hook's whole reach is held to it too, not only the entities it claims.
    expect(() => moduleErasurePlan(registration(erasure('custom'), () => undefined, ddl))).toThrow(/'notes'/);
  });

  it('does not hold an unreached entity to ownership — it writes nothing', () => {
    const unreached: SubjectErasureDeclaration = {
      tables: ['elsewhere'],
      entities: [{ entityType: 'x', table: 'elsewhere', mode: 'unreached', fields: [{ name: 'memo', blank: null }] }],
    };
    expect(moduleErasurePlan(registration(unreached, undefined, ''))?.ownTables.size).toBe(0);
  });
});

describe('tablesCreatedBy (#2068)', () => {
  it('follows CREATE, RENAME and DROP across migrations, in order, and ignores TEMP and views', () => {
    const owned = tablesCreatedBy([
      { sql: 'CREATE TABLE IF NOT EXISTS "Notes" (id TEXT); CREATE TABLE main.ratings (x TEXT); CREATE TEMP TABLE scratch (x TEXT);' },
      { sql: "CREATE VIEW v AS SELECT 1; CREATE VIRTUAL TABLE idx USING fts5(body); ALTER TABLE ratings RENAME TO scores;" },
      { sql: 'ALTER TABLE notes RENAME COLUMN id TO note_id; DROP TABLE IF EXISTS idx; CREATE TABLE gone (x TEXT); DROP TABLE gone;' },
    ]);
    expect([...owned].sort()).toEqual(['notes', 'scores']);
  });
});

describe('assertWithinErasureReach (#2068)', () => {
  const own = new Set(['notes', 'ratings']);
  const refused = (sql: string) => {
    try {
      assertWithinErasureReach('@test/m', sql, own);
    } catch (e) {
      return errorCodeOf(e);
    }
    return undefined;
  };

  it('lets the module read and write its own tables, however the statement is shaped', () => {
    expect(refused('UPDATE ratings SET comment = NULL WHERE note_id IN (SELECT id FROM notes WHERE author = ?)')).toBeUndefined();
    expect(refused('INSERT INTO ratings (note_id) VALUES (?)')).toBeUndefined();
    expect(refused('INSERT OR REPLACE INTO ratings (note_id) SELECT id FROM notes')).toBeUndefined();
    expect(refused('UPDATE OR IGNORE "Notes" SET body = ? WHERE id = ?')).toBeUndefined();
    expect(refused('SELECT n.id FROM notes AS n JOIN ratings r ON r.note_id = n.id, notes')).toBeUndefined();
    expect(refused('DELETE FROM ratings WHERE note_id NOT IN (SELECT id FROM notes)')).toBeUndefined();
    expect(refused('SELECT value FROM notes, json_each(notes.body)')).toBeUndefined();
    expect(refused('INSERT INTO ratings (note_id) VALUES (?) ON CONFLICT(note_id) DO UPDATE SET comment = NULL')).toBeUndefined();
  });

  it('refuses every table that is not its own — an allowlist, so nothing needs listing', () => {
    // Another module's, a view, a TEMP table: all just names that are not on the list.
    expect(refused('SELECT * FROM other_secrets')).toBe('forbidden');
    expect(refused('SELECT * FROM some_view')).toBe('forbidden');
    expect(refused('SELECT * FROM a_temp_table')).toBe('forbidden');
    expect(refused('SELECT * FROM notes WHERE id IN (SELECT id FROM "Other_Secrets")')).toBe('forbidden');
    expect(refused('UPDATE notes SET body = (SELECT body_text FROM ticket0_messages LIMIT 1)')).toBe('forbidden');
    expect(refused('SELECT * FROM notes LEFT JOIN other_secrets ON 1')).toBe('forbidden');
    expect(refused('INSERT INTO other_secrets (x) VALUES (1)')).toBe('forbidden');
    expect(refused('DELETE FROM other_secrets')).toBe('forbidden');
  });

  it('refuses a comma-joined table after a subquery, at any depth', () => {
    expect(refused('SELECT * FROM (SELECT 1) AS a, other_secrets')).toBe('forbidden');
    expect(refused('SELECT * FROM notes, (SELECT * FROM (SELECT 1) b, other_secrets) c')).toBe('forbidden');
    expect(refused('SELECT * FROM notes, other_secrets')).toBe('forbidden');
  });

  it('refuses a qualified name, even of its own table — main., temp. or any other schema', () => {
    expect(refused('SELECT * FROM main.notes')).toBe('forbidden');
    expect(refused('SELECT * FROM temp.notes')).toBe('forbidden');
    expect(refused('SELECT * FROM "temp"."notes"')).toBe('forbidden');
  });

  it('refuses WITH — a CTE could shadow one of its own table names', () => {
    expect(refused('WITH notes AS (SELECT secret AS body FROM other_secrets) SELECT body FROM notes')).toBe('forbidden');
    expect(refused('SELECT * FROM notes WHERE id IN (WITH x AS (SELECT 1) SELECT * FROM x)')).toBe('forbidden');
  });

  it('refuses a table-valued function other than json_each / json_tree', () => {
    expect(refused("SELECT * FROM pragma_table_info('notes')")).toBe('forbidden');
  });

  it('refuses the spine and SQLite’s own tables anywhere, reads included', () => {
    expect(refused('SELECT payload FROM _substrat_outbox')).toBe('forbidden');
    expect(refused('SELECT name FROM sqlite_master')).toBe('forbidden');
  });

  it('refuses anything but SELECT, UPDATE, DELETE, INSERT and REPLACE — in every chained statement', () => {
    expect(refused('PRAGMA table_info(notes)')).toBe('forbidden');
    expect(refused('DROP TABLE notes')).toBe('forbidden');
    expect(refused("ATTACH DATABASE 'x' AS y")).toBe('forbidden');
    expect(refused('SELECT 1; PRAGMA writable_schema = 1')).toBe('forbidden');
    // A semicolon inside a string literal starts no statement.
    expect(refused("UPDATE notes SET body = 'a; PRAGMA x'")).toBeUndefined();
  });
});

describe('the hook capability and the temp schema (#2068)', () => {
  /** A handle over nothing: no rows, and an optional temp schema. */
  const bare = (temp: string[] = []) => {
    const writes: string[] = [];
    const sql: ScopedSql = {
      query: <T>(q: string) =>
        (q.includes('temp.sqlite_master') ? temp.map((name) => ({ name })) : [{ c: 0, t: writes.length }]) as T[],
      exec: (q: string) => {
        writes.push(q);
        return { changes: 1 };
      },
    };
    return { sql, writes };
  };

  it('revokes ctx when the hook returns: a call made later throws and writes nothing', () => {
    let kept: ScopedSql | undefined;
    const plan = moduleErasurePlan(registration(erasure('custom'), (ctx) => {
      kept = ctx.sql;
    }))!;
    const { sql, writes } = bare();
    erase({ sql, plans: [plan], searchPlans: [], subjectId: 'S', at: 'now' });
    expect(() => kept!.exec('UPDATE ratings SET comment = NULL')).toThrow(/used after the hook returned/);
    expect(writes).toEqual([]);
  });

  it('refuses any returned value — a generator hook is refused with its body never run', () => {
    let ran = false;
    for (const hook of [
      () => (function* () { ran = true; })(),
      () => Promise.resolve(),
      () => 0,
      () => null,
    ]) {
      const plan = moduleErasurePlan(registration(erasure('custom'), hook as unknown as ModuleRegistration['onSubjectErased']))!;
      const err = (() => {
        try {
          erase({ sql: bare().sql, plans: [plan], searchPlans: [], subjectId: 'S', at: 'now' });
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(errorCodeOf(err), String(err)).toBe('precondition_failed');
    }
    expect(ran).toBe(false);
  });

  it('revokes it when the hook throws, too', () => {
    let kept: ScopedSql | undefined;
    const plan = moduleErasurePlan(registration(erasure('custom'), (ctx) => {
      kept = ctx.sql;
      throw new Error('boom');
    }))!;
    expect(() => erase({ sql: bare().sql, plans: [plan], searchPlans: [], subjectId: 'S', at: 'now' })).toThrow(/boom/);
    expect(() => kept!.query('SELECT * FROM ratings')).toThrow(/used after the hook returned/);
  });

  it('refuses the erasure when a TEMP object shadows a table it would touch', () => {
    const plan = moduleErasurePlan(registration(erasure('blank')))!;
    const { sql, writes } = bare(['NOTES']);
    expect(() => erase({ sql, plans: [plan], searchPlans: [], subjectId: 'S', at: 'now' })).toThrow(
      /TEMP object 'NOTES' shadows/,
    );
    expect(writes).toEqual([]);
    // Its twin: an unrelated temp object is no reason to refuse.
    expect(() => erase({ sql: bare(['scratch']).sql, plans: [plan], searchPlans: [], subjectId: 'S', at: 'now' })).not.toThrow();
  });
});

describe('the SQLite floor for FTS5 secure-delete (#2068)', () => {
  /** A handle that finds a matching row, records every write, and — on an old SQLite — has no secure-delete. */
  const handle = (secureDelete: boolean) => {
    const writes: string[] = [];
    const sql: ScopedSql = {
      query: <T>(q: string) =>
        (q.includes('temp.sqlite_master') ? [] : q.startsWith('SELECT 1') ? [{ one: 1 }] : [{ n: 1 }]) as T[],
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
    erase({ sql, plans: [plan], searchPlans, subjectId: 'S', at: '2026-10-06T00:00:00.000Z' });

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
