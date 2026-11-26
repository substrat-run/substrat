// K-70: the history readers beyond the admin log, held to the directory's own answer. Rows are
// written through the SQLite adapter with capture on, its outbox is loaded into a lake that
// `node:sqlite` serves (so the compiled WHERE, ORDER and LIMIT run as SQL), and the reader is given
// a clock 40 days ahead: every row is then before the window, the lake answers it all, and the
// directory's list read over the same rows is the oracle.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instant, platformActorId, scopeId, tenantId, upstreamReferenceMarker, type ModelUsageLine, type TenantId } from '@substrat-run/contracts';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { UNSAFE_allowAllChecker, ulid, withheldOpsFailure, type HostAdmin } from '@substrat-run/kernel';
import {
  MODEL_USAGE_HISTORY,
  OPS_FAILURE_HISTORY,
  SWEEP_RUN_HISTORY,
  historyPageOf,
  readDirectoryHistory,
  type DirectoryHistoryDeps,
  type DirectoryHistorySpec,
  type DirectoryHistoryFilter,
  type DirectoryLakeReads,
} from '../src/directory-lake-reads.js';

const staff = platformActorId.parse(ulid());
const T1 = tenantId.parse(ulid());
const T2 = tenantId.parse(ulid());
const S1 = scopeId.parse(ulid());
const LATER = Date.now() + 40 * 86_400_000;

