/**
 * A table holder's rows that share an `idColumn` are all read, whichever row a window ends on
 * (#2154, #2159 review). Nothing makes `idColumn` unique or the principal non-NULL, so a read keyed
 * on the id alone, or on the id and the principal, skipped the rest of an id's rows at a window's
 * edge, and the run-once record then closed the backfill over them for good. Pure, with no runner:
 * each adapter hands it its scope's own SQLite as the kernel's `SwitchSql`, so the cases run on the
 * engine it actually ships, and asserts every case marked what it expected.
 *
 * Harness code: it writes `_substrat_*` rows directly, which is exactly what `ctx.sql` refuses.
 */
import { entityGrantShape } from '@substrat-run/contracts';
import { topUpEntityGrantShapes, ulid, type ShapeCursor, type SwitchSql } from '@substrat-run/kernel';

interface TieCase {
  name: string;
  /** The pairs the backfill marked, and the ones it should have. */
  marked: string[];
  expected: string[];
  /** Whether the run-once record was written once the reconcile finished. */
  recorded: boolean;
}

const KEY = 'shape-tie:use';

/**
 * Three cases, each its own table and entity type, each reconciled at `limit` 1 (one mark, a window
 * of ten rows) until the reconcile finishes:
 *
 * - `duplicate id`: `(e1, A)`, `(e1, B)`, `(e2, C)` on an index of the id alone. The write budget
 *   ends the first pass on A, mid-id.
 * - `null principal at the edge`: nine rows with no principal, then `(e1, NULL)` closing the first
 *   window, then `(e1, A)`. A principal-keyed seek past `(e1, NULL)` compares NULL for every e1 row.
 * - `without rowid`: `(e1, A)`, `(e1, B)`, `(e2, C)` in a `WITHOUT ROWID` table keyed on another
 *   column, with an index on the id.
 */
export function shapeBackfillTies(raw: SwitchSql, ids: { tenantId: string; scopeId: string }): TieCase[] {
  const cases: { name: string; type: string; ddl: string[]; rows: [string, string | null][] }[] = [
    {
      name: 'duplicate id',
      type: 'tieseat',
      ddl: ['CREATE TABLE shape_tie_seat (entity_id TEXT, holder TEXT)', 'CREATE INDEX shape_tie_seat_id ON shape_tie_seat (entity_id)'],
      rows: [['e1', 'A'], ['e1', 'B'], ['e2', 'C']],
    },
    {
      name: 'null principal at the edge',
      type: 'tiedesk',
      ddl: ['CREATE TABLE shape_tie_desk (entity_id TEXT, holder TEXT)', 'CREATE INDEX shape_tie_desk_id ON shape_tie_desk (entity_id)'],
      rows: [...Array.from({ length: 9 }, (_, i): [string, null] => [`a${i}`, null]), ['e1', null], ['e1', 'A']],
    },
    {
      name: 'without rowid',
      type: 'tiebadge',
      ddl: [
        'CREATE TABLE shape_tie_badge (k TEXT PRIMARY KEY, entity_id TEXT, holder TEXT) WITHOUT ROWID',
        'CREATE INDEX shape_tie_badge_id ON shape_tie_badge (entity_id)',
      ],
      rows: [['e1', 'A'], ['e1', 'B'], ['e2', 'C']],
    },
  ];
  return cases.map(({ name, type, ddl, rows }) => {
    const table = ddl[0]!.split(' ')[2]!;
    for (const st of ddl) raw.run(st);
    const expected: string[] = [];
    const keyed = ddl[0]!.includes('WITHOUT ROWID'); // its own key column, `k`
    rows.forEach(([id, who], i) => {
      const holder = who && `${who}-${ulid()}`;
      if (keyed) raw.run(`INSERT INTO ${table} (k, entity_id, holder) VALUES (?, ?, ?)`, `k${i}`, id, holder);
      else raw.run(`INSERT INTO ${table} (entity_id, holder) VALUES (?, ?)`, id, holder);
      if (!holder) return;
      raw.run('INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', `principal:${holder}`, `granted:${KEY}`, `${type}:${id}`);
      expected.push(`principal:${holder} ${type}:${id}`);
    });
    const shapes = [entityGrantShape.parse({ entityType: type, permissions: [KEY], bootstrap: true, holder: { table, idColumn: 'entity_id', principalColumn: 'holder' } })];
    let after: ShapeCursor | null = null;
    let passes = 0;
    do {
      after = topUpEntityGrantShapes(raw, { ...ids, shapes, now: new Date().toISOString(), limit: 1, after, mintEventId: () => ulid(), version: null }).next;
      passes++;
    } while (after && passes < 100);
    const marked = raw
      .all("SELECT subject || ' ' || object AS pair FROM _substrat_tuples WHERE relation = 'bootstrap' AND object >= ? AND object < ? ORDER BY 1", `${type}:`, `${type};`)
      .map((r) => String(r['pair']));
    const recorded = raw.all("SELECT 1 FROM _substrat_tuples WHERE subject = ? AND relation = 'shape-backfilled'", `shape:${type}`).length === 1;
    return { name, marked, expected: expected.sort(), recorded };
  });
}
