import { scopeId, substratError } from '@substrat-run/contracts';
import { liveTupleSql } from './permission-eval.js';
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
 * **Which row wins a collision (#1882).** `(subject, relation, object)` is the primary key,
 * so a moved row can land on a row the dump already holds for the destination. That used to
 * be `UPDATE OR REPLACE`, so the moved row always won, `expires_at` and `revoked_at` with it:
 * a revoked or expired source row could replace a live grant on the destination. The rule
 * now, with "live" meaning not revoked and not expired at `now`:
 *
 * | moved row | destination row | kept                                          |
 * |-----------|-----------------|-----------------------------------------------|
 * | live      | live            | the destination row, expiry and all           |
 * | live      | revoked/expired | the moved row                                 |
 * | dead      | any             | the destination row                           |
 *
 * So a live row beats a dead one, and otherwise the destination row stays: between two live
 * rows a restore never widens an expiry the destination already had. Two moved rows that
 * would land on the same key (only the fallback moves more than one object) are settled the
 * same way, live first and then the lower `object`, before either meets the destination. The
 * loser is deleted: it cannot stay under its old object, because a row naming another scope
 * is exactly what a later restore of this scope refuses. Everything runs inside the load's
 * transaction, and the final `UPDATE` is a plain one, so a collision this missed fails the
 * restore instead of replacing a row.
 *
 * `COLLATE BINARY` is written out on every comparison. Since #1883 the tuples table is always
 * built from the kernel's DDL, never the dump's, so its columns are BINARY already; the
 * collation stays as a second guard, so this function never depends on the table it is
 * handed having the right one.
 */
export function repointScopeGrants(
  sql: SwitchSql,
  destScopeId: string,
  source: RepointSource | undefined,
  /** The instant `expires_at` is judged against, as the adapter's checker judges it. */
  now: string,
): void {
  // `exact` is a claim about a named source; with none named it would silently take the fallback.
  if (source !== undefined && !source.scopeId) {
    throw substratError('validation_failed', 'restore refused: `exact` needs the scope the dump came from');
  }
  const dest = `scope:${destScopeId}`;
  const from = source === undefined ? undefined : `scope:${source.scopeId}`;
  if (from === undefined || (!source?.exact && sql.all(SOURCE_PROBE, from).length === 0)) {
    moveOnto(sql, dest, now, undefined);
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
  moveOnto(sql, dest, now, from);
}

/**
 * Move onto `dest` every row naming `from` (the exact rule), or every `scope:` row when `from`
 * is undefined (the fallback), settling each key collision by the rule in
 * `repointScopeGrants`'s header. A row already on `dest` is never moved.
 */
function moveOnto(sql: SwitchSql, dest: string, now: string, from: string | undefined): void {
  // Whether the row under `alias` moves. Binds `moved` (below), in that order.
  const isMoved = (alias: string) =>
    `(${from === undefined ? `substr(${alias}.object, 1, 6) = 'scope:'` : `${alias}.object = ?`} COLLATE BINARY ` +
    `AND ${alias}.object <> ? COLLATE BINARY)`;
  const moved = from === undefined ? [dest] : [from, dest];
  // The checker's own definition of live, so a restore keeps the row a check would honour. Binds `now`.
  const live = (alias: string) => `(${liveTupleSql(alias)})`;
  const sameKey = (a: string, b: string) =>
    `${a}.subject = ${b}.subject COLLATE BINARY AND ${a}.relation = ${b}.relation COLLATE BINARY`;
  // `_substrat_tuples` is the row being judged; SQLite takes no alias on a DELETE's target.
  const T = '_substrat_tuples';

  // 1. Between two moved rows for one key: live first, then the lower object.
  sql.run(
    `DELETE FROM ${T} WHERE ${isMoved(T)} AND EXISTS (
       SELECT 1 FROM ${T} o WHERE ${sameKey('o', T)} AND ${isMoved('o')} AND o.object <> ${T}.object COLLATE BINARY
         AND (${live('o')} > ${live(T)} OR (${live('o')} = ${live(T)} AND o.object < ${T}.object COLLATE BINARY)))`,
    ...moved,
    ...moved,
    now,
    now,
    now,
    now,
  );
  // 2. A moved row loses to the destination row unless it is live and the destination row is not.
  sql.run(
    `DELETE FROM ${T} WHERE ${isMoved(T)} AND EXISTS (
       SELECT 1 FROM ${T} d WHERE ${sameKey('d', T)} AND d.object = ? COLLATE BINARY
         AND (${live('d')} OR NOT ${live(T)}))`,
    ...moved,
    dest,
    now,
    now,
  );
  // 3. Every moved row still standing beat the destination row for its key, which goes.
  sql.run(
    `DELETE FROM ${T} WHERE object = ? COLLATE BINARY AND EXISTS (
       SELECT 1 FROM ${T} o WHERE ${sameKey('o', T)} AND ${isMoved('o')})`,
    dest,
    ...moved,
  );
  // 4. No key collides now. A plain UPDATE, so one that still did would fail the restore.
  sql.run(`UPDATE ${T} SET object = ? WHERE ${isMoved(T)}`, dest, ...moved);
}

const SOURCE_PROBE = 'SELECT 1 FROM _substrat_tuples WHERE object = ? COLLATE BINARY LIMIT 1';
// Live rows only: a revoked grant (K-21 tombstone) on a third scope authorizes nothing anywhere.
const STRAY_SCOPES = `SELECT DISTINCT object FROM _substrat_tuples
  WHERE substr(object, 1, 6) = 'scope:' COLLATE BINARY AND object <> ? COLLATE BINARY AND object <> ? COLLATE BINARY
    AND revoked_at IS NULL
  ORDER BY object`;
