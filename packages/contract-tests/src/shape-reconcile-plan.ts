/**
 * The shape reconcile's reads, planned by the SQLite each adapter actually runs (#2083).
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
 * Harness code: it writes `_substrat_*` rows directly, which is exactly what `ctx.sql` refuses.
 */
import { entityGrantShape } from '@substrat-run/contracts';
import { topUpEntityGrantShapes, ulid, type ShapeCursor, type SwitchSql } from '@substrat-run/kernel';

type Param = string | number | null;

interface ShapeReconcilePlanReport {
  /** The plan of each marker walk the passes sent (one per retire and top-up walk). */
  walks: string[];
  /** The plan of each grantee backfill read. */
  backfills: string[];
  /** Every planned table scan of `_substrat_tuples`, with the statement that planned it. */
  scans: string[];
  /** Passes the reconcile took, and whether every holder ended up with the whole shape. */
  passes: number;
  complete: boolean;
}

const MARKERS = 30;
const LEGACY = 5;
const KEYS = ['shape-plan:read', 'shape-plan:use'];
const RETIRED = 'shape-plan:old';

/**
 * Seed one shape's world on `raw` — holders of the old shape, legacy grantees with no marker, a
 * retired key, and another type's markers beside them — then reconcile it in small passes, each
 * resuming from the last, planning every statement. Run it on a scope nothing else is writing.
 */
export function shapeReconcilePlans(raw: SwitchSql, ids: { tenantId: string; scopeId: string }): ShapeReconcilePlanReport {
  const tuple = (subject: string, relation: string, object: string) =>
    raw.run('INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', subject, relation, object);
  const pad = (i: number) => String(i).padStart(3, '0');
  for (let i = 0; i < MARKERS; i++) {
    const [who, desk] = [`principal:${ulid()}`, `desk:d${pad(i)}`];
    tuple(who, 'bootstrap', desk);
    tuple(who, `granted:${KEYS[0]}`, desk);
    if (i % 3 === 0) tuple(who, `granted:${RETIRED}`, desk);
    tuple(who, 'bootstrap', `room:d${pad(i)}`); // another type's marker: never read by this shape
  }
  for (let i = 0; i < LEGACY; i++) tuple(`principal:${ulid()}`, `granted:${KEYS[0]}`, `desk:l${pad(i)}`);

  const walks: string[] = [];
  const backfills: string[] = [];
  const scans: string[] = [];
  const plan = (sql: string, params: readonly Param[]) => {
    if (!/^\s*(SELECT|UPDATE|DELETE)/i.test(sql)) return;
    const detail = raw.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => String(r['detail']));
    const joined = detail.join(' | ');
    if (sql.includes('(m.object, m.subject) > (?, ?)')) walks.push(joined);
    if (sql.includes('SELECT DISTINCT t.subject, t.object')) backfills.push(joined);
    // A virtual table (`json_each`) is scanned by design; a scan of the tuple table never is.
    for (const d of detail) if (/^SCAN /.test(d) && !/VIRTUAL TABLE/.test(d)) scans.push(`${d} — ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
  };
  const sql: SwitchSql = {
    all: (q, ...p) => {
      plan(q, p);
      return raw.all(q, ...p);
    },
    run: (q, ...p) => {
      plan(q, p);
      raw.run(q, ...p);
    },
  };

  const shapes = [entityGrantShape.parse({ entityType: 'desk', permissions: KEYS, retired: [RETIRED], bootstrap: true, holder: 'grantee' })];
  let after: ShapeCursor | null = null;
  let passes = 0;
  do {
    after = topUpEntityGrantShapes(sql, {
      ...ids,
      shapes,
      now: new Date().toISOString(),
      limit: 4,
      after,
      mintEventId: () => ulid(),
      version: null,
    }).next;
    passes++;
  } while (after && passes < 100);

  const short = raw.all(
    `SELECT count(*) AS n FROM _substrat_tuples m
      WHERE m.relation = 'bootstrap' AND m.object >= 'desk:' AND m.object < 'desk;'
        AND NOT EXISTS (SELECT 1 FROM _substrat_tuples t WHERE t.subject = m.subject AND t.object = m.object
                         AND t.relation = 'granted:${KEYS[1]}' AND t.revoked_at IS NULL)`,
  )[0]!['n'];
  return { walks, backfills, scans, passes, complete: after === null && Number(short) === 0 };
}
