import {
  LAKE_LITERAL,
  adminLogEntry,
  modelUsageEntry,
  opsFailureEntry,
  pageOf,
  sweepRunEntry,
  upstreamReferenceMarker,
  type AdminLogEntry,
  type ModelUsageEntry,
  type OpsFailureEntry,
  type Page,
  type PlatformActorId,
  type ScopeId,
  type SweepRunEntry,
  type TenantId,
} from '@substrat-run/contracts';
import {
  DIRECTORY_LAKE_WINDOW_DAYS,
  type AuditLogFilter,
  type DirectoryLakeDataset,
  type HostAdmin,
  type ModelUsageFilter,
  type OpsFailureFilter,
  type SweepRunFilter,
} from '@substrat-run/kernel';
import type { LakeQueryEngine } from './lake-gateway.js';

/**
 * K-70 (tenants × time data leaves the objects), step 2 part 2: history beyond the directory's
 * window, read from the lake's directory table (`kernel.directory`, fed by the directory outbox,
 * `packages/kernel/src/directory-lake.ts`).
 *
 * **The split.** A read is cut at the window's start (`DIRECTORY_LAKE_WINDOW_DAYS` before now):
 * rows from then on come from the directory, as today, and rows before it from the lake. The two
 * halves are disjoint by the row's own time, and walked in the read's order, so one page may hold
 * rows from both and its cursor (the last row's id) continues across the seam.
 *
 * **The switch** (`DirectoryLakeReads`), off by default, because the prune is what makes the lake
 * the only copy and it is not on yet:
 * - `off`: the directory answers everything, exactly as before.
 * - `compare`: the directory still answers everything; the part before the window is also read
 *   from the lake and the two are compared, the difference logged. The verify phase.
 * - `on`: the part before the window comes from the lake. Turned on before the prune, then the
 *   prune; switched back off, the directory answers again for what it still holds.
 *
 * **Isolation**, as `lake-gateway.ts` holds it for events: no caller supplies SQL; every value is a
 * literal from `LAKE_LITERAL`'s alphabet or refused; the data set and, for a tenant's read, the
 * tenant are the first conjuncts; and every row the engine answers is checked against both, a
 * mismatch failing the whole read.
 *
 * **Versions.** The lake keeps every version of a row; a read keeps one per `row_key`, the latest
 * by `captured_at` then `seq` (a backfilled row has no `seq`). The admin log never updates a row,
 * so its versions are copies of one row, but the rule is the data set's, not the admin log's.
 *
 * **Which reads.** One seam (`readDirectoryHistory`), one spec per data set keyed by a ULID id:
 * - admin log: `GET /admin-log` and the tenant export (#3405);
 * - ops failures: `GET /ops-failures` (the console's failures view, the `reference` lookup, the
 *   CLI's `status`, the dashboard's failure groups);
 * - sweep runs: `GET /sweep-runs` (the console's Sweeps);
 * - model usage: `GET /model-usage` (the console's ledger), and only that: the summary, billing,
 *   reconciliation and review-spend reads aggregate over the directory and do not read the lake,
 *   which is why model usage is not in `DIRECTORY_LAKE_HISTORY_READ`.
 * Every other reader of these data sets asks for rows inside the window (a `since` of days, or the
 * newest few), which the directory keeps. The day-keyed rollups (request, cost and meter days, build
 * usage) are folded per day by their readers and are not read this way.
 *
 * **Filters the envelope does not carry** (a vertical, a code, a unit) are judged on the stored row
 * after the query, so a read may scan several lake pages to fill one; past a bound the page is short
 * and its cursor continues the scan (`DirectoryHistoryPage.resume`).
 */
export type DirectoryLakeReads = 'off' | 'compare' | 'on';

