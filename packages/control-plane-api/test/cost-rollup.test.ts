import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, type CloudflareUsageDay } from '@substrat-run/contracts';
import { createCloudflareUsageDayReader, createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth } from '../src/index.js';
import { createObservabilityVolumeReader, OBSERVABILITY_MIN_SPLIT_MS } from '../src/observability-volume.js';

/**
 * The Cloudflare cost rollup's reader and routes (#3316). The reader runs against a small stand-in
 * for the GraphQL API that applies the keyset filter, the order and the limit the reader asks for,
 * so a reader that dropped a page or repeated one would read wrong rows here. Attribution through
 * the directory is the kernel's, held in its own suite.
 */

type Row = Record<string, unknown>;
const DATASETS: Record<string, { key: string; rows: Row[] }> = {
  workersInvocationsAdaptive: {
    key: 'scriptName',
    rows: [
      {
        dimensions: { scriptName: 'tenant-a-crm' },
        sum: { cpuTimeUs: 1500 },
        confidence: { sum: { cpuTimeUs: { lower: 1400.5, upper: 1599.5, isValid: true } } },
      },
      // Cloudflare calls this interval invalid: no interval is kept, never a made-up one.
      { dimensions: { scriptName: 'substrat-router' }, sum: { cpuTimeUs: 99 }, confidence: { sum: { cpuTimeUs: { lower: 1, upper: 2, isValid: false } } } },
    ],
  },
  durableObjectsInvocationsAdaptiveGroups: {
    key: 'namespaceId',
    rows: [{ dimensions: { namespaceId: 'ns-1', scriptName: 'tenant-a-crm' }, sum: { requests: 10 } }],
  },
  durableObjectsPeriodicGroups: {
    key: 'objectId',
    rows: ['c', 'a', 'b'].map((c) => ({
      dimensions: { namespaceId: 'ns-1', objectId: c.repeat(64) },
      sum: { rowsRead: 1, rowsWritten: 2, storageWriteUnits: 0, duration: 0.5 },
    })),
  },
  containersUsageAdaptiveGroups: {
    key: 'instanceId',
    rows: [
      // Cloudflare answers a label the container was started without as an empty string.
      { dimensions: { instanceId: 'i-2', applicationId: 'app-1', tenant: '', app: '' }, sum: { cpuTimeSec: 1, allocatedMemory: 2, allocatedDisk: 3, txBytes: 4 } },
      { dimensions: { instanceId: 'i-1', applicationId: 'app-1', tenant: '01JZ0000000000000000TEN001', app: 'acme/crm' }, sum: { cpuTimeSec: 5, allocatedMemory: 6, allocatedDisk: 7, txBytes: 8 } },
    ],
  },
};
/** The reader's clock: 2026-11-20 is inside container usage's retention, 2026-10-01 is not. */
const NOW = () => Date.parse('2026-11-21T12:00:00Z');

/** One telemetry `calculations` ask (#3358), as the volume reader sends it. */
type TelemetryAsk = { timeframe: { from: number; to: number }; parameters: { datasets: string[]; groupBys: Array<{ value: string }> } };
/** A telemetry answer: per group, its key values and the two figures, under the reader's aliases. */
const telemetryAnswer = (groups: Array<{ keys: Record<string, string>; events: number; bytes?: number }>) =>
  Response.json({
    success: true,
    result: {
      calculations: [
        { alias: 'events', aggregates: groups.map((g) => ({ value: g.events, groups: Object.entries(g.keys).map(([key, value]) => ({ key, value })) })) },
        {
          alias: 'bytes',
          aggregates: groups.filter((g) => g.bytes !== undefined).map((g) => ({ value: g.bytes, groups: Object.entries(g.keys).map(([key, value]) => ({ key, value })) })),
        },
      ],
    },
  });

