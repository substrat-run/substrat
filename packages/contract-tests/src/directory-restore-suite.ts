import { describe, expect, it } from 'vitest';
import { namesSpineTable, type ScopeDumpTable } from '@substrat-run/contracts';
import { ALTERED_SHAPES, CREATED_SHAPES, type DirectoryShape } from './directory-shapes.js';

/**
 * A directory restore builds every directory table from the running code's schema, and the
 * dump contributes rows only, by column name (#1912). #1898 held the directory's `_substrat_*`
 * tables to that; this holds the platform's registries to it too (`tenants`, `scopes`,
 * `hostnames`, `verticals`, `vertical_versions`, `orgs`, `tenant_stores`, `blob_stores`, …), and
 * refuses a table the directory does not build at all.
 *
 * The harness hands each case a directory of its own, and reads it without writing to it (an
 * export records an access-log row on the host path, which a byte-for-byte comparison would
 * trip over).
 */
export interface RestorableDirectory {
  /** Every table as the directory's storage holds it: DDL, columns and rows, in name order. */
  snapshot(): Promise<ScopeDumpTable[]>;
  /** The adapter's directory restore. */
  restore(tables: ScopeDumpTable[]): Promise<void>;
  /** A vertical registered by the adapter's own INSERT, which names no capability column. */
  registerVertical(slug: string): Promise<void>;
  /** Runs what a restore leaves to run after it: the #1764 split, where it is not run inline. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export interface DirectoryRestoreHarness {
  /** A freshly built directory that no other case reads or writes. */
  open(): Promise<RestorableDirectory>;
}

/** The columns a restore could not have filled from the dump, and what today's DDL gives them. */
const DEFAULTS: Record<string, unknown> = {
  status: 'active',
  storage_shape: 'A',
  schema_version: '0',
  migration_attempts: 0,
  canonical: 0,
  listed: 0,
  installs_blocked: 0,
  tenant_provisioner: 0,
  email_sender: 0,
};
const INTEGER_COLUMNS = new Set([...Object.keys(DEFAULTS).filter((c) => typeof DEFAULTS[c] === 'number'), 'ordinal']);
/** A live tenant row's NOT NULL columns. */
const LIVE_TENANT = { tenant_id: 't-0', status: 'active', created_at: 'c' };
/** A live pre-directory scope row: its NOT NULL columns, and a NULL slug for the backfill to fill. */
const LIVE_SCOPE = { tenant_id: 't-0', storage_shape: 'A', status: 'active', schema_version: '0', created_at: 'c' };

/**
 * The value a crafted row carries in `column`: distinct per table and column, so a value that
 * landed in the wrong column shows. `1` in an integer column, which for the three capability
 * columns is the value a staff grant writes. The #1764 progress columns are dumped as a version
 * the split has not reached, and the manifest as one it can parse.
 */
const valueFor = (table: string, column: string): unknown => {
  if (column === 'provisioned_by_tenant' || column === 'migration_count' || column === 'migrations_split') return null;
  if (column === 'manifest_json') return '{"version":"1.0.0"}';
  return INTEGER_COLUMNS.has(column) ? 1 : `${table}.${column}`;
};

const find = (tables: ScopeDumpTable[], name: string) => {
  const t = tables.find((x) => x.name === name);
  if (!t) throw new Error(`no table ${name} in the directory`);
  return t;
};
const withTable = (tables: ScopeDumpTable[], name: string, edit: (t: ScopeDumpTable) => ScopeDumpTable) =>
  tables.map((t) => (t.name === name ? edit(t) : t));
const rowOf = (columns: readonly string[], values: Record<string, unknown>) => columns.map((c) => values[c] ?? null);
/** One table's rows as objects, keyed by column name. */
const recordsOf = (t: ScopeDumpTable) => t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
const crafted = (table: string, columns: readonly string[]) => columns.map((c) => valueFor(table, c));
/** A table in one of its older shapes, holding one crafted row. */
const inShape = (shape: DirectoryShape): Pick<ScopeDumpTable, 'ddl' | 'columns' | 'rows'> => ({
  ddl: shape.ddl,
  columns: shape.columns,
  rows: [crafted(shape.table, shape.columns)],
});

