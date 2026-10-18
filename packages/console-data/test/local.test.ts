import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConsoleQueryError,
  contractWorld,
  createLocalSource,
  LocalArtifactError,
  MAX_PAGE,
  WORLD_ALL,
  WORLD_T0,
  type LocalArtifacts,
} from '../src/index.js';
import { memoryBuffer } from './fixtures.js';

const world = contractWorld();
const withParams = world.traces.find((t) => t.steps.some((s) => s.type === 'sql'))!;

function source(options: { rawPayloads?: boolean; traces?: readonly unknown[]; artifacts?: () => LocalArtifacts } = {}) {
  const buffer = memoryBuffer(options.traces ?? world.traces);
  return {
    buffer,
    source: createLocalSource({
      label: 'tasks',
      artifacts: options.artifacts ?? (() => ({})),
      traces: buffer,
      ...(options.rawPayloads === undefined ? {} : { rawPayloads: options.rawPayloads }),
    }),
  };
}

describe('local source: bound values', () => {
  it('strips them by default and says so in capture', async () => {
    const got = await source().source.getTrace(withParams.invocationId);
    const sql = got!.steps.filter((s) => s.type === 'sql');
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.every((s) => !('params' in s))).toBe(true);
    expect(got!.capture.sqlParams).toBe(false);
  });

  it('keeps them when rawPayloads is on (the positive twin)', async () => {
    const got = await source({ rawPayloads: true }).source.getTrace(withParams.invocationId);
    const sql = got!.steps.find((s) => s.type === 'sql');
    expect(sql && 'params' in sql && sql.params).toEqual((withParams.steps.find((s) => s.type === 'sql') as { params: unknown[] }).params);
    expect(got!.capture.sqlParams).toBe(true);
    expect(source({ rawPayloads: true }).source.describe().capabilities.rawPayloads).toBe(true);
  });
});

describe('local source: what crosses in is parsed', () => {
  it('leaves out a record that is not a trace, and keeps the rest', async () => {
    const { source: s } = source({ traces: [{ invocationId: 'inv-bad' }, world.traces[0]] });
    const page = await s.queryRequests(WORLD_ALL);
    expect(page.requests.map((r) => r.invocationId)).toEqual([world.traces[0]!.invocationId]);
    expect(await s.getTrace('inv-bad')).toBeNull();
  });

  it('refuses a model.json that is not a model, naming the project', async () => {
    const { source: s } = source({ artifacts: () => ({ modelJson: { entities: { task: { fields: {} } } } }) });
    await expect(s.artifacts()).rejects.toThrow(LocalArtifactError);
    await expect(s.artifacts()).rejects.toThrow(/^tasks: model\.json/);
  });

  it('reads the artifacts again on every call, so a working-tree edit shows', async () => {
    let md: string | undefined;
    const { source: s } = source({ artifacts: () => (md === undefined ? {} : { permissionsMd: md }) });
    expect((await s.artifacts()).permissions).toBeNull();
    md = world.permissionsMd;
    expect((await s.artifacts()).permissions?.roles.map((r) => r.role)).toEqual(['member']);
  });

  it('answers a real vertical’s artifacts', async () => {
    const root = fileURLToPath(new URL('../../../demos/todo/', import.meta.url));
    const { source: s } = source({
      artifacts: () => ({
        modelJson: JSON.parse(readFileSync(`${root}model.json`, 'utf8')),
        permissionsMd: readFileSync(`${root}PERMISSIONS.md`, 'utf8'),
      }),
    });
    const { model, permissions } = await s.artifacts();
    expect(Object.keys(model!.entities)).toContain('list');
    expect(permissions!.descriptions.size).toBeGreaterThan(0);
  });
});

