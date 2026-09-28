import { scopeId, substratError } from '@substrat-run/contracts';
import type { SwitchSql } from './system-switch.js';

/** Where a dump came from, as the caller of a restore, fork or carry knows it (#1869). */
export interface RepointSource {
  /** The scope the dump was captured from. */
  scopeId: string;
  /**
   * True when the platform exported the dump itself (a fork, snapshot, preview, carry, adopt
   * or rebind), so its provenance is a fact rather than a claim. The re-point is then exact
   * even when the dump holds no grant on its source: nothing moves, and there is no fallback.
   */
  exact?: boolean;
}

/**
 * Re-point a dump's scope-level grants at the scope it lands in, the step every restore, fork
 * and preview carry ends with (#1869). One definition for both adapters' `importDump`, so the
 * DO and the pure host cannot move different rows. It was a `LIKE 'scope:%'`, which ignores
 * case and so also moved an entity grant typed `Scope` or `SCOPE`.
 *
 * Scope-level grants are stored as `object = 'scope:<scopeId>'`, naming the scope the dump
 * was captured FROM, so a copy landing anywhere else has to move them. Entity-narrowed
 * grants are stored as `<entityType>:<entityId>` and travel with the dump unchanged.
 *
 * - **Exact**, when the source is named and either the dump holds a `scope:<source>` row or
 *   the source is `exact` (platform-exported): `scope:<source>` and nothing else moves. An
 *   entity grant whose type is spelled `scope` in any case stays put (the write verbs refuse
 *   that type since #1856, but rows written before it are still stored). When the source IS
 *   the destination (a carry onto a new version) nothing moves at all.
 * - **Fallback**, for a dump the caller supplied, when no source is named (a caller that
 *   predates the field) or the dump holds no `scope:<source>` row (its stated provenance does
 *   not describe its rows, as when `substrat scope restore` stamps a local world with the
 *   target's id): every object whose first six characters are exactly `scope:`. That is the
 *   rule before #1869 minus LIKE's case folding, so `Scope:<id>` and `SCOPE:<id>` still stay
 *   put. An entity typed exactly `scope` cannot be told apart from a node grant here, and moves.
 *
 * A caller-supplied dump that holds its source's grants AND grants on a THIRD scope, shaped
 * like a scope node (`scope:<ULID>`) and neither the source nor the destination, is refused:
 * its stated provenance describes only part of it, and moving the rest would guess. The
 * refusal throws inside the load's transaction, so the target keeps what it held. A platform
 * copy (`exact`) is not refused: there a `scope:<X>` row authorized nothing in the source it
 * was exported from, so it is left untouched and authorizes nothing here either. A
 * `scope:<id>` whose id is not a scope id's shape is an entity grant, and is left alone.
 *
 * The probe and the update are separate statements rather than one with an `EXISTS` in its
 * `WHERE`: the update rewrites the very rows the probe looks for, and the answer must not
 * change part-way through.
 *
 * `COLLATE BINARY` is written out because the tuples table's DDL comes from the dump, and a
 * column declared `COLLATE NOCASE` there would make a bare `=` fold case again.
 */
export function repointScopeGrants(sql: SwitchSql, destScopeId: string, source?: RepointSource): void {
  // `exact` is a claim about a named source; with none named it would silently take the fallback.
  if (source !== undefined && !source.scopeId) {
    throw substratError('validation_failed', 'restore refused: `exact` needs the scope the dump came from');
  }
  const dest = `scope:${destScopeId}`;
  const update = 'UPDATE OR REPLACE _substrat_tuples SET object = ? WHERE object <> ? COLLATE BINARY AND';
  const from = source === undefined ? undefined : `scope:${source.scopeId}`;
  if (from === undefined || (!source?.exact && sql.all(SOURCE_PROBE, from).length === 0)) {
    sql.run(`${update} substr(object, 1, 6) = 'scope:' COLLATE BINARY`, dest, dest);
    return;
  }
  const strays = source!.exact
    ? []
    : sql
        .all(STRAY_SCOPES, from, dest)
        .map((r) => String(r.object))
        .filter((o) => scopeId.safeParse(o.slice('scope:'.length)).success);
  if (strays.length > 0) {
    throw substratError(
      'validation_failed',
      `restore refused: the dump holds grants on ${strays.length} scope(s) other than its source ` +
        `(${source!.scopeId}) and this scope (${destScopeId}), which a restore cannot re-point: ` +
        `${strays.slice(0, 3).join(', ')}${strays.length > 3 ? ', …' : ''}`,
    );
  }
  sql.run(`${update} object = ? COLLATE BINARY`, dest, dest, from);
}

const SOURCE_PROBE = 'SELECT 1 FROM _substrat_tuples WHERE object = ? COLLATE BINARY LIMIT 1';
// Live rows only: a revoked grant (K-21 tombstone) on a third scope authorizes nothing anywhere.
const STRAY_SCOPES = `SELECT DISTINCT object FROM _substrat_tuples
  WHERE substr(object, 1, 6) = 'scope:' COLLATE BINARY AND object <> ? COLLATE BINARY AND object <> ? COLLATE BINARY
    AND revoked_at IS NULL
  ORDER BY object`;