/**
 * The row a restore of `shape`'s crafted row must leave in today's table: the dumped values by
 * name, today's default for a column the shape did not have, and a pre-directory scope row's
 * naming columns filled the way the legacy backfill fills them. A version's #1764 progress is
 * whatever the split then wrote, so it is asserted apart.
 */
const expectedRow = (shape: DirectoryShape, columns: readonly string[]): Record<string, unknown> => {
  const dumped = new Set(shape.columns);
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    if (shape.table === 'vertical_versions' && (c === 'migration_count' || c === 'migrations_split')) continue;
    out[c] = dumped.has(c) ? valueFor(shape.table, c) : (DEFAULTS[c] ?? null);
  }
  if (shape.table === 'scopes') {
    if (!dumped.has('slug')) out.slug = String(out.scope_id).toLowerCase();
    if (!dumped.has('kind')) out.kind = 'scope';
    if (!dumped.has('name')) out.name = out.slug;
  }
  return out;
};

/** The scopes table as the directory's first day built it, before its naming columns. */
const OLDEST_SCOPES = CREATED_SHAPES.find((s) => s.table === 'scopes')!;
/** That table holding one live pre-directory row per id, each with a NULL slug. */
const oldScopes = (ids: string[]): ScopeDumpTable => ({
  name: 'scopes',
  ddl: OLDEST_SCOPES.ddl,
  columns: OLDEST_SCOPES.columns,
  rows: ids.map((id) => rowOf(OLDEST_SCOPES.columns, { ...LIVE_SCOPE, scope_id: id })),
});

type Refusal = [what: string, craft: (tables: ScopeDumpTable[]) => ScopeDumpTable[], message: RegExp];