function cloudflare(opts: { refuse?: string; telemetry?: (ask: TelemetryAsk) => Response } = {}) {
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/telemetry/query')) {
      const ask = JSON.parse(String(init?.body)) as TelemetryAsk;
      calls.push(`telemetry:${ask.parameters.datasets[0]}`);
      return opts.telemetry ? opts.telemetry(ask) : telemetryAnswer([]);
    }
    if (url.includes('/durable_objects/namespaces')) {
      calls.push('namespaces');
      return Response.json({ result: [{ id: 'ns-1', script: 'tenant-a-crm', class: 'ScopeDO', name: 'x' }] });
    }
    if (opts.refuse) return Response.json({ data: null, errors: [{ message: opts.refuse }] });
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { after: string; day: string } };
    const name = Object.keys(DATASETS).find((d) => query.includes(`${d}(`))!;
    const { key, rows } = DATASETS[name]!;
    const limit = Number(/limit: (\d+)/.exec(query)![1]);
    const keyOf = (r: Row) => String((r['dimensions'] as Row)[key]);
    const page = rows
      .filter((r) => keyOf(r) > variables.after)
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
      .slice(0, limit);
    calls.push(`${name}>${variables.after.slice(0, 1) || '-'}`);
    return Response.json({ data: { viewer: { accounts: [{ rows: page }] } }, errors: null });
  };
  return { fetch, calls };
}

