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
 * - `migration_digest_derived` (#2339): 1 once `migration_digest` is the one the control plane
 *   derives from these rows and the manifest's `doClasses`, never the one the push sent. NULL is
 *   a version stored before this, whose digest is still the pushed one: a backfill re-derives
 *   those a batch at a time, and a read of one derives it first.
 */
import {
  declaredMigrationDeclarations,
  deployManifest,
  migrationDigestOf,
  reviewLine,
  storedDeployManifest,
  substratError,
  UNHELD_MIGRATION_DIGEST_PREFIX,
  unheldMigrationDigest,
  type DeclaredMigration,
  type ModuleId,
} from '@substrat-run/contracts';
import type { SwitchSql } from './system-switch.js';

/**
 * The table, and the index the backfill walks. Interpolated into both adapters' directory DDL,
 * so `lint:spine-ddl` sees one spelling on each side. Anything that references this table or
 * this index goes in this fragment, which is what the adapters run after their column additions.
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
    -- The migration's declared moves and discards (#2322), as JSON { moves?, discards? }.
    -- NULL = it declares none, or was stored before they were carried.
    declarations TEXT,
    PRIMARY KEY (version_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS vertical_versions_unsplit
    ON vertical_versions (id) WHERE migrations_split IS NULL;
  -- #2339: versions whose migration_digest is still the pushed one, not yet re-derived.
  CREATE INDEX IF NOT EXISTS vertical_versions_underived
    ON vertical_versions (id) WHERE migration_digest_derived IS NULL;
`;

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
 * and 512 KiB of SQL, which also bounds every row under a Durable Object's 2 MB row limit.
 * `/deploy` already refuses an over-cap set, before the upload, because it parses the whole
 * manifest with `deployManifest`. This split caps whatever reaches `publishVersion` by any
 * route, including `POST /verticals/:slug/versions`, which stores `manifestJson` unparsed
 * (#1765). There, a field over the caps or not shaped like migrations is dropped and the
 * version reads as "SQL not available", so the promote dialog still asks. `stored` is for a
 * manifest already in the directory, whose history the caps must never make unreadable
 * (`storedDeployManifest`).
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

/** The `declarations` column of one row: JSON `{ moves?, discards? }`, or NULL when it declares none. */
function declarationsJson(m: DeclaredMigration): string | null {
  if (!m.moves && !m.discards) return null;
  return JSON.stringify({ ...(m.moves ? { moves: m.moves } : {}), ...(m.discards ? { discards: m.discards } : {}) });
}

/** What a stored `declarations` column must parse as: the push boundary's own schema, and nothing else. */
const storedDeclarations = declaredMigrationDeclarations.strict();

/**
 * One row's declarations as a `DeclaredMigration`'s spread, or null when the column holds
 * something that is not a declaration — which the caller answers as "not available" for the
 * whole version, never as a list that silently lost what a migration may lose.
 */
function declarationsOf(json: string | null): Pick<DeclaredMigration, 'moves' | 'discards'> | null {
  if (json === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = storedDeclarations.safeParse(parsed);
  if (!result.success || (!result.data.moves && !result.data.discards)) return null;
  return {
    ...(result.data.moves ? { moves: result.data.moves } : {}),
    ...(result.data.discards ? { discards: result.data.discards } : {}),
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
      `INSERT INTO vertical_version_migrations (version_id, ordinal, module_id, version, sql, declarations)
       VALUES (?, ?, ?, ?, ?, ?)`,
      versionId, ordinal, m.moduleId, m.version, m.sql, declarationsJson(m),
    );
  });
}

/**
 * The two reads that find unsplit versions. Named so the kernel's test can EXPLAIN these
 * exact strings: each must be answered from `vertical_versions_unsplit`, never by a scan of
 * every version's row (and its manifest's overflow pages).
 */
export const UNSPLIT_IDS_SQL = 'SELECT id FROM vertical_versions WHERE migrations_split IS NULL ORDER BY id LIMIT ?';
export const UNSPLIT_PROBE_SQL = 'SELECT 1 AS present FROM vertical_versions WHERE migrations_split IS NULL LIMIT 1';

/** How many versions one backfill batch moves at most. */
const BATCH_VERSIONS = 25;
/**
 * How much manifest one batch reads at most, in UTF-8 bytes (the first version is always
 * moved). A stored manifest can be up to about 1.5 MiB, and a batch holds the directory DO.
 * Bytes, because what a batch costs is the bytes it reads: a manifest of four-byte characters
 * is four times its character count.
 */
