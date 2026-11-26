import { LAKE_LITERAL, adminLogEntry, type AdminLogEntry, type PlatformActorId, type TenantId } from '@substrat-run/contracts';
import { DIRECTORY_LAKE_WINDOW_DAYS, type AuditLogFilter, type DirectoryLakeDataset, type HostAdmin } from '@substrat-run/kernel';
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

export interface AdminLogHistoryDeps {
  admin: HostAdmin;
  actor: PlatformActorId;
  lake: LakeQueryEngine | undefined;
  mode: DirectoryLakeReads;
  nowMs: number;
  /** Where a compare's difference is reported. `console.warn` in the worker. */
  report?: (line: Record<string, unknown>) => void;
}

const later = (a: string | undefined, b: string): string => (a !== undefined && a > b ? a : b);
const earlier = (a: string | undefined, b: string): string => (a !== undefined && a < b ? a : b);

/**
 * The admin log, read across the directory's window and the lake behind it. `filter.limit` is
 * required here: a history read is a page, never the whole log.
 */
export async function readAdminLogHistory(
  deps: AdminLogHistoryDeps,
  filter: AuditLogFilter & { limit: number },
): Promise<AdminLogEntry[]> {
  const { admin, actor, lake, mode } = deps;
  const read = (f: AuditLogFilter) => admin.auditLog(actor, f);
  if (mode === 'off' || !lake) return read(filter);
  const ws = directoryWindowStart(deps.nowMs);
  const olderAsked = filter.since === undefined || filter.since < ws;
  if (!olderAsked) return read(filter);

  const order = filter.order === 'desc' ? 'desc' : 'asc';
  const lakeFilter = (limit: number, cursor: string | undefined): DirectoryLakeFilter => ({
    ...(filter.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
    ...(filter.scopeId !== undefined ? { scopeId: filter.scopeId } : {}),
    ...(filter.actor !== undefined ? { actor: filter.actor } : {}),
    ...(filter.action !== undefined ? { kind: filter.action } : {}),
    ...(filter.since !== undefined ? { since: filter.since } : {}),
    until: earlier(filter.until, ws),
    ...(cursor !== undefined ? { cursor } : {}),
    order,
    limit,
  });
  // K-70: a staff read of the lake is recorded like any staff read, after the engine answered.
  const recordLakeRead = (resultCount: number, compare: boolean) =>
    admin.recordDelegatedRead(actor, {
      method: 'lakeDirectory',
      tenantId: (filter.tenantId ?? null) as TenantId | null,
      scopeId: filter.scopeId ?? null,
      params: { dataset: 'admin_log', ...(compare ? { compare: true } : {}), ...filter, cursor: undefined, limit: undefined },
      resultCount,
    });

  if (mode === 'compare') {
    const answer = await read(filter);
    // The directory's rows before the window, against the lake's for the same filter and page.
    const old = answer.filter((e) => e.at < ws);
    if (old.length > 0) {
      const first = old[0]!.id;
      try {
        // The same filter, cursor and order: the lake's rows before the window are the same set
        // as the directory's, whichever end of the page they sit at.
        const { records } = await queryDirectoryLake(lake, 'admin_log', lakeFilter(old.length, filter.cursor));
        await recordLakeRead(records.length, true);
        const inLake = new Set(records.map((r) => r.rowKey));
        const missing = old.filter((e) => !inLake.has(e.id)).map((e) => e.id);
        if (missing.length > 0 || records.length !== old.length) {
          deps.report?.({ compare: 'admin_log', directory: old.length, lake: records.length, missing: missing.slice(0, 10), first });
        }
      } catch (err) {
        deps.report?.({ compare: 'admin_log', error: (err as Error).message, first });
      }
    }
    return answer;
  }

  // `on`: the window from the directory, the rest from the lake, walked in the read's order.
  const fromDirectory = (limit: number, cursor: string | undefined) =>
    filter.until !== undefined && filter.until <= ws
      ? Promise.resolve([] as AdminLogEntry[])
      : read({ ...filter, since: later(filter.since, ws), limit, ...(cursor !== undefined ? { cursor } : {}) });
  const fromLake = async (limit: number, cursor: string | undefined) => {
    const { records } = await queryDirectoryLake(lake, 'admin_log', lakeFilter(limit, cursor));
    await recordLakeRead(records.length, false);
    return records.map((r) => adminLogEntryOfLakeRow(r.row));
  };
  const segments = order === 'asc' ? [fromLake, fromDirectory] : [fromDirectory, fromLake];
  const out: AdminLogEntry[] = [];
  let cursor = filter.cursor;
  for (const segment of segments) {
    const rows = await segment(filter.limit - out.length, cursor);
    out.push(...rows);
    if (out.length >= filter.limit) break;
    if (out.length > 0) cursor = out[out.length - 1]!.id;
  }
  return out;
}

/** How many rows one page of a whole-history walk asks for. */
const HISTORY_WALK_PAGE = 1_000;

/**
 * A tenant's whole admin log (the export), across the window and the lake. Off, or with no lake,
 * it is the one directory read it always was; otherwise it pages the history read to its end.
 */
export async function readWholeAdminLog(deps: AdminLogHistoryDeps, filter: AuditLogFilter): Promise<AdminLogEntry[]> {
  if (deps.mode === 'off' || !deps.lake) return deps.admin.auditLog(deps.actor, filter);
  const out: AdminLogEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await readAdminLogHistory(deps, {
      ...filter,
      order: 'asc',
      limit: HISTORY_WALK_PAGE,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    out.push(...page);
    if (page.length < HISTORY_WALK_PAGE) return out;
    cursor = page[page.length - 1]!.id;
  }
}
