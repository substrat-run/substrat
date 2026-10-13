/**
 * Filter by a list of any length in ONE bound parameter (#2248).
 *
 * A Durable Object's SQLite refuses a statement binding more than 100 parameters, so the
 * natural spelling — `WHERE id IN (${ids.map(() => '?').join(', ')})` — passes every small
 * fixture and fails the first hosted call whose list outgrew it. The list goes in as one JSON
 * array instead, read back with `json_each`, which is SQLite's own JSON1 table-valued function
 * and runs the same on both adapters (better-sqlite3 and the Durable Object):
 *
 * ```ts
 * const ids = inList(usedIds);
 * ctx.sql.exec(`UPDATE acme_items SET used = used + 1 WHERE id IN ${ids.sql}`, [now, ...ids.params]);
 * ```
 *
 * `IN` stays in the caller's SQL, so the statement still reads as what it is. An empty list
 * matches nothing, which is what `IN` of nothing means (a hand-built `IN ()` is a syntax
 * error).
 *
 * **Pass values in the column's own type.** A `json_each` value carries no affinity, so only a
 * numeric column converts: `inList(['123'])` matches an INTEGER `123`, but `inList([1])` matches
 * NO row of a TEXT column — not `'1'`, and not the `'1.0'` a bound `1` would match. A TEXT id is
 * passed as a string (`ids.map(String)`), or the comparison is cast (`CAST(col AS INTEGER)`).
 *
 * Only strings and finite numbers: JSON has no `bigint` or blob, and it writes `NaN` and
 * `Infinity` as `null`, which would drop the value from the list without a word — so a
 * non-finite number throws instead.
 *
 * boundary-lint R12 refuses the hand-built placeholder list in module code and points here.
 */
export interface InList {
  /** `(SELECT value FROM json_each(?))` — write it after `IN` / `NOT IN`. */
  readonly sql: typeof IN_LIST_SQL;
  /** The one parameter `sql` binds, in its position among the statement's others. */
  readonly params: readonly [string];
}

const IN_LIST_SQL = '(SELECT value FROM json_each(?))';

export function inList(values: readonly (string | number)[]): InList {
  for (const v of values) {
    if (typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'string') {
      throw new TypeError(`inList: ${String(v)} is not a string or a finite number`);
    }
  }
  return { sql: IN_LIST_SQL, params: [JSON.stringify(values)] };
}
