import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { RUNTIME_BASELINE } from '@substrat-run/contracts';

const src = (file: string) => JSON.stringify(fileURLToPath(new URL(`../src/${file}`, import.meta.url)));

/**
 * A worker over the identity DO: `/` reads the empty owner seat, `/stores` drives the people
 * and refresh stores a hosted plugin and master build over the stub (#3161), through real RPC,
 * and `/sweep` plants refresh rows of an expired session (the subclass writes the timestamp a
 * week-old sign-in would have) and signs in once more (#3179).
 */
const source = `
  import { IdentityDO } from ${src('identity-do.ts')};
  import { identityPeopleStore } from ${src('people.ts')};
  import { identityRefreshStore } from ${src('session-refresh.ts')};
  export class PlantingIdentityDO extends IdentityDO {
    plantRefresh(sid, sub, updatedAt) {
      this.ctx.storage.sql.exec('INSERT INTO session_refresh (sid, sub, refresh_token, updated_at) VALUES (?, ?, ?, ?)', sid, sub, 'rt-' + sid, updatedAt);
    }
  }
  export default {
    async fetch(request, env) {
      const stub = env.IDENTITY.get(env.IDENTITY.idFromName('tenant-a'));
      const path = new URL(request.url).pathname;
      if (path === '/sweep') {
        const sweep = env.IDENTITY.get(env.IDENTITY.idFromName('tenant-sweep'));
        const day = 24 * 60 * 60 * 1000;
        await sweep.plantRefresh('sid-expired', 'ada', new Date(Date.now() - 8 * day).toISOString());
        await sweep.plantRefresh('sid-other-device', 'ada', new Date(Date.now() - 6 * day).toISOString());
        await sweep.putSessionRefresh('sid-new', { sub: 'ada', refreshToken: 'rt-new' });
        return Response.json({
          expired: await sweep.sessionRefresh('sid-expired'),
          otherDevice: await sweep.sessionRefresh('sid-other-device'),
          signedIn: await sweep.sessionRefresh('sid-new'),
        });
      }
      if (path !== '/stores') return Response.json({ owner: await stub.getOwnerOfRecord('scope-a') });
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
    durableObjects: { IDENTITY: { className: 'PlantingIdentityDO', useSQLite: true } },
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

it("sweeps an expired session's refresh token when someone signs in, and keeps the same person's other device", async () => {
  const response = await runtime.dispatchFetch('https://acme.example/sweep');
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({
    expired: null,
    otherDevice: { sub: 'ada', refreshToken: 'rt-sid-other-device' },
    signedIn: { sub: 'ada', refreshToken: 'rt-new' },
  });
});
