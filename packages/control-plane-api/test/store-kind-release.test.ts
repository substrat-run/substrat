import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { RESERVED_STORE_OPERATIONS, platformActorId } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth } from '../src/index.js';

describe('publishing a store kind records the release (#2297)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-store-release-'));
  const host = new SqliteScopeHost({ dir });
  const staff = platformActorId.parse(ulid());
  const stored = new Map<string, Uint8Array>();
  const uploaded: string[] = [];
  const app = createControlPlaneApi({
    host,
    authenticate: UNSAFE_devPlatformActorAuth(),
    storeKinds: [{
      kind: 'graph',
      release: '1.0.0',
      className: 'Store',
      operations: ['read'],
      platformOperations: [...RESERVED_STORE_OPERATIONS],
    }],
    storeReleases: {
      put: async (key, bytes) => {
        stored.set(key, bytes);
      },
      get: async (key) => stored.get(key),
    },
    ensureScopeStores: async (input) => {
      uploaded.push(input.vertical);
    },
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const body = JSON.stringify({
    releaseId: '2026-10-15',
    entry: 'kind_counter.py',
    modules: [{ name: 'kind_counter.py', contentBase64: btoa('class Store:\n    pass\n') }],
  });

  it('an unregistered kind is refused before anything is stored', async () => {
    const res = await app.request('/store-kinds/other/releases', {
      method: 'POST',
      headers: { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(403);
    expect(stored.size).toBe(0);
  });

  it('with no vertical serving the kind, the release becomes current and nothing is uploaded', async () => {
    const res = await app.request('/store-kinds/graph/releases', {
      method: 'POST',
      headers: { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' },
      body,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const json = (await res.json()) as { release: { status: string; releaseId: string }; verticals: string[] };
    expect(json.release.status).toBe('current');
    expect(json.release.releaseId).toBe('2026-10-15');
    expect(json.verticals).toEqual([]);
    expect(uploaded).toEqual([]);
    const rows = await host.admin.listStoreKindReleases(staff, 'graph');
    expect(rows.map((r) => r.status)).toEqual(['current']);
  });

  it('the same release id is refused, and a rollback with no previous release is a conflict', async () => {
    const again = await app.request('/store-kinds/graph/releases', {
      method: 'POST',
      headers: { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' },
      body,
    });
    expect(again.status).toBe(409);
    const rollback = await app.request('/store-kinds/graph/rollback', {
      method: 'POST',
      headers: { [DEV_ACTOR_HEADER]: staff },
    });
    expect(rollback.status).toBe(409);
  });
});
