import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalTraceStore } from '../src/dev-traces.js';
import { dev } from '../src/dev.js';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const cli = join(repo, 'packages/cli/dist/cli.js');
const dirs: string[] = [];
const children: ChildProcess[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-dev-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ }
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('substrat dev', () => {
  it('returns the project script exit code unchanged when tracing is off', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node -e "process.exit(7)"' } }));
    expect(await dev({ dir, trace: false })).toBe(7);
    expect(existsSync(join(dir, '.data'))).toBe(false);
  });

  it('runs the project script if the tracing preload cannot load, with one warning', async () => {
    const project = temp();
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'node -e "process.exit(7)"' } }));
    const isolated = temp();
    writeFileSync(join(isolated, 'package.json'), '{"type":"module"}');
    copyFileSync(join(repo, 'packages/cli/dist/dev.js'), join(isolated, 'dev.js'));
    const moduleUrl = pathToFileURL(join(isolated, 'dev.js')).href;
    const script = `const { dev } = await import(${JSON.stringify(moduleUrl)}); process.exitCode = await dev({ dir: ${JSON.stringify(project)} });`;
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stderr }));
    });
    expect(result.code).toBe(7);
    expect(result.stderr.match(/warning: local request traces unavailable:/g)).toHaveLength(1);
  });

  it('preloads through concurrently and tsx watch, then records allowed and denied HTTP calls', async () => {
    // One process launch tests the real inheritance chain; the adapter's own trace suite
    // separately proves that its permission checker supplies these check steps.
    const dir = temp();
    const ready = join(dir, 'ready');
    const concurrently = join(repo, 'node_modules/.bin/concurrently');
    const tsx = join(repo, 'node_modules/.bin/tsx');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { dev: `${JSON.stringify(concurrently)} -k ${JSON.stringify(`${tsx} watch server.js`)}` },
    }));
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(join(repo, 'packages/vertical-host/node_modules/hono'), join(dir, 'node_modules/hono'), 'dir');
    const middleware = pathToFileURL(join(repo, 'packages/vertical-host/dist/invocation-log.js')).href;
    writeFileSync(join(dir, 'server.js'), `
      import { createServer } from 'node:http';
      import { writeFileSync } from 'node:fs';
      import { Hono } from 'hono';
      import { invocationLog, invocationStampOf } from ${JSON.stringify(middleware)};
      const app = new Hono();
      app.use('*', invocationLog({ allowUnsigned: () => true }));
      app.get('/:answer', (c) => {
        const stamp = invocationStampOf(c.req.raw);
        const allowed = c.req.param('answer') === 'allowed';
        stamp.record.operation = 'demo/read';
        stamp.record.principalKind = 'principal';
        if (!allowed) stamp.record.problemCode = 'permission_denied';
        const sink = globalThis[Symbol.for('substrat.trace-sink')];
        sink.head(stamp.invocationId, { principalKind: 'principal' });
        sink.step(stamp.invocationId, {
          type: 'check', atMs: 0, permission: 'demo:read', entity: null, allowed,
          decidedBy: allowed ? 'role:member' : null,
          requires: allowed ? [] : ['member'], callerHas: allowed ? [] : ['viewer'],
        });
        return c.json({ ok: allowed }, allowed ? 200 : 403);
      });
      const server = createServer(async (req, res) => {
        const response = await app.request(new Request('http://localhost' + req.url, { method: req.method }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
      server.listen(0, '127.0.0.1', () => writeFileSync(process.env.READY, String(server.address().port)));
    `);

    const child = spawn(process.execPath, [cli, 'dev', dir], {
      env: { ...process.env, READY: ready }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await vi.waitFor(() => {
      if (child.exitCode !== null) throw new Error(`dev exited early: ${output}`);
      expect(existsSync(ready)).toBe(true);
    }, { timeout: 10_000, interval: 20 });
    const port = Number(readFileSync(ready, 'utf8'));
    const allowed = await fetch(`http://127.0.0.1:${port}/allowed`);
    const denied = await fetch(`http://127.0.0.1:${port}/denied`);
    expect([allowed.status, denied.status]).toEqual([200, 403]);
    const ids = [allowed.headers.get('x-substrat-request-id'), denied.headers.get('x-substrat-request-id')];
    expect(ids.every(Boolean)).toBe(true);
    const traces = new LocalTraceStore(join(dir, '.data', 'substrat-traces')).traces();
    expect(traces.map((trace) => trace.invocationId).sort()).toEqual([...ids].sort());
    expect(traces.find((trace) => trace.status === 200)?.steps).toContainEqual(expect.objectContaining({ type: 'check', allowed: true, decidedBy: 'role:member' }));
    expect(traces.find((trace) => trace.status === 403)?.steps).toContainEqual(expect.objectContaining({ type: 'check', allowed: false, requires: ['member'] }));
    await vi.waitFor(() => {
      expect(output).toContain('[substrat trace]');
      expect(output).toContain('requires member; caller has viewer');
    }, { timeout: 2_000, interval: 20 });
    const stopped = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once('exit', (code, signal) => resolve([code, signal])));
    child.kill('SIGINT');
    await stopped;
    await expect(fetch(`http://127.0.0.1:${port}/allowed`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  }, 15_000);
});