describe('local source: paging', () => {
  it('a request recorded mid-walk shifts no page', async () => {
    const { source: s, buffer } = source();
    const first = await s.queryRequests({ ...WORLD_ALL, limit: 10 });
    buffer.push({ ...world.traces[0]!, invocationId: 'inv-new', startedAt: new Date(WORLD_T0 + 3_600_000).toISOString() });
    const second = await s.queryRequests({ ...WORLD_ALL, limit: 10, cursor: first.nextCursor! });
    const seen = new Set(first.requests.map((r) => r.invocationId));
    expect(second.requests.some((r) => seen.has(r.invocationId))).toBe(false);
    expect(second.requests).toHaveLength(10);
  });

  it('caps a page at MAX_PAGE', async () => {
    const many = Array.from({ length: MAX_PAGE + 5 }, (_, i) => ({ ...world.traces[0]!, invocationId: `inv-m-${i}` }));
    const page = await source({ traces: many }).source.queryRequests({ ...WORLD_ALL, limit: 10_000 });
    expect(page.requests).toHaveLength(MAX_PAGE);
    expect(page.nextCursor).not.toBeNull();
  });

  it('refuses a cursor it did not write, and a page size that is not one', async () => {
    const { source: s } = source();
    await expect(s.queryRequests({ ...WORLD_ALL, cursor: 'c1:abc' })).rejects.toThrow(ConsoleQueryError);
    await expect(s.queryRequests({ ...WORLD_ALL, limit: 0 })).rejects.toThrow(ConsoleQueryError);
  });

  it('matches status as its decimal text', async () => {
    const page = await source().source.queryRequests({ ...WORLD_ALL, where: { status: ['403'] } });
    expect(page.requests.length).toBeGreaterThan(0);
    expect(page.requests.every((r) => r.status === 403)).toBe(true);
  });
});

describe('local source: a re-recorded request', () => {
  // The buffer may hold an id twice; the last record is the complete one, everywhere.
  const first = world.traces[0]!;
  const again = { ...first, status: 500, threw: true, level: 'error' as const };
  const { source: s } = source({ traces: [...world.traces, again] });

  it('is listed once, as its last record', async () => {
    const page = await s.queryRequests({ ...WORLD_ALL, limit: MAX_PAGE });
    const copies = page.requests.filter((r) => r.invocationId === first.invocationId);
    expect(page.requests).toHaveLength(world.traces.length);
    expect(copies).toEqual([expect.objectContaining({ status: 500, level: 'error' })]);
    expect((await s.getTrace(first.invocationId))?.status).toBe(500);
  });

  it('is counted once, under its last record', async () => {
    const f = await s.facets(WORLD_ALL);
    expect(f.total).toBe(world.traces.length);
    const statusCounts = Object.fromEntries(f.facets.status.map((v) => [v.value, v.count]));
    const plain = Object.fromEntries((await source().source.facets(WORLD_ALL)).facets.status.map((v) => [v.value, v.count]));
    expect(statusCounts['500']).toBe((plain['500'] ?? 0) + 1);
    expect(statusCounts[String(first.status)]).toBe((plain[String(first.status)] ?? 0) - 1);
  });

  it('walks one request at a time to the same list, its last record included', async () => {
    const walked: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await s.queryRequests({ ...WORLD_ALL, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      walked.push(...page.requests);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(walked).toEqual((await s.queryRequests({ ...WORLD_ALL, limit: MAX_PAGE })).requests);
    expect(walked).toContainEqual(expect.objectContaining({ invocationId: first.invocationId, status: 500 }));
  });
});

describe('local source: tail', () => {
  it('is declared exactly when the reader can subscribe', () => {
    expect(source().source.describe().capabilities.tail).toBe(true);
    const noTail = createLocalSource({ label: 'tasks', artifacts: () => ({}), traces: { traces: () => [] } });
    expect(noTail.describe().capabilities.tail).toBe(false);
    expect(noTail.tail).toBeUndefined();
  });

  it('delivers heads, never steps', async () => {
    const { source: s, buffer } = source();
    const got: unknown[] = [];
    const stop = s.tail!({}, (h) => got.push(h));
    buffer.push(withParams);
    stop();
    expect(got).toHaveLength(1);
    expect(got[0]).not.toHaveProperty('steps');
    expect(got[0]).not.toHaveProperty('capture');
  });
});
