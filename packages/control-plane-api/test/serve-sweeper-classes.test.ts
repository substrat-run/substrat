import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  createWfpUploader,
  DEV_ACTOR_HEADER,
  stableDeploymentRefFor,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * The serving record holds the classes the serving script ACTUALLY has (#1902, Codex r1 on
 * #2022). The platform's sweeper is a class the version's manifest does not declare — the
 * uploader adds it — so a record built from `manifest.doClasses` was a class short of the
 * script, and the next in-place upload re-declared `SweeperDO` as new under a bumped tag: an
 * upload Cloudflare refuses, on a script that is already live.
 *
 * Driven through the REAL uploader (`createWfpUploader`, Cloudflare stubbed at `fetch`), so the
 * migration block asserted is the one the runtime would be sent, and walked through every
 * upload a served version gets: the first serve, a re-serve of the same version, a promote to
 * the next one, and a rollback to the first.
 */
describe('a supplied sweeper on the serving script: one class set, recorded and migrated (#1902)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };
  /** The metadata of every script PUT, in order. */
  const puts: { url: string; meta: Record<string, any> }[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-serve-sweeper-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      deployVertical: createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' }),
      fetchVerticalModules: async () => [
        { name: 'worker.js', content: new TextEncoder().encode('export default {}'), contentType: 'application/javascript+module' },
      ],
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Cloudflare, stubbed: every script PUT recorded with its metadata, every call answered 200. */
  function stubCloudflare() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
        if (init?.method === 'PUT' && init.body instanceof FormData) {
          puts.push({ url, meta: JSON.parse(await (init.body.get('metadata') as File).text()) });
        }
        return new Response('{}', { status: 200 });
      }),
    );
  }

  const schedules = [{ moduleId: 'crm', operation: 'crm/tick', cadence: { everyMinutes: 5 } }];
  /** The `npm create substrat` template's shape: ScopeDO and ConfigDO, no sweeper of its own. */
  const TEMPLATE = [
    { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' },
    { type: 'durable_object_namespace', name: 'CONFIG', class_name: 'ConfigDO' },
  ];
  const manifest = (version: string, extra: { type: string; name: string; class_name: string }[] = []) => ({
    version,
    entry: 'worker.js',
    compatibilityDate: '2025-01-01',
    doClasses: [...TEMPLATE, ...extra].map((b) => b.class_name),
    bindings: [...TEMPLATE, ...extra],
    digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
    registry: { permissions: [], roles: [], entityGrants: [] },
    schedules,
    sweeperClasses: [],
  });
  const push = async (version: string, extra?: Parameters<typeof manifest>[1]): Promise<{ id: string; verticalSlug: string }> => {
    const fd = new FormData();
    fd.set('manifest', JSON.stringify(manifest(version, extra)));
    fd.set('tenant', 'sweep-serve');
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    const res = await app.request('/verticals/crm/deploy', { method: 'POST', headers: auth, body: fd });
    expect(res.status, await res.clone().text()).toBe(201);
    return res.json();
  };
  const promote = async (slug: string, versionId: string) => {
    const res = await app.request(`/verticals/${encodeURIComponent(slug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  /** The last PUT to the serving script, and the serving record after it. */
  const served = async (slug: string) => {
    const stable = stableDeploymentRefFor(slug);
    const put = [...puts].reverse().find((p) => p.url.endsWith(`/scripts/${encodeURIComponent(stable)}`));
    return { meta: put!.meta, record: await host.admin.verticalServing(staff, slug) };
  };

  it('records SweeperDO with the first serve; no later upload re-declares it, and a new class still moves the tag', async () => {
    stubCloudflare();
    await host.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug: 'sweep-serve', name: 'sweep-serve' });
    const v1 = await push('0.1.0');
    const slug = v1.verticalSlug;
    const BASE = ['ScopeDO', 'ConfigDO', 'SweeperDO'];

    // First serve: a fresh serving script, every class declared under v1 — and RECORDED.
    await promote(slug, v1.id);
    const first = await served(slug);
    expect(first.meta['migrations']).toEqual({ new_tag: 'v1', new_sqlite_classes: BASE });
    expect(first.meta['bindings']).toContainEqual({ type: 'durable_object_namespace', name: 'SWEEPER', class_name: 'SweeperDO' });
    expect(first.record).toMatchObject({ doClasses: BASE, migrationTag: 'v1' });

    // A re-serve of the same version, a promote to the next, and a rollback to the first: each
    // an in-place upload with NO migration block, and the record's classes and tag unmoved.
    const v2 = await push('0.2.0');
    for (const versionId of [v1.id, v2.id, v1.id]) {
      await promote(slug, versionId);
      const step = await served(slug);
      expect(step.meta['migrations']).toBeUndefined();
      expect(step.meta['bindings']).toContainEqual({ type: 'durable_object_namespace', name: 'SWEEPER', class_name: 'SweeperDO' });
      expect(step.record).toMatchObject({ doClasses: BASE, migrationTag: 'v1', versionId });
    }

    // A later version that adds a class of its own: exactly that class, under the next tag.
    const v3 = await push('0.3.0', [{ type: 'durable_object_namespace', name: 'NOTES', class_name: 'NotesDO' }]);
    await promote(slug, v3.id);
    const grown = await served(slug);
    expect(grown.meta['migrations']).toEqual({ old_tag: 'v1', new_tag: 'v2', new_sqlite_classes: ['NotesDO'] });
    expect(grown.record).toMatchObject({ doClasses: [...BASE, 'NotesDO'], migrationTag: 'v2' });

    // …and rolling back past it neither re-declares nor drops anything: the class set only grows.
    await promote(slug, v1.id);
    const back = await served(slug);
    expect(back.meta['migrations']).toBeUndefined();
    expect(back.record).toMatchObject({ doClasses: [...BASE, 'NotesDO'], migrationTag: 'v2', versionId: v1.id });
  });
});