let host: SqliteScopeHost;
let dir: string;
let lake: { query(sql: string): Promise<readonly Record<string, unknown>[]> };
let queries: string[];
let reads: unknown[];
let admin: HostAdmin;
let pairReference: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'substrat-lake-history-'));
  host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  await host.admin.setDirectoryLakeCapture!(staff, ['ops_failures', 'sweep_runs', 'model_usage']);

  const fail = (tenant: TenantId | null, operation: string, vertical: string, code: 'not_found' | 'conflict') =>
    host.admin.recordOpsFailure({ actor: staff, operation, message: `${operation} failed`, tenantId: tenant, scopeId: S1, vertical, code });
  for (let i = 0; i < 3; i++) {
    await fail(T1, 'a/run', 'acme/crm', 'not_found');
    await fail(T2, 'a/run', 'acme/shop', 'conflict');
    await fail(null, 'b/sync', 'acme/crm', 'conflict');
  }
  // A withheld failure: the tenant's row and staff's row under one reference, staff's text
  // beginning with the upstream handle (#2540).
  const pair = withheldOpsFailure({ operation: 'c/pair', tenantId: T1 }, 'upstream said no', (r) => `answered ${r}`, undefined, '');
  pairReference = pair.reference;
  await host.admin.recordOpsFailure({ actor: staff, ...pair, detail: `${upstreamReferenceMarker('UP-1')} upstream said no` });

  for (let i = 0; i < 3; i++) {
    for (const [unit, outcome] of [['conn-1', 'ok'], ['conn-1', 'failed'], ['conn-2', 'ok']] as const) {
      await host.admin.recordSweepRun({ kind: 'connector', unit, outcome, tenantId: T1, connectionId: unit });
    }
    await host.admin.recordSweepRun({ kind: 'schedule', unit: 'nightly', outcome: 'ok', tenantId: T2, vertical: 'acme/shop' });
  }

  const line = (tenant: TenantId, vertical: string, model: string): ModelUsageLine => ({
    attribution: { tenant, scope: S1, vertical, version: '0.1.0', operation: 'x/ask' },
    model, provider: model.split(':')[0]!, modelId: model.split(':')[1]!, reported: true,
    inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, listUsd: '0.01', elapsedMs: 5,
    at: instant.parse(new Date().toISOString()),
  });
  for (let i = 0; i < 3; i++) {
    await host.admin.recordModelUsage({ requestId: ulid(), line: line(T1, 'acme/crm', 'anthropic:claude-opus-5') });
    await host.admin.recordModelUsage({ requestId: ulid(), line: line(T2, 'acme/shop', 'anthropic:claude-opus-5') });
    await host.admin.recordModelUsage({ requestId: ulid(), line: line(T1, 'acme/shop', 'cloudflare:llama') });
  }

  // The lake: every captured row, as the directory's outbox queued it.
  const db = new DatabaseSync(':memory:');
  db.exec(`ATTACH ':memory:' AS kernel;
    CREATE TABLE kernel.directory (seq INTEGER, dataset TEXT, row_key TEXT, tenant_id TEXT, scope_id TEXT, at TEXT,
      kind TEXT, actor TEXT, captured_at TEXT, row TEXT)`);
  const insert = db.prepare(`INSERT INTO kernel.directory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of await host.admin.directoryOutbox!(staff, 10_000)) {
    insert.run(r.seq, r.dataset, r.rowKey, r.tenantId, r.scopeId, r.at, r.kind, r.actor, r.capturedAt, r.row);
  }
  queries = [];
  lake = { query: async (sql) => (queries.push(sql), db.prepare(sql).all() as Record<string, unknown>[]) };
  reads = [];
  admin = { ...host.admin, recordDelegatedRead: async (_a: unknown, r: unknown) => void reads.push(r) } as HostAdmin;
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps = (mode: DirectoryLakeReads, extra: Partial<DirectoryHistoryDeps> = {}): DirectoryHistoryDeps =>
  ({ admin, actor: staff, lake, mode, nowMs: LATER, ...extra });

/** Walk a history read to its end, page by page, following each page's cursor. */
async function walk<E, F extends DirectoryHistoryFilter>(
  d: DirectoryHistoryDeps,
  spec: DirectoryHistorySpec<E, F>,
  filter: F,
  read: (f: F) => Promise<E[]>,
): Promise<E[]> {
  const out: E[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = historyPageOf(await readDirectoryHistory(d, spec, { ...filter, ...(cursor ? { cursor } : {}) }, read), filter.limit, spec.idOf);
    out.push(...page.entries);
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
  throw new Error('the walk did not end');
}

describe('history from the lake equals the directory (K-70)', () => {
  const ops = (f: Parameters<HostAdmin['listOpsFailures']>[1]) => host.admin.listOpsFailures(staff, f);
  const sweeps = (f: Parameters<HostAdmin['listSweepRuns']>[1]) => host.admin.listSweepRuns(staff, f);
  const usage = (f: Parameters<HostAdmin['listModelUsage']>[1]) => host.admin.listModelUsage(staff, f);

  it.each([
    ['every failure, newest first', {}],
    ['one tenant, oldest first', { tenantId: T1, order: 'asc' as const }],
    ['an envelope filter and a row filter', { operation: 'a/run', vertical: 'acme/crm' }],
    ['by code across tenants', { code: 'conflict' as const }],
    ['a pair, by its upstream handle', { reference: 'UP-1', referenceInText: true }],
  ])('ops failures: %s', async (_name, filter) => {
    const lakeRead = await walk(deps('on'), OPS_FAILURE_HISTORY, { ...filter, limit: 2 }, ops);
    expect(lakeRead).toEqual(await ops(filter));
    expect(lakeRead.length).toBeGreaterThan(0);
  });

  it('a pair found by its handle is both rows, under the reference they share', async () => {
    const rows = await walk(deps('on'), OPS_FAILURE_HISTORY, { reference: 'UP-1', referenceInText: true, limit: 5 }, ops);
    expect(rows.map((r) => [r.tenantId, r.reference])).toEqual(expect.arrayContaining([[T1, pairReference], [null, pairReference]]));
  });

  it.each([
    ['one connection\'s failures', { kind: 'connector' as const, unit: 'conn-1', outcome: 'failed' as const }],
    ['a tenant\'s schedules, oldest first', { tenantId: T2, kind: 'schedule' as const, order: 'asc' as const }],
    ['by connection id', { connectionId: 'conn-2' }],
  ])('sweep runs: %s', async (_name, filter) => {
    const lakeRead = await walk(deps('on'), SWEEP_RUN_HISTORY, { ...filter, limit: 2 }, sweeps);
    expect(lakeRead).toEqual(await sweeps(filter));
    expect(lakeRead.length).toBeGreaterThan(0);
  });

  it.each([
    ['one tenant', { tenantId: T1 }],
    ['a model and a vertical', { model: 'anthropic:claude-opus-5', vertical: 'acme/shop' }],
  ])('model usage: %s', async (_name, filter) => {
    const lakeRead = await walk(deps('on'), MODEL_USAGE_HISTORY, { ...filter, limit: 2 }, usage);
    expect(lakeRead).toEqual(await usage(filter));
    expect(lakeRead.length).toBeGreaterThan(0);
  });

  it('a scan that reaches its bound ends the page short with a cursor, and the walk still finds every row', async () => {
    // Three lake rows a step, one step a read: a filter matching one row in three ends pages early.
    const bounded = deps('on', { scan: { page: 3, pages: 1 } });
    const filter = { kind: 'connector' as const, unit: 'conn-2', limit: 3 };
    const first = await readDirectoryHistory(bounded, SWEEP_RUN_HISTORY, filter, sweeps);
    expect(first.entries.length).toBeLessThan(3);
    expect(first.resume).not.toBeNull();
    expect(await walk(bounded, SWEEP_RUN_HISTORY, filter, sweeps)).toEqual(await sweeps({ kind: 'connector', unit: 'conn-2' }));
  });

  it('records one lake read per page under the data set, naming the tenant asked about', async () => {
    reads.length = 0;
    await readDirectoryHistory(deps('on'), OPS_FAILURE_HISTORY, { tenantId: T2, limit: 10 }, ops);
    expect(reads).toEqual([
      expect.objectContaining({ method: 'lakeDirectory', tenantId: T2, resultCount: 3, params: expect.objectContaining({ dataset: 'ops_failures' }) }),
    ]);
  });

  it('compare answers from the directory and reports a row the lake lacks; off never asks the lake', async () => {
    const reported: Record<string, unknown>[] = [];
    const missing = { query: async (sql: string) => (await lake.query(sql)).slice(1) };
    const page = await readDirectoryHistory(deps('compare', { lake: missing, report: (l) => reported.push(l) }), MODEL_USAGE_HISTORY, { tenantId: T1, limit: 10 }, usage);
    expect(page.entries).toEqual(await usage({ tenantId: T1, limit: 10 }));
    expect(reported).toEqual([expect.objectContaining({ compare: 'model_usage', directory: 6, lake: 5 })]);

    queries.length = 0;
    expect((await readDirectoryHistory(deps('off'), MODEL_USAGE_HISTORY, { limit: 10 }, usage)).entries).toHaveLength(9);
    expect(queries).toEqual([]);
  });
});
