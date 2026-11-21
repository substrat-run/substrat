import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, type CloudflareUsageDay } from '@substrat-run/contracts';
import { createCloudflareUsageDayReader, createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth } from '../src/index.js';

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
};

function cloudflare(opts: { refuse?: string } = {}) {
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
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
    const read = createCloudflareUsageDayReader({ accountId: 'acct', apiToken: 't', fetch: cf.fetch, pageSize: 2 });
    const day = await read('2026-11-20');
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
});
