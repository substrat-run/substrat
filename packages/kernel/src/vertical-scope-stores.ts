/**
 * Every scope-store binding a vertical has declared, by any version (#2286, RFC scope-stores L17),
 * shared by both adapters.
 *
 * A store object is named by (tenant, vertical, scope, binding) and carries no version, so a later
 * version that drops a binding leaves the old object holding data. The lifecycle (export, wipe,
 * erasure, the meter) reaches the union of every binding any version declared, which this keeps as
 * a directory table, read by its keys, instead of reading every version's manifest per call.
 *
 * A binding keeps its kind for the life of its vertical. The kind names the store script, so a
 * re-kinded binding would point the same name at another script's object, and the union would have
 * to hold both. `publishVersion` refuses it instead (`conflict`), in the transaction that inserts
 * the version: one door, where the push can still be told to pick a new binding name. A manifest
 * that declares one binding twice is refused there too.
 *
 * Each version is indexed once, and marked in `vertical_scope_store_versions`; a vertical whose
 * versions are all indexed is marked in `vertical_scope_store_indexed`, so a read of it is three
 * keyed lookups and no per-version work. A version stored before these tables, or loaded by a
 * directory restore from an older dump, leaves its vertical unmarked. Whichever comes first, a read
 * or a publish, then indexes all of the vertical's versions, oldest first, in its own transaction:
 * nothing runs on a constructor's path, a restore needs no backfill of its own, and a publish judges
 * a re-kind against every older version, not only those indexed so far. A version whose manifest
 * cannot be read is marked unreadable, and a read of its vertical refuses: it may declare a store
 * nobody can name.
 *
 * Nothing here retires a binding: the record never shrinks (K-50 forbids it as a side effect of a
 * push). The explicit retire step is an open item of the RFC (§10.8).
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
  -- A vertical every version of which is indexed above.
  CREATE TABLE IF NOT EXISTS vertical_scope_store_indexed (
    vertical_slug TEXT PRIMARY KEY
  );
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

/** One version, judged and written; a version already indexed is left as it is. */
function indexOne(db: SwitchSql, verticalSlug: string, versionId: string, manifestJson: string | null): void {
  if (db.all('SELECT 1 AS present FROM vertical_scope_store_versions WHERE version_id = ?', versionId).length > 0) return;
  const declared = declaredIn(manifestJson);
  // Every binding is judged before any is written, so a refusal writes nothing.
  const fresh: VerticalScopeStore[] = [];
  const seen = new Set<string>();
  for (const { binding, kind } of declared ?? []) {
    if (seen.has(binding)) {
      throw substratError('conflict', `a version of '${verticalSlug}' declares scope store '${binding}' twice`);
    }
    seen.add(binding);
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

/** Index every version of the vertical not indexed yet, oldest first, then mark the vertical. */
function indexVertical(db: SwitchSql, verticalSlug: string): void {
  if (db.all('SELECT 1 AS present FROM vertical_scope_store_indexed WHERE vertical_slug = ?', verticalSlug).length > 0) return;
  const unindexed = db.all(
    `SELECT v.id, v.manifest_json FROM vertical_versions AS v
      WHERE v.vertical_slug = ?
        AND NOT EXISTS (SELECT 1 FROM vertical_scope_store_versions AS s WHERE s.version_id = v.id)
      ORDER BY v.created_at, v.id`,
    verticalSlug,
  ) as { id: string; manifest_json: string | null }[];
  for (const { id, manifest_json } of unindexed) indexOne(db, verticalSlug, id, manifest_json);
  db.run('INSERT OR IGNORE INTO vertical_scope_store_indexed (vertical_slug) VALUES (?)', verticalSlug);
}

/**
 * Index a version `publishVersion` is inserting, in the insert's transaction, after its row. The
 * vertical's older versions are indexed first when it is not marked yet, so a re-kind is judged
 * against every version, not only those a read reached. Refuses (`conflict`) a binding the vertical
 * already declared as another kind, or one declared twice, and then nothing is written.
 */
export function indexVersionScopeStores(
  db: SwitchSql,
  verticalSlug: string,
  versionId: string,
  manifestJson: string | null,
): void {
  indexVertical(db, verticalSlug);
  indexOne(db, verticalSlug, versionId, manifestJson);
}

/**
 * Every binding any version of the vertical declared, in binding order. An unmarked vertical is
 * indexed first (the caller runs this in one transaction). Refuses (`unavailable`) when a version's
 * manifest cannot be read, or when versions stored before the record re-kinded a binding: the
 * lifecycle cannot name every store the vertical may hold.
 */
export function verticalScopeStoresOf(db: SwitchSql, verticalSlug: string): VerticalScopeStore[] {
  try {
    indexVertical(db, verticalSlug);
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

/**
 * Every vertical whose any version declared a binding of `kind`, with those bindings (#2300): the
 * store scripts a release rollout of the kind reaches, including a vertical whose serving version
 * dropped the store while a pinned or preview scope still runs one that declares it. Every vertical
 * not indexed yet is indexed first (the caller runs this in one transaction).
 *
 * `unreadable` names the verticals that cannot say: a version whose manifest cannot be read, or
 * versions stored before the record that re-kinded a binding. Any of them may declare the kind, so
 * a caller that must reach every script (a rollout) refuses while the list is not empty, rather
 * than leave a script on another release without saying so.
 */
export function kindDeclarationsOf(
  db: SwitchSql,
  kind: string,
): { verticals: { vertical: string; stores: VerticalScopeStore[] }[]; unreadable: string[] } {
  const slugs = db.all('SELECT DISTINCT vertical_slug FROM vertical_versions ORDER BY vertical_slug') as { vertical_slug: string }[];
  const unreadable = new Set<string>();
  for (const { vertical_slug } of slugs) {
    try {
      indexVertical(db, vertical_slug);
    } catch {
      unreadable.add(vertical_slug);
    }
  }
  for (const { vertical_slug } of db.all(
    'SELECT DISTINCT vertical_slug FROM vertical_scope_store_versions WHERE readable = 0',
  ) as { vertical_slug: string }[]) {
    unreadable.add(vertical_slug);
  }
  const rows = db.all(
    'SELECT vertical_slug, binding FROM vertical_scope_stores WHERE kind = ? ORDER BY vertical_slug, binding',
    kind,
  ) as { vertical_slug: string; binding: string }[];
  const byVertical = new Map<string, VerticalScopeStore[]>();
  for (const { vertical_slug, binding } of rows) {
    const stores = byVertical.get(vertical_slug) ?? [];
    stores.push({ binding, kind });
    byVertical.set(vertical_slug, stores);
  }
  return {
    verticals: [...byVertical].map(([vertical, stores]) => ({ vertical, stores })),
    unreadable: [...unreadable].sort(),
  };
}

/** A deleted vertical's declarations go with its versions, so a slug registered again starts clean. */
export function forgetVerticalScopeStores(db: SwitchSql, verticalSlug: string): void {
  db.run('DELETE FROM vertical_scope_stores WHERE vertical_slug = ?', verticalSlug);
  db.run('DELETE FROM vertical_scope_store_versions WHERE vertical_slug = ?', verticalSlug);
  db.run('DELETE FROM vertical_scope_store_indexed WHERE vertical_slug = ?', verticalSlug);
}
