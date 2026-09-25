/**
 * A version's SQL migrations, stored apart from its manifest (#1764), shared by both adapters.
 *
 * Since #1677 a pushed deploy manifest carries its whole cumulative migration set
 * (`migrations: { moduleId, version, sql }[]`). The manifest is one `manifest_json` column on
 * `vertical_versions`, so every read of a version moved that SQL too: `readVersion` on every
 * admit, promote and bind, and every `storedDeployManifest.parse` behind `/registry`, `/model`,
 * `/schedules` and the serving upload. Only the promote review reads the SQL.
 *
 * So `publishVersion` splits the field off: the SQL goes to `vertical_version_migrations`, one
 * row per migration, and the manifest is stored without it. The wire is unchanged, since the
 * CLI still sends `migrations` inside the manifest. Two columns on `vertical_versions` carry
 * what the rows alone cannot:
 *
 * - `migration_count`: how many rows the version stored. **NULL means the version carries no
 *   SQL** (pushed before #1677, over the push's caps, or malformed), which a reader must show
 *   as "not available", never as "no migrations". `0` is a version whose modules ship none. A
 *   read whose row count disagrees with it answers null rather than a short list.
 * - `migrations_split`: 1 once the version's SQL is out of its manifest. NULL is a version
 *   stored before this, whose manifest may still carry it. The backfill below moves those a
 *   bounded batch at a time, and until it reaches a version the read falls back to that
 *   version's manifest. The fallback is only for those rows. A version published by this code
 *   is split on the way in.
 */
import {
  deployManifest,
  storedDeployManifest,
  type DeclaredMigration,
  type ModuleId,
} from '@substrat-run/contracts';
import type { SwitchSql } from './system-switch.js';

/**
 * The table, and the index the backfill walks. Interpolated into both adapters' directory DDL,
 * so `lint:spine-ddl` sees one spelling on each side.
 *
 * The index is partial: it holds only versions still waiting for the backfill, so "is there
 * anything left" is one probe that costs nothing once the backfill is done. It names a column
 * a directory from before #1764 lacks, so the adapters run these statements after their
 * column additions, not in their DDL loop.
 */
