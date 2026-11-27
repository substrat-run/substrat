import { createControlPlaneApi } from './setup/build-fixtures.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, tenantId, type VerticalTraceSampling } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, type VerticalBundle } from '../src/index.js';

/**
 * #3358: an app's Workers trace rate is its owner's setting, read per upload — the serving script's
 * at promote, a preview script's at the push that creates it — and floored at the environment's
 * default. Driven through the real deploy, promote and setting routes over the pure host.
 */
describe('an app’s trace rates, read per upload (#3358)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };
  const json = { ...auth, 'content-type': 'application/json' };
  const uploads: Array<{ ref: string; bundle: VerticalBundle }> = [];
  const deployVertical = vi.fn(async (ref: string, bundle: VerticalBundle) => {
    uploads.push({ ref, bundle });
  });

  const appWith = (traceSampling?: { serving?: number; previews?: number }) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical,
      fetchVerticalModules: async () => [
        { name: 'worker.js', content: new TextEncoder().encode('export default {}'), contentType: 'application/javascript+module' },
      ],
      ...(traceSampling ? { traceSampling } : {}),
    });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-trace-sampling-'));
    host = new SqliteScopeHost({ dir });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A tenant's app pushed once (twice, when `rates` are set between): its slug and last version. */
  const pushed = async (app: ReturnType<typeof appWith>, rates?: VerticalTraceSampling) => {
    const slug = `traced-${ulid().toLowerCase()}`;
    const owner = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: owner, slug, name: slug });
    const push = async () => {
      const fd = new FormData();
      fd.set(
        'manifest',
        JSON.stringify({
          version: `0.1.${ulid().toLowerCase()}`,
          entry: 'worker.js',
          compatibilityDate: '2025-01-01',
          doClasses: ['ScopeDO'],
          bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
          digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
          registry: { permissions: [], roles: [], entityGrants: [] },
        }),
      );
      fd.set('tenant', slug);
      fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
      const res = await app.request('/verticals/app/deploy', { method: 'POST', headers: auth, body: fd });
      expect(res.status, await res.clone().text()).toBe(201);
      return (await res.json()) as { id: string; verticalSlug: string };
    };
    // The first push registers the vertical; the setting is made on it, then a second push reads it.
    const first = await push();
    if (rates) await host.admin.setVerticalTraceSampling(staff, first.verticalSlug, rates);
    uploads.length = 0;
    const version = await push();
    return { slug: version.verticalSlug, version };
  };
  const promote = async (app: ReturnType<typeof appWith>, slug: string, versionId: string) => {
    await host.admin.admitVersion(staff, versionId);
    uploads.length = 0;
    const res = await app.request(`/verticals/${encodeURIComponent(slug)}/channels/prod/promote`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ versionId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  };

  it.each([
    ['an app that asked for nothing, with no default: no traces block on either script', undefined, undefined, undefined, undefined],
    ['the owner’s rates, each on its own kind of script', { serving: 0.05, previews: 1 }, undefined, 1, 0.05],
    ['the environment’s default as a floor under a lower request (TEST at 1)', { serving: 0.05, previews: 0 }, { serving: 1, previews: 1 }, 1, 1],
    ['a request above the default', { serving: 0.5, previews: 0 }, { serving: 0.1 }, undefined, 0.5],
  ] as const)('%s', async (_what, rates, defaults, preview, serving) => {
    const app = appWith(defaults);
    const { slug, version } = await pushed(app, rates);
    expect(uploads.map((u) => u.bundle.traceSampling)).toEqual([preview]);
    await promote(app, slug, version.id);
    expect(uploads.map((u) => u.bundle.traceSampling)).toEqual([serving]);
  });

  it('answers what was asked, the defaults and what the next upload declares, and refuses a rate outside 0–1', async () => {
    const app = appWith({ serving: 0.1 });
    const { slug } = await pushed(app);
    const path = `/verticals/${encodeURIComponent(slug)}/trace-sampling`;
    const set = await app.request(path, { method: 'POST', headers: json, body: JSON.stringify({ serving: 0.05, previews: 1 }) });
    expect(set.status, await set.clone().text()).toBe(200);
    const expected = {
      slug,
      asked: { serving: 0.05, previews: 1 },
      defaults: { serving: 0.1, previews: 0 },
      effective: { serving: 0.1, previews: 1 },
    };
    expect(await set.json()).toEqual(expected);
    expect(await (await app.request(path, { headers: auth })).json()).toEqual(expected);
    const refused = await app.request(path, { method: 'POST', headers: json, body: JSON.stringify({ serving: 2, previews: 0 }) });
    expect(refused.status).toBe(400);
  });
});
