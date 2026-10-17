import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { migrationDigestOf, platformActorId, tenantId } from '@substrat-run/contracts';
import {
  migrationSetDigest,
  migrationSetDivergence,
  migrationSteps,
  MIGRATIONS_DIGEST_BINDING,
  moduleMigrations,
  ulid,
} from '@substrat-run/kernel';
import {
  createControlPlaneApi,
  createWfpUploader,
  deploymentRefFor,
  DEV_ACTOR_HEADER,
  stableDeploymentRefFor,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * #2349: both uploads `api.ts` sends — the per-version push and the serving upload — carry the
 * stored migration set digest a scope host checks before it applies a migration, as the
 * `SUBSTRAT_MIGRATIONS_DIGEST` plain_text binding, and a version whose migrations the control
 * plane does not hold carries none. Driven through the real routes and the real uploader
 * (`createWfpUploader`, Cloudflare stubbed at `fetch`), so the bindings asserted are the ones in
 * the multipart metadata Cloudflare would be sent.
 */
describe('a vertical upload carries the stored migration set digest (#2349)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };
  const puts: { script: string; meta: Record<string, any> }[] = [];

  /** A module as a host registers it: two authored migrations. */
  const mod = {
    manifest: { id: 'acme-crm' },
    migrations: [
      { version: '0001-init', sql: 'CREATE TABLE contacts (id TEXT PRIMARY KEY);' },
      { version: '0002-note', sql: 'ALTER TABLE contacts ADD COLUMN note TEXT;' },
    ],
  };
  /** What a push of it declares: the kernel's own list, flattened with the module, as the CLI does. */
  const declared = moduleMigrations(mod).map((m) => ({ moduleId: mod.manifest.id, version: m.version, sql: m.sql }));

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-upload-migrations-digest-'));
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

  function stubCloudflare() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
        if (init?.method === 'PUT' && init.body instanceof FormData) {
          const meta = JSON.parse(await (init.body.get('metadata') as File).text());
          puts.push({ script: decodeURIComponent(url.split('/scripts/')[1]!.split('/')[0]!), meta });
        }
        return new Response('{}', { status: 200 });
      }),
    );
  }
  const push = async (slug: string, migrations?: typeof declared) => {
    await host.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug, name: slug });
    const fd = new FormData();
    fd.set(
      'manifest',
      JSON.stringify({
        version: '0.1.0',
        entry: 'worker.js',
        compatibilityDate: '2025-01-01',
        doClasses: ['ScopeDO'],
        bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
        digests: {
          manifest: 'm1',
          permission: 'p1',
          migration: migrations ? await migrationDigestOf({ doClasses: ['ScopeDO'], migrations }) : 'g1',
        },
        registry: { permissions: [], roles: [], entityGrants: [] },
        ...(migrations ? { migrations } : {}),
      }),
    );
    fd.set('tenant', slug);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    const res = await app.request('/verticals/crm/deploy', { method: 'POST', headers: auth, body: fd });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string; verticalSlug: string };
  };
  const promote = async (verticalSlug: string, versionId: string) => {
    const res = await app.request(`/verticals/${encodeURIComponent(verticalSlug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const digestSentTo = (script: string) =>
    ([...puts].reverse().find((p) => p.script === script)?.meta['bindings'] as { type: string; name: string; text?: string }[])
      .filter((b) => b.name === MIGRATIONS_DIGEST_BINDING);

  it('a held version: the push and the serving upload carry the digest a scope registering the same migrations matches', async () => {
    stubCloudflare();
    const { id, verticalSlug } = await push('digest-held', declared);
    await promote(verticalSlug, id);
    const expected = await migrationSetDigest(declared);
    for (const script of [deploymentRefFor(verticalSlug, id), stableDeploymentRefFor(verticalSlug)]) {
      expect(digestSentTo(script), script).toEqual([{ type: 'plain_text', name: MIGRATIONS_DIGEST_BINDING, text: expected }]);
    }
    // Against the consumer: a scope host registering this module compares equal, and one
    // registering other SQL under the same versions does not.
    expect(await migrationSetDivergence([{ id: mod.manifest.id, steps: migrationSteps(mod) }], expected)).toBeNull();
    const edited = { ...mod, migrations: mod.migrations.map((m, i) => (i === 0 ? { ...m, sql: `${m.sql}\n-- edited` } : m)) };
    expect(await migrationSetDivergence([{ id: mod.manifest.id, steps: migrationSteps(edited) }], expected)).toMatch(
      /^the authored migrations this deployment registers are not the ones stored/,
    );
  });

  it('an unheld version (its push left the migrations out) injects no binding on either upload', async () => {
    stubCloudflare();
    const { id, verticalSlug } = await push('digest-unheld');
    await promote(verticalSlug, id);
    for (const script of [deploymentRefFor(verticalSlug, id), stableDeploymentRefFor(verticalSlug)]) {
      expect(digestSentTo(script), script).toEqual([]);
    }
  });
});
