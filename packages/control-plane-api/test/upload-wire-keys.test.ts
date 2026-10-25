import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { LIST_PAGE_MAX, platformActorId, tenantId } from '@substrat-run/contracts';
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
import { heldManifest } from './held-manifest.js';

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
  beforeEach(() => stubCloudflare());
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
    // A held migration set (the same for every version), so a second version promotes without an acknowledgement.
    const manifest = await heldManifest({
      version: `0.1.${ulid().toLowerCase()}`,
      entry: 'worker.js',
      compatibilityDate: '2025-01-01',
      doClasses: ['ScopeDO'],
      bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
      digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
      registry: { permissions: [], roles: [], entityGrants: [] },
      ...extra,
    });
    fd.set('manifest', JSON.stringify(manifest));
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
  /** A version pushed and promoted: its id, its vertical, and the two scripts the uploads went to. */
  const serve = async (app: ReturnType<typeof createControlPlaneApi>, tenant: string) => {
    const { id, verticalSlug } = await push(app, tenant);
    await promote(app, verticalSlug, id);
    return { id, verticalSlug, scripts: [deploymentRefFor(verticalSlug, id), stableDeploymentRefFor(verticalSlug)] as const };
  };
  const failuresOf = async (vertical: string) => {
    // The recorder is fire-and-forget: let its write settle before reading.
    await new Promise((r) => setTimeout(r, 20));
    return host.admin.listOpsFailures(staff, { vertical });
  };
  const lastPutTo = (script: string) => [...puts].reverse().find((p) => p.script === script)!;
  const bindingsOf = (script: string) => (lastPutTo(script).meta['bindings'] ?? []) as { type: string; name: string; text?: string }[];
  const wireOf = (script: string) => Object.fromEntries(bindingsOf(script).filter((b) => WIRE.test(b.name)).map((b) => [b.name, b]));
  const recordsOf = async (verticalSlug: string) =>
    Object.fromEntries((await host.admin.listWireAuth!(staff, { reach: { fleet: true }, limit: LIST_PAGE_MAX, verticalSlug })).map((r) => [r.deploymentRef, r]));

  it('fleet: the push and the serving upload each carry both lists, their own name and `dual`, as plain configuration, and each records it', async () => {
    const { id, verticalSlug, scripts } = await serve(appWith(fleet()), await tenantOf('wire-fleet'));
    const records = await recordsOf(verticalSlug);
    for (const script of scripts) {
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
    const sent: Record<string, unknown[]> = {};
    // Whole binding objects, the version's own id aside: it is the one value two versions never share.
    const comparable = (b: { name: string; text?: string }) => (b.name === 'SUBSTRAT_VERSION_ID' ? { ...b, text: '<version>' } : b);
    for (const [name, settings] of [
      ['none', null],
      ['off', { rollout: 'off', routerKeys, platformKeys }],
      ['unset', { routerKeys, platformKeys }],
    ] as const) {
      const { verticalSlug, scripts } = await serve(appWith(settings), await tenantOf(`wire-${name}`));
      const [archive, serving] = scripts;
      for (const script of scripts) expect(Object.keys(wireOf(script)), `${name} ${script}`).toEqual([]);
      sent[name] = [...bindingsOf(archive), ...bindingsOf(serving)].map(comparable);
      const records = await recordsOf(verticalSlug);
      for (const script of scripts) {
        expect(records[script]?.record, `${name} ${script}`).toEqual({
          envelope: 1, entrySkipped: null, state: 'legacy-only', audience: null, routerKids: [], platformKids: [], withheld: 'unconfigured',
        });
      }
    }
    expect(sent['off']).toEqual(sent['none']);
    expect(sent['unset']).toEqual(sent['none']);
  });

  it('canary: only the named vertical’s deployments are given lists; another vertical’s upload records that it was left out', async () => {
    const canaryTenant = await tenantOf('wire-canary');
    const app = appWith({ rollout: `canary:${canaryTenant}/crm`, routerKeys, platformKeys });
    const canary = await serve(app, canaryTenant);
    const other = await serve(app, await tenantOf('wire-other'));
    for (const script of canary.scripts) expect(wireOf(script)[WIRE_AUDIENCE_VAR]?.text, script).toBe(script);
    for (const script of other.scripts) expect(Object.keys(wireOf(script)), script).toEqual([]);
    const records = await recordsOf(other.verticalSlug);
    expect(Object.values(records).map((r) => r.record.withheld)).toEqual(['not-in-rollout', 'not-in-rollout']);
  });

  it('the in-place serve every later promote does gives the serving script its lists too, under the fleet and under a canary', async () => {
    for (const kind of ['fleet', 'canary'] as const) {
      const tenant = await tenantOf(`wire-inplace-${kind}`);
      const app = appWith({ rollout: kind === 'fleet' ? 'fleet' : `canary:${tenant}/crm`, routerKeys, platformKeys });
      await serve(app, tenant);
      const second = await serve(app, tenant);
      const serving = second.scripts[1];
      // The second serve updated the serving script in place: no fresh migration tag, as a first serve declares.
      expect(puts.filter((p) => p.script === serving)).toHaveLength(2);
      expect(lastPutTo(serving).meta['migrations'], kind).toBeUndefined();
      expect(Object.values(wireOf(serving)).map((b) => [b.name, b.text]), kind).toEqual([
        [WIRE_ROUTER_KEYS_VAR, routerKeys.trim()],
        [WIRE_PLATFORM_KEYS_VAR, platformKeys],
        [WIRE_AUDIENCE_VAR, serving],
        [WIRE_STATE_VAR, 'dual'],
      ]);
      expect((await recordsOf(second.verticalSlug))[serving], kind).toMatchObject({
        versionId: second.id,
        record: { state: 'dual', audience: serving, routerKids: kids.router, platformKids: kids.platform, withheld: null },
      });
    }
  });

  it('a re-upload writes the lists again from the setting: given, then taken back by an upload under `off`', async () => {
    const tenant = await tenantOf('wire-again');
    const first = await serve(appWith(fleet()), tenant);
    const serving = first.scripts[1];
    expect(wireOf(serving)[WIRE_STATE_VAR]?.text).toBe('dual');

    // The next version, pushed and served under `off`: plain configuration is rewritten on every
    // upload, so the serving script now carries none, and its record says so.
    const second = await serve(appWith({ rollout: 'off', routerKeys, platformKeys }), tenant);
    expect(Object.keys(wireOf(serving))).toEqual([]);
    expect((await recordsOf(first.verticalSlug))[serving]).toMatchObject({ versionId: second.id, record: { state: 'legacy-only', withheld: 'unconfigured' } });
  });

  it('lists a deployment’s verifier would refuse are never given: nothing is injected, the record says why, and the log names the problem, never a key', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = routerKeys.trim().split(',')[0]!;
    for (const [tenant, settings, reason] of [
      // The router's key listed for the platform too: it could sign as the platform.
      ['wire-shared', { rollout: 'fleet', routerKeys, platformKeys: `${platformKeys},${first}` }, /listed for both issuers/],
      // A list missing.
      ['wire-missing', { rollout: 'fleet', routerKeys }, /^WIRE_PLATFORM_PUBLIC_KEYS lists no key$/],
      // A key that is not one.
      ['wire-garbled', { rollout: 'fleet', routerKeys: `${routerKeys},not-a-key`, platformKeys }, /^WIRE_ROUTER_PUBLIC_KEYS: a public key /],
    ] as const) {
      const { verticalSlug, scripts } = await serve(appWith(settings), await tenantOf(tenant));
      for (const script of scripts) expect(Object.keys(wireOf(script)), `${tenant} ${script}`).toEqual([]);
      expect(Object.values(await recordsOf(verticalSlug)).map((r) => r.record.withheld), tenant).toEqual(['lists-refused', 'lists-refused']);
      const lines = errors.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(verticalSlug));
      expect(lines.length, tenant).toBe(2);
      for (const line of lines) {
        expect(JSON.parse(line)).toMatchObject({ substrat: 'wire-upload', vertical: verticalSlug, withheld: 'lists-refused', reason: expect.stringMatching(reason) });
        for (const key of [...routerKeys.trim().split(','), ...platformKeys.split(',')]) expect(line).not.toContain(key);
      }
      // Recorded as an operational failure too, once per upload, by reason.
      const failures = (await failuresOf(verticalSlug)).filter((f) => f.operation === 'deploy.wire-upload');
      expect(failures.map((f) => f.stage), tenant).toEqual(['lists-refused', 'lists-refused']);
    }
  });

  it('a rollout setting it cannot read gives nothing, records `rollout-refused` and says why', async () => {
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
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(host.admin, 'recordWireAuth').mockRejectedValue(new Error('directory unavailable'));
    const { id, verticalSlug } = await push(appWith(fleet()), await tenantOf('wire-unrecorded'));
    expect(wireOf(deploymentRefFor(verticalSlug, id))[WIRE_STATE_VAR]?.text).toBe('dual');
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"substrat":"wire-upload-record-failed"'));
    expect((await failuresOf(verticalSlug)).map((f) => [f.operation, f.version])).toContainEqual(['deploy.wire-record', id]);
  });

  it('the first push of a vertical registers it before it records, and so does its first serve: the registered-only rule never refuses an upload', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const settings of [fleet(), { rollout: 'off', routerKeys, platformKeys }]) {
      // A tenant and a slug the registry has never seen.
      const tenant = await tenantOf(`wire-first-${ulid().slice(-6).toLowerCase()}`);
      const order: string[] = [];
      const register = host.admin.registerVertical.bind(host.admin);
      const record = host.admin.recordWireAuth!.bind(host.admin);
      vi.spyOn(host.admin, 'registerVertical').mockImplementation(async (actor, input) => {
        order.push(`register ${input.slug}`);
        return register(actor, input);
      });
      vi.spyOn(host.admin, 'recordWireAuth').mockImplementation(async (actor, input) => {
        order.push(`record ${input.deploymentRef}`);
        return record(actor, input);
      });
      const { id, verticalSlug, scripts } = await serve(appWith(settings), tenant);
      const [archive, serving] = scripts;
      expect(order.indexOf(`register ${verticalSlug}`)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(`register ${verticalSlug}`)).toBeLessThan(order.indexOf(`record ${archive}`));
      expect(order.indexOf(`record ${serving}`)).toBeGreaterThan(order.indexOf(`record ${archive}`));
      const records = await recordsOf(verticalSlug);
      expect(Object.keys(records).sort()).toEqual([archive, serving].sort());
      expect(records[archive]?.versionId).toBe(id);
      expect((await failuresOf(verticalSlug)).filter((f) => f.operation === 'deploy.wire-record')).toEqual([]);
      vi.restoreAllMocks();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    }
    errors.mockRestore();
  });

  it('a record refused because the vertical went away mid-push is the visible ops failure, and nothing is stored', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const record = host.admin.recordWireAuth!.bind(host.admin);
    // The vertical is deleted between its upload and its record: the race the rule exists for.
    vi.spyOn(host.admin, 'recordWireAuth').mockImplementation(async (actor, input) => {
      await host.admin.deleteVertical(actor, input.verticalSlug);
      return record(actor, input);
    });
    await push(appWith(fleet()), await tenantOf('wire-raced'));
    vi.restoreAllMocks();
    // Named here: the vertical is gone, so the push's answer can no longer name it.
    const verticalSlug = 'wire-raced/crm';
    expect(await host.admin.listWireAuth!(staff, { reach: { fleet: true }, limit: LIST_PAGE_MAX, verticalSlug })).toEqual([]);
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('"substrat":"wire-upload-record-failed"'));
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringMatching(/"error":"[^"]*not_found"/));
    expect((await failuresOf(verticalSlug)).filter((f) => f.operation === 'deploy.wire-record').map((f) => f.version)).toEqual([expect.stringMatching(/^[0-9A-Z]{26}$/)]);
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