describe('the cost rollup reader', () => {
  it('reads every page of each dataset, keeps a valid interval only, and lists the namespaces once per reader', async () => {
    const cf = cloudflare();
    const read = createCloudflareUsageDayReader({ accountId: 'acct', apiToken: 't', fetch: cf.fetch, pageSize: 2, now: NOW });
    const day = await read('2026-11-20');
    expect(day.containers).toEqual([
      { applicationId: 'app-1', instanceId: 'i-1', tenant: '01JZ0000000000000000TEN001', app: 'acme/crm', cpuTimeSec: 5, allocatedMemory: 6, allocatedDisk: 7, txBytes: 8 },
      { applicationId: 'app-1', instanceId: 'i-2', tenant: null, app: null, cpuTimeSec: 1, allocatedMemory: 2, allocatedDisk: 3, txBytes: 4 },
    ]);
    expect(day.workers).toEqual([
      { script: 'substrat-router', cpuTimeUs: 99 },
      { script: 'tenant-a-crm', cpuTimeUs: 1500, lower: 1400.5, upper: 1599.5 },
    ]);
    expect(day.doObjects.map((o) => o.objectId[0])).toEqual(['a', 'b', 'c']);
    expect(day.namespaces).toEqual([{ id: 'ns-1', script: 'tenant-a-crm', class: 'ScopeDO' }]);
    await read('2026-11-19');
    // Three objects in pages of two: a second page after `b`. One namespace list for both days.
    expect(cf.calls.filter((c) => c.startsWith('durableObjectsPeriodicGroups'))).toEqual([
      'durableObjectsPeriodicGroups>-',
      'durableObjectsPeriodicGroups>b',
      'durableObjectsPeriodicGroups>-',
      'durableObjectsPeriodicGroups>b',
    ]);
    expect(cf.calls.filter((c) => c === 'namespaces')).toHaveLength(1);
  });

  it('reads a day older than Cloudflare keeps container usage without it, rather than having the day refused (#3316)', async () => {
    const cf = cloudflare();
    const day = await createCloudflareUsageDayReader({ accountId: 'acct', apiToken: 't', fetch: cf.fetch, now: NOW })('2026-10-01');
    expect(day.containers).toBeUndefined();
    expect(day.workers).toHaveLength(2);
    expect(cf.calls.some((c) => c.startsWith('containersUsageAdaptiveGroups'))).toBe(false);
  });

  it('reads observability volume when turned on, only for a day the telemetry still holds whole (#3358)', async () => {
    const cf = cloudflare({
      telemetry: (ask) =>
        ask.parameters.datasets[0] === 'otel'
          ? telemetryAnswer([{ keys: { '$metadata.service': 'tenant-a-crm' }, events: 40 }])
          : telemetryAnswer([
              { keys: { '$metadata.service': 'tenant-a-crm', tenantId: '01JZ0000000000000000TEN001', scopeId: '01JZ0000000000000000SCP001' }, events: 10, bytes: 4000 },
              // A line naming no tenant: the backend leaves the group's value empty.
              { keys: { '$metadata.service': 'tenant-a-crm', tenantId: '', scopeId: '' }, events: 3, bytes: 900 },
            ]),
    });
    const read = (on: boolean) => createCloudflareUsageDayReader({ accountId: 'acct', apiToken: 't', fetch: cf.fetch, now: NOW, observabilityVolume: on });
    expect((await read(true)('2026-11-20')).observability).toEqual([
      { signal: 'logs', script: 'tenant-a-crm', tenantId: '01JZ0000000000000000TEN001', scopeId: '01JZ0000000000000000SCP001', events: 10, bytes: 4000 },
      { signal: 'logs', script: 'tenant-a-crm', tenantId: null, scopeId: null, events: 3, bytes: 900 },
      // No size reported for the spans: kept as unmeasured, never as 0 bytes.
      { signal: 'spans', script: 'tenant-a-crm', tenantId: null, scopeId: null, events: 40, bytes: null },
    ]);
    cf.calls.length = 0;
    // Seven days back the telemetry no longer holds the whole day; off, it is never asked.
    expect((await read(true)('2026-11-14')).observability).toBeUndefined();
    expect((await read(false)('2026-11-20')).observability).toBeUndefined();
    expect(cf.calls.filter((c) => c.startsWith('telemetry'))).toEqual([]);
  });

  it('splits a full or timed-out volume answer by time and adds the halves; a span still full leaves the day without it (#3358)', async () => {
    const HOUR = OBSERVABILITY_MIN_SPLIT_MS;
    const line = (n: number) => ({ keys: { '$metadata.service': `s-${n}`, tenantId: '', scopeId: '' }, events: 1, bytes: 10 });
    const reader = (answer: (ask: TelemetryAsk) => Response) =>
      createObservabilityVolumeReader({ accountId: 'acct', apiToken: 't', groupLimit: 2, fetch: cloudflare({ telemetry: answer }).fetch });
    const width = (ask: TelemetryAsk) => ask.timeframe.to - ask.timeframe.from;
    // The whole day times out; each half then answers the same script, and the halves add.
    const split = await reader((ask) => {
      if (ask.parameters.datasets[0] === 'otel') return telemetryAnswer([]);
      if (width(ask) === 86_400_000) return new Response('timeout', { status: 504 });
      return telemetryAnswer([line(1)]);
    })('2026-11-20');
    expect(split).toEqual({ rows: [{ signal: 'logs', script: 's-1', tenantId: null, scopeId: null, events: 2, bytes: 20 }] });
    // Full at every width down to an hour: the day cannot be read whole.
    expect(await reader((ask) => telemetryAnswer(ask.parameters.datasets[0] === 'otel' ? [] : [line(1), line(2)]))('2026-11-20')).toEqual({ saturated: true });
    // Still timing out at an hour is a failure, so the cost day is read again later.
    await expect(reader((ask) => (width(ask) <= HOUR ? new Response('', { status: 524 }) : new Response('', { status: 504 })))('2026-11-20')).rejects.toThrow(/timed out/);
  });

  it('fails the day on a GraphQL refusal, rather than reading it as a day without usage', async () => {
    const read = createCloudflareUsageDayReader({ accountId: 'acct', apiToken: 't', fetch: cloudflare({ refuse: 'not authorized' }).fetch });
    await expect(read('2026-11-20')).rejects.toThrow(/refused the read: not authorized/);
  });
});

