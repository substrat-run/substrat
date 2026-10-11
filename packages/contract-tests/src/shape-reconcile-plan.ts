/**
 * The shape reconcile's reads, planned by the SQLite each adapter actually runs (#2083, #2154).
 *
 * A pass walks a shape's markers on `_substrat_tuples_shape_marker`, a partial index SQLite uses
 * only where it can prove the index's `relation = 'bootstrap'` from the query. A relation term it
 * cannot prove that from, or an object prefix written as `substr`, plans a scan of the whole tuple
 * table, which no functional test notices, because a test scope has a dozen rows. So the probe here drives the kernel's own
 * pass over a scope's real schema and asks the engine to plan every statement the pass sends,
 * exactly as sent. Pure, with no runner: each adapter hands it its scope's own SQLite as the
 * kernel's `SwitchSql` (over a `better-sqlite3` file, a Durable Object's `storage.sql`) and
 * asserts on the report.
 *
 * The backfill reads in windows too (#2154), for each holder kind: the probe seeds legacy holders
 * of a `'self'`, a `'grantee'` and a table-holder shape, and reports each kind's read plans, how
 * many rows each pass fetched, and how many markers the backfill wrote, so an adapter can assert
 * every holder was marked exactly once. Given the engine's own count of rows read (a Durable
 * Object's `cursor.rowsRead`), it reports the most any one pass read, every statement included,
 * which is the bound a scope actually pays.
 *
 * Harness code: it writes `_substrat_*` rows directly, which is exactly what `ctx.sql` refuses.
 */
import { entityGrantShape } from '@substrat-run/contracts';
import { SHAPE_MARKER_READS_PER_ROW, topUpEntityGrantShapes, ulid, type ShapeCursor, type SwitchSql } from '@substrat-run/kernel';

type Param = string | number | null;

type HolderKind = 'self' | 'grantee' | 'table';

interface ShapeReconcilePlanReport {
  /** The plan of each marker walk the passes sent (one per retire and top-up walk). */
  walks: string[];
  /** The plan of each backfill read, by the holder kind it read for. */
  backfills: Record<HolderKind, string[]>;
  /** Every planned table scan of `_substrat_tuples`, with the statement that planned it. */
  scans: string[];
  /** Passes the reconcile took, and whether every holder ended up with the whole shape. */
  passes: number;
  complete: boolean;
  /** Markers the backfill wrote, and how many legacy holders there were to mark. */
  marks: number;
  holders: number;
  /** The most rows any one pass's backfill reads fetched, and the read budget of a pass. */
  maxFetched: number;
  window: number;
  /** The most rows the engine read in one pass, every statement included: given `rowsRead` only. */
  maxRowsRead: number | null;
}

const MARKERS = 30;
const LIMIT = 4;
const KEYS = ['shape-plan:read', 'shape-plan:use'];
const RETIRED = 'shape-plan:old';
const BADGES = 'shape_plan_badge';

/**
 * Seed three shapes' worlds on `raw` — holders of the old shape, legacy holders with no marker for
 * each holder kind, a retired key, and another type's markers beside them — then reconcile them in
 * small passes, each resuming from the last, planning every statement. `legacy` legacy holders per
 * kind (default 5); `rowsRead`, when the engine counts them, the running total of rows it has read.
 * Run it on a scope nothing else is writing.
 */
