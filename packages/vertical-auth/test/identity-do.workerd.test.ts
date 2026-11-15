import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { RUNTIME_BASELINE } from '@substrat-run/contracts';

const src = (file: string) => JSON.stringify(fileURLToPath(new URL(`../src/${file}`, import.meta.url)));

/**
 * A worker over the identity DO: `/` reads the empty owner seat, and `/stores` drives the people
 * and refresh stores a hosted plugin and master build over the stub (#3161), through real RPC.
 */
const source = `
  import { IdentityDO } from ${src('identity-do.ts')};
  import { identityPeopleStore } from ${src('people.ts')};
  import { identityRefreshStore } from ${src('session-refresh.ts')};
  export { IdentityDO };
  export default {
    async fetch(request, env) {
      const stub = env.IDENTITY.get(env.IDENTITY.idFromName('tenant-a'));
      if (new URL(request.url).pathname !== '/stores') return Response.json({ owner: await stub.getOwnerOfRecord('scope-a') });
      const people = identityPeopleStore(stub);
      const copy = { principal: '01JZ0000000000000000BJ0RN0', status: 'active', expiresAt: '2026-11-15T10:00:00.000Z' };
      await people.saveLogin('scope-a', 'bjorn', copy);
      await people.saveSeated('scope-a', copy.principal, ['writer']);
      const refresh = identityRefreshStore(stub);
      await refresh.put('sid-1', { sub: 'ada', refreshToken: 'rt-1' });
      await refresh.put('sid-1', { sub: 'ada', refreshToken: 'rt-2' });
      const kept = await refresh.get('sid-1');
      await refresh.delete('sid-1');
      return Response.json({
        login: await people.login('scope-a', 'bjorn'),
        otherScope: await people.login('scope-b', 'bjorn'),
        seated: await people.seated('scope-a', copy.principal),
        kept,
        afterDelete: await refresh.get('sid-1'),
      });
    },
  };
`;

let runtime: Miniflare;
beforeAll(async () => {
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
  runtime = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.js', contents: result.outputFiles[0]!.text }],
    compatibilityDate: RUNTIME_BASELINE,
    compatibilityFlags: [],
    durableObjects: { IDENTITY: { className: 'IdentityDO', useSQLite: true } },
  });
});
afterAll(async () => {
  await runtime?.dispose();
});

/** The OIDC-only identity directory must boot in real workerd without Node compatibility. */
it('boots IdentityDO and reads its empty owner seat on a flagless Worker', async () => {
  const response = await runtime.dispatchFetch('https://acme.example/');
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ owner: null });
});

it('keeps a plugin\'s person copies and a master\'s session refresh tokens, over the stub', async () => {
  const response = await runtime.dispatchFetch('https://acme.example/stores');
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({
    login: { principal: '01JZ0000000000000000BJ0RN0', status: 'active', expiresAt: '2026-11-15T10:00:00.000Z' },
    otherScope: null,
    seated: ['writer'],
    kept: { sub: 'ada', refreshToken: 'rt-2' },
    afterDelete: null,
  });
});
