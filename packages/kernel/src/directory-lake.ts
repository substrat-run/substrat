import type { PlatformActorId } from '@substrat-run/contracts';
import type { RedactionSql } from './subject-redaction.js';
import type { HostAdmin } from './scope-host.js';
import { assertRowLimit } from './retention.js';

/**
 * The directory's outbox to the lake (K-70, tenants × time data leaves the objects; step 2 of
 * docs/rfc/tenant-scale.md §12), as statements both adapters run against their directory.
 *
 * The directory keeps nine data sets that grow with tenants times time: the admin log, the staff
 * access log, ops failures, sweep runs, model and build usage, and the request, cost and meter
 * days. Each is shipped to the lake the way a scope ships its events: a row is written into an
 * outbox in the SAME transaction as the row it records, and a drain ships the outbox in batches
 * and deletes what the sink confirmed. Nothing here prunes a source row. What is shipped stays in
 * the directory exactly as long as it did before; pruning to a window is a later, separate switch.
 *
 * **Captured by trigger, not by the writers.** An `AFTER INSERT` trigger on each captured table
 * (and `AFTER UPDATE` where rows change after they are written) copies the row into the outbox.
 * That keeps the guarantee K-70 asks of the admin log, written atomically with its change and
 * shipped after, without touching any of the writers: whatever transaction wrote the source row
 * wrote its outbox row, or neither. It also means a column added to a source table cannot be
 * forgotten the way #1237's was: the trigger's column list is derived from the table as built
 * (`ensureDirectoryLakeTriggers`), and re-derived whenever it differs.
 *
 * **Off unless switched on, per data set.** The triggers exist only for the data sets whose
 * capture is on (`_substrat_directory_capture`), and are dropped when it is switched off, so a
 * directory with capture off writes exactly what it wrote before this file existed. The two tables
 * below are created empty either way, because a directory restore builds every table it may load
 * from the directory's DDL.
 *
 * **What the lake gets.** Every version of a row the directory wrote while capture was on: an
 * update ships the row again, with a later `captured_at` and `seq`. A delete ships nothing, which
 * is what lets the directory prune a row the lake keeps. So a key's value in the lake is its
 * latest captured version, and an erasure that redacted a row in place (ops failures, sweep runs)
 * reaches the lake as a later version, not as the removal of the earlier one.
 */

/** One captured data set: its table, its key, and the envelope columns the lake filters on. */
export interface DirectoryLakeDatasetSpec {
  table: string;
  /** The primary key, in order. One column ships as itself, more as a JSON array. */
  key: readonly string[];
  /** The row's own time: an ISO instant, or a UTC day. */
  at: string;
  tenant: string | null;
  scope: string | null;
  /** The column a reader most often filters on (an action, a method, an operation), or none. */
  kind: string | null;
  actor: string | null;
  /** Whether rows change after they are written, so an update is captured too. */
  updates: boolean;
  /** Bookkeeping columns that are facts about the directory's copy, not the row. */
  notShipped: readonly string[];
}

export const DIRECTORY_LAKE_DATASETS = {
  admin_log: {
    table: '_substrat_admin_log', key: ['id'], at: 'at', tenant: 'tenant_id', scope: 'scope_id',
    kind: 'action', actor: 'actor', updates: false, notShipped: [],
  },
  // `drained_at` is the access log's own drain to R2 (K-24), stamped by an UPDATE: a fact about
  // that copy, and not a reason to ship the row a second time.
  access_log: {
    table: '_substrat_access_log', key: ['id'], at: 'at', tenant: 'tenant_id', scope: 'scope_id',
    kind: 'method', actor: 'actor', updates: false, notShipped: ['drained_at'],
  },
  // Updated in place by an erasure (`subject-redaction.ts`), so the redacted version ships too.
  ops_failures: {
    table: '_substrat_ops_failures', key: ['id'], at: 'at', tenant: 'tenant_id', scope: 'scope_id',
    kind: 'operation', actor: 'actor', updates: true, notShipped: [],
  },
  sweep_runs: {
    table: '_substrat_sweep_runs', key: ['id'], at: 'at', tenant: 'tenant_id', scope: 'scope_id',
    kind: 'kind', actor: null, updates: true, notShipped: [],
  },
  model_usage: {
    table: '_substrat_model_usage', key: ['id'], at: 'at', tenant: 'tenant_id', scope: 'scope_id',
    kind: 'model', actor: null, updates: false, notShipped: [],
  },
  build_usage: {
    table: '_substrat_build_usage', key: ['build_id'], at: 'at', tenant: 'tenant_id', scope: null,
    kind: 'vertical', actor: null, updates: false, notShipped: [],
  },
  // The three rollups upsert (`ON CONFLICT … DO UPDATE`), and cost days are re-attributed later.
  request_days: {
    table: '_substrat_request_days', key: ['day', 'tenant_id', 'vertical', 'scope_id'], at: 'day',
    tenant: 'tenant_id', scope: 'scope_id', kind: 'vertical', actor: null, updates: true, notShipped: [],
  },
  cost_days: {
    table: '_substrat_cost_days', key: ['day', 'script', 'scope_id', 'object_class', 'object_id', 'dimension'],
    at: 'day', tenant: 'tenant_id', scope: 'scope_id', kind: 'dimension', actor: null, updates: true, notShipped: [],
  },
  meter_days: {
    table: '_substrat_meter_days', key: ['day', 'tenant_id'], at: 'day', tenant: 'tenant_id', scope: null,
    kind: 'status', actor: null, updates: true, notShipped: [],
  },
} as const satisfies Record<string, DirectoryLakeDatasetSpec>;