export function shapeReconcilePlans(
  raw: SwitchSql,
  ids: { tenantId: string; scopeId: string },
  opts: { legacy?: number; rowsRead?: () => number } = {},
): ShapeReconcilePlanReport {
  const legacy = opts.legacy ?? 5;
  const tuple = (subject: string, relation: string, object: string) =>
    raw.run('INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', subject, relation, object);
  const pad = (i: number) => String(i).padStart(5, '0');
  for (let i = 0; i < MARKERS; i++) {
    const [who, desk] = [`principal:${ulid()}`, `desk:d${pad(i)}`];
    tuple(who, 'bootstrap', desk);
    tuple(who, `granted:${KEYS[0]}`, desk);
    if (i % 3 === 0) tuple(who, `granted:${RETIRED}`, desk);
    tuple(who, 'bootstrap', `room:d${pad(i)}`); // another type's marker: never read by this shape
  }
  raw.run(`CREATE TABLE IF NOT EXISTS ${BADGES} (id TEXT PRIMARY KEY, holder TEXT)`);
  for (let i = 0; i < legacy; i++) {
    const [grantee, owner, badged] = [ulid(), ulid(), ulid()];
    tuple(`principal:${grantee}`, `granted:${KEYS[0]}`, `desk:l${pad(i)}`);
    tuple(`principal:${owner}`, `granted:${KEYS[0]}`, `seat:${owner}`);
    tuple(`principal:${ulid()}`, `granted:${KEYS[0]}`, `seat:${owner}`); // a sharee on it: never marked
    raw.run(`INSERT INTO ${BADGES} (id, holder) VALUES (?, ?)`, `b${pad(i)}`, badged);
    tuple(`principal:${badged}`, `granted:${KEYS[0]}`, `badge:b${pad(i)}`);
  }

  const walks: string[] = [];
  const backfills: Record<HolderKind, string[]> = { self: [], grantee: [], table: [] };
  const scans: string[] = [];
  let [marks, fetched] = [0, 0];
  /** Which holder kind a statement is the backfill read of, if it is one. */
  const backfillOf = (sql: string, params: readonly Param[]): HolderKind | null =>
    sql.includes(`FROM "${BADGES}" e`) ? 'table' : sql.includes('(t.object, t.relation, t.subject) > (?, ?, ?)') ? (params.includes('seat;') ? 'self' : 'grantee') : null;
  const plan = (sql: string, params: readonly Param[]) => {
    if (!/^\s*(SELECT|UPDATE|DELETE)/i.test(sql)) return;
    const detail = raw.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => String(r['detail']));
    const joined = detail.join(' | ');
    if (sql.includes('(m.object, m.subject) > (?, ?)')) walks.push(joined);
    const kind = backfillOf(sql, params);
    if (kind) backfills[kind].push(joined);
    // A virtual table (`json_each`, `pragma_table_list`) is scanned by design; a scan of the tuple
    // table, or of the holder's table, never is.
    for (const d of detail) if (/^SCAN /.test(d) && !/VIRTUAL TABLE/.test(d)) scans.push(`${d} — ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
  };
  const sql: SwitchSql = {
    all: (q, ...p) => {
      if (q.startsWith('EXPLAIN')) return raw.all(q, ...p); // the kernel's own plan check: not a read of rows
      plan(q, p);
      const rows = raw.all(q, ...p);
      if (backfillOf(q, p)) fetched += rows.length;
      return rows;
    },
    run: (q, ...p) => {
      plan(q, p);
      if (q.startsWith('INSERT OR IGNORE') && p[1] === 'bootstrap') marks++;
      raw.run(q, ...p);
    },
  };

  const shapes = [
    entityGrantShape.parse({ entityType: 'desk', permissions: KEYS, retired: [RETIRED], bootstrap: true, holder: 'grantee' }),
    entityGrantShape.parse({ entityType: 'seat', permissions: KEYS, bootstrap: true, holder: 'self' }),
    entityGrantShape.parse({ entityType: 'badge', permissions: KEYS, bootstrap: true, holder: { table: BADGES, idColumn: 'id', principalColumn: 'holder' } }),
  ];
  let after: ShapeCursor | null = null;
  let passes = 0;
  let maxFetched = 0;
  let maxRowsRead = 0;
  do {
    fetched = 0;
    const before = opts.rowsRead?.() ?? 0;
    after = topUpEntityGrantShapes(sql, {
      ...ids,
      shapes,
      now: new Date().toISOString(),
      limit: LIMIT,
      after,
      mintEventId: () => ulid(),
      version: null,
    }).next;
    maxFetched = Math.max(maxFetched, fetched);
    // `EXPLAIN QUERY PLAN` executes nothing, so the probe's own planning adds no rows read.
    maxRowsRead = Math.max(maxRowsRead, (opts.rowsRead?.() ?? 0) - before);
    passes++;
  } while (after && passes < 100_000);

  const short = raw.all(
    `SELECT count(*) AS n FROM _substrat_tuples m
      WHERE m.relation = 'bootstrap' AND ((m.object >= 'desk:' AND m.object < 'desk;') OR (m.object >= 'seat:' AND m.object < 'seat;')
                                          OR (m.object >= 'badge:' AND m.object < 'badge;'))
        AND NOT EXISTS (SELECT 1 FROM _substrat_tuples t WHERE t.subject = m.subject AND t.object = m.object
                         AND t.relation = 'granted:${KEYS[1]}' AND t.revoked_at IS NULL)`,
  )[0]!['n'];
  const markers = raw.all(
    `SELECT count(*) AS n FROM _substrat_tuples WHERE relation = 'bootstrap'
        AND ((object >= 'desk:l' AND object < 'desk:m') OR (object >= 'seat:' AND object < 'seat;') OR (object >= 'badge:' AND object < 'badge;'))`,
  )[0]!['n'];
  const holders = legacy * 3;
  return {
    walks,
    backfills,
    scans,
    passes,
    complete: after === null && Number(short) === 0 && Number(markers) === holders,
    marks,
    holders,
    maxFetched,
    window: LIMIT * SHAPE_MARKER_READS_PER_ROW,
    maxRowsRead: opts.rowsRead ? maxRowsRead : null,
  };
}
