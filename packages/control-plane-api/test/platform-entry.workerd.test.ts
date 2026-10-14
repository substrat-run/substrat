import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_BASELINE } from '@substrat-run/contracts';
import { PLATFORM_ENTRY_MODULE, withPlatformEntry } from '../src/platform-entry.js';

/**
 * #2245, on workerd: the platform entry imports `node:async_hooks` so a request's store calls
 * reach its line with no observer from the vertical, and workerd allows that import only under
 * `nodejs_als` or `nodejs_compat`. Whether a script with neither starts, and whether a request
 * then really is held in an `AsyncLocalStorage`, are facts about workerd that node cannot
 * answer. So each script here is what `withPlatformEntry` uploads, flags included, run in
 * workerd. The vertical's store call is the kernel's own `observeStoreCall`, bundled into the
 * vertical the way a pushed vertical bundles its kernel: a different copy from the entry's.
 */

const SECRET = 'router-sekret';
const routed = {
  'x-substrat-router': SECRET,
  'x-substrat-tenant': '01JZ0000000000000000TEN001',
  'x-substrat-scope': '01JZ0000000000000000SCP001',
  'x-substrat-vertical': 'acme/widgets',
  'x-substrat-surface': 'app',
};

/** The vertical: two store calls, then answers with the record the platform's stamp holds. */
const VERTICAL = `
import { observeStoreCall } from ${JSON.stringify(fileURLToPath(new URL('../../kernel/src/scope-store.ts', import.meta.url)))};
export default {
  async fetch(request) {
    await observeStoreCall('GRAPH', 'increment', async () => 1);
    await observeStoreCall('GRAPH', 'read', async () => 1);
    const stamp = globalThis[Symbol.for('substrat.invocation-stamp')]?.get(request);
    return Response.json({ storeCalls: stamp?.record.storeCalls ?? null });
  },
};`;

let vertical: string;
beforeAll(async () => {
  const out = await build({
    stdin: { contents: VERTICAL, loader: 'ts', resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    write: false,
  });
  vertical = out.outputFiles[0]!.text;
});

const runtimes: Miniflare[] = [];
afterAll(async () => {
  await Promise.all(runtimes.map((mf) => mf.dispose()));
});

/** Upload the vertical the way the platform does, with these declared flags, and serve one request. */
async function served(compatibilityFlags: string[], compatibilityDate = RUNTIME_BASELINE) {
  const uploaded = withPlatformEntry({
    entry: 'worker.js',
    modules: [{ name: 'worker.js', content: new TextEncoder().encode(vertical), contentType: 'application/javascript+module' }],
    compatibilityFlags,
  });
  const lines: string[] = [];
  const mf = new Miniflare({
    modules: uploaded.modules.map((m) => ({ type: 'ESModule' as const, path: m.name, contents: new TextDecoder().decode(m.content) })),
    modulesRoot: '/',
    compatibilityDate,
    compatibilityFlags: uploaded.compatibilityFlags,
    bindings: { ROUTER_SECRET: SECRET },
    handleRuntimeStdio(stdout) {
      stdout.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n')));
    },
  });
  runtimes.push(mf);
  expect(uploaded.entry).toBe(PLATFORM_ENTRY_MODULE);
  const res = await mf.dispatchFetch('https://acme.example/api/things', { headers: routed });
  const body = (await res.json()) as { storeCalls: Array<{ operation: string }> | null };
  return { flags: uploaded.compatibilityFlags, status: res.status, body, lines };
}

/** The invocation line in a script's stdout. */
const lineOf = (lines: string[]) =>
  lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return undefined; } }).find((l) => l?.['substrat'] === 'invocation');

const NAMED = [
  { binding: 'GRAPH', operation: 'increment', outcome: 'ok', durationMs: expect.any(Number) },
  { binding: 'GRAPH', operation: 'read', outcome: 'ok', durationMs: expect.any(Number) },
];

describe('the platform entry, uploaded and run on workerd (#2245)', () => {
  it('a script with no flags is given nodejs_als, starts, and names its store calls', async () => {
    const run = await served([]);
    expect(run.flags).toEqual(['nodejs_als']);
    expect(run.status).toBe(200);
    expect(run.body.storeCalls).toEqual(NAMED);
    // And the line the entry writes for the request carries them.
    await expect.poll(() => lineOf(run.lines)?.storeCalls).toEqual(NAMED);
  });

  it('nodejs_als needs no particular compatibility date', async () => {
    const run = await served([], '2022-01-01');
    expect(run.flags).toEqual(['nodejs_als']);
    expect(run.body.storeCalls).toEqual(NAMED);
  });

  it('a nodejs_compat script is uploaded with its flags unchanged, and names its store calls', async () => {
    const run = await served(['nodejs_compat']);
    expect(run.flags).toEqual(['nodejs_compat']);
    expect(run.body.storeCalls).toEqual(NAMED);
  });

  it('a script that already carries nodejs_als is uploaded unchanged', async () => {
    const run = await served(['nodejs_als']);
    expect(run.flags).toEqual(['nodejs_als']);
    expect(run.body.storeCalls).toEqual(NAMED);
  });

  it('a script that opts out with no_nodejs_als still starts and answers; its line names no calls', async () => {
    const run = await served(['no_nodejs_als']);
    expect(run.flags).toEqual(['no_nodejs_als']);
    expect(run.status).toBe(200);
    expect(run.body.storeCalls).toBeNull();
  });

  it('an opt-out beside nodejs_compat still names its calls, through process.getBuiltinModule', async () => {
    const run = await served(['nodejs_compat', 'no_nodejs_als']);
    expect(run.flags).toEqual(['nodejs_compat', 'no_nodejs_als']);
    expect(run.body.storeCalls).toEqual(NAMED);
  });

  it('without the flag the entry could not start: the import is why nodejs_als is added', async () => {
    const mf = new Miniflare({
      modules: [{ type: 'ESModule', path: 'entry.js', contents: `import { AsyncLocalStorage } from "node:async_hooks"; export default { fetch: () => new Response(String(typeof AsyncLocalStorage)) };` }],
      compatibilityDate: RUNTIME_BASELINE,
    });
    try {
      await expect(mf.dispatchFetch('https://acme.example/')).rejects.toThrow(/node:async_hooks/);
    } finally {
      await mf.dispose().catch(() => undefined);
    }
  });
});
