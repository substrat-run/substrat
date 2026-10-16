/**
 * A vertical's migrations, replayed against a scope that holds data, through the data-loss fence
 * (#115, #2321).
 *
 * The fence (`migration-fence.ts`) judges an authored migration at apply, against the rows a scope
 * actually holds — which closes a populated scope when it refuses. This asks the same question
 * earlier, outside any host: it applies a vertical's modules in the order a host registers them,
 * and before every authored migration it gives every table the fence measures a row and every
 * column a value, so every migration meets a populated scope. `lint:migration-fence` runs it over
 * every vertical in this repository; `substrat push` runs it through the VERTICAL's own kernel
 * before upload — the copy of this code the scope will run at apply — which is why it lives here
 * and not in a tool: the CLI is Apache-2.0 and reaches it at run time, never as a dependency.
 *
 * The database is the caller's: an empty in-memory SQLite it hands in as a {@link ReplayDatabase}
 * (the kernel imports no driver). Nothing here reads a real scope, the network or the environment.
 *
 * What a synthetic row cannot stand in for: foreign keys are off (a made-up value satisfies no
 * reference), and so are CHECK constraints, so a cascade's loss is the run-time fence's to catch.
 * And a migration whose own SQL cannot run on made-up values (a `json_extract` over text that is
 * not JSON) is not a loss: it is reported as {@link ReplayOutcome.failed}, apart from a refusal,
 * so a caller can tell "this would lose data" from "this could not be checked".
 */
import { isSubstratError } from '@substrat-run/contracts';
import { fencedTables } from './migration-fence.js';
import { moduleMigrations } from './module-migrations.js';
import type { ScopedSql, SqlMigration, SqlValue } from './scope-host.js';
import { assertWithinSqlLimits } from './sql-limits.js';
import { runMigrationStatements } from './table-ownership.js';

/**
 * The shape of {@link replayMigrations} and its outcome. A caller reaching a kernel it did not
 * build against (`substrat push`, through the vertical's own) checks this before calling, and
 * treats any other value as "this kernel's replay is not one I know how to call".
 */
export const MIGRATION_REPLAY_API = 1;

/** An empty database the replay may do anything to. SQLite: the fence measures with its SQL. */
export interface ReplayDatabase {
  /** Run SQL text holding any number of statements, with no parameters. */
  exec(sql: string): void;
  query<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[];
  run(sql: string, params?: readonly SqlValue[]): { changes: number };
}

/** Structural, as `moduleMigrations` takes it: a `ModuleRegistration` fits, and so does one read as data. */
export type ReplayModule = Parameters<typeof moduleMigrations>[0];

/** The fence's own refusals, by the `reason` it throws them with: everything else is "could not check". */
const FENCE_REASONS = new Set(['data_loss', 'migration_declaration', 'migration_temp']);

export interface ReplayOutcome {
  /** Authored migrations across the modules — the ones the fence judges. */
  readonly authored: number;
  /** Authored migrations that ran against a populated scope and passed the fence. */
  readonly passed: number;
  /** The fence refused this migration: it would lose data a scope holds. The replay stopped here. */
  readonly refused?: { readonly key: string; readonly reason: string; readonly message: string };
  /** This migration could not be run on synthetic data at all. The replay stopped here. */
  readonly failed?: { readonly key: string; readonly message: string };
  /** Every declared move and discard that passed, with its reason — what a reviewer reads beside the SQL. */
  readonly declared: readonly string[];
}

const quote = (n: string): string => `"${n.replace(/"/g, '""')}"`;

/** A value of the column's affinity, unique per table, column and row so no UNIQUE collides. */
function valueFor(type: string, table: string, column: string, n: number): SqlValue {
  if (/int/i.test(type)) return 1_000_000 + n;
  if (/real|floa|doub/i.test(type)) return n + 0.5;
  return `${table}.${column}#${n}`;
}

/**
 * Give every table the fence measures a row, and every column a value, so the next migration
 * meets a populated scope. The fence's own list, so the replay fills exactly what is judged.
 * Straight to the database: this is the replay's setup, not SQL a scope would run.
 */
function populate(db: ReplayDatabase, sql: ScopedSql, next: () => number): void {
  for (const name of fencedTables(sql)) {
    const columns = db.query<{ name: string; type: string }>('SELECT name, type FROM pragma_table_info(?)', [name]);
    const rows = Number(db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quote(name)}`)[0]!.n);
    if (rows === 0) {
      db.run(
        `INSERT INTO ${quote(name)} (${columns.map((c) => quote(c.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((c) => valueFor(c.type, name, c.name, next())),
      );
      continue;
    }
    for (const c of columns) {
      const held = Number(db.query<{ n: number }>(`SELECT COUNT(${quote(c.name)}) AS n FROM ${quote(name)}`)[0]!.n);
      if (held === 0) db.run(`UPDATE ${quote(name)} SET ${quote(c.name)} = ?`, [valueFor(c.type, name, c.name, next())]);
    }
  }
}

/**
 * Replay `modules`, in order, against a populated scope in `db`. `spineDdl` builds the platform's
 * `_substrat_*` tables first, for an authored migration that reads them (adapter-sqlite's
 * `SCOPE_SPINE_DDL`); without it such a migration is {@link ReplayOutcome.failed}, not refused.
 *
 * Stops at the first refusal or failure: the migrations after it would replay against a schema
 * no scope ever had.
 */
export function replayMigrations(
  db: ReplayDatabase,
  modules: readonly ReplayModule[],
  opts: { readonly spineDdl?: string } = {},
): ReplayOutcome {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA ignore_check_constraints = ON');
  if (opts.spineDdl) db.exec(opts.spineDdl);
  // What a scope's `ctx.sql` is judged by: node's SQLite does not enforce a Durable Object's
  // limits, and the fence's measuring queries must stay inside them.
  const sql: ScopedSql = {
    query: <T>(q: string, p: readonly SqlValue[] = []) => {
      assertWithinSqlLimits(q);
      return db.query<T>(q, p);
    },
    exec: (q: string, p: readonly SqlValue[] = []) => db.run(q, p),
  };
  const authored = modules.reduce((n, m) => n + (m.migrations?.length ?? 0), 0);
  const declared: string[] = [];
  let passed = 0;
  let n = 0;
  for (const mod of modules) {
    const own = new Set((mod.migrations ?? []).map((m) => m.version));
    for (const migration of moduleMigrations(mod)) {
      const key = `${mod.manifest.id}@${migration.version}`;
      const isAuthored = own.has(migration.version);
      db.exec('BEGIN');
      try {
        if (isAuthored) populate(db, sql, () => ++n);
        runMigrationStatements(sql, migration, (st) => db.exec(st), { key, authored: isAuthored });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        const message = err instanceof Error ? err.message : String(err);
        const reason = isSubstratError(err) ? err.extensions.reason : undefined;
        if (typeof reason === 'string' && FENCE_REASONS.has(reason)) {
          return { authored, passed, refused: { key, reason, message }, declared };
        }
        return { authored, passed, failed: { key, message }, declared };
      }
      if (!isAuthored) continue;
      passed += 1;
      declared.push(...declarationsOf(key, migration));
    }
  }
  return { authored, passed, declared };
}

function declarationsOf(key: string, migration: SqlMigration): string[] {
  return [
    ...Object.entries(migration.moves ?? {}).map(([from, to]) => `${key} moves ${from} → ${to} (verified)`),
    ...Object.entries(migration.discards ?? {}).map(([target, why]) => `${key} discards ${target}: ${why}`),
  ];
}