export function directoryRestoreSuite(name: string, harness: DirectoryRestoreHarness): void {
  const using = async <T>(fn: (dir: RestorableDirectory, fresh: ScopeDumpTable[]) => Promise<T>): Promise<T> => {
    const dir = await harness.open();
    try {
      return await fn(dir, await dir.snapshot());
    } finally {
      await dir.close();
    }
  };
  /** The directory's tables and their DDL, which a restore must leave as this code builds them. */
  const shapeOf = (tables: ScopeDumpTable[]) => tables.map((t) => [t.name, t.ddl, t.columns]);

  describe(`directory restore builds every table from its own schema (#1912): ${name}`, () => {
    it('a DEFAULT 1 on the three capability columns in the dump does not decide a later registration', async () => {
      await using(async (dir, fresh) => {
        const verticals = find(fresh, 'verticals');
        const granted = ['tenant_provisioner', 'email_sender', 'installs_blocked'];
        let ddl = verticals.ddl;
        for (const c of granted) ddl = ddl.replace(new RegExp(`\\b(${c}\\s+INTEGER\\s+NOT NULL\\s+DEFAULT\\s+)0`), (_, head: string) => `${head}1`);
        expect(ddl.match(/NOT NULL\s+DEFAULT\s+1\b/g)).toHaveLength(granted.length);
        // A row that was granted all three in the copy keeps them: rows are the dump's to say.
        await dir.restore(withTable(fresh, 'verticals', (t) => ({ ...t, ddl, rows: [crafted('verticals', t.columns)] })));
        await dir.registerVertical('registered-after');

        const after = await dir.snapshot();
        expect(find(after, 'verticals').ddl).toBe(verticals.ddl);
        const bySlug = Object.fromEntries(recordsOf(find(after, 'verticals')).map((r) => [r.slug, r]));
        const capabilities = (slug: string) => Object.fromEntries(granted.map((c) => [c, bySlug[slug]?.[c]]));
        expect(capabilities('registered-after')).toEqual({ tenant_provisioner: 0, email_sender: 0, installs_blocked: 0 });
        expect(capabilities('verticals.slug')).toEqual({ tenant_provisioner: 1, email_sender: 1, installs_blocked: 1 });
      });
    });

    it('a COLLATE NOCASE on tenants.slug and hostnames.hostname is not carried: case variants are two rows', async () => {
      await using(async (dir, fresh) => {
        const nocase = (ddl: string, column: string) => {
          const out = ddl.replace(new RegExp(`\\b(${column}\\s+TEXT)\\s+(NOT NULL|PRIMARY KEY)`), '$1 COLLATE NOCASE $2');
          expect(out).not.toBe(ddl);
          return out;
        };
        let tables = withTable(fresh, 'tenants', (t) => ({
          ...t,
          ddl: nocase(t.ddl, 'slug'),
          rows: ['Acme', 'acme'].map((slug, i) => rowOf(t.columns, { ...LIVE_TENANT, tenant_id: `t-${i}`, slug, name: slug })),
        }));
        tables = withTable(tables, 'hostnames', (t) => ({
          ...t,
          ddl: nocase(t.ddl, 'hostname'),
          rows: ['App.example.com', 'app.example.com'].map((hostname) =>
            rowOf(t.columns, { hostname, tenant_id: 't-0', scope_id: 's', surface: 'app', status: 'active', canonical: 0, created_at: 'c' }),
          ),
        }));
        await dir.restore(tables);
        const after = await dir.snapshot();
        expect(shapeOf(after)).toEqual(shapeOf(fresh));
        expect(recordsOf(find(after, 'tenants')).map((r) => r.slug)).toEqual(['Acme', 'acme']);
        expect(recordsOf(find(after, 'hostnames')).map((r) => r.hostname).sort()).toEqual(['App.example.com', 'app.example.com']);
      });
    });

    it('a REFERENCES in a registry’s own DDL is not carried', async () => {
      await using(async (dir, fresh) => {
        // Carried, this row would fail the commit: its tenant is not in the dump.
        const tables = withTable(fresh, 'scopes', (t) => ({
          ...t,
          ddl: t.ddl.replace(/\b(tenant_id\s+TEXT\s+NOT NULL)/, '$1 REFERENCES tenants(tenant_id)'),
          rows: [crafted('scopes', t.columns)],
        }));
        expect(find(tables, 'scopes').ddl).toMatch(/REFERENCES tenants/);
        await dir.restore(tables);
        const after = await dir.snapshot();
        expect(find(after, 'scopes').ddl).toBe(find(fresh, 'scopes').ddl);
        expect(find(after, 'scopes').rows).toHaveLength(1);
      });
    });

    it('a registry column this code does not know is kept bare and lowercased, with its values', async () => {
      await using(async (dir, fresh) => {
        const tables = withTable(fresh, 'tenants', (t) => {
          const columns = [...t.columns, 'Future_Note'];
          return {
            ...t,
            ddl: t.ddl.replace(/\)\s*$/, ", Future_Note TEXT NOT NULL COLLATE NOCASE DEFAULT 'x')"),
            columns,
            rows: [rowOf(columns, { ...LIVE_TENANT, slug: 'acme', name: 'Acme', Future_Note: 'kept' })],
          };
        });
        await dir.restore(tables);
        const t = find(await dir.snapshot(), 'tenants');
        expect(t.columns.at(-1)).toBe('future_note');
        expect(t.ddl).toMatch(/ "future_note"[,\n)]/);
        expect(t.ddl).not.toMatch(/NOCASE|Future_Note|DEFAULT 'x'/);
        expect(t.rows.map((r) => r.at(-1))).toEqual(['kept']);
      });
    });

    describe('an older dump of each registry still restores, into today’s table', () => {
      for (const shape of [...CREATED_SHAPES, ...ALTERED_SHAPES]) {
        it(`${shape.table}, ${shape.since}`, async () => {
          await using(async (dir, fresh) => {
            const today = find(fresh, shape.table);
            await dir.restore(withTable(fresh, shape.table, (t) => ({ ...t, ...inShape(shape) })));
            await dir.settle();
            const after = await dir.snapshot();
            expect(shapeOf(after)).toEqual(shapeOf(fresh));
            const [row, ...rest] = recordsOf(find(after, shape.table));
            expect(rest).toEqual([]);
            expect(row).toMatchObject(expectedRow(shape, today.columns));
            // #1764's split still runs over a version the dump stored before it.
            if (shape.table === 'vertical_versions') expect(row!.migrations_split).toBe(1);
          });
        });
      }

      it('a directory whose every registry is at its first shape', async () => {
        await using(async (dir, fresh) => {
          const first = new Map<string, DirectoryShape>();
          for (const s of CREATED_SHAPES) if (!first.has(s.table)) first.set(s.table, s);
          await dir.restore(fresh.map((t) => (first.has(t.name) ? { ...t, ...inShape(first.get(t.name)!) } : t)));
          await dir.settle();
          const after = await dir.snapshot();
          expect(shapeOf(after)).toEqual(shapeOf(fresh));
          for (const [table, shape] of first) {
            expect(recordsOf(find(after, table))).toEqual([expect.objectContaining(expectedRow(shape, find(fresh, table).columns))]);
          }
        });
      });

      it('a directory from before the tenant registry, holding only its scopes', async () => {
        await using(async (dir, fresh) => {
          await dir.restore([{ name: 'scopes', ...inShape(OLDEST_SCOPES) }]);
          const after = await dir.snapshot();
          expect(shapeOf(after)).toEqual(shapeOf(fresh));
          expect(recordsOf(find(after, 'scopes'))).toEqual([expect.objectContaining(expectedRow(OLDEST_SCOPES, find(fresh, 'scopes').columns))]);
          expect(find(after, 'tenants').rows).toEqual([]);
        });
      });
    });

    it('export → restore → export round-trips, every registry holding a row', async () => {
      await using(async (dir, fresh) => {
        await dir.restore(fresh.map((t) => (!namesSpineTable(t.name) ? { ...t, rows: [crafted(t.name, t.columns)] } : t)));
        // The crafted version is one the #1764 split has not reached; it moves before the copy.
        await dir.settle();
        const before = await dir.snapshot();
        expect(before.filter((t) => !namesSpineTable(t.name) && t.rows.length !== 1)).toEqual([]);
        await dir.restore(before);
        await dir.settle();
        const after = await dir.snapshot();
        expect(shapeOf(after)).toEqual(shapeOf(before));
        for (const t of after) {
          const was = find(before, t.name);
          // The pure adapter records the restore in the admin log it just loaded; the Durable
          // Object leaves that to its host.
          if (t.name === '_substrat_admin_log') {
            const action = t.columns.indexOf('action');
            expect(t.rows.slice(0, was.rows.length)).toEqual(was.rows);
            for (const r of t.rows.slice(was.rows.length)) expect(r[action]).toBe('restoreDirectory');
          } else {
            expect(t.rows).toEqual(was.rows);
          }
        }
      });
    });

    it('a removal fence survives the round trip, row for row (#1184)', async () => {
      await using(async (dir, fresh) => {
        const fence = { tenant_id: 'tenant-a', principal: '01JZ00000000000000000000F1', removed_at: '2026-09-29T00:00:00.000Z' };
        await dir.restore(withTable(fresh, '_substrat_membership_fences', (t) => ({ ...t, rows: [rowOf(t.columns, fence)] })));
        await dir.settle();
        const before = await dir.snapshot();
        expect(recordsOf(find(before, '_substrat_membership_fences'))).toEqual([fence]);
        await dir.restore(before);
        await dir.settle();
        expect(recordsOf(find(await dir.snapshot(), '_substrat_membership_fences'))).toEqual([fence]);
      });
    });

    describe('refused, and the directory is left exactly as it was', () => {
      const refusals: Refusal[] = [
        [
          // The issue's second case: with foreign keys enforced, a row here would fail the delete
          // of the tenant it names. Named with a second unbuilt table, to show both are named.
          'tables this directory does not build, one of them REFERENCES tenants',
          (tables) => [
            ...tables,
            { name: 'tenant_mirror', ddl: 'CREATE TABLE tenant_mirror (tenant_id TEXT REFERENCES tenants(tenant_id))', columns: ['tenant_id'], rows: [['t-0']] },
            { name: 'sqlitedata', ddl: 'CREATE TABLE sqlitedata (id INTEGER PRIMARY KEY, v TEXT)', columns: ['id', 'v'], rows: [] },
          ],
          /this directory does not build: tenant_mirror, sqlitedata\b/,
        ],
        // Both entries would load into the one table SQLite resolves them to, and the second could
        // carry what the first's checks never saw. `assertDumpIdentifiers` folds case, as SQLite does.
        ...(['tenants', '_substrat_roles'] as const).map((table): Refusal => [
          `a table listed twice, differing only in case: ${table}`,
          (tables) => {
            const t = find(tables, table);
            const twin = { ...t, name: table.toUpperCase(), ddl: t.ddl.replace(new RegExp(`^(CREATE TABLE\\s+)"?${table}"?`, 'i'), `$1${table.toUpperCase()}`) };
            return [...tables, twin];
          },
          new RegExp(`"${table.toUpperCase()}" is listed twice`),
        ]),
        ...(['sqlite_master', 'SQLITE_SCHEMA', 'sqlite_sequence', '_cf_METADATA', '_cf_KV'] as const).map(
          (reserved): Refusal => [
            `a table named like one SQLite or workerd keeps for itself: ${reserved}`,
            (tables) => [...tables, { name: reserved, ddl: `CREATE TABLE ${reserved} (name TEXT)`, columns: ['name'], rows: [['x']] }],
            new RegExp(`this directory does not build: ${reserved}\\b`),
          ],
        ),
        ...(['rowid', 'OID', '_rowid_'] as const).map((alias): Refusal => [
          `a registry column named ${alias}`,
          (tables) =>
            withTable(tables, 'tenants', (t) => ({
              ...t,
              ddl: t.ddl.replace(/\)\s*$/, `, ${alias} INTEGER)`),
              columns: [...t.columns, alias],
              rows: t.rows.map((r) => [...r, 7]),
            })),
          new RegExp(`named for SQLite's rowid: ${alias}`),
        ]),
        [
          // A column added to one table, then a later table's row refused: the addition goes too.
          'a row that fails after a column was added',
          (tables) => {
            const t = withTable(tables, 'tenants', (x) => ({
              ...x,
              ddl: x.ddl.replace(/\)\s*$/, ', note TEXT)'),
              columns: [...x.columns, 'note'],
              rows: x.rows.map((r) => [...r, 'n']),
            }));
            // No `source`, which every shape of the table has required.
            return withTable(t, 'verticals', (x) => {
              const columns = x.columns.filter((c) => c !== 'source');
              return { ...x, columns, rows: [rowOf(columns, { ...DEFAULTS, slug: 'v', name: 'V', created_at: 'c' })] };
            });
          },
          /NOT NULL constraint failed: verticals\.source/,
        ],
        [
          // Two pre-directory scope rows whose ids differ only in case: the legacy backfill gives
          // them one slug, which the live-slug index refuses. It runs inside the transaction.
          'a legacy scope backfill that fails',
          (tables) => withTable(tables, 'scopes', () => oldScopes(['Dup', 'dup'])),
          /UNIQUE/,
        ],
      ];
      for (const [what, craft, message] of refusals) {
        it(what, async () => {
          await using(async (dir, fresh) => {
            // A directory holding something, so a restore that went through would show.
            await dir.restore(withTable(fresh, 'tenants', (t) => ({ ...t, rows: [rowOf(t.columns, { ...LIVE_TENANT, slug: 'kept', name: 'Kept' })] })));
            const before = await dir.snapshot();
            const attempt = craft(withTable(before, 'tenants', (t) => ({ ...t, rows: t.rows.map((r) => r.map((v) => (v === 'Kept' ? 'Changed' : v))) })));
            await expect(dir.restore(attempt)).rejects.toThrow(message);
            expect(await dir.snapshot()).toEqual(before);
          });
        });
      }

      it('twin: the same dump without the refused parts restores', async () => {
        await using(async (dir, fresh) => {
          await dir.restore(withTable(fresh, 'scopes', () => oldScopes(['Dup', 'other'])));
          expect(recordsOf(find(await dir.snapshot(), 'scopes')).map((r) => r.slug).sort()).toEqual(['dup', 'other']);
        });
      });
    });
  });
}