export function parseDirectoryLakeReads(value: string | undefined): DirectoryLakeReads {
  const v = (value ?? '').trim();
  if (v === '' || v === 'off') return 'off';
  if (v === 'compare' || v === 'on') return v;
  throw new Error(`directory lake reads: expected off, compare or on, got ${v}`);
}

/** The lake's directory table — `LAKES.directory` in `scripts/lake-provision.mjs`. */
const DIRECTORY_LAKE_TABLE = 'kernel.directory';

const COLUMNS = ['seq', 'dataset', 'row_key', 'tenant_id', 'scope_id', 'at', 'kind', 'actor', 'captured_at', 'row'] as const;

/** The filters a directory lake read may carry; each maps to one envelope column. */
export interface DirectoryLakeFilter {
  tenantId?: string;
  scopeId?: string;
  actor?: string;
  /** One value, or any of several (`kind IN (…)`). */
  kind?: string | readonly string[];
  /** Inclusive lower and exclusive upper bound on the row's own time (ISO 8601). */
  since?: string;
  until?: string;
  /** Keyset on `row_key`, exclusive, in the read's order. */
  cursor?: string;
  order: 'asc' | 'desc';
  limit: number;
}

function literal(value: string): string {
  if (!LAKE_LITERAL.test(value)) throw new Error('directory lake: refusing a literal outside the lake alphabet');
  return `'${value}'`;
}

/** One page of one data set's rows as SQL. One row over the limit, so duplicates cannot end a walk early. */
export function compileDirectoryLakeQuery(dataset: DirectoryLakeDataset, filter: DirectoryLakeFilter): string {
  if (!Number.isInteger(filter.limit) || filter.limit < 1) throw new Error('directory lake: limit must be a positive integer');
  const where = [`dataset = ${literal(dataset)}`];
  if (filter.tenantId !== undefined) where.push(`tenant_id = ${literal(filter.tenantId)}`);
  if (filter.scopeId !== undefined) where.push(`scope_id = ${literal(filter.scopeId)}`);
  if (filter.actor !== undefined) where.push(`actor = ${literal(filter.actor)}`);
  if (filter.kind !== undefined) {
    const kinds = typeof filter.kind === 'string' ? [filter.kind] : [...filter.kind];
    if (kinds.length === 0) throw new Error('directory lake: an empty kind list matches nothing; ask for no filter instead');
    where.push(kinds.length === 1 ? `kind = ${literal(kinds[0]!)}` : `kind IN (${kinds.map(literal).join(', ')})`);
  }
  if (filter.since !== undefined) where.push(`at >= ${literal(filter.since)}`);
  if (filter.until !== undefined) where.push(`at < ${literal(filter.until)}`);
  if (filter.cursor !== undefined) where.push(`row_key ${filter.order === 'desc' ? '<' : '>'} ${literal(filter.cursor)}`);
  const order = filter.order === 'desc' ? 'DESC' : 'ASC';
  // Twice the page, so a key's other versions (a retried batch, a backfill beside a capture) cannot
  // shorten a page that has more rows behind it.
  return (
    `SELECT ${COLUMNS.join(', ')} FROM ${DIRECTORY_LAKE_TABLE} WHERE ${where.join(' AND ')} ` +
    `ORDER BY row_key ${order} LIMIT ${filter.limit * 2 + 1}`
  );
}

/** A row the engine handed back outside the data set or tenant asked about. */
export class DirectoryLakeMismatchError extends Error {
  constructor(what: string) {
    super(`directory lake: the engine returned a row outside ${what}; the read is refused whole`);
    this.name = 'DirectoryLakeMismatchError';
  }
}

/** One lake row, reduced to what a reader needs: its key, and the source row as stored. */
export interface DirectoryLakeRecord {
  rowKey: string;
  row: Record<string, unknown>;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : -1);
const capturedMs = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : Number.NaN);

/**
 * One page of a data set's rows from the lake, one per key (its latest version), in the read's
 * order, at most `limit`. Answers whether the lake held more past the page.
 */
