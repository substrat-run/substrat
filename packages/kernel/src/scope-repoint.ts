import type { SwitchSql } from './system-switch.js';

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
 * - **Exact**, when the caller names the source scope AND the dump holds a `scope:<source>`
 *   row: that object and nothing else. An entity grant whose type is spelled `scope` in any
 *   case stays put (the write verbs refuse that type since #1856, but rows written before it
 *   are still stored). When the source IS the destination (a carry onto a new version, a
 *   scope restored from its own backup) nothing moves at all.
 * - **Fallback**, when no source is named (a caller that predates the field) or the dump
 *   holds no `scope:<source>` row (its stated provenance does not describe its rows, as when
 *   `substrat scope restore` stamps a local world with the target's id): every object whose
 *   first six characters are exactly `scope:`. That is the rule before #1869 minus LIKE's case
 *   folding, so `Scope:<id>` and `SCOPE:<id>` still stay put. An entity typed exactly `scope`
 *   cannot be told apart from a node grant here, and moves.
 *
 * The probe and the update are two statements rather than one with an `EXISTS` in its
 * `WHERE`: the update rewrites the very rows the probe looks for, and the answer must not
 * change part-way through.
 *
 * `COLLATE BINARY` is written out because the tuples table's DDL comes from the dump, and a
 * column declared `COLLATE NOCASE` there would make a bare `=` fold case again.
 */
export function repointScopeGrants(sql: SwitchSql, destScopeId: string, sourceScopeId?: string): void {
  const dest = `scope:${destScopeId}`;
  const source = sourceScopeId === undefined ? undefined : `scope:${sourceScopeId}`;
  const update = 'UPDATE OR REPLACE _substrat_tuples SET object = ? WHERE object <> ? COLLATE BINARY AND';
  if (source !== undefined && sql.all(SOURCE_PROBE, source).length > 0) {
    sql.run(`${update} object = ? COLLATE BINARY`, dest, dest, source);
  } else {
    sql.run(`${update} substr(object, 1, 6) = 'scope:' COLLATE BINARY`, dest, dest);
  }
}

const SOURCE_PROBE = 'SELECT 1 FROM _substrat_tuples WHERE object = ? COLLATE BINARY LIMIT 1';
