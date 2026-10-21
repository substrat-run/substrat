import { afterAll, expect, it } from 'vitest';
import { builtinModules } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const workers: Miniflare[] = [];
afterAll(async () => {
  await Promise.all(workers.map((worker) => worker.dispose()));
});

it('uses Worker crypto instead of tweetnacl’s guarded Node PRNG on workerd', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import nacl from 'tweetnacl';
        export default {
          fetch() {
            return Response.json({
              globalRequireType: typeof globalThis.require,
              workerCrypto: typeof self.crypto.getRandomValues === 'function',
              randomBytes: Array.from(nacl.randomBytes(4)),
            });
          },
        };
      `,
      resolveDir: dirname(fileURLToPath(import.meta.url)) + '/..',
      sourcefile: 'worker.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['node:*', ...builtinModules],
    write: false,
    logLevel: 'silent',
  });
  const worker = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.js', contents: bundle.outputFiles[0]!.text }],
    compatibilityDate: '2026-07-01',
    compatibilityFlags: [],
  });
  workers.push(worker);

  const response = await worker.dispatchFetch('http://localhost/');
  expect(response.status).toBe(200);
  const result = await response.json() as { globalRequireType: string; workerCrypto: boolean; randomBytes: number[] };
  expect(result.globalRequireType).toBe('undefined');
  expect(result.workerCrypto).toBe(true);
  expect(result.randomBytes).toHaveLength(4);
});