export const BATCH_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * Move the SQL out of the next versions stored before #1764: at most `limit` of them, and
 * at most `BATCH_MANIFEST_BYTES` of manifest. Returns how many it moved, and whether any are
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
  const ids = db.all(UNSPLIT_IDS_SQL, limit) as { id: string }[];
  let moved = 0;
  let bytes = 0;
  for (const { id } of ids) {
    // The candidate is measured before it is taken, so a batch never passes the bound by one
    // more manifest. The first is always taken, or a manifest over the bound would never move.
    // `octet_length` (SQLite 3.43+) counts bytes; `length` would count code points.
    const { size } = db.all(
      'SELECT COALESCE(octet_length(manifest_json), 0) AS size FROM vertical_versions WHERE id = ?',
      id,
    )[0] as { size: number };
    if (moved > 0 && bytes + size > BATCH_MANIFEST_BYTES) break;
    bytes += size;
    const { manifest_json: stored } = db.all('SELECT manifest_json FROM vertical_versions WHERE id = ?', id)[0] as {
      manifest_json: string | null;
    };
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
  return db.all(UNSPLIT_PROBE_SQL).length > 0;
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
    `SELECT module_id, version, sql, declarations FROM vertical_version_migrations
      WHERE version_id = ? ORDER BY ordinal`,
    versionId,
  ) as { module_id: string; version: string; sql: string; declarations: string | null }[];
  // Never a short list: rows that disagree with the count are not the version's migrations.
  if (rows.length !== row.migration_count) return { verticalSlug: row.vertical_slug, migrations: null };
  const migrations: DeclaredMigration[] = [];
  for (const r of rows) {
    // Never a list without what a migration declares it may lose (#2322): a row whose
    // declarations do not read makes the whole version "not available".
    const declared = declarationsOf(r.declarations);
    if (declared === null) return { verticalSlug: row.vertical_slug, migrations: null };
    // Parsed on the way in (`splitManifestMigrations`), so the brand is the stored value's.
    migrations.push({ moduleId: r.module_id as ModuleId, version: r.version, sql: r.sql, ...declared });
  }
  return { verticalSlug: row.vertical_slug, migrations };
}

/**
 * The `reason` on a push refused because its `digests.migration` is not the one the control plane
 * derives from the migrations it carries (#2339).
 */
export const MIGRATION_DIGEST_MISMATCH_REASON = 'migration_digest_mismatch';