export const VERSION_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS vertical_version_migrations (
    version_id TEXT NOT NULL,
    -- The migration's place in the order the host runs them, from 0.
    ordinal    INTEGER NOT NULL,
    module_id  TEXT NOT NULL,
    -- The module's SqlMigration.version, e.g. 0001-init.
    version    TEXT NOT NULL,
    sql        TEXT NOT NULL,
    PRIMARY KEY (version_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS vertical_versions_unsplit
    ON vertical_versions (id) WHERE migrations_split IS NULL;
`;

/** True for a DDL statement the adapters hold back until `vertical_versions` has its columns. */
export function isVersionMigrationsDdl(statement: string): boolean {
  return statement.includes('vertical_version_migrations') || statement.includes('vertical_versions_unsplit');
}

/** A manifest with its SQL taken out, and the SQL. */
export interface SplitManifest {
  /** The manifest to store: without `migrations`, or exactly as given when there was nothing to take. */
  manifestJson: string | null;
  /** The migrations to store, or null when the version carries none that can be stored. */
  migrations: DeclaredMigration[] | null;
}

/**
 * Take `migrations` out of a manifest.
 *
 * `push` holds the field to the push boundary's caps (`deployManifest`): at most 2000 entries
 * and 512 KiB of SQL, which also bounds every row under a Durable Object's 2 MB row limit. A
 * field over the caps, or not shaped like migrations, is dropped and the version reads as
 * "SQL not available", so the promote dialog still asks. Refusing instead would fail the
 * push after its script was uploaded. `stored` is for a manifest already in the directory,
 * whose history the caps must never make unreadable (`storedDeployManifest`).
 *
 * A manifest that is not a JSON object is returned as it came, with no migrations. The
 * manifest is only rewritten when it has a `migrations` key to remove.
 */
export function splitManifestMigrations(manifestJson: string | null, mode: 'push' | 'stored'): SplitManifest {
  if (manifestJson === null) return { manifestJson, migrations: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return { manifestJson, migrations: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('migrations' in parsed)) {
    return { manifestJson, migrations: null };
  }
  const { migrations: carried, ...rest } = parsed as Record<string, unknown>;
  const schema = (mode === 'push' ? deployManifest : storedDeployManifest).shape.migrations;
  const result = schema.safeParse(carried);
  return {
    manifestJson: JSON.stringify(rest),
    migrations: result.success && result.data !== undefined ? result.data : null,
  };
}

/** Replace one version's migration rows. The caller sets its `migration_count` and `migrations_split`. */
export function writeVersionMigrations(
  db: SwitchSql,
  versionId: string,
  migrations: readonly DeclaredMigration[] | null,
): void {
  db.run('DELETE FROM vertical_version_migrations WHERE version_id = ?', versionId);
  (migrations ?? []).forEach((m, ordinal) => {
    db.run(
      `INSERT INTO vertical_version_migrations (version_id, ordinal, module_id, version, sql)
       VALUES (?, ?, ?, ?, ?)`,
      versionId, ordinal, m.moduleId, m.version, m.sql,
    );
  });
}

/** How many versions one backfill batch moves at most. */
const BATCH_VERSIONS = 25;
/**
 * How much manifest one batch reads at most, in characters (the first version is always
 * moved). A stored manifest can be up to about 1.5 MiB, and a batch holds the directory DO.
 */
const BATCH_MANIFEST_CHARS = 4 * 1024 * 1024;

/**
 * Move the SQL out of the next versions stored before #1764: at most `limit` of them, and
 * at most `BATCH_MANIFEST_CHARS` of manifest. Returns how many it moved, and whether any are
 * left.
 *
 * Bounded so that no one run has to read the whole version history: the Durable-Object
 * adapter runs one batch per alarm and re-arms while any are left, so its constructor never
 * does per-version work. Resumable because each version is marked as it is moved, in the
 * caller's transaction with its rows. A version is moved by the same `splitManifestMigrations`
 * a push goes through, in `stored` mode, so history is read without the push caps.
 *
 * Idempotent: a version that is already split is never selected, and moving one replaces its
 * rows. A directory restored from a dump taken before the backfill comes back unsplit and is
 * simply moved again.
 */
export function splitVersionMigrationsBatch(
  db: SwitchSql,
  limit: number = BATCH_VERSIONS,
): { moved: number; more: boolean } {
  // The ids come off the partial index alone; each manifest is read only when it is moved.
  const ids = db.all(
    'SELECT id FROM vertical_versions WHERE migrations_split IS NULL ORDER BY id LIMIT ?',
    limit,
  ) as { id: string }[];
  let moved = 0;
  let chars = 0;
  for (const { id } of ids) {
    if (moved > 0 && chars >= BATCH_MANIFEST_CHARS) break;
    const { manifest_json: stored } = db.all('SELECT manifest_json FROM vertical_versions WHERE id = ?', id)[0] as {
      manifest_json: string | null;
    };
    chars += stored?.length ?? 0;
    const split = splitManifestMigrations(stored, 'stored');
    writeVersionMigrations(db, id, split.migrations);
    const count = split.migrations?.length ?? null;
    // A manifest with nothing taken out is left where it is, not rewritten.
    if (split.manifestJson === stored) {
      db.run('UPDATE vertical_versions SET migration_count = ?, migrations_split = 1 WHERE id = ?', count, id);
    } else {
      db.run(
        'UPDATE vertical_versions SET manifest_json = ?, migration_count = ?, migrations_split = 1 WHERE id = ?',
        split.manifestJson, count, id,
      );
    }
    moved++;
  }
  return { moved, more: versionsAwaitSplit(db) };
}

/** Whether any version still waits for the backfill. One probe of the partial index. */
export function versionsAwaitSplit(db: SwitchSql): boolean {
  return db.all('SELECT 1 AS present FROM vertical_versions WHERE migrations_split IS NULL LIMIT 1').length > 0;
}

/**
 * One version's migrations, in the order the host runs them. `undefined` when there is no
 * such version. `migrations` is null when the version carries none that can be shown, which
 * a reader must say as "not available", never as "no migrations".
 */
export function versionMigrationsOf(
  db: SwitchSql,
  versionId: string,
): { verticalSlug: string; migrations: DeclaredMigration[] | null } | undefined {
  // The manifest is read only for a version the backfill has not reached: its SQL, if any,
  // is still in there. A split version's manifest carries none, so it is left unread.
  const row = db.all(
    `SELECT vertical_slug, migration_count, migrations_split,
            CASE WHEN migrations_split IS NULL THEN manifest_json END AS manifest_json
       FROM vertical_versions WHERE id = ?`,
    versionId,
  )[0] as
    | { vertical_slug: string; migration_count: number | null; migrations_split: number | null; manifest_json: string | null }
    | undefined;
  if (!row) return undefined;
  if (row.migrations_split === null) {
    return { verticalSlug: row.vertical_slug, migrations: splitManifestMigrations(row.manifest_json, 'stored').migrations };
  }
  if (row.migration_count === null) return { verticalSlug: row.vertical_slug, migrations: null };
  const rows = db.all(
    `SELECT module_id, version, sql FROM vertical_version_migrations
      WHERE version_id = ? ORDER BY ordinal`,
    versionId,
  ) as { module_id: string; version: string; sql: string }[];
  // Never a short list: rows that disagree with the count are not the version's migrations.
  if (rows.length !== row.migration_count) return { verticalSlug: row.vertical_slug, migrations: null };
  return {
    verticalSlug: row.vertical_slug,
    // Parsed on the way in (`splitManifestMigrations`), so the brand is the stored value's.
    migrations: rows.map((r) => ({ moduleId: r.module_id as ModuleId, version: r.version, sql: r.sql })),
  };
}