export type DirectoryLakeDataset = keyof typeof DIRECTORY_LAKE_DATASETS;

export const DIRECTORY_LAKE_DATASET_NAMES = Object.keys(DIRECTORY_LAKE_DATASETS) as [DirectoryLakeDataset, ...DirectoryLakeDataset[]];

export const isDirectoryLakeDataset = (name: string): name is DirectoryLakeDataset =>
  Object.prototype.hasOwnProperty.call(DIRECTORY_LAKE_DATASETS, name);

/**
 * The outbox and the capture switch. `seq` is AUTOINCREMENT so a number is never handed out twice,
 * even once every row below it has been shipped and deleted: the lake orders a key's versions by it.
 * `row` is the whole source row as a JSON object of its columns, values as stored.
 */
export const DIRECTORY_LAKE_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_directory_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset TEXT NOT NULL,
    row_key TEXT NOT NULL,
    tenant_id TEXT,
    scope_id TEXT,
    at TEXT NOT NULL,
    kind TEXT,
    actor TEXT,
    captured_at TEXT NOT NULL,
    row TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _substrat_directory_capture (
    dataset TEXT PRIMARY KEY,
    since TEXT NOT NULL,
    backfill_until INTEGER NOT NULL DEFAULT 0,
    backfill_after INTEGER NOT NULL DEFAULT 0,
    backfilled_at TEXT
  );
`;

/** One outbox row, or one backfilled source row in the same shape (`seq` null: it never queued). */
export interface DirectoryLakeRow {
  seq: number | null;
  dataset: DirectoryLakeDataset;
  rowKey: string;
  tenantId: string | null;
  scopeId: string | null;
  at: string;
  kind: string | null;
  actor: string | null;
  capturedAt: string;
  /** The source row, a JSON object text. */
  row: string;
}

/**
 * Which data sets capture, and since when; the highest source rowid when capture began (every row
 * above it was written with the trigger in place, so a backfill stops there); how far a real
 * backfill has shipped (the rowid its next page starts after); and `backfilledAt` once it is done.
 */
export interface DirectoryLakeCaptureState {
  dataset: DirectoryLakeDataset;
  since: string;
  backfillUntil: number;
  backfillAfter: number;
  backfilledAt: string | null;
}

/** What one reconcile of the capture switch changed. */
export interface DirectoryLakeCaptureResult {
  enabled: DirectoryLakeDataset[];
  disabled: DirectoryLakeDataset[];
  current: DirectoryLakeCaptureState[];
  /** Triggers rebuilt because the table they copy no longer had the columns they named. */
  rebuilt: number;
}

/** One page of a backfill: the rows in outbox shape, and the cursor after them. */
export interface DirectoryLakeBackfillPage {
  dataset: DirectoryLakeDataset;
  rows: DirectoryLakeRow[];
  /** The last source rowid read, to pass as `after` next; null when the page was empty. */
  next: number | null;
  /** Whether the walk reached the table's end with this page. */
  done: boolean;
}

/**
 * Where the drained rows go. Injected, like `EventSink`: the control plane binds a Pipelines
 * stream; a self-host may bind nothing, and then keeps capture off.
 *
 * `ship` MUST be durable before it resolves: a resolved ship is what licenses deleting the outbox
 * rows, and a sink that returned early would turn the lake's copy into a claim nobody can check.
 */
export interface DirectoryLakeSink {
  ship(rows: DirectoryLakeRow[]): Promise<{ ref: string }>;
}

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const quoteText = (text: string): string => `'${text.replaceAll("'", "''")}'`;
const triggerName = (verb: 'i' | 'u', dataset: DirectoryLakeDataset) => `_substrat_directory_capture_${verb}_${dataset}`;
const CAPTURED_AT = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function columnsOf(sql: RedactionSql, table: string): string[] {
  return (sql(`SELECT name FROM pragma_table_info(?, 'main')`, [table]) as { name: string }[]).map((c) => c.name);
}