/** The manifest's `doClasses` as the stored parser reads them (absent is `[]`), or null when they do not read. */
function doClassesOf(raw: unknown): string[] | null {
  const result = storedDeployManifest.shape.doClasses.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * A version's migration digest as the control plane derives it (#2339): `migrationDigestOf`
 * over the manifest's `doClasses` and the migrations the version stores, with what each
 * declares. A version that stores no migrations to derive it from (`migrations` null), or whose
 * `doClasses` do not read, gets `unheldMigrationDigest`, which equals no other version's.
 */
export async function derivedMigrationDigest(
  versionId: string,
  doClasses: unknown,
  migrations: readonly DeclaredMigration[] | null,
): Promise<string> {
  const classes = doClassesOf(doClasses);
  if (migrations === null || classes === null) return unheldMigrationDigest(versionId);
  return migrationDigestOf({ doClasses: classes, migrations });
}

/**
 * The migration digest a publish stores (#2339): the one derived from what it stores, never the
 * one pushed. A push that carries its migrations and pushed another digest is refused
 * (`validation_failed`, reason {@link MIGRATION_DIGEST_MISMATCH_REASON}): either its CLI hashes
 * something other than what it sent, or it hashes less than the platform compares. One that
 * carries none is not refused, since nothing can check it, and stores the unheld digest.
 */
export async function publishedMigrationDigest(input: {
  id: string;
  migrationDigest: string;
  manifestJson: string | null;
  migrations: readonly DeclaredMigration[] | null;
}): Promise<string> {
  let doClasses: unknown;
  if (input.manifestJson !== null) {
    try {
      doClasses = (JSON.parse(input.manifestJson) as { doClasses?: unknown } | null)?.doClasses;
    } catch {
      doClasses = null;
    }
  }
  const derived = await derivedMigrationDigest(
    input.id,
    input.manifestJson === null ? null : doClasses,
    input.migrations,
  );
  if (input.migrations !== null && derived !== input.migrationDigest) {
    throw substratError(
      'validation_failed',
      `the push's migration digest (${input.migrationDigest}) is not the digest of the migrations it carries ` +
        `(${derived}). The platform derives the digest a promote compares from the migrations and their declared ` +
        'moves and discards itself, so a push must hash exactly those: upgrade to a CLI release whose push digest ' +
        'covers its SQL migrations and their declarations (npm i -g @substrat-run/cli), and push again',
      { reason: MIGRATION_DIGEST_MISMATCH_REASON },
    );
  }
  return derived;
}

/** The two reads that find versions whose digest is not derived yet, answered from `vertical_versions_underived`. */
export const UNDERIVED_IDS_SQL =
  'SELECT id FROM vertical_versions WHERE migration_digest_derived IS NULL ORDER BY id LIMIT ?';
export const UNDERIVED_PROBE_SQL = 'SELECT 1 AS present FROM vertical_versions WHERE migration_digest_derived IS NULL LIMIT 1';

/** How many versions one digest batch derives at most. Each reads at most the push's 512 KiB of SQL. */
const DIGEST_BATCH_VERSIONS = 10;

/**
 * Derive one stored version's migration digest from its stored rows and record it (#2339),
 * unless it is derived already. Returns the digest the version now holds, or undefined when
 * there is no such version.
 *
 * Two statements, not a transaction: the digest is computed between them (Web Crypto is
 * asynchronous), and the write is guarded on the row still being underived, so two derivations
 * racing write the same value once. A version's migrations and `doClasses` never change after
 * it is published, so what was read is what is recorded.
 */
export async function deriveVersionMigrationDigest(db: SwitchSql, versionId: string): Promise<string | undefined> {
  const row = db.all(
    `SELECT migration_digest, migration_digest_derived,
            CASE WHEN manifest_json IS NULL THEN 0 ELSE 1 END AS has_manifest,
            CASE WHEN json_valid(manifest_json) THEN json_extract(manifest_json, '$.doClasses') END AS do_classes
       FROM vertical_versions WHERE id = ?`,
    versionId,
  )[0] as
    | { migration_digest: string; migration_digest_derived: number | null; has_manifest: number; do_classes: string | null }
    | undefined;
  if (!row) return undefined;
  if (row.migration_digest_derived !== null) return row.migration_digest;
  let doClasses: unknown = null;
  if (row.has_manifest === 1) {
    try {
      // `json_extract` answers an array as its JSON text, and NULL for a manifest without the key.
      doClasses = row.do_classes === null ? undefined : JSON.parse(row.do_classes);
    } catch {
      doClasses = null;
    }
  }
  const digest = await derivedMigrationDigest(versionId, doClasses, versionMigrationsOf(db, versionId)?.migrations ?? null);
  db.run(
    'UPDATE vertical_versions SET migration_digest = ?, migration_digest_derived = 1 WHERE id = ? AND migration_digest_derived IS NULL',
    digest, versionId,
  );
  return (db.all('SELECT migration_digest FROM vertical_versions WHERE id = ?', versionId)[0] as { migration_digest: string }).migration_digest;
}

/**
 * Re-derive the next versions stored before #2339, whose migration digest is still the one their
 * push sent: at most `limit` of them. Returns how many it derived, and whether any are left.
 * Resumable and idempotent on #1764's terms: each version is marked as it is derived, and a
 * derived one is never selected again. Until the backfill reaches a version, a read of it
 * derives it first (`deriveVersionMigrationDigest`), so no gate compares a pushed digest.
 */
export async function deriveMigrationDigestsBatch(
  db: SwitchSql,
  limit: number = DIGEST_BATCH_VERSIONS,
): Promise<{ derived: number; more: boolean }> {
  const ids = db.all(UNDERIVED_IDS_SQL, limit) as { id: string }[];
  for (const { id } of ids) await deriveVersionMigrationDigest(db, id);
  return { derived: ids.length, more: versionsAwaitDigest(db) };
}

/** Whether any version's migration digest still waits to be derived. One probe of the partial index. */
export function versionsAwaitDigest(db: SwitchSql): boolean {
  return db.all(UNDERIVED_PROBE_SQL).length > 0;
}

/**
 * The promote gate's refusal when the migration digest moved and the change was not acknowledged.
 * A side whose digest is unheld (#2339) is named with why it always asks, so a vertical whose
 * pushes leave their SQL out of the manifest is not surprised that every promote does.
 */
export function migrationChangeRefusal(outgoing: string, incoming: string): string {
  const unheld = [outgoing, incoming]
    .filter((d) => d.startsWith(UNHELD_MIGRATION_DIGEST_PREFIX))
    .map((d) => d.slice(UNHELD_MIGRATION_DIGEST_PREFIX.length));
  return (
    `promotion changes migrations (${outgoing} → ${incoming}) — acknowledge it explicitly to promote` +
    (unheld.length === 0
      ? ''
      : `. ${unheld.length === 1 ? `Version ${reviewLine(unheld[0]!)} holds` : `Versions ${unheld.map((id) => reviewLine(id)).join(' and ')} hold`} ` +
        'no migrations the platform can compare: the push left them out of the manifest (over the size a manifest ' +
        'carries, or from before manifests carried them), so a promote to or over it always asks for this acknowledgement')
  );
}