export async function queryDirectoryLake(
  engine: LakeQueryEngine,
  dataset: DirectoryLakeDataset,
  filter: DirectoryLakeFilter,
): Promise<{ records: DirectoryLakeRecord[]; more: boolean }> {
  const answered = await engine.query(compileDirectoryLakeQuery(dataset, filter));
  const latest = new Map<string, { at: number; seq: number; raw: Record<string, unknown> }>();
  const keys: string[] = [];
  for (const raw of answered) {
    if (raw['dataset'] !== dataset) throw new DirectoryLakeMismatchError(`data set ${dataset}`);
    if (filter.tenantId !== undefined && raw['tenant_id'] !== filter.tenantId) throw new DirectoryLakeMismatchError(`tenant ${filter.tenantId}`);
    const key = String(raw['row_key']);
    const at = capturedMs(raw['captured_at']);
    const seq = num(raw['seq']);
    const held = latest.get(key);
    if (!held) keys.push(key);
    if (!held || at > held.at || (at === held.at && seq > held.seq)) latest.set(key, { at, seq, raw });
  }
  // The engine's order is kept; the last key may have versions past the page, so it is dropped
  // when the answer was full, and the page ends before it.
  const full = answered.length > filter.limit * 2;
  const usable = full ? keys.slice(0, -1) : keys;
  const records = usable.slice(0, filter.limit).map((key) => {
    const raw = latest.get(key)!.raw;
    const row = typeof raw['row'] === 'string' ? (JSON.parse(raw['row']) as Record<string, unknown>) : (raw['row'] as Record<string, unknown>);
    return { rowKey: key, row };
  });
  return { records, more: full || usable.length > filter.limit };
}

/** An admin-log row as the directory stores it (snake_case, JSON columns as text), as an entry. */
export function adminLogEntryOfLakeRow(row: Record<string, unknown>): AdminLogEntry {
  const json = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v);
  return adminLogEntry.parse({
    id: row['id'],
    actor: row['actor'],
    action: row['action'],
    tenantId: row['tenant_id'] ?? null,
    scopeId: row['scope_id'] ?? null,
    vertical: row['vertical'] ?? null,
    before: json(row['before']),
    after: json(row['after']),
    causedBy: row['caused_by'] ?? null,
    onBehalfOf: json(row['on_behalf_of']),
    at: row['at'],
  });
}

/** The start of the directory's window: rows at or after it are the directory's to answer. */
export function directoryWindowStart(nowMs: number, windowDays = DIRECTORY_LAKE_WINDOW_DAYS): string {
  return new Date(nowMs - windowDays * 86_400_000).toISOString();
}

/** What a history read needs, per request. */
export interface DirectoryHistoryDeps {
  admin: HostAdmin;
  actor: PlatformActorId;
  lake: LakeQueryEngine | undefined;
  mode: DirectoryLakeReads;
  nowMs: number;
  /** Where a compare's difference is reported. `console.warn` in the worker. */
  report?: (line: Record<string, unknown>) => void;
  /** The lake scan's bound; `DIRECTORY_LAKE_SCAN_PAGE` rows a step, `DIRECTORY_LAKE_SCAN_PAGES` steps. */
  scan?: { page: number; pages: number };
}

/** The name #3405 shipped, kept for its callers. */
export type AdminLogHistoryDeps = DirectoryHistoryDeps;

/** The page fields every history read carries. `limit` is required: a history read is a page. */
export interface DirectoryHistoryFilter {
  since?: string;
  until?: string;
  cursor?: string;
  order?: 'asc' | 'desc';
  limit: number;
}

/**
 * One data set's history read: how a filter maps onto the lake's envelope columns, which rows
 * pass the filters the envelope does not carry, and how a stored row becomes the entry the
 * directory read returns. Only data sets keyed by a ULID `id` fit, because the cursor is the
 * entry's id on both sides of the seam and `row_key` is that id in the lake.
 */
