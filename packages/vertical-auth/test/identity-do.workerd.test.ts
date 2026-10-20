import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { RUNTIME_BASELINE } from '@substrat-run/contracts';

/** The OIDC-only identity directory must boot in real workerd without Node compatibility. */
it('boots IdentityDO and reads its empty owner seat on a flagless Worker', async () => {
  const identity = fileURLToPath(new URL('../src/identity-do.ts', import.meta.url));
  const source = `
    import { IdentityDO } from ${JSON.stringify(identity)};
    export { IdentityDO };
    export default {
      async fetch(_request, env) {
        const stub = env.IDENTITY.get(env.IDENTITY.idFromName('tenant-a'));
        return Response.json({ owner: await stub.getOwnerOfRecord('scope-a') });
      },
    };
  `;
  const result = await build({
    stdin: { contents: source, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:*'],
    write: false,
  });
  const runtime = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.js', contents: result.outputFiles[0]!.text }],
    compatibilityDate: RUNTIME_BASELINE,
    compatibilityFlags: [],
    durableObjects: { IDENTITY: { className: 'IdentityDO', useSQLite: true } },
  });
  try {
    const response = await runtime.dispatchFetch('https://acme.example/');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ owner: null });
  } finally {
    await runtime.dispose();
  }
});