/** The envelope and the row, as SQL expressions over one row named by `ref` (`NEW`, or the table). */
function rowExpressions(spec: DirectoryLakeDatasetSpec, columns: readonly string[], ref: string) {
  const col = (c: string) => `${ref}.${quoteIdent(c)}`;
  const opt = (c: string | null) => (c === null ? 'NULL' : col(c));
  const shipped = columns.filter((c) => !spec.notShipped.includes(c));
  return {
    key: spec.key.length === 1 ? `CAST(${col(spec.key[0]!)} AS TEXT)` : `json_array(${spec.key.map(col).join(', ')})`,
    tenant: opt(spec.tenant),
    scope: opt(spec.scope),
    at: col(spec.at),
    kind: opt(spec.kind),
    actor: opt(spec.actor),
    row: `json_object(${shipped.map((c) => `${quoteText(c)}, ${col(c)}`).join(', ')})`,
  };
}

/**
 * The capture triggers a data set needs against the table as it is built now. Spelled as
 * `sqlite_master` keeps it (no IF NOT EXISTS, single spaces), so one in place can be compared
 * with the one this schema needs, text for text.
 */
export function directoryLakeTriggerSql(sql: RedactionSql, dataset: DirectoryLakeDataset): { name: string; sql: string }[] {
  const spec: DirectoryLakeDatasetSpec = DIRECTORY_LAKE_DATASETS[dataset];
  const columns = columnsOf(sql, spec.table);
  const required = [...spec.key, spec.at, spec.tenant, spec.scope, spec.kind, spec.actor].filter((c): c is string => c !== null);
  const missing = required.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    throw new Error(`directory lake: ${spec.table} has no column ${missing.join(', ')}; the ${dataset} capture cannot be built`);
  }
  const e = rowExpressions(spec, columns, 'NEW');
  const body =
    `INSERT INTO _substrat_directory_outbox (dataset, row_key, tenant_id, scope_id, at, kind, actor, captured_at, row) ` +
    `VALUES (${quoteText(dataset)}, ${e.key}, ${e.tenant}, ${e.scope}, ${e.at}, ${e.kind}, ${e.actor}, ${CAPTURED_AT}, ${e.row});`;
  const on = (verb: 'i' | 'u', event: string) => {
    const name = triggerName(verb, dataset);
    return { name, sql: `CREATE TRIGGER ${quoteIdent(name)} AFTER ${event} ON ${quoteIdent(spec.table)} BEGIN ${body} END` };
  };
  return spec.updates ? [on('i', 'INSERT'), on('u', 'UPDATE')] : [on('i', 'INSERT')];
}

function dropTriggers(sql: RedactionSql, dataset: DirectoryLakeDataset): void {
  for (const verb of ['i', 'u'] as const) sql(`DROP TRIGGER IF EXISTS ${quoteIdent(triggerName(verb, dataset))}`, []);
}