describe('/meters/cloudflare-costs (#3316)', () => {
  const staff = platformActorId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const usage: CloudflareUsageDay = {
    day: '2026-08-24',
    workers: [{ script: 'substrat-router', cpuTimeUs: 99 }, { script: 'no-such-vertical', cpuTimeUs: 5 }],
    doInvocations: [],
    doObjects: [{ namespaceId: 'ns-9', objectId: 'e'.repeat(64), rowsRead: 0, rowsWritten: 7, storageWriteUnits: 0, duration: 0 }],
    namespaces: [],
  };
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-cost-rollup-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a snapshot day through the directory once, refuses it a second time, and serves it with the day ledger', async () => {
    const post = (body: unknown) => app.request('/meters/cloudflare-costs/days', { method: 'POST', headers: asStaff, body: JSON.stringify(body) });
    const loaded = await post(usage);
    expect(loaded.status).toBe(201);
    expect(await loaded.json()).toEqual({ day: '2026-08-24', recorded: 3 });
    expect((await post(usage)).status).toBe(409);
    expect((await post({ ...usage, day: new Date().toISOString().slice(0, 10) })).status).toBe(400);

    const res = await app.request('/meters/cloudflare-costs?since=2026-08-24&until=2026-08-24', { headers: asStaff });
    const body = (await res.json()) as { rows: { script: string; attribution: string; dimension: string; quantity: string; tenantId: string | null }[]; days: { day: string; rows: number }[] };
    expect(body.rows.map((r) => `${r.script} ${r.dimension} ${r.attribution} ${r.quantity} ${r.tenantId}`)).toEqual([
      // A namespace nobody can name a script for is reported apart, attributed to no one.
      ' do_rows_written unknown 7 null',
      'no-such-vertical worker_cpu_us unknown 5 null',
      'substrat-router worker_cpu_us platform 99 null',
    ]);
    expect(body.days).toMatchObject([{ day: '2026-08-24', rows: 3 }]);
    const unmapped = await app.request('/meters/cloudflare-costs?since=2026-08-24&until=2026-08-24&attribution=platform', { headers: asStaff });
    expect(((await unmapped.json()) as { rows: unknown[] }).rows).toHaveLength(1);
    expect((await app.request('/meters/cloudflare-costs')).status).toBe(401);
  });

  it('backfills container usage onto a read day, charging an unlabelled builder sandbox to its team (#3316)', async () => {
    // Runs after the snapshot test above, which read 2026-08-24.
    const team = ulid();
    await host.admin.createTenant(staff, { id: team, slug: 'acme', name: 'Acme' });
    const sandbox = 'd'.repeat(64);
    const asked: string[] = [];
    const backfill = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      builderSandboxObjects: async (tenantId) => {
        asked.push(tenantId);
        return tenantId === team ? [{ objectId: sandbox, app: 'acme/crm' }] : [];
      },
    });
    const box = { applicationId: 'app-1', tenant: null, app: null, cpuTimeSec: 10, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0 };
    const post = () =>
      backfill.request('/meters/cloudflare-costs/containers', {
        method: 'POST',
        headers: asStaff,
        body: JSON.stringify({
          days: [
            { day: '2026-08-24', containers: [{ ...box, instanceId: sandbox }, { ...box, instanceId: 'e'.repeat(64) }] },
            { day: '2026-08-25', containers: [{ ...box, instanceId: sandbox }] },
          ],
        }),
      });
    const first = await post();
    expect(first.status).toBe(201);
    // The day the rollup never read is left for the rollup to read itself.
    expect(await first.json()).toEqual({
      matched: 2,
      days: [
        { day: '2026-08-24', recorded: 2, refused: null },
        { day: '2026-08-25', recorded: 0, refused: 'not-read' },
      ],
    });
    expect(asked).toContain(team);
    const res = await app.request('/meters/cloudflare-costs?since=2026-08-24&until=2026-08-24&attribution=container', { headers: asStaff });
    expect(((await res.json()) as { rows: unknown[] }).rows).toEqual([
      expect.objectContaining({ objectId: sandbox, dimension: 'container_cpu_s', tenantId: team, vertical: 'acme/crm', quantity: '10' }),
    ]);
    // A second load does not count the day's containers twice.
    expect(((await (await post()).json()) as { days: unknown[] }).days[0]).toEqual({ day: '2026-08-24', recorded: 0, refused: 'already-recorded' });
  });
});
