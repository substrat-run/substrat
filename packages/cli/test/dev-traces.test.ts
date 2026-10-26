import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestTrace } from '@substrat-run/contracts';
import { createDevTraceSink, LocalTraceStore, traceLine } from '../src/dev-traces.js';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-dev-traces-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function head(id: string): RequestTrace {
  return {
    invocationId: id, startedAt: new Date().toISOString(), tenantId: '', scopeId: null,
    vertical: null, surface: null, method: 'GET', path: '/', status: 200,
    threw: false, durationMs: 1, level: 'info', operation: 'demo/read', problemCode: null,
    principalKind: null, principal: null, eventCount: null, eventTypes: [], entities: [],
    versionId: null, specVersion: null, steps: [], capture: { sqlParams: false, stepsDropped: 0 },
  };
}

describe('dev request trace recorder', () => {
  it('merges host and HTTP heads, names the decision, and withholds SQL values', () => {
    const store = new LocalTraceStore(temp());
    const lines: string[] = [];
    const sink = createDevTraceSink(store, (trace) => lines.push(traceLine(trace)));
    sink.head('req-1', { operation: 'demo/read', principalKind: 'principal' });
    sink.step('req-1', { type: 'check', atMs: 1, permission: 'demo:read', entity: null, allowed: true, decidedBy: 'role:member', requires: [], callerHas: [] });
    sink.step('req-1', { type: 'sql', atMs: 2, operation: 'query', statement: 'SELECT 1', params: ['private'], rowsRead: 1 });
    sink.head('req-1', { method: 'GET', status: 200, durationMs: 3, operation: undefined });
    sink.end('req-1');

    const trace = store.traces()[0]!;
    expect(trace).toMatchObject({ invocationId: 'req-1', operation: 'demo/read', status: 200, capture: { sqlParams: false, stepsDropped: 0 } });
    expect(trace.steps[1]).toMatchObject({ type: 'sql', statement: 'SELECT 1', rowsRead: 1 });
    expect(JSON.stringify(trace)).not.toContain('private');
    expect(lines[0]).toContain('allowed by role:member');
  });

  it('counts dropped steps and prunes by both count and bytes', () => {
    const dir = temp();
    const store = new LocalTraceStore(dir, 2);
    const wideStore = new LocalTraceStore(temp());
    const sink = createDevTraceSink(wideStore, () => {});
    for (let i = 0; i < 501; i++) sink.step('wide', { type: 'log', atMs: i, level: 'info', message: 'step' });
    sink.end('wide');
    expect(wideStore.traces()[0]).toMatchObject({ capture: { stepsDropped: 1 } });
    expect(wideStore.traces()[0]?.steps).toHaveLength(500);
    for (const id of ['a', 'b', 'c']) store.write(head(id));
    const traces = store.traces();
    expect(traces).toHaveLength(2);
    expect(traces[0]?.invocationId).toBe('c');
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(traces.length);

    const oneTraceBytes = Buffer.byteLength(JSON.stringify(head('a')));
    const byteStore = new LocalTraceStore(temp(), 10, oneTraceBytes * 2 - 1);
    byteStore.write(head('a'));
    byteStore.write(head('b'));
    expect(byteStore.traces().map((trace) => trace.invocationId)).toEqual(['b']);
  });

  it('keeps complete records when two processes write and prune at the cap', async () => {
    const dir = temp();
    const moduleUrl = new URL('../dist/dev-traces.js', import.meta.url).href;
    const script = `import { LocalTraceStore } from ${JSON.stringify(moduleUrl)};
      const store = new LocalTraceStore(process.argv[1], 2, 8192);
      const trace = JSON.parse(process.argv[2]);
      for (let i = 0; i < 2; i++) store.write({ ...trace, invocationId: process.argv[3] + i });`;
    const run = (id: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, JSON.stringify(head(id)), id]);
      let error = '';
      child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(error)));
    });
    await Promise.all([run('left'), run('right')]);
    const store = new LocalTraceStore(dir);
    const names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(names).toHaveLength(2);
    expect(store.traces()).toHaveLength(2);
  });
});