/** Build or rebuild one data set's triggers where the ones in place differ. Returns how many it wrote. */
function ensureTriggers(sql: RedactionSql, dataset: DirectoryLakeDataset): number {
  let written = 0;
  for (const t of directoryLakeTriggerSql(sql, dataset)) {
    const held = (sql(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`, [t.name]) as { sql: string }[])[0];
    if (held?.sql === t.sql) continue;
    sql(`DROP TRIGGER IF EXISTS ${quoteIdent(t.name)}`, []);
    sql(t.sql, []);
    written += 1;
  }
  return written;
}

const maxRowid = (sql: RedactionSql, dataset: DirectoryLakeDataset): number =>
  (sql(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${quoteIdent(DIRECTORY_LAKE_DATASETS[dataset].table)}`, []) as { m: number }[])[0]?.m ?? 0;

export function readDirectoryLakeCapture(sql: RedactionSql): DirectoryLakeCaptureState[] {
  return (sql(`SELECT dataset, since, backfill_until, backfill_after, backfilled_at FROM _substrat_directory_capture ORDER BY dataset`, []) as {
    dataset: string; since: string; backfill_until: number; backfill_after: number; backfilled_at: string | null;
  }[])
    .filter((r) => isDirectoryLakeDataset(r.dataset))
    .map((r) => ({
      dataset: r.dataset as DirectoryLakeDataset,
      since: r.since,
      backfillUntil: r.backfill_until,
      backfillAfter: r.backfill_after,
      backfilledAt: r.backfilled_at,
    }));
}

/**
 * Every capturing data set's triggers, held to its table as built. Run where a directory is
 * constructed (a deploy that added a column rebuilds the trigger before the first write) and before
 * every drain (a restore drops every table, and its triggers with it). Writes nothing when nothing
 * differs.
 */
export function ensureDirectoryLakeTriggers(sql: RedactionSql): number {
  let written = 0;
  for (const { dataset } of readDirectoryLakeCapture(sql)) written += ensureTriggers(sql, dataset);
  return written;
}

/**
 * Reconcile the capture switch to `wanted`, in the caller's transaction. A data set switched on
 * gets its triggers and `since = now`; one switched off loses them (its queued rows stay queued and
 * still drain). Switching one back on resets `since` and its backfill mark: the rows written while
 * it was off reached no outbox, so only a new backfill can vouch for them.
 */
export function setDirectoryLakeCapture(
  sql: RedactionSql,
  wanted: readonly DirectoryLakeDataset[],
  now: string,
): DirectoryLakeCaptureResult {
  for (const d of wanted) if (!isDirectoryLakeDataset(d)) throw new Error(`directory lake: no data set named ${String(d)}`);
  const before = new Set(readDirectoryLakeCapture(sql).map((c) => c.dataset));
  const want = new Set(wanted);
  const enabled: DirectoryLakeDataset[] = [];
  const disabled: DirectoryLakeDataset[] = [];
  let rebuilt = 0;
  for (const dataset of DIRECTORY_LAKE_DATASET_NAMES) {
    if (want.has(dataset) && !before.has(dataset)) {
      // Read and written in the transaction that creates the triggers: no row lands between them.
      const until = maxRowid(sql, dataset);
      sql(
        `INSERT INTO _substrat_directory_capture (dataset, since, backfill_until, backfill_after, backfilled_at) VALUES (?, ?, ?, 0, NULL)`,
        [dataset, now, until],
      );
      ensureTriggers(sql, dataset);
      enabled.push(dataset);
    } else if (!want.has(dataset) && before.has(dataset)) {
      dropTriggers(sql, dataset);
      sql(`DELETE FROM _substrat_directory_capture WHERE dataset = ?`, [dataset]);
      disabled.push(dataset);
    } else if (want.has(dataset)) {
      rebuilt += ensureTriggers(sql, dataset);
    } else {
      // Off, and recorded off: a trigger left by a half-applied reconcile is dropped anyway.
      dropTriggers(sql, dataset);
    }
  }
  return { enabled, disabled, current: readDirectoryLakeCapture(sql), rebuilt };
}

interface OutboxRow {
  seq: number; dataset: string; row_key: string; tenant_id: string | null; scope_id: string | null;
  at: string; kind: string | null; actor: string | null; captured_at: string; row: string;
}

const fromOutbox = (r: OutboxRow): DirectoryLakeRow => ({
  seq: r.seq,
  dataset: r.dataset as DirectoryLakeDataset,
  rowKey: r.row_key,
  tenantId: r.tenant_id,
  scopeId: r.scope_id,
  at: r.at,
  kind: r.kind,
  actor: r.actor,
  capturedAt: r.captured_at,
  row: r.row,
});

/** The oldest `limit` queued rows, in the order they were written. */
export function readDirectoryOutbox(sql: RedactionSql, limit: number): DirectoryLakeRow[] {
  assertRowLimit('limit', limit);
  return (sql(
    `SELECT seq, dataset, row_key, tenant_id, scope_id, at, kind, actor, captured_at, row
       FROM _substrat_directory_outbox ORDER BY seq LIMIT ?`,
    [limit],
  ) as OutboxRow[]).map(fromOutbox);
}

/**
 * Delete the queued rows up to and including `upToSeq`, once the sink has confirmed them. `seq`
 * is handed out in write order, so rows queued during the shipment sort after it and stay.
 */
export function ackDirectoryOutbox(sql: RedactionSql, upToSeq: number): number {
  if (!Number.isSafeInteger(upToSeq) || upToSeq < 0) throw new Error(`directory lake: upToSeq must be a whole number, got ${upToSeq}`);
  const n = (sql(`SELECT COUNT(*) AS n FROM _substrat_directory_outbox WHERE seq <= ?`, [upToSeq]) as { n: number }[])[0]?.n ?? 0;
  if (n > 0) sql(`DELETE FROM _substrat_directory_outbox WHERE seq <= ?`, [upToSeq]);
  return n;
}

/**
 * One page of the rows a data set already held, in the outbox's shape, read by rowid after
 * `after` and up to the rowid its capture began at (or the table's end, for a data set not
 * capturing, which only a dry run reads). Rows above that were captured by the trigger, so a walk
 * never chases the rows its own receipts write. Writes nothing: the backfill ships a page directly rather than queueing it, because a
 * table's whole history through the outbox would cost the directory two writes a row for nothing.
 * A row also captured by its trigger reaches the lake twice; the lake keeps a key's latest version.
 */
export function readDirectoryLakeBackfill(
  sql: RedactionSql,
  dataset: DirectoryLakeDataset,
  after: number,
  limit: number,
): DirectoryLakeBackfillPage {
  assertRowLimit('limit', limit);
  if (!isDirectoryLakeDataset(dataset)) throw new Error(`directory lake: no data set named ${String(dataset)}`);
  if (!Number.isSafeInteger(after) || after < 0) throw new Error(`directory lake: after must be a whole number, got ${after}`);
  const spec: DirectoryLakeDatasetSpec = DIRECTORY_LAKE_DATASETS[dataset];
  const e = rowExpressions(spec, columnsOf(sql, spec.table), 't');
  const until = readDirectoryLakeCapture(sql).find((c) => c.dataset === dataset)?.backfillUntil ?? maxRowid(sql, dataset);
  const rows = sql(
    `SELECT t.rowid AS rid, ${e.key} AS row_key, ${e.tenant} AS tenant_id, ${e.scope} AS scope_id, ${e.at} AS at,
            ${e.kind} AS kind, ${e.actor} AS actor, ${CAPTURED_AT} AS captured_at, ${e.row} AS row
       FROM ${quoteIdent(spec.table)} t WHERE t.rowid > ? AND t.rowid <= ? ORDER BY t.rowid LIMIT ?`,
    [after, until, limit],
  ) as (Omit<OutboxRow, 'seq' | 'dataset'> & { rid: number })[];
  return {
    dataset,
    rows: rows.map(({ rid: _rid, ...r }) => fromOutbox({ ...r, seq: null as unknown as number, dataset })),
    next: rows.length === 0 ? null : rows[rows.length - 1]!.rid,
    done: rows.length < limit || rows[rows.length - 1]!.rid >= until,
  };
}

/**
 * Record that a real backfill shipped one page of a CAPTURING data set: the page read after
 * `after` and ending at `next`. Refused unless `after` is where the last recorded page ended, so
 * the walk the mark vouches for has no gap, and refused for a data set not capturing (a row
 * written after the walk passed it would then reach no outbox). `done` records `backfilledAt`.
 * Returns the state after the call; writes nothing when the page was already recorded.
 */
export function advanceDirectoryLakeBackfill(
  sql: RedactionSql,
  dataset: DirectoryLakeDataset,
  page: { after: number; next: number | null; done: boolean },
  now: string,
): { state: DirectoryLakeCaptureState; changed: boolean } {
  const held = readDirectoryLakeCapture(sql).find((c) => c.dataset === dataset);
  if (!held) throw new Error(`directory lake: ${dataset} is not capturing, so a backfill of it vouches for nothing`);
  // Once it reached the end, a later page vouches for nothing new: rows written since are captured.
  if (held.backfilledAt !== null) return { state: held, changed: false };
  const to = page.next ?? page.after;
  if (page.after !== held.backfillAfter) {
    throw new Error(`directory lake: the ${dataset} backfill resumes after rowid ${held.backfillAfter}, not ${page.after}`);
  }
  if (to < page.after) throw new Error(`directory lake: a backfill page cannot end (${to}) before it starts (${page.after})`);
  const backfilledAt = page.done ? now : null;
  if (to === held.backfillAfter && backfilledAt === null) return { state: held, changed: false };
  sql(`UPDATE _substrat_directory_capture SET backfill_after = ?, backfilled_at = COALESCE(backfilled_at, ?) WHERE dataset = ?`, [to, backfilledAt, dataset]);
  return { state: readDirectoryLakeCapture(sql).find((c) => c.dataset === dataset)!, changed: true };
}

/**
 * The switch as the control plane's environment spells it: unset, empty or `off` captures
 * nothing; `all` captures every data set; otherwise a comma list of data set names. A name this
 * code does not know is refused rather than ignored, so a typo cannot read as "on".
 */
export function parseDirectoryLakeCapture(value: string | undefined): DirectoryLakeDataset[] {
  const text = (value ?? '').trim();
  if (text === '' || text === 'off') return [];
  if (text === 'all') return [...DIRECTORY_LAKE_DATASET_NAMES];
  const names = [...new Set(text.split(',').map((s) => s.trim()).filter((s) => s !== ''))];
  const unknown = names.filter((n) => !isDirectoryLakeDataset(n));
  if (unknown.length > 0) {
    throw new Error(`directory lake: unknown data set ${unknown.join(', ')} (known: ${DIRECTORY_LAKE_DATASET_NAMES.join(', ')}, or all, or off)`);
  }
  return names as DirectoryLakeDataset[];
}

/**
 * K-70's proposed window: how many days of each captured data set the directory keeps once the
 * prune is switched on, and the boundary a history read splits at (directory after, lake before).
 * 35 days covers a billing period and a dispute. An open choice in K-70; one constant on purpose.
 */
export const DIRECTORY_LAKE_WINDOW_DAYS = 35;

/** How many outbox rows one batch ships by default, and how many batches one pass may drain. */
export const DIRECTORY_LAKE_BATCH = 500;
export const DIRECTORY_LAKE_BATCHES_PER_PASS = 8;

export interface DirectoryLakeSweepOptions {
  sink: DirectoryLakeSink;
  /** The data sets that capture. Empty switches capture off; queued rows still drain. */
  capture: readonly DirectoryLakeDataset[];
  batch?: number;
  batchesPerPass?: number;
}

export interface DirectoryLakeSweepReport {
  /** What the reconcile changed, or null when the host has no directory outbox. */
  capture: DirectoryLakeCaptureResult | null;
  shipped: number;
  acked: number;
  ref: string | null;
}

/**
 * The pass's phase: reconcile the switch, then ship → confirm → delete, batch after batch while
 * each comes back full, up to `batchesPerPass`. A throw anywhere leaves the unconfirmed rows queued,
 * so the next pass ships them again (at least once, never fewer).
 */
export async function sweepDirectoryLake(
  admin: HostAdmin,
  actor: PlatformActorId,
  options: DirectoryLakeSweepOptions,
  out: DirectoryLakeSweepReport,
): Promise<void> {
  if (!admin.setDirectoryLakeCapture || !admin.directoryOutbox || !admin.ackDirectoryOutbox) return;
  const batch = options.batch ?? DIRECTORY_LAKE_BATCH;
  const batches = options.batchesPerPass ?? DIRECTORY_LAKE_BATCHES_PER_PASS;
  assertRowLimit('batch', batch);
  out.capture = await admin.setDirectoryLakeCapture(actor, options.capture);
  for (let i = 0; i < batches; i++) {
    const pending = await admin.directoryOutbox(actor, batch);
    if (pending.length === 0) return;
    const { ref } = await options.sink.ship(pending);
    out.shipped += pending.length;
    out.ref = ref;
    out.acked += await admin.ackDirectoryOutbox(actor, pending[pending.length - 1]!.seq!, ref);
    if (pending.length < batch) return;
  }
}
