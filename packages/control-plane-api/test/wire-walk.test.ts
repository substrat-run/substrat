import { createControlPlaneApi } from './setup/build-fixtures.js';
/**
 * RFC wire-signing follow-on 4, the fleet walk: `POST /wire-auth/walk` brings every deployed script's
 * key lists, audience and state to what the control plane gives now, a pass at a time. Driven through
 * the real routes: versions are pushed and promoted through the real uploader (`createWfpUploader`,
 * Cloudflare stubbed at `fetch`), and the walk writes through a fake of the script-settings endpoint
 * that holds what each upload sent, plus a secret the platform injected, whose value no output carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { LIST_PAGE_MAX, platformActorId, tenantId, type DeploymentWireAuth } from '@substrat-run/contracts';
import { generateScopeStoreKeyPair, scopeStoreKeyId } from '@substrat-run/contracts/scope-store-envelope';
import { WIRE_AUDIENCE_VAR, WIRE_PLATFORM_KEYS_VAR, WIRE_ROUTER_KEYS_VAR, WIRE_STATE_VAR } from '@substrat-run/contracts/wire-signing';
import { ulid } from '@substrat-run/kernel';
import {
  createWfpUploader,
  deploymentRefFor,
  DEV_ACTOR_HEADER,
  stableDeploymentRefFor,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';
import { PLATFORM_ENTRY_MODULE } from '../src/platform-entry.js';
import type { ScriptBinding, WireSettingsApi } from '../src/wire-settings.js';
import type { WireUploadSettings } from '../src/wire-upload.js';
import type { WireWalkPass } from '../src/wire-walk.js';
import { heldManifest } from './held-manifest.js';

const WIRE = /^SUBSTRAT_WIRE_/;
const SECRET_VALUE = 'injected-secret-value-never-echoed';

describe('the fleet walk', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const person = platformActorId.parse(ulid());
  /** Every script the runtime holds, by name: what its last upload sent, then what the walk wrote. */
  let scripts: Map<string, ScriptBinding[]>;
  let calls: { kind: 'read' | 'write'; script: string }[];
  let moduleFetches: string[];
  let routerKeys: string;
  let platformKeys: string;
  let kids: { router: string[]; platform: string[] };
  /** Hooks a test sets to make one script misbehave. */
  let readHook: ((script: string, state: ScriptBinding[]) => ScriptBinding[]) | null;
  let writeHook: ((script: string, next: ScriptBinding[]) => ScriptBinding[] | Promise<ScriptBinding[]>) | null;
  let readFails: Set<string>;
  /** Scripts whose modules, read back, lack the platform's entry: uploaded before it existed. */
  let unwrapped: Set<string>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-wire-walk-'));
    host = new SqliteScopeHost({ dir });
    scripts = new Map();
    calls = [];
    moduleFetches = [];
    readHook = null;
    writeHook = null;
    readFails = new Set();
    unwrapped = new Set();
    const [r1, r2, p1, p2] = await Promise.all([1, 2, 3, 4].map(() => generateScopeStoreKeyPair()));
    routerKeys = `${r1!.publicKey},${r2!.publicKey}`;
    platformKeys = `${p1!.publicKey},${p2!.publicKey}`;
    kids = {
      router: [await scopeStoreKeyId(r1!.publicKey), await scopeStoreKeyId(r2!.publicKey)],
      platform: [await scopeStoreKeyId(p1!.publicKey), await scopeStoreKeyId(p2!.publicKey)],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
        if (init?.method === 'PUT' && init.body instanceof FormData) {
          const meta = JSON.parse(await (init.body.get('metadata') as File).text());
          const script = decodeURIComponent(url.split('/scripts/')[1]!.split('/')[0]!);
          // An upload replaces the script's bindings; the platform's secret rides beside them.
          scripts.set(script, [...(meta.bindings ?? []), { type: 'secret_text', name: 'PLATFORM_HELD', text: SECRET_VALUE }]);
        }
        return new Response('{}', { status: 200 });
      }),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The script-settings endpoint over `scripts`: a write replaces the set, keeping the types it names. */
  const settingsApi: WireSettingsApi = {
    async read(script) {
      calls.push({ kind: 'read', script });
      if (readFails.has(script)) throw new Error(`the settings of '${script}' could not be read (500)`);
      let state = scripts.get(script);
      if (!state) throw new Error(`the settings of '${script}' could not be read (404)`);
      if (readHook) scripts.set(script, (state = readHook(script, state)));
      return state.map((b) => ({ ...b }));
    },
    async write(script, body) {
      calls.push({ kind: 'write', script });
      const kept = (scripts.get(script) ?? []).filter((b) => body.keep_bindings.includes(b.type));
      const next = [...body.bindings.map((b) => ({ ...b })), ...kept];
      scripts.set(script, writeHook ? await writeHook(script, next) : next);
    },
  };

  const appWith = (wireUpload: WireUploadSettings | null) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      humanStaffActor: async (r) => (r.headers.get(DEV_ACTOR_HEADER) === person ? person : null),
      deployVertical: createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' }),
      // A script's modules as the runtime holds them: the platform's entry beside the vertical's own,
      // unless the script was uploaded before the entry existed.
      fetchVerticalModules: async (ref) => {
        moduleFetches.push(ref);
        const kind = 'application/javascript+module';
        const own = { name: 'worker.js', content: new TextEncoder().encode('export default {}'), contentType: kind };
        return unwrapped.has(ref) ? [own] : [{ name: PLATFORM_ENTRY_MODULE, content: new TextEncoder().encode('export default {}'), contentType: kind }, own];
      },
      wireSettings: settingsApi,
      ...(wireUpload ? { wireUpload } : {}),
    });
  const fleet = (): WireUploadSettings => ({ rollout: 'fleet', routerKeys, platformKeys });
  const off = (): WireUploadSettings => ({ rollout: 'off', routerKeys, platformKeys });

  const tenantOf = async (slug: string) => {
    await host.admin.createTenant(person, { id: tenantId.parse(ulid()), slug, name: slug });
    return slug;
  };
  const push = async (app: ReturnType<typeof createControlPlaneApi>, tenant: string) => {
    const fd = new FormData();
    const manifest = await heldManifest({
      version: `0.1.${ulid().toLowerCase()}`,
      entry: 'worker.js',
      compatibilityDate: '2025-01-01',
      doClasses: ['ScopeDO'],
      bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
      digests: { manifest: 'm1', permission: 'p1', migration: 'g1' },
      registry: { permissions: [], roles: [], entityGrants: [] },
    });
    fd.set('manifest', JSON.stringify(manifest));
    fd.set('tenant', tenant);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    const res = await app.request('/verticals/crm/deploy', { method: 'POST', headers: { [DEV_ACTOR_HEADER]: person }, body: fd });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string; verticalSlug: string };
  };
  const promote = async (app: ReturnType<typeof createControlPlaneApi>, verticalSlug: string, versionId: string) => {
    const res = await app.request(`/verticals/${encodeURIComponent(verticalSlug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { [DEV_ACTOR_HEADER]: person, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  /**
   * A vertical with a served version and a second version pushed but not served (the script a
   * preview of it is routed to): its three scripts, serving first, then the versions' by id.
   */
  const vertical = async (app: ReturnType<typeof createControlPlaneApi>, tenant: string) => {
    const served = await push(app, tenant);
    await promote(app, served.verticalSlug, served.id);
    const preview = await push(app, tenant);
    const slug = served.verticalSlug;
    return {
      slug,
      served: served.id,
      scripts: [stableDeploymentRefFor(slug), deploymentRefFor(slug, served.id), deploymentRefFor(slug, preview.id)],
    };
  };
  const walk = async (app: ReturnType<typeof createControlPlaneApi>, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request('/wire-auth/walk', {
      method: 'POST',
      headers: { [DEV_ACTOR_HEADER]: person, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const pass = async (app: ReturnType<typeof createControlPlaneApi>, body: Record<string, unknown>) => {
    const res = await walk(app, body);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as WireWalkPass;
  };
  /** Every pass from the start of the fleet to its end, `limit` scripts at a time. */
  const walkAll = async (app: ReturnType<typeof createControlPlaneApi>, body: Record<string, unknown>) => {
    const passes: WireWalkPass[] = [];
    let cursor: string | null = null;
    do {
      const p = await pass(app, { ...body, ...(cursor ? { cursor } : {}) });
      passes.push(p);
      cursor = p.next;
    } while (cursor !== null && passes.length < 50);
    return passes.flatMap((p) => p.scripts);
  };
  const wireOf = (script: string) =>
    Object.fromEntries((scripts.get(script) ?? []).filter((b) => WIRE.test(b.name)).map((b) => [b.name, b['text']]));
  const recordsOf = async (verticalSlug: string) =>
    Object.fromEntries(
      (await host.admin.listWireAuth!(person, { reach: { fleet: true }, limit: LIST_PAGE_MAX, verticalSlug })).map((r) => [r.deploymentRef, r] as [string, DeploymentWireAuth]),
    );
  const failuresOf = async (vertical: string) => {
    await new Promise((r) => setTimeout(r, 20));
    return (await host.admin.listOpsFailures(person, { vertical })).filter((f) => f.operation === 'wire-walk');
  };
  const walkRows = async () => host.admin.auditLog(person, { action: 'walkWireAuth' });

  it('in an environment the rollout never reached, a pass makes no call to the runtime, dry or applied', async () => {
    const plain = appWith(null);
    const a = await vertical(plain, await tenantOf('walk-never-a'));
    const b = await vertical(plain, await tenantOf('walk-never-b'));
    const before = new Map([...scripts].map(([k, v]) => [k, JSON.stringify(v)]));
    // The promotes read their versions' modules back; the walk is what is counted from here.
    moduleFetches.length = 0;
    for (const settings of [null, off(), { routerKeys, platformKeys }]) {
      for (const apply of [false, true]) {
        const walked = await walkAll(appWith(settings), { apply, limit: 2 });
        expect(walked.map((s) => s.deploymentRef).sort()).toEqual([...a.scripts, ...b.scripts].sort());
        expect(new Set(walked.map((s) => s.action)), JSON.stringify(settings)).toEqual(new Set(['current']));
      }
    }
    expect(calls).toEqual([]);
    expect(moduleFetches).toEqual([]);
    expect(new Map([...scripts].map(([k, v]) => [k, JSON.stringify(v)]))).toEqual(before);
    // Each pass is audited, dry or applied.
    expect((await walkRows()).length).toBeGreaterThanOrEqual(6);
  });

  it('walks every serving and version script, the one a preview is routed to included, in order, a pass at a time', async () => {
    const app = appWith(off());
    const a = await vertical(app, await tenantOf('walk-order-a'));
    const b = await vertical(app, await tenantOf('walk-order-b'));
    const passes: WireWalkPass[] = [];
    let cursor: string | null = null;
    do {
      const p = await pass(app, { limit: 1, ...(cursor ? { cursor } : {}) });
      passes.push(p);
      expect(p.from).toBe(cursor);
      cursor = p.next;
    } while (cursor !== null);
    const walked = passes.flatMap((p) => p.scripts.map((s) => [s.deploymentRef, s.kind]));
    // Verticals by slug; each one's serving script, then its versions' scripts by id. Every script once.
    const [first, second] = [a, b].sort((x, y) => x.slug.localeCompare(y.slug));
    const expected = [first!, second!].flatMap((v) => [
      [v.scripts[0], 'serving'],
      [v.scripts[1], 'version'],
      [v.scripts[2], 'version'],
    ]);
    expect(walked).toEqual(expected);
    // One script a pass, and the pass that walks the fleet's last script already answers `null`.
    expect(passes.map((p) => p.scripts.length)).toEqual(expected.map(() => 1));
    expect(passes.at(-1)!.next).toBeNull();
    // A pass whose limit is the fleet's size is the whole walk.
    const whole = await pass(app, { limit: expected.length });
    expect([whole.scripts.length, whole.next]).toEqual([expected.length, null]);
  });

  it('a dry run reports what would change and only reads; applied, it brings each script current and records it', async () => {
    const tenant = await tenantOf('walk-fleet');
    const v = await vertical(appWith(off()), tenant);
    for (const s of v.scripts) expect(wireOf(s), s).toEqual({});

    const dry = await walkAll(appWith(fleet()), { limit: 10 });
    expect(dry.map((s) => [s.deploymentRef, s.action])).toEqual(v.scripts.map((s) => [s, 'would-change']));
    expect(dry[0]!.changes).toEqual([WIRE_ROUTER_KEYS_VAR, WIRE_PLATFORM_KEYS_VAR, WIRE_AUDIENCE_VAR, WIRE_STATE_VAR]);
    expect(calls.every((c) => c.kind === 'read')).toBe(true);
    for (const s of v.scripts) expect(wireOf(s), s).toEqual({});
    expect(Object.values(await recordsOf(v.slug)).map((r) => r.record.state)).toEqual(['legacy-only', 'legacy-only', 'legacy-only']);

    calls.length = 0;
    const applied = await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    expect(applied.map((s) => [s.deploymentRef, s.action])).toEqual(v.scripts.map((s) => [s, 'updated']));
    const records = await recordsOf(v.slug);
    for (const s of v.scripts) {
      expect(wireOf(s), s).toEqual({ [WIRE_ROUTER_KEYS_VAR]: routerKeys, [WIRE_PLATFORM_KEYS_VAR]: platformKeys, [WIRE_AUDIENCE_VAR]: s, [WIRE_STATE_VAR]: 'dual' });
      expect(records[s]?.record, s).toEqual({ envelope: 1, entrySkipped: null, state: 'dual', audience: s, routerKids: kids.router, platformKids: kids.platform, withheld: null });
      // Every other binding as the upload sent it, the secret kept.
      expect((scripts.get(s) ?? []).filter((b) => !WIRE.test(b.name)).map((b) => b.name).sort(), s).toEqual(
        expect.arrayContaining(['PLATFORM_HELD', 'SCOPE', 'SUBSTRAT_VERSION_ID']),
      );
    }
    // Each script's record wrote its own admin row; the pass wrote its own.
    const recordRows = (await host.admin.auditLog(person, { action: 'recordWireAuth' })).filter((r) => r.vertical === v.slug && r.actor === person);
    expect(recordRows.length).toBeGreaterThanOrEqual(3);
    const [latest] = (await walkRows()).slice(-1);
    expect(latest?.after).toMatchObject({ apply: true, walked: 3, updated: v.scripts, held: [], released: [], failed: [] });

    // Current now: the next pass reads nothing at all.
    calls.length = 0;
    expect((await walkAll(appWith(fleet()), { apply: true, limit: 10 })).map((s) => s.action)).toEqual(['current', 'current', 'current']);
    expect(calls).toEqual([]);

    // A key withdrawn (the rollout set back to off) reaches every script, the version scripts included.
    const back = await walkAll(appWith(off()), { apply: true, limit: 10 });
    expect(back.map((s) => s.action)).toEqual(['updated', 'updated', 'updated']);
    for (const s of v.scripts) expect(wireOf(s), s).toEqual({});
    expect(Object.values(await recordsOf(v.slug)).map((r) => r.record.withheld)).toEqual(['unconfigured', 'unconfigured', 'unconfigured']);

    // No output carries the secret's value: not a pass, not a record, not the admin log.
    expect(JSON.stringify([dry, applied, back, await walkRows(), records])).not.toContain(SECRET_VALUE);
  });

  it('one script’s failure is that script’s: recorded, and the pass goes on to the rest', async () => {
    const tenant = await tenantOf('walk-fail');
    const v = await vertical(appWith(off()), tenant);
    readFails.add(v.scripts[1]!);
    const walked = await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    expect(walked.map((s) => [s.deploymentRef, s.action, s.reason])).toEqual([
      [v.scripts[0], 'updated', undefined],
      [v.scripts[1], 'failed', 'settings'],
      [v.scripts[2], 'updated', undefined],
    ]);
    const failures = await failuresOf(v.slug);
    expect(failures.map((f) => f.stage)).toEqual(['settings']);
    expect(failures[0]!.message).toContain(v.scripts[1]!);
    // Not held: a read that failed changed nothing, and the next pass tries it again.
    readFails.clear();
    expect((await walkAll(appWith(fleet()), { apply: true, limit: 10 })).map((s) => s.action)).toEqual(['current', 'updated', 'current']);
  });

  it('a read after the update that differs holds the script, by binding name, until a person releases it', async () => {
    const tenant = await tenantOf('walk-verify');
    const v = await vertical(appWith(off()), tenant);
    const odd = v.scripts[2]!;
    // The runtime drops the script's own binding on the write.
    writeHook = (script, next) => (script === odd ? next.filter((b) => b.name !== 'SCOPE') : next);
    const walked = await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    expect(walked.find((s) => s.deploymentRef === odd)).toMatchObject({ action: 'failed', reason: 'verify', bindings: ['SCOPE'], held: true });
    expect((await recordsOf(v.slug))[odd]?.record.walkHold).toMatchObject({ reason: 'verify', bindings: ['SCOPE'] });
    const [failure] = await failuresOf(v.slug);
    expect(failure).toMatchObject({ stage: 'verify' });
    expect(failure!.message).toContain(odd);
    expect(failure!.message).toContain('SCOPE');
    expect(failure!.message).not.toContain(SECRET_VALUE);
    expect(failure!.message).not.toContain(routerKeys);

    // Held: later passes leave it alone, without a single call for it, even when the settings change.
    writeHook = null;
    calls.length = 0;
    const later = await walkAll(appWith(off()), { apply: true, limit: 10 });
    expect(later.find((s) => s.deploymentRef === odd)?.action).toBe('held');
    expect(calls.filter((c) => c.script === odd)).toEqual([]);

    // A person names it: released for that pass, brought current, and its fresh record holds no more.
    scripts.set(odd, [...(scripts.get(odd) ?? []), { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }]);
    const released = await walkAll(appWith(off()), { apply: true, limit: 10, release: [odd] });
    expect(released.find((s) => s.deploymentRef === odd)).toMatchObject({ action: 'updated', released: true });
    expect((await recordsOf(v.slug))[odd]?.record.walkHold).toBeUndefined();
    const [latest] = (await walkRows()).slice(-1);
    expect(latest?.after).toMatchObject({ released: [odd] });
  });

  it('a serving script that does not run the served version is not written, and says to promote again', async () => {
    const tenant = await tenantOf('walk-serving');
    const v = await vertical(appWith(off()), tenant);
    const serving = v.scripts[0]!;
    // A promote under way: the script already runs another version than the directory serves.
    scripts.set(serving, (scripts.get(serving) ?? []).map((b) => (b.name === 'SUBSTRAT_VERSION_ID' ? { ...b, text: ulid() } : b)));
    const walked = await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    expect(walked[0]).toMatchObject({ deploymentRef: serving, action: 'failed', reason: 'serve-in-flight' });
    expect(walked[0]!.held).toBeUndefined();
    expect(calls.filter((c) => c.script === serving && c.kind === 'write')).toEqual([]);
    expect(wireOf(serving)).toEqual({});
    expect((await failuresOf(v.slug))[0]!.message).toMatch(/promote again/);
  });

  it('a script with no record is read back to learn whether it carries the platform’s entry, then given its lists', async () => {
    const tenant = await tenantOf('walk-unrecorded');
    // The push's record is not written (as before records existed): the script has none.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(host.admin, 'recordWireAuth').mockRejectedValue(new Error('directory unavailable'));
    const { id, verticalSlug } = await push(appWith(off()), tenant);
    spy.mockRestore();
    const script = deploymentRefFor(verticalSlug, id);
    expect(await recordsOf(verticalSlug)).toEqual({});
    // Under `off` it is not read at all: nothing to give it.
    expect((await walkAll(appWith(off()), { apply: true, limit: 10 })).map((s) => s.action)).toEqual(['unrecorded']);
    expect(calls).toEqual([]);
    expect(moduleFetches).toEqual([]);
    // Under the fleet: its bundle read back, its entry found, its lists given, its record written.
    expect((await walkAll(appWith(fleet()), { apply: true, limit: 10 })).map((s) => s.action)).toEqual(['updated']);
    expect(moduleFetches).toEqual([script]);
    expect((await recordsOf(verticalSlug))[script]?.record).toMatchObject({ envelope: 1, entrySkipped: null, state: 'dual', audience: script });
  });

  it('a script with no record that runs without the platform’s entry is skipped by name: no lists, no record saying it verifies', async () => {
    const tenant = await tenantOf('walk-noentry');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(host.admin, 'recordWireAuth').mockRejectedValue(new Error('directory unavailable'));
    const { id, verticalSlug } = await push(appWith(off()), tenant);
    spy.mockRestore();
    const script = deploymentRefFor(verticalSlug, id);
    // Uploaded before the platform's entry existed: its modules, read back, hold none.
    unwrapped.add(script);
    calls.length = 0;
    const walked = await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    expect(walked).toEqual([expect.objectContaining({ deploymentRef: script, action: 'skipped', reason: 'no-entry' })]);
    expect(calls).toEqual([]);
    expect(wireOf(script)).toEqual({});
    expect(await recordsOf(verticalSlug)).toEqual({});
    const [latest] = (await walkRows()).slice(-1);
    expect(latest?.after).toMatchObject({ walked: 1, updated: [], skipped: [{ deploymentRef: script, reason: 'no-entry' }] });
  });

  it('passes over a vertical that is gone, a saved cursor naming one included, and audits a pass that stops with what it did', async () => {
    const app = appWith(off());
    const a = await vertical(app, await tenantOf('walk-gone-a'));
    const b = await vertical(app, await tenantOf('walk-gone-b'));
    // A dry pass stops after a's scripts; a is then deleted, and its cursor saved.
    const first = await pass(appWith(fleet()), { limit: 3 });
    expect(first.scripts.map((s) => s.deploymentRef)).toEqual(a.scripts);
    expect(first.next).not.toBeNull();
    await host.admin.deleteVertical(person, a.slug);
    const resumed = await pass(appWith(fleet()), { limit: 10, cursor: first.next });
    expect(resumed.scripts.map((s) => s.deploymentRef)).toEqual(b.scripts);
    expect(resumed.next).toBeNull();

    // A pass that stops on a directory read it cannot make is audited with the scripts it did walk.
    const c = await vertical(app, await tenantOf('walk-gone-c'));
    const list = host.admin.listWireAuth!.bind(host.admin);
    vi.spyOn(host.admin, 'listWireAuth').mockImplementation(async (actor, filter) => {
      if (filter?.verticalSlug === c.slug) throw new Error('directory unavailable');
      return list(actor, filter);
    });
    const res = await walk(appWith(fleet()), { apply: true, limit: 10 });
    expect(res.status).toBe(500);
    vi.restoreAllMocks();
    const [stopped] = (await walkRows()).slice(-1);
    expect(stopped?.after).toMatchObject({ apply: true, walked: 3, updated: b.scripts, next: null, error: expect.stringMatching(/stopped/) });
    expect(JSON.stringify(stopped?.after)).not.toContain('directory unavailable');
  });

  it('a script the walk wrote and could not confirm is always held, on the record as it stands; one with no record claims no lists', async () => {
    const tenant = await tenantOf('walk-truth');
    const v = await vertical(appWith(off()), tenant);
    const serving = v.scripts[0]!;
    const preview = v.scripts[2]!.split('-').at(-1)!.toUpperCase();
    // A promote lands before the walk's write of the serving script lands (its upload records, and the
    // serve moves to another version): the walk's write may have replaced what the promote wrote, so
    // the script is held, on the promote's record, under the promote's version.
    const fresh = { envelope: 1 as const, entrySkipped: null, state: 'legacy-only' as const, audience: null, routerKids: [], platformKids: [], withheld: 'not-in-rollout' as const };
    writeHook = async (script, next) => {
      if (script !== serving) return next;
      writeHook = null;
      const now = await host.admin.verticalServing(person, v.slug);
      await host.admin.recordWireAuth!(person, { deploymentRef: serving, verticalSlug: v.slug, versionId: preview, record: fresh, recordedAt: new Date(Date.now() + 1000).toISOString() });
      await host.admin.setVerticalServing(person, v.slug, { ref: serving, versionId: preview, doClasses: now!.doClasses, migrationTag: now!.migrationTag });
      return next;
    };
    const walked = await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    expect(walked[0]).toMatchObject({ deploymentRef: serving, action: 'failed', reason: 'serve-in-flight', held: true });
    expect((await recordsOf(v.slug))[serving]).toMatchObject({
      versionId: preview,
      record: { ...fresh, walkHold: { reason: 'serve-in-flight', bindings: [], at: expect.any(String) } },
    });
    // Held: the next ordinary pass leaves it alone rather than calling it current.
    calls.length = 0;
    expect((await walkAll(appWith(fleet()), { apply: true, limit: 10 }))[0]).toMatchObject({ deploymentRef: serving, action: 'held' });
    expect(calls.filter((c) => c.script === serving)).toEqual([]);

    // A script with no record whose update reads back differently: held, claiming no lists.
    const other = await tenantOf('walk-truth-unrecorded');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(host.admin, 'recordWireAuth').mockRejectedValue(new Error('directory unavailable'));
    const { id, verticalSlug } = await push(appWith(off()), other);
    spy.mockRestore();
    const script = deploymentRefFor(verticalSlug, id);
    writeHook = (s, next) => (s === script ? next.filter((b) => b.name !== 'SCOPE') : next);
    const second = await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    expect(second.find((s) => s.deploymentRef === script)).toMatchObject({ action: 'failed', reason: 'verify', held: true });
    expect((await recordsOf(verticalSlug))[script]?.record).toEqual({
      envelope: 1,
      entrySkipped: null,
      state: 'legacy-only',
      audience: null,
      routerKids: [],
      platformKids: [],
      withheld: 'unverified',
      walkHold: { reason: 'verify', bindings: ['SCOPE'], at: expect.any(String) },
    });
  });

  it('holds a script whose record is newer than the pass when its write cannot be confirmed', async () => {
    const tenant = await tenantOf('walk-newer');
    const v = await vertical(appWith(off()), tenant);
    const odd = v.scripts[2]!;
    // An upload recorded the script after the pass began (its record dated later than any the pass writes).
    const records = await recordsOf(v.slug);
    await host.admin.recordWireAuth!(person, {
      deploymentRef: odd,
      verticalSlug: v.slug,
      versionId: records[odd]!.versionId,
      record: records[odd]!.record,
      recordedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    writeHook = (script, next) => (script === odd ? next.filter((b) => b.name !== 'SCOPE') : next);
    const walked = await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    expect(walked.find((s) => s.deploymentRef === odd)).toMatchObject({ action: 'failed', reason: 'verify', held: true });
    expect((await recordsOf(v.slug))[odd]?.record.walkHold).toMatchObject({ reason: 'verify', bindings: ['SCOPE'] });
    writeHook = null;
    expect((await walkAll(appWith(fleet()), { apply: true, limit: 10 })).find((s) => s.deploymentRef === odd)?.action).toBe('held');
  });

  it('marks a release only when the released script came out current', async () => {
    const tenant = await tenantOf('walk-release');
    const v = await vertical(appWith(off()), tenant);
    const odd = v.scripts[2]!;
    writeHook = (script, next) => (script === odd ? next.filter((b) => b.name !== 'SCOPE') : next);
    await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    // Released, under settings that change it again, and its write still cannot be confirmed: held
    // again, and not marked released.
    const scope = { type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' };
    scripts.set(odd, [...(scripts.get(odd) ?? []), scope]);
    const again = await walkAll(appWith(off()), { apply: true, limit: 10, release: [odd] });
    const hit = again.find((s) => s.deploymentRef === odd)!;
    expect(hit).toMatchObject({ action: 'failed', reason: 'verify', held: true });
    expect(hit.released).toBeUndefined();
    expect((await walkRows()).slice(-1)[0]?.after).toMatchObject({ released: [] });
    // Its positive twin: the write confirmed, released.
    writeHook = null;
    scripts.set(odd, [...(scripts.get(odd) ?? []), scope]);
    expect((await walkAll(appWith(fleet()), { apply: true, limit: 10, release: [odd] })).find((s) => s.deploymentRef === odd)).toMatchObject({
      action: 'updated',
      released: true,
    });
  });

  it('a pass that is done answers it, even when the look past its last script fails', async () => {
    const app = appWith(off());
    const a = await vertical(app, await tenantOf('walk-peek-a'));
    const b = await vertical(app, await tenantOf('walk-peek-b'));
    const serving = host.admin.verticalServing.bind(host.admin);
    vi.spyOn(host.admin, 'verticalServing').mockImplementation(async (actor, slug) => {
      if (slug === b.slug) throw new Error('directory unavailable');
      return serving(actor, slug);
    });
    // The pass walks a's three scripts, then looks one ahead into b, which fails: the pass still answers.
    const done = await pass(appWith(fleet()), { limit: 3 });
    expect(done.scripts.map((s) => s.deploymentRef)).toEqual(a.scripts);
    expect(done.next).not.toBeNull();
    vi.restoreAllMocks();
    // And the next pass, from there, walks b.
    expect((await pass(appWith(fleet()), { limit: 10, cursor: done.next })).scripts.map((s) => s.deploymentRef)).toEqual(b.scripts);
  });

  it('a confirming pass reads every script, whatever its record says, and finds one changed behind it', async () => {
    const tenant = await tenantOf('walk-confirm');
    const v = await vertical(appWith(off()), tenant);
    await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    // Something rewrote one script's bindings behind the walk: its record still says it carries the lists.
    const behind = v.scripts[1]!;
    scripts.set(behind, (scripts.get(behind) ?? []).filter((b) => !WIRE.test(b.name)));
    calls.length = 0;
    expect((await walkAll(appWith(fleet()), { apply: true, limit: 10 })).map((s) => s.action)).toEqual(['current', 'current', 'current']);
    expect(calls).toEqual([]);
    // Confirming, dry: every script read, the one behind found.
    const dry = await walkAll(appWith(fleet()), { confirm: true, limit: 10 });
    expect(dry.map((s) => [s.deploymentRef, s.action])).toEqual([
      [v.scripts[0], 'unchanged'],
      [behind, 'would-change'],
      [v.scripts[2], 'unchanged'],
    ]);
    expect(new Set(calls.map((c) => c.script))).toEqual(new Set(v.scripts));
    expect(calls.every((c) => c.kind === 'read')).toBe(true);
    // Confirming, applied: brought back.
    expect((await walkAll(appWith(fleet()), { confirm: true, apply: true, limit: 10 })).map((s) => s.action)).toEqual(['unchanged', 'updated', 'unchanged']);
    expect(wireOf(behind)[WIRE_STATE_VAR]).toBe('dual');
    const [latest] = (await walkRows()).slice(-1);
    expect(latest?.after).toMatchObject({ confirm: true, apply: true, updated: [behind] });
  });

  it('a dry run files no failure and releases nothing; it only reports', async () => {
    const tenant = await tenantOf('walk-dry');
    const v = await vertical(appWith(off()), tenant);
    const odd = v.scripts[2]!;
    writeHook = (script, next) => (script === odd ? next.filter((b) => b.name !== 'SCOPE') : next);
    await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    writeHook = null;
    const filed = (await failuresOf(v.slug)).length;
    // Dry and confirming (so every script is read), naming the held script, with another failing to
    // read: reported, nothing filed or released.
    readFails.add(v.scripts[1]!);
    const dry = await walkAll(appWith(fleet()), { limit: 10, confirm: true, release: [odd] });
    expect(dry.find((s) => s.deploymentRef === odd)).toEqual(expect.objectContaining({ action: 'held' }));
    expect(dry.find((s) => s.deploymentRef === odd)!.released).toBeUndefined();
    expect(dry.find((s) => s.deploymentRef === v.scripts[1])).toMatchObject({ action: 'failed', reason: 'settings' });
    expect((await failuresOf(v.slug)).length).toBe(filed);
    const [latest] = (await walkRows()).slice(-1);
    expect(latest?.after).toMatchObject({ apply: false, released: [] });
    expect((await recordsOf(v.slug))[odd]?.record.walkHold).toBeDefined();
  });

  it('never touches a script the registry does not name', async () => {
    const tenant = await tenantOf('walk-stray');
    await vertical(appWith(off()), tenant);
    scripts.set('stray-script', [{ type: 'plain_text', name: 'X', text: 'y' }]);
    await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    expect(calls.filter((c) => c.script === 'stray-script')).toEqual([]);
    expect(scripts.get('stray-script')).toEqual([{ type: 'plain_text', name: 'X', text: 'y' }]);
  });

  it('is a person’s act, takes JSON, and refuses a body or a cursor it did not give', async () => {
    const app = appWith(fleet());
    await vertical(app, await tenantOf('walk-refuse'));
    // A service token, not a person.
    const token = platformActorId.parse(ulid());
    expect((await walk(app, {}, { [DEV_ACTOR_HEADER]: token })).status).toBe(403);
    expect((await app.request('/wire-auth/walk', { method: 'POST', headers: { [DEV_ACTOR_HEADER]: person, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await walk(app, {}, { origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await walk(app, { cursor: 'not-a-cursor' })).status).toBe(422);
    expect((await walk(app, { cursor: 'Not A Slug|x' })).status).toBe(422);
    expect((await walk(app, { cursor: '|x' })).status).toBe(422);
    for (const body of [{ apply: 'yes' }, { limit: 0 }, { limit: 51 }, { extra: 1 }, { release: Array.from({ length: 51 }, (_, i) => `s${i}`) }]) {
      expect((await walk(app, body)).status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
    }
    // None of those reached the runtime, and none wrote a pass.
    expect(calls).toEqual([]);
    expect(await walkRows()).toEqual([]);
  });

  it('refuses a pass, dry or applied, before it walks anything, while the rollout or the lists are refused', async () => {
    const tenant = await tenantOf('walk-refused');
    const v = await vertical(appWith(fleet()), tenant);
    const before = new Map([...scripts].map(([k, b]) => [k, JSON.stringify(b)]));
    const records = await recordsOf(v.slug);
    calls.length = 0;
    moduleFetches.length = 0;
    for (const [settings, withheld] of [
      [{ rollout: 'canary:a/crm,b/crm', routerKeys, platformKeys }, 'rollout-refused'],
      [{ rollout: 'fleet', routerKeys: `${routerKeys},not-a-key`, platformKeys }, 'lists-refused'],
      [{ rollout: 'fleet', routerKeys }, 'lists-refused'],
    ] as const) {
      for (const apply of [false, true]) {
        const res = await walk(appWith(settings), { apply, limit: 10 });
        expect(res.status, `${withheld} ${apply}`).toBe(409);
        expect(await res.text()).toContain(withheld);
        const [row] = (await walkRows()).slice(-1);
        expect(row?.after).toMatchObject({ apply, walked: 0, updated: [], refused: expect.stringContaining(withheld) });
        expect(JSON.stringify(row?.after)).not.toContain(routerKeys.split(',')[0]!);
      }
    }
    // Nothing read, nothing written, nothing recorded.
    expect(calls).toEqual([]);
    expect(moduleFetches).toEqual([]);
    expect(new Map([...scripts].map(([k, b]) => [k, JSON.stringify(b)]))).toEqual(before);
    expect(await recordsOf(v.slug)).toEqual(records);
    // Its positive twin: `off` is a withdrawal, not a refusal.
    expect((await walk(appWith(off()), { limit: 10 })).status).toBe(200);
  });

  it('a valid canary is not refused: the canary’s vertical is walked current, one outside it is withdrawn', async () => {
    const inside = await vertical(appWith(fleet()), await tenantOf('walk-canary-in'));
    const outside = await vertical(appWith(fleet()), await tenantOf('walk-canary-out'));
    const canary = { rollout: `canary:${inside.slug}`, routerKeys, platformKeys };
    const res = await walk(appWith(canary), { apply: true, limit: 10 });
    expect(res.status, await res.clone().text()).toBe(200);
    const walked = ((await res.json()) as WireWalkPass).scripts;
    expect(walked.filter((s) => inside.scripts.includes(s.deploymentRef)).map((s) => s.action)).toEqual(['current', 'current', 'current']);
    expect(walked.filter((s) => outside.scripts.includes(s.deploymentRef)).map((s) => s.action)).toEqual(['updated', 'updated', 'updated']);
    expect(walked.some((s) => s.reason === 'settings-refused')).toBe(false);
    for (const s of inside.scripts) expect(wireOf(s)[WIRE_STATE_VAR], s).toBe('dual');
    for (const s of outside.scripts) expect(wireOf(s), s).toEqual({});
    expect(Object.values(await recordsOf(outside.slug)).map((r) => r.record.withheld)).toEqual(['not-in-rollout', 'not-in-rollout', 'not-in-rollout']);
  });

  it('a pass can end on a version whose id is not a ULID, and the next pass resumes from it', async () => {
    const app = appWith(off());
    const v = await vertical(app, await tenantOf('walk-ids'));
    // A version published by the publish route, under an id of its own spelling, with its own script.
    const ref = `${v.slug.replace('/', '-')}-custom`;
    scripts.set(ref, [{ type: 'plain_text', name: 'SUBSTRAT_VERSION_ID', text: 'zz-custom-id' }]);
    await host.admin.publishVersion(person, {
      id: 'zz-custom-id', verticalSlug: v.slug, version: '9.9.9', manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: ref,
    });
    // A second vertical sorts after it, so a pass that ends on the custom version answers a `next` naming it.
    const after = await vertical(app, await tenantOf('walk-idt'));
    const onIt = await pass(app, { limit: 4 });
    expect(onIt.scripts.at(-1)?.deploymentRef).toBe(ref);
    expect(onIt.next).toBe(`${v.slug}|zz-custom-id`);
    // And the next pass takes that cursor, and walks on from it.
    const rest = await pass(app, { limit: 10, cursor: onIt.next });
    expect(rest.scripts.map((s) => s.deploymentRef)).toEqual(after.scripts);
    expect(rest.next).toBeNull();
  });

  it('a hold keeps 64 binding names and counts the rest; a hold that cannot be written is retried, then said', async () => {
    const tenant = await tenantOf('walk-many');
    const v = await vertical(appWith(off()), tenant);
    const odd = v.scripts[2]!;
    const extra = Array.from({ length: 70 }, (_, i) => ({ type: 'plain_text', name: `EXTRA_${String(i).padStart(2, '0')}`, text: 'x' }));
    scripts.set(odd, [...(scripts.get(odd) ?? []), ...extra]);
    writeHook = (script, next) => (script === odd ? next.filter((b) => !b.name.startsWith('EXTRA_')) : next);
    const walked = await walkAll(appWith(fleet()), { apply: true, limit: 10 });
    const hit = walked.find((s) => s.deploymentRef === odd)!;
    expect(hit).toMatchObject({ action: 'failed', reason: 'verify', held: true });
    expect(hit.bindings).toHaveLength(64);
    expect(hit.more).toBe(6);
    const hold = (await recordsOf(v.slug))[odd]?.record.walkHold;
    expect(hold?.bindings).toHaveLength(64);
    expect(hold?.more).toBe(6);
    expect((await failuresOf(v.slug)).find((f) => f.message.includes(`'${odd}'`))?.message).toMatch(/and 6 more; held until a person looks/);

    // A hold write that fails is tried once more, and the failure says it could not be written.
    writeHook = null;
    const other = v.scripts[1]!;
    writeHook = (script, next) => (script === other ? next.filter((b) => b.name !== 'SCOPE') : next);
    const record = host.admin.recordWireAuth!.bind(host.admin);
    let refusedHolds = 0;
    vi.spyOn(host.admin, 'recordWireAuth').mockImplementation(async (actor, input) => {
      if (input.deploymentRef === other && input.record.walkHold) {
        refusedHolds += 1;
        throw new Error('directory unavailable');
      }
      return record(actor, input);
    });
    const second = await walkAll(appWith(off()), { apply: true, limit: 10 });
    vi.restoreAllMocks();
    expect(refusedHolds).toBe(2);
    const failedHold = second.find((s) => s.deploymentRef === other)!;
    expect(failedHold).toMatchObject({ action: 'failed', reason: 'verify' });
    expect(failedHold.held).toBeUndefined();
    expect((await failuresOf(v.slug)).find((f) => f.message.includes(`'${other}'`))?.message).toMatch(/the hold itself could not be written/);
  });

  it('answers 501 where no settings endpoint is configured', async () => {
    const app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      humanStaffActor: async () => person,
    });
    expect((await walk(app, {})).status).toBe(501);
  });
});
