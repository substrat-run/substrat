import { utf8Length } from './deploy.js';

/** A migration as the diff reads it: a `DeclaredMigration`, or anything shaped like one. */
type MigrationLike = { moduleId: string; version: string; sql: string };

/**
 * The migrations a version adds on top of another (#1677): what the promote dialog and
 * `substrat promote` show a person before they acknowledge a migration change.
 *
 * Read from the `migrations` each version's manifest carries. Pure, so the route stays a
 * read and the bounds are testable without one.
 */

/** At most this many migrations in one answer. The rest are counted in `total`. */
export const MIGRATION_READ_MAX = 200;
/** At most this many bytes of SQL in one answer. A migration past the budget keeps its id, with `sql: null`. */
export const MIGRATION_READ_SQL_BYTES_MAX = 256 * 1024;

export interface MigrationEntry {
  moduleId: string;
  version: string;
  /** Null when the answer's SQL budget ran out before this entry. The id is still listed. */
  sql: string | null;
}

export interface MigrationDiff {
  /**
   * What `added` is relative to:
   * - `version`: the base version's own migrations.
   * - `none`: no base was named (a first promote), so every migration is listed.
   * - `unavailable`: the base was pushed before manifests carried migrations, so every
   *   migration is listed and nothing can say which of them are new.
   */
  baseline: 'version' | 'none' | 'unavailable';
  /** Migrations the base does not have, in the order the host runs them. */
  added: MigrationEntry[];
  /**
   * Migrations the base also has, under the same `(moduleId, version)`, with different SQL.
   * A shipped migration was edited. A scope that already journaled it will NOT run the new
   * SQL, which is why it is listed apart from `added`.
   */
  changed: MigrationEntry[];
  /** `added` plus `changed`, before the count bound. */
  total: number;
  /** True when entries were left out, or when an entry's SQL was. */
  truncated: boolean;
}

const keyOf = (m: { moduleId: string; version: string }): string => `${m.moduleId}\u001f${m.version}`;

/**
 * `incoming` is the promoted version's migrations. `base` is the serving version's:
 * `undefined` when there is none to compare with, `null` when it carries none.
 */
export function migrationsOnTop(
  incoming: readonly MigrationLike[],
  base: readonly MigrationLike[] | null | undefined,
): MigrationDiff {
  const baseSql = new Map((base ?? []).map((m) => [keyOf(m), m.sql]));
  const added: MigrationLike[] = [];
  const changed: MigrationLike[] = [];
  for (const m of incoming) {
    const before = baseSql.get(keyOf(m));
    if (before === undefined) added.push(m);
    else if (before !== m.sql) changed.push(m);
  }

  // One pass, `changed` first: an edited shipped migration is the case a person most needs
  // to see, so it is the first to be kept and the first to spend the SQL budget.
  let budget = MIGRATION_READ_SQL_BYTES_MAX;
  const kept = [...changed, ...added].slice(0, MIGRATION_READ_MAX).map((m): MigrationEntry => {
    const size = utf8Length(m.sql);
    if (size > budget) return { moduleId: m.moduleId, version: m.version, sql: null };
    budget -= size;
    return { moduleId: m.moduleId, version: m.version, sql: m.sql };
  });
  const total = added.length + changed.length;

  return {
    baseline: base === undefined ? 'none' : base === null ? 'unavailable' : 'version',
    added: kept.slice(changed.length),
    changed: kept.slice(0, changed.length),
    total,
    truncated: kept.length < total || kept.some((e) => e.sql === null),
  };
}
