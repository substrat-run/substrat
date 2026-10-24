import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { migrationDigestOf, platformActorId, tenantId } from '@substrat-run/contracts';
import { generateScopeStoreKeyPair, scopeStoreKeyId } from '@substrat-run/contracts/scope-store-envelope';
import {
  WIRE_AUDIENCE_VAR,
  WIRE_PLATFORM_KEYS_VAR,
  WIRE_ROUTER_KEYS_VAR,
  WIRE_STATE_VAR,
  wireStateOf,
} from '@substrat-run/contracts/wire-signing';
import { ulid } from '@substrat-run/kernel';
import {
  createControlPlaneApi,
  createWfpUploader,
  deploymentRefFor,
  DEV_ACTOR_HEADER,
  stableDeploymentRefFor,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';
import { wireKeysRolloutOf, wireUploadFor, type WireUploadSettings } from '../src/wire-upload.js';

/**
 * RFC wire-signing step 2, follow-on 3: what both uploads `api.ts` sends (the per-version push and
 * the serving upload) give a deployment for the envelope's verifier, under the control plane's
 * `WIRE_KEYS_ROLLOUT`, and the capability record each writes. Driven through the real routes and the
 * real uploader (`createWfpUploader`, Cloudflare stubbed at `fetch`), so the bindings asserted are
 * the ones in the multipart metadata Cloudflare would be sent.
 */

const WIRE = /^SUBSTRAT_WIRE_/;

describe('wireKeysRolloutOf: the rollout setting’s one reading', () => {
  it.each([undefined, null, '', '  ', 'off', ' off '])('%j is off', (value) => {
    expect(wireKeysRolloutOf(value)).toEqual({ kind: 'off' });
  });

  it('`fleet` is every deployment; `canary:<vertical>` one vertical, bare or tenant-owned', () => {
    expect(wireKeysRolloutOf('fleet')).toEqual({ kind: 'fleet' });
    expect(wireKeysRolloutOf('canary:todo')).toEqual({ kind: 'canary', vertical: 'todo' });
    expect(wireKeysRolloutOf(' canary: acme/crm ')).toEqual({ kind: 'canary', vertical: 'acme/crm' });
  });

  it.each([
    ['a second vertical', 'canary:todo,meridian', /one vertical/],
    ['two separated by a space', 'canary:todo meridian', /one vertical/],
    ['no vertical', 'canary:', /registry slug/],
    ['a name the registry never gives', 'canary:Todo', /registry slug/],
    ['an unknown word', 'on', /`off`, `canary:<vertical>` or `fleet`/],
    ['another spelling', 'Fleet', /`off`, `canary:<vertical>` or `fleet`/],
    ['not text', 1, /not text/],
  ])('refuses %s', (_, value, reason) => {
    expect(wireKeysRolloutOf(value)).toEqual({ refused: expect.stringMatching(reason) });
  });
});

describe('the uploader gives the deployments the rollout names their lists, audience and state, and records it', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };
  const puts: { script: string; meta: Record<string, any> }[] = [];
  let routerKeys: string;
  let platformKeys: string;
  let kids: { router: string[]; platform: string[] };
  const apps = new Map<string, ReturnType<typeof createControlPlaneApi>>();

  beforeAll(async () => {
    const [r1, r2, p1, p2] = await Promise.all([1, 2, 3, 4].map(() => generateScopeStoreKeyPair()));
    // The key in use and its standby, per issuer, as the RFC lists them.
    routerKeys = ` ${r1!.publicKey},${r2!.publicKey} `;
    platformKeys = `${p1!.publicKey},${p2!.publicKey}`;
    kids = {
      router: [await scopeStoreKeyId(r1!.publicKey), await scopeStoreKeyId(r2!.publicKey)],
      platform: [await scopeStoreKeyId(p1!.publicKey), await scopeStoreKeyId(p2!.publicKey)],
    };
    dir = mkdtempSync(join(tmpdir(), 'cp-upload-wire-keys-'));
    host = new SqliteScopeHost({ dir });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** One control plane over the shared host, under these settings (none: the option left out). */
  const appWith = (settings: WireUploadSettings | null) => {
    const key = JSON.stringify(settings);
    if (!apps.has(key)) {
      apps.set(
        key,
        createControlPlaneApi({
          host,
          authenticate: UNSAFE_devPlatformActorAuth(),
          deployVertical: createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' }),
          fetchVerticalModules: async () => [
            { name: 'worker.js', content: new TextEncoder().encode('export default {}'), contentType: 'application/javascript+module' },
          ],
          ...(settings ? { wireUpload: settings } : {}),
        }),
      );
    }
    return apps.get(key)!;
  };
  const fleet = () => ({ rollout: 'fleet', routerKeys, platformKeys });

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
  const tenantOf = async (slug: string) => {
    await host.admin.createTenant(staff, { id: tenantId.parse(ulid()), slug, name: slug });
    return slug;
  };
  const deploy = async (app: ReturnType<typeof createControlPlaneApi>, tenant: string, extra: Record<string, unknown> = {}, source = 'export default {}') => {
    const fd = new FormData();
    // Every version declares the same (empty) migration set, so a second one promotes without an acknowledgement.
    const migration = await migrationDigestOf({ doClasses: ['ScopeDO'], migrations: [] });
    fd.set(
      'manifest',
      JSON.stringify({
        version: `0.1.${ulid().toLowerCase()}`,
        entry: 'worker.js',
        compatibilityDate: '2025-01-01',
        doClasses: ['ScopeDO'],
        bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
        digests: { manifest: 'm1', permission: 'p1', migration },
        registry: { permissions: [], roles: [], entityGrants: [] },
        migrations: [],
        ...extra,
      }),
    );
    fd.set('tenant', tenant);
    fd.set('worker.js', new Blob([source], { type: 'application/javascript+module' }), 'worker.js');
    return app.request('/verticals/crm/deploy', { method: 'POST', headers: auth, body: fd });
  };
  const push = async (app: ReturnType<typeof createControlPlaneApi>, tenant: string, source?: string) => {
    const res = await deploy(app, tenant, {}, source);
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string; verticalSlug: string };
  };
  const promote = async (app: ReturnType<typeof createControlPlaneApi>, verticalSlug: string, versionId: string) => {
    const res = await app.request(`/verticals/${encodeURIComponent(verticalSlug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const lastPutTo = (script: string) => [...puts].reverse().find((p) => p.script === script)!;
  const bindingsOf = (script: string) => (lastPutTo(script).meta['bindings'] ?? []) as { type: string; name: string; text?: string }[];
  const wireOf = (script: string) => Object.fromEntries(bindingsOf(script).filter((b) => WIRE.test(b.name)).map((b) => [b.name, b]));
  const recordsOf = async (verticalSlug: string) =>
    Object.fromEntries((await host.admin.listWireAuth!(staff, { verticalSlug })).map((r) => [r.deploymentRef, r]));

  it('fleet: the push and the serving upload each carry both lists, their own name and `dual`, as plain configuration, and each records it', async () => {
    stubCloudflare();
    const app = appWith(fleet());
    const { id, verticalSlug } = await push(app, await tenantOf('wire-fleet'));
    await promote(app, verticalSlug, id);
    const records = await recordsOf(verticalSlug);
    for (const script of [deploymentRefFor(verticalSlug, id), stableDeploymentRefFor(verticalSlug)]) {
      expect(wireOf(script), script).toEqual({
        [WIRE_ROUTER_KEYS_VAR]: { type: 'plain_text', name: WIRE_ROUTER_KEYS_VAR, text: routerKeys.trim() },
        [WIRE_PLATFORM_KEYS_VAR]: { type: 'plain_text', name: WIRE_PLATFORM_KEYS_VAR, text: platformKeys },
        [WIRE_AUDIENCE_VAR]: { type: 'plain_text', name: WIRE_AUDIENCE_VAR, text: script },
        [WIRE_STATE_VAR]: { type: 'plain_text', name: WIRE_STATE_VAR, text: 'dual' },
      });
      // The entry reads them as given: lists present, so `dual`.
      const env = Object.fromEntries(Object.values(wireOf(script)).map((b) => [b.name, b.text]));
      expect(wireStateOf({ routerKeys: env[WIRE_ROUTER_KEYS_VAR], platformKeys: env[WIRE_PLATFORM_KEYS_VAR], state: env[WIRE_STATE_VAR] })).toBe('dual');
      // The vertical's own bindings are in the same upload.
      expect(bindingsOf(script).map((b) => b.name), script).toEqual(expect.arrayContaining(['SCOPE']));
      expect(records[script], script).toMatchObject({
        verticalSlug,
        versionId: id,
        record: { envelope: 1, entrySkipped: null, state: 'dual', audience: script, routerKids: kids.router, platformKids: kids.platform, withheld: null },
      });
    }
  });

  it('off, unset or left out: no upload carries anything, the bindings are the ones sent with no setting at all, and each records that it gave nothing', async () => {
    stubCloudflare();
    const sent: Record<string, string[]> = {};
    for (const [name, settings] of [
      ['none', null],
      ['off', { rollout: 'off', routerKeys, platformKeys }],
      ['unset', { routerKeys, platformKeys }],
    ] as const) {
      const app = appWith(settings);
      const { id, verticalSlug } = await push(app, await tenantOf(`wire-${name}`));
      await promote(app, verticalSlug, id);
      const archive = deploymentRefFor(verticalSlug, id);
      const serving = stableDeploymentRefFor(verticalSlug);
      for (const script of [archive, serving]) expect(Object.keys(wireOf(script)), `${name} ${script}`).toEqual([]);
      sent[name] = [...bindingsOf(archive), ...bindingsOf(serving)].map((b) => `${b.type}:${b.name}`);
      const records = await recordsOf(verticalSlug);
      for (const script of [archive, serving]) {
        expect(records[script]?.record, `${name} ${script}`).toEqual({
          envelope: 1, entrySkipped: null, state: 'legacy-only', audience: null, routerKids: [], platformKids: [], withheld: 'unconfigured',
        });
      }
    }
    expect(sent['off']).toEqual(sent['none']);
    expect(sent['unset']).toEqual(sent['none']);
  });

  it('canary: only the named vertical’s deployments are given lists; another vertical’s upload records that it was left out', async () => {
    stubCloudflare();
    const canaryTenant = await tenantOf('wire-canary');
    const app = appWith({ rollout: `canary:${canaryTenant}/crm`, routerKeys, platformKeys });
    const canary = await push(app, canaryTenant);
    await promote(app, canary.verticalSlug, canary.id);
    const other = await push(app, await tenantOf('wire-other'));
    await promote(app, other.verticalSlug, other.id);

    for (const script of [deploymentRefFor(canary.verticalSlug, canary.id), stableDeploymentRefFor(canary.verticalSlug)]) {
      expect(wireOf(script)[WIRE_AUDIENCE_VAR]?.text, script).toBe(script);
    }
    for (const script of [deploymentRefFor(other.verticalSlug, other.id), stableDeploymentRefFor(other.verticalSlug)]) {
      expect(Object.keys(wireOf(script)), script).toEqual([]);
    }
    const records = await recordsOf(other.verticalSlug);
    expect(Object.values(records).map((r) => r.record.withheld)).toEqual(['not-in-rollout', 'not-in-rollout']);
  });

  it('a re-upload writes the lists again from the setting: given, then taken back by an upload under `off`', async () => {
    stubCloudflare();
    const tenant = await tenantOf('wire-again');
    const first = await push(appWith(fleet()), tenant);
    await promote(appWith(fleet()), first.verticalSlug, first.id);
    const serving = stableDeploymentRefFor(first.verticalSlug);
    expect(wireOf(serving)[WIRE_STATE_VAR]?.text).toBe('dual');

    // The next version, pushed and served under `off`: plain configuration is rewritten on every
    // upload, so the serving script now carries none, and its record says so.
    const off = appWith({ rollout: 'off', routerKeys, platformKeys });
    const second = await push(off, tenant);
    await promote(off, second.verticalSlug, second.id);
    expect(Object.keys(wireOf(serving))).toEqual([]);
    expect((await recordsOf(first.verticalSlug))[serving]).toMatchObject({ versionId: second.id, record: { state: 'legacy-only', withheld: 'unconfigured' } });
  });

  it('lists a deployment’s verifier would refuse are never given: nothing is injected, the record says why, and the log names the problem, never a key', async () => {
    stubCloudflare();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = routerKeys.trim().split(',')[0]!;
    for (const [tenant, settings, reason] of [
      // The router's key listed for the platform too: it could sign as the platform.
      ['wire-shared', { rollout: 'fleet', routerKeys, platformKeys: `${platformKeys},${first}` }, /listed for both issuers/],
      // A list missing.
      ['wire-missing', { rollout: 'fleet', routerKeys }, /at least one key/],
      // A key that is not one.
      ['wire-garbled', { rollout: 'fleet', routerKeys: `${routerKeys},not-a-key`, platformKeys }, /./],
    ] as const) {
      const app = appWith(settings);
      const { id, verticalSlug } = await push(app, await tenantOf(tenant));
      await promote(app, verticalSlug, id);
      for (const script of [deploymentRefFor(verticalSlug, id), stableDeploymentRefFor(verticalSlug)]) {
        expect(Object.keys(wireOf(script)), `${tenant} ${script}`).toEqual([]);
      }
      expect(Object.values(await recordsOf(verticalSlug)).map((r) => r.record.withheld), tenant).toEqual(['lists-refused', 'lists-refused']);
      const lines = errors.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(verticalSlug));
      expect(lines.length, tenant).toBe(2);
      for (const line of lines) {
        expect(JSON.parse(line)).toMatchObject({ substrat: 'wire-upload', vertical: verticalSlug, withheld: 'lists-refused', reason: expect.stringMatching(reason) });
        for (const key of [...routerKeys.trim().split(','), ...platformKeys.split(',')]) expect(line).not.toContain(key);
      }
    }
  });

  it('a rollout setting it cannot read gives nothing, records `rollout-refused` and says why', async () => {
    stubCloudflare();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWith({ rollout: 'canary:a/crm,b/crm', routerKeys, platformKeys });
    const { id, verticalSlug } = await push(app, await tenantOf('wire-two-canaries'));
    expect(Object.keys(wireOf(deploymentRefFor(verticalSlug, id)))).toEqual([]);
    expect(Object.values(await recordsOf(verticalSlug)).map((r) => r.record.withheld)).toEqual(['rollout-refused']);
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({ substrat: 'wire-upload', vertical: verticalSlug, withheld: 'rollout-refused', reason: 'a canary names one vertical' }),
    );
  });

  it('a bundle uploaded without the platform’s entry is still given its lists, and recorded as unable to verify, with the reason', async () => {
    stubCloudflare();
    const app = appWith(fleet());
    // A vertical that writes the invocation line with a kernel older than the platform's stamp:
    // the entry's own skip rule leaves it unwrapped.
    const { id, verticalSlug } = await push(app, await tenantOf('wire-unwrapped'), 'export default {}; console.log({ substrat: "invocation" })');
    const script = deploymentRefFor(verticalSlug, id);
    expect(lastPutTo(script).meta['main_module']).toBe('worker.js');
    expect(wireOf(script)[WIRE_STATE_VAR]?.text).toBe('dual');
    expect((await recordsOf(verticalSlug))[script]?.record).toMatchObject({
      envelope: null,
      entrySkipped: expect.stringMatching(/predates the platform stamp/),
      state: 'dual',
    });
  });

  it('a vertical cannot declare any of them: a push naming one is refused before anything is uploaded', async () => {
    stubCloudflare();
    const app = appWith(fleet());
    const tenant = await tenantOf('wire-declared');
    const before = puts.length;
    for (const name of [WIRE_STATE_VAR, WIRE_ROUTER_KEYS_VAR, WIRE_AUDIENCE_VAR]) {
      const res = await deploy(app, tenant, {
        bindings: [
          { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' },
          { type: 'plain_text', name },
        ],
      });
      expect(res.status, name).toBe(403);
      expect(await res.text(), name).toMatch(/binding namespace is the platform's/);
    }
    expect(puts.length).toBe(before);
  });

  it('a record that cannot be written never fails the upload: the push answers as it would, and the failure is logged', async () => {
    stubCloudflare();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(host.admin, 'recordWireAuth').mockRejectedValue(new Error('directory unavailable'));
    const { id, verticalSlug } = await push(appWith(fleet()), await tenantOf('wire-unrecorded'));
    expect(wireOf(deploymentRefFor(verticalSlug, id))[WIRE_STATE_VAR]?.text).toBe('dual');
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"substrat":"wire-upload-record-failed"'));
  });

  it('no upload in this suite gave a state other than `dual`: no code path here can give `signed-only`', () => {
    const states = puts.flatMap((p) => ((p.meta['bindings'] ?? []) as { name: string; text?: string }[]).filter((b) => b.name === WIRE_STATE_VAR).map((b) => b.text));
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set(['dual']));
  });
});

describe('wireUploadFor: every setting gives `dual` or nothing', () => {
  it('across rollouts and lists, the only states are `dual` (lists given) and `legacy-only` (none)', async () => {
    const [r, p] = await Promise.all([generateScopeStoreKeyPair(), generateScopeStoreKeyPair()]);
    const bundle = { entry: 'worker.js', modules: [{ name: 'worker.js', content: new TextEncoder().encode('export default {}'), contentType: 'application/javascript+module' }] };
    for (const rollout of [undefined, '', 'off', 'fleet', 'canary:todo', 'canary:other', 'signed-only', 'canary:a,b']) {
      for (const lists of [{}, { routerKeys: r.publicKey }, { routerKeys: r.publicKey, platformKeys: p.publicKey }]) {
        const wire = await wireUploadFor({ rollout, ...lists }, { vertical: 'todo', deploymentRef: 'todo-serving', bundle });
        const state = wire.bindings.find((b) => b.name === WIRE_STATE_VAR)?.text;
        expect([undefined, 'dual'], `${rollout} ${JSON.stringify(lists)}`).toContain(state);
        expect(wire.record.state).toBe(state === undefined ? 'legacy-only' : 'dual');
        expect(wire.record.withheld === null, `${rollout}`).toBe(state !== undefined);
      }
    }
  });
});
