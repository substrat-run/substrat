import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A store call made with no observer still reaches the request's record, on
 * workerd (#2245). The workers pool has no second script here; Miniflare is
 * the runtime, with the `nodejs_als` flag the uploader sets.
 */

let mf: Miniflare;

beforeAll(async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('./store-log-worker.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    external: ['node:async_hooks'],
    alias: {
      '@substrat-run/contracts': fileURLToPath(
        new URL('../../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  });
  const contents = bundled.outputFiles?.[0]?.text;
  if (!contents) throw new Error('the store-log worker did not bundle');
  mf = new Miniflare({
    workers: [
      {
        name: 'log',
        modules: [{ type: 'ESModule', path: 'worker.mjs', contents }],
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat', 'nodejs_als'],
      },
    ],
  });
});

afterAll(async () => {
  await mf?.dispose();
});

describe('a store call with no observer is on the request line (#2245)', () => {
  it('records the call, keeps an explicit observer, and stays quiet with no request', async () => {
    const worker = await mf.getWorker('log');
    const heard = await worker.fetch('https://log/');
    expect(heard.status).toBe(200);
    const body = (await heard.json()) as {
      calls: { binding: string; operation: string; outcome: string }[];
      explicit: { operation: string }[];
    };
    expect(body.calls).toEqual([
      expect.objectContaining({ binding: 'GRAPH', operation: 'read', outcome: 'ok' }),
    ]);
    expect(body.explicit).toEqual([expect.objectContaining({ operation: 'named' })]);

    const bare = await worker.fetch('https://log/bare');
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual({ threw: false });
  });
});