export interface DirectoryHistorySpec<E, F extends DirectoryHistoryFilter> {
  dataset: DirectoryLakeDataset;
  /** The order the directory read uses when the filter names none. */
  defaultOrder: 'asc' | 'desc';
  /** The filters the envelope columns carry, compiled into the lake query. */
  envelope(filter: F): Pick<DirectoryLakeFilter, 'tenantId' | 'scopeId' | 'actor' | 'kind'>;
  /**
   * The rows of one scanned lake page that pass the filters the envelope cannot carry, judged on
   * the stored row (its columns as the directory holds them). Given the page, not one row, because
   * a filter may relate rows to each other (`referenceInText` finds a pair). None: every row passes.
   */
  select?(filter: F, rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[];
  entryOf(row: Record<string, unknown>): E;
  idOf(entry: E): string;
  atOf(entry: E): string;
}

/**
 * One page of a history read. `resume` is set when the lake was scanned as far as one read may go
 * (`DIRECTORY_LAKE_SCAN_PAGES`) without filling the page or reaching the end: the page is short,
 * and the walk continues after `resume`, which is then the page's cursor.
 */
export interface DirectoryHistoryPage<E> {
  entries: E[];
  resume: string | null;
}

/**
 * How many lake rows one scan step asks for when rows are judged after the query (a `select`), and
 * how many steps one read may take. A filter the envelope does not carry may match few rows, so the
 * read scans; bounded, because each step is an R2 SQL query. Past the bound the page is short and
 * carries `resume`, never silently cut.
 */
export const DIRECTORY_LAKE_SCAN_PAGE = 200;
export const DIRECTORY_LAKE_SCAN_PAGES = 4;

const later = (a: string | undefined, b: string): string => (a !== undefined && a > b ? a : b);
const earlier = (a: string | undefined, b: string): string => (a !== undefined && a < b ? a : b);

/**
 * The rows before the window, from the lake, in the read's order, starting after `cursor`: up to
 * `need` entries, or fewer with `resume` when the scan reached its bound first. The read is
 * recorded once (K-70: a staff read of the lake is a `HostAdmin` read under K-24), after the
 * engine answered, also when a later step throws.
 */
async function lakeSegment<E, F extends DirectoryHistoryFilter>(
  deps: DirectoryHistoryDeps,
  lake: LakeQueryEngine,
  spec: DirectoryHistorySpec<E, F>,
  filter: F,
  windowStart: string,
  need: number,
  cursor: string | undefined,
  compare: boolean,
): Promise<DirectoryHistoryPage<E>> {
  const order = filter.order ?? spec.defaultOrder;
  const envelope = spec.envelope(filter);
  const { page, pages } = deps.scan ?? { page: DIRECTORY_LAKE_SCAN_PAGE, pages: DIRECTORY_LAKE_SCAN_PAGES };
  const step = spec.select ? Math.max(need, page) : need;
  const entries: E[] = [];
  let queries = 0;
  try {
    for (let i = 0; i < pages; i++) {
      const { records, more } = await queryDirectoryLake(lake, spec.dataset, {
        ...envelope,
        ...(filter.since !== undefined ? { since: filter.since } : {}),
        until: earlier(filter.until, windowStart),
        ...(cursor !== undefined ? { cursor } : {}),
        order,
        limit: step,
      });
      queries += 1;
      const kept = new Set(spec.select ? spec.select(filter, records.map((r) => r.row)) : records.map((r) => r.row));
      for (const r of records) {
        if (!kept.has(r.row)) continue;
        entries.push(spec.entryOf(r.row));
        if (entries.length >= need) return { entries, resume: null };
      }
      if (!more || records.length === 0) return { entries, resume: null };
      cursor = records[records.length - 1]!.rowKey;
    }
    return { entries, resume: cursor ?? null };
  } finally {
    if (queries > 0) {
      const { cursor: _c, limit: _l, ...params } = filter;
      await deps.admin.recordDelegatedRead(deps.actor, {
        method: 'lakeDirectory',
        tenantId: (envelope.tenantId ?? null) as TenantId | null,
        scopeId: (envelope.scopeId ?? null) as ScopeId | null,
        params: { dataset: spec.dataset, ...(compare ? { compare: true } : {}), ...params },
        resultCount: entries.length,
      });
    }
  }
}

/**
 * A data set's history, read across the directory's window and the lake behind it (the split and
 * the switch are described at the top of this file). `read` is the directory's own list read,
 * which answers everything while the switch is `off`, everything in `compare`, and the window in `on`.
 */
export async function readDirectoryHistory<E, F extends DirectoryHistoryFilter>(
  deps: DirectoryHistoryDeps,
  spec: DirectoryHistorySpec<E, F>,
  filter: F,
  read: (filter: F) => Promise<E[]>,
): Promise<DirectoryHistoryPage<E>> {
  const { lake, mode } = deps;
  const whole = async (): Promise<DirectoryHistoryPage<E>> => ({ entries: await read(filter), resume: null });
  if (mode === 'off' || !lake) return whole();
  const ws = directoryWindowStart(deps.nowMs);
  if (filter.since !== undefined && filter.since >= ws) return whole();
  const order = filter.order ?? spec.defaultOrder;

  if (mode === 'compare') {
    const answer = await read(filter);
    // The directory's rows before the window, against the lake's for the same filter from the same
    // cursor: the same set, whichever end of the page they sit at.
    const old = answer.filter((e) => spec.atOf(e) < ws);
    if (old.length > 0) {
      const first = spec.idOf(old[0]!);
      try {
        const got = await lakeSegment(deps, lake, spec, filter, ws, old.length, filter.cursor, true);
        const inLake = new Set(got.entries.map(spec.idOf));
        const missing = old.filter((e) => !inLake.has(spec.idOf(e))).map(spec.idOf);
        if (missing.length > 0 || got.entries.length !== old.length) {
          deps.report?.({
            compare: spec.dataset, directory: old.length, lake: got.entries.length, missing: missing.slice(0, 10), first,
            ...(got.resume !== null ? { scanBound: true } : {}),
          });
        }
      } catch (err) {
        deps.report?.({ compare: spec.dataset, error: (err as Error).message, first });
      }
    }
    return { entries: answer, resume: null };
  }

  // `on`: the window from the directory, the rest from the lake, walked in the read's order.
  const fromDirectory = async (need: number, cursor: string | undefined): Promise<DirectoryHistoryPage<E>> =>
    filter.until !== undefined && filter.until <= ws
      ? { entries: [], resume: null }
      : { entries: await read({ ...filter, since: later(filter.since, ws), limit: need, ...(cursor !== undefined ? { cursor } : {}) }), resume: null };
  const fromLake = (need: number, cursor: string | undefined) => lakeSegment(deps, lake, spec, filter, ws, need, cursor, false);
  const segments = order === 'asc' ? [fromLake, fromDirectory] : [fromDirectory, fromLake];
  const entries: E[] = [];
  let cursor = filter.cursor;
  for (const segment of segments) {
    const got = await segment(filter.limit - entries.length, cursor);
    entries.push(...got.entries);
    if (entries.length >= filter.limit) break;
    // The lake was not read to its end: the next page starts where the scan stopped, before the
    // directory's half (ascending) or after it (descending, where this is the last segment).
    if (got.resume !== null) return { entries, resume: got.resume };
    if (entries.length > 0) cursor = spec.idOf(entries[entries.length - 1]!);
  }
  return { entries, resume: null };
}

/** A history page as the list routes answer it: `pageOf`'s cursor, or `resume` on a short page. */
export function historyPageOf<E>(page: DirectoryHistoryPage<E>, limit: number, idOf: (e: E) => string): Page<E> {
  const out = pageOf(page.entries, limit, idOf);
  return out.nextCursor === null && page.resume !== null ? { ...out, nextCursor: page.resume } : out;
}

// -- the data sets read this way ----------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const json = (v: unknown): unknown => (v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v);
/** A filter the directory applies only when it is non-empty (`if (filter?.x)` in both adapters). */
const given = (v: string | undefined): v is string => v !== undefined && v !== '';

export const ADMIN_LOG_HISTORY: DirectoryHistorySpec<AdminLogEntry, AuditLogFilter & DirectoryHistoryFilter> = {
  dataset: 'admin_log',
  defaultOrder: 'asc',
  envelope: (f) => ({
    ...(f.tenantId !== undefined ? { tenantId: f.tenantId } : {}),
    ...(f.scopeId !== undefined ? { scopeId: f.scopeId } : {}),
    ...(f.actor !== undefined ? { actor: f.actor } : {}),
    ...(f.action !== undefined ? { kind: f.action } : {}),
  }),
  entryOf: adminLogEntryOfLakeRow,
  idOf: (e) => e.id,
  atOf: (e) => e.at,
};

/** An ops-failure row as the directory stores it, as an entry (adapter-sqlite's `listOpsFailures`). */
export function opsFailureEntryOfLakeRow(row: Record<string, unknown>): OpsFailureEntry {
  return opsFailureEntry.parse({
    id: row['id'], actor: row['actor'], operation: row['operation'], stage: row['stage'] ?? null,
    tenantId: row['tenant_id'] ?? null, scopeId: row['scope_id'] ?? null, vertical: row['vertical'] ?? null,
    version: row['version'] ?? null, status: row['status'] ?? null, message: row['message'],
    reference: row['reference'] ?? null, origin: row['origin'] ?? null, code: row['code'] ?? null,
    fingerprint: row['fingerprint'] ?? null, at: row['at'],
  });
}

export const OPS_FAILURE_HISTORY: DirectoryHistorySpec<OpsFailureEntry, OpsFailureFilter & DirectoryHistoryFilter> = {
  dataset: 'ops_failures',
  defaultOrder: 'desc',
  envelope: (f) => ({
    ...(given(f.tenantId) ? { tenantId: f.tenantId } : {}),
    ...(given(f.scopeId) ? { scopeId: f.scopeId } : {}),
    ...(given(f.operation) ? { kind: f.operation } : {}),
  }),
  select: (f, rows) => {
    // `reference`, as `opsFailureReferenceWhere` reads it: exact, or with `referenceInText` also both
    // rows of a pair whose row with no tenant begins with the handle. Judged within the scanned page:
    // a pair is written in one transaction, so its two ids are adjacent, and only a pair split by a
    // page boundary shows one row.
    let references: Set<unknown> | null = null;
    if (given(f.reference)) {
      references = new Set([f.reference]);
      if (f.referenceInText) {
        const marker = upstreamReferenceMarker(f.reference);
        for (const r of rows) {
          if (r['tenant_id'] == null && str(r['reference']) !== null && str(r['message'])?.startsWith(marker)) references.add(r['reference']);
        }
      }
    }
    const eq = (column: string, value: string | undefined) => (r: Record<string, unknown>) => !given(value) || r[column] === value;
    const tests = [eq('vertical', f.vertical), eq('version', f.version), eq('code', f.code), eq('fingerprint', f.fingerprint)];
    return rows.filter((r) => tests.every((t) => t(r)) && (references === null || references.has(r['reference'])));
  },
  entryOf: opsFailureEntryOfLakeRow,
  idOf: (e) => e.id,
  atOf: (e) => e.at,
};

/** A sweep-run row as the directory stores it, as an entry (adapter-sqlite's `listSweepRuns`). */
export function sweepRunEntryOfLakeRow(row: Record<string, unknown>): SweepRunEntry {
  return sweepRunEntry.parse({
    id: row['id'], kind: row['kind'], unit: row['unit'], outcome: row['outcome'],
    tenantId: row['tenant_id'] ?? null, scopeId: row['scope_id'] ?? null, vertical: row['vertical'] ?? null,
    version: row['version'] ?? null, operation: row['operation'] ?? null, connectionId: row['connection_id'] ?? null,
    error: row['error'] ?? null, elapsedMs: row['elapsed_ms'] ?? null, eventType: row['event_type'] ?? null,
    observedAt: row['observed_at'] ?? null, platformRequests: json(row['platform_requests']), at: row['at'],
  });
}

export const SWEEP_RUN_HISTORY: DirectoryHistorySpec<SweepRunEntry, SweepRunFilter & DirectoryHistoryFilter> = {
  dataset: 'sweep_runs',
  defaultOrder: 'desc',
  // The directory narrows these whenever they are given, empty or not (`eq` in both adapters).
  envelope: (f) => ({
    ...(f.tenantId !== undefined ? { tenantId: f.tenantId } : {}),
    ...(f.scopeId !== undefined ? { scopeId: f.scopeId } : {}),
    ...(f.kind !== undefined ? { kind: f.kind } : {}),
  }),
  select: (f, rows) => {
    const tests = (
      [['unit', f.unit], ['outcome', f.outcome], ['vertical', f.vertical], ['connection_id', f.connectionId]] as const
    ).filter(([, v]) => v !== undefined);
    return rows.filter((r) => tests.every(([c, v]) => r[c] === v));
  },
  entryOf: sweepRunEntryOfLakeRow,
  idOf: (e) => e.id,
  atOf: (e) => e.at,
};

/** A model-usage row as the directory stores it, as an entry (`modelUsageEntryOf` in both adapters). */
export function modelUsageEntryOfLakeRow(row: Record<string, unknown>): ModelUsageEntry {
  return modelUsageEntry.parse({
    id: row['id'],
    requestId: row['request_id'],
    attribution: {
      tenant: row['tenant_id'], scope: row['scope_id'], vertical: row['vertical'], version: row['version'], operation: row['operation'],
    },
    model: row['model'], provider: row['provider'], modelId: row['model_id'], reported: row['reported'] === 1 || row['reported'] === true,
    inputTokens: row['input_tokens'], outputTokens: row['output_tokens'], cachedInputTokens: row['cached_input_tokens'],
    cacheWriteTokens: row['cache_write_tokens'], listUsd: row['list_usd'] ?? null, at: row['at'], elapsedMs: row['elapsed_ms'],
  });
}

export const MODEL_USAGE_HISTORY: DirectoryHistorySpec<ModelUsageEntry, ModelUsageFilter & DirectoryHistoryFilter> = {
  dataset: 'model_usage',
  defaultOrder: 'desc',
  envelope: (f) => ({
    ...(given(f.tenantId) ? { tenantId: f.tenantId } : {}),
    ...(given(f.scopeId) ? { scopeId: f.scopeId } : {}),
    ...(given(f.model) ? { kind: f.model } : {}),
  }),
  select: (f, rows) => (given(f.vertical) ? rows.filter((r) => r['vertical'] === f.vertical) : [...rows]),
  entryOf: modelUsageEntryOfLakeRow,
  idOf: (e) => e.id,
  atOf: (e) => e.at,
};

/**
 * The admin log, read across the directory's window and the lake behind it. `filter.limit` is
 * required here: a history read is a page, never the whole log.
 */
export async function readAdminLogHistoryPage(
  deps: DirectoryHistoryDeps,
  filter: AuditLogFilter & { limit: number },
): Promise<DirectoryHistoryPage<AdminLogEntry>> {
  return readDirectoryHistory(deps, ADMIN_LOG_HISTORY, filter, (f) => deps.admin.auditLog(deps.actor, f));
}

/** `readAdminLogHistoryPage`'s entries alone, the shape #3405 shipped. */
export async function readAdminLogHistory(deps: DirectoryHistoryDeps, filter: AuditLogFilter & { limit: number }): Promise<AdminLogEntry[]> {
  return (await readAdminLogHistoryPage(deps, filter)).entries;
}

/** How many rows one page of a whole-history walk asks for. */
const HISTORY_WALK_PAGE = 1_000;

/**
 * A tenant's whole admin log (the export), across the window and the lake. Off, or with no lake,
 * it is the one directory read it always was; otherwise it pages the history read to its end.
 */
export async function readWholeAdminLog(deps: DirectoryHistoryDeps, filter: AuditLogFilter): Promise<AdminLogEntry[]> {
  if (deps.mode === 'off' || !deps.lake) return deps.admin.auditLog(deps.actor, filter);
  const out: AdminLogEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await readAdminLogHistoryPage(deps, {
      ...filter,
      order: 'asc',
      limit: HISTORY_WALK_PAGE,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    out.push(...page.entries);
    const next = historyPageOf(page, HISTORY_WALK_PAGE, (e) => e.id).nextCursor;
    if (next === null) return out;
    cursor = next;
  }
}

/**
 * The data sets whose every history reader reads the lake before the window (this file), so the
 * directory may prune them to it. Listing one here only ALLOWS its prune: `DIRECTORY_LAKE_PRUNE`
 * must still name it, reads must be `on`, and the kernel still refuses a data set that is not
 * captured and backfilled (`pruneDirectoryLakeWindow`).
 *
 * - `admin_log`: `GET /admin-log` and the export (#3405).
 * - `ops_failures`: `GET /ops-failures`, which every history reader goes through (#3425). The other
 *   readers ask for days (the connection-health and backlog counts, the digest, the refile checks).
 * - `sweep_runs`: `GET /sweep-runs` (#3425). The cadence guards read the last outcome per unit, and
 *   the table is already pruned on write at `SWEEP_RUN_RETENTION_DAYS`, inside the window.
 *
 * Not listed, and why:
 * - `access_log`: no product reader, but its own drain to R2 (K-24) reads every row not yet drained,
 *   however old, and `pruneAccessLog` deletes only drained rows ("age alone is not a licence").
 * - `model_usage`: the ledger list reads the lake, but the summary, billing, reconciliation and
 *   review-spend reads fold the directory's rows over any window asked for.
 * - `build_usage`, `request_days`, `cost_days`, `meter_days`: their readers (Billing, Meters) fold
 *   per day over the directory; none reads the lake yet.
 */
export const DIRECTORY_LAKE_HISTORY_READ: readonly DirectoryLakeDataset[] = ['admin_log', 'ops_failures', 'sweep_runs'];

/**
 * Of the data sets the prune switch lists, those that may be pruned now: their history is read
 * from the lake (`DIRECTORY_LAKE_HISTORY_READ`) and reads are `on`. The rest are refused with the
 * reason, so a switch set ahead of its reader prunes nothing a console still needs.
 */
export function prunableDirectoryDatasets(
  wanted: readonly DirectoryLakeDataset[],
  reads: DirectoryLakeReads,
): { allowed: DirectoryLakeDataset[]; refused: { dataset: DirectoryLakeDataset; reason: string }[] } {
  const allowed: DirectoryLakeDataset[] = [];
  const refused: { dataset: DirectoryLakeDataset; reason: string }[] = [];
  for (const dataset of wanted) {
    if (!DIRECTORY_LAKE_HISTORY_READ.includes(dataset)) refused.push({ dataset, reason: 'its history readers do not read the lake yet' });
    else if (reads !== 'on') refused.push({ dataset, reason: `DIRECTORY_LAKE_READS is ${reads}, not on` });
    else allowed.push(dataset);
  }
  return { allowed, refused };
}
