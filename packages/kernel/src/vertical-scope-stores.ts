/**
 * Every scope-store binding a vertical has declared, by any version (#2286, RFC scope-stores L17),
 * shared by both adapters.
 *
 * A store object is named by (tenant, vertical, scope, binding) and carries no version, so a later
 * version that drops a binding leaves the old object holding data. The lifecycle (export, wipe,
 * erasure, the meter) reaches the union of every binding any version declared, which this keeps as
 * a directory table: one indexed read, instead of reading every version's manifest per call.
 *
 * A binding keeps its kind for the life of its vertical. The kind names the store script, so a
 * re-kinded binding would point the same name at another script's object, and the union would have
 * to hold both. `publishVersion` refuses it instead (`conflict`), in the transaction that inserts
 * the version: one door, where the push can still be told to pick a new binding name.
 *
 * Each version is indexed once, and marked in `vertical_scope_store_versions`. `publishVersion`
 * indexes the version it inserts. A version stored before this table, or loaded by a directory
 * restore from an older dump, is indexed on the first read of its vertical's bindings, so nothing
 * runs on a constructor's path and a restore needs no backfill of its own. A version whose manifest
 * cannot be read is marked unreadable, and a read of its vertical refuses: it may declare a store
 * nobody can name.
 */
import { substratError } from '@substrat-run/contracts';
import type { SwitchSql } from './system-switch.js';

/** Interpolated into both adapters' directory DDL, so `lint:spine-ddl` sees one spelling on each side. */
export const VERTICAL_SCOPE_STORES_DDL = `
  CREATE TABLE IF NOT EXISTS vertical_scope_stores (
    vertical_slug    TEXT NOT NULL,
    binding          TEXT NOT NULL,
    kind             TEXT NOT NULL,
    -- The version that declared the binding first.
    first_version_id TEXT NOT NULL,
    PRIMARY KEY (vertical_slug, binding)
  );
  CREATE TABLE IF NOT EXISTS vertical_scope_store_versions (
    version_id    TEXT PRIMARY KEY,
    vertical_slug TEXT NOT NULL,
    -- 0: the manifest could not be read, so the version may declare a store nobody can name.
    readable      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS vertical_scope_store_versions_slug
    ON vertical_scope_store_versions (vertical_slug, readable);
`;

/** One declared binding. */
export interface VerticalScopeStore {
  readonly binding: string;
  readonly kind: string;
}

/**
 * The bindings a stored manifest declares, or null when the manifest cannot be read. No manifest
 * declares none. Read for its shape only, `{ binding, kind }` strings as the router reads them:
 * whether a kind is one the platform runs is the push's question, and a record that refused to
 * hold a kind it did not know could not refuse that kind's re-kind either.
 */
function declaredIn(manifestJson: string | null): VerticalScopeStore[] | null {
  if (manifestJson === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(manifestJson);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const stores = (raw as { scopeStores?: unknown }).scopeStores;
  if (stores === undefined) return [];
  if (!Array.isArray(stores)) return null;
  const declared: VerticalScopeStore[] = [];
  for (const store of stores as unknown[]) {
    const { binding, kind } = (store ?? {}) as { binding?: unknown; kind?: unknown };
    if (typeof binding !== 'string' || typeof kind !== 'string') return null;
    declared.push({ binding, kind });
  }
  return declared;
}

/**
 * Index one version's declarations, refusing (`conflict`) a binding the vertical already declared
 * as another kind. Run in the transaction that inserts the version, or that reads the vertical.
 * Idempotent: a version already indexed is left as it is.
 */
export function indexVersionScopeStores(
  db: SwitchSql,
  verticalSlug: string,
  versionId: string,
  manifestJson: string | null,
): void {
  if (db.all('SELECT 1 AS present FROM vertical_scope_store_versions WHERE version_id = ?', versionId).length > 0) return;
  const declared = declaredIn(manifestJson);
  // Every binding is judged before any is written, so a refusal writes nothing.
  const fresh: VerticalScopeStore[] = [];
  for (const { binding, kind } of declared ?? []) {
    const [held] = db.all(
      'SELECT kind FROM vertical_scope_stores WHERE vertical_slug = ? AND binding = ?',
      verticalSlug, binding,
    ) as { kind: string }[];
    if (held && held.kind !== kind) {
      throw substratError(
        'conflict',
        `scope store '${binding}' of '${verticalSlug}' is a '${held.kind}', and a binding keeps its kind for ` +
          `the life of its vertical: objects of the old kind may still hold data under that name. ` +
          `Declare the '${kind}' store under a new binding name`,
      );
    }
    if (!held) fresh.push({ binding, kind });
  }
  for (const { binding, kind } of fresh) {
    db.run(
      'INSERT INTO vertical_scope_stores (vertical_slug, binding, kind, first_version_id) VALUES (?, ?, ?, ?)',
      verticalSlug, binding, kind, versionId,
    );
  }
  db.run(
    'INSERT INTO vertical_scope_store_versions (version_id, vertical_slug, readable) VALUES (?, ?, ?)',
    versionId, verticalSlug, declared === null ? 0 : 1,
  );
}

/**
 * Every binding any version of the vertical declared, in binding order. Versions not indexed yet
 * are indexed first (the caller runs this in one transaction). Refuses (`unavailable`) when a
 * version's manifest cannot be read, or when versions stored before the table re-kinded a binding:
 * the lifecycle cannot name every store the vertical may hold.
 */
export function verticalScopeStoresOf(db: SwitchSql, verticalSlug: string): VerticalScopeStore[] {
  const unindexed = db.all(
    `SELECT v.id, v.manifest_json FROM vertical_versions AS v
      WHERE v.vertical_slug = ?
        AND NOT EXISTS (SELECT 1 FROM vertical_scope_store_versions AS s WHERE s.version_id = v.id)
      ORDER BY v.created_at, v.id`,
    verticalSlug,
  ) as { id: string; manifest_json: string | null }[];
  try {
    for (const { id, manifest_json } of unindexed) indexVersionScopeStores(db, verticalSlug, id, manifest_json);
  } catch (error) {
    throw substratError('unavailable', `the scope stores of '${verticalSlug}' cannot be named: ${String((error as Error).message ?? error)}`);
  }
  if (db.all('SELECT 1 AS present FROM vertical_scope_store_versions WHERE vertical_slug = ? AND readable = 0 LIMIT 1', verticalSlug).length > 0) {
    throw substratError('unavailable', `a version of '${verticalSlug}' has a manifest that cannot be read, so its scope stores cannot be named`);
  }
  return (db.all(
    'SELECT binding, kind FROM vertical_scope_stores WHERE vertical_slug = ? ORDER BY binding',
    verticalSlug,
  ) as { binding: string; kind: string }[]).map(({ binding, kind }) => ({ binding, kind }));
}

/** A deleted vertical's declarations go with its versions, so a slug registered again starts clean. */
export function forgetVerticalScopeStores(db: SwitchSql, verticalSlug: string): void {
  db.run('DELETE FROM vertical_scope_stores WHERE vertical_slug = ?', verticalSlug);
  db.run('DELETE FROM vertical_scope_store_versions WHERE vertical_slug = ?', verticalSlug);
}
