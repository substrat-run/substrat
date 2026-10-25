/**
 * RFC wire-signing follow-on 4, the readiness report: `POST /wire-auth/readiness` and its gate
 * predicates (what blocks `signed-only`, a key drop and the withdrawal of the shared credential).
 * The confirmation it reads from the walk's rows is judged on its own first; then the route is driven
 * over a fleet pushed through the real uploader (Cloudflare stubbed at `fetch`) and walked through a
 * fake of the script-settings endpoint, as the walk's own suite does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { LIST_PAGE_MAX, platformActorId, tenantId, type DeploymentWireAuth } from '@substrat-run/contracts';
import { generateScopeStoreKeyPair, scopeStoreKeyId } from '@substrat-run/contracts/scope-store-envelope';
import { WIRE_UNSIGNED_ROUTES } from '@substrat-run/contracts/wire-signing';
import { ulid } from '@substrat-run/kernel';
import { createControlPlaneApi, createWfpUploader, deploymentRefFor, DEV_ACTOR_HEADER, stableDeploymentRefFor, UNSAFE_devPlatformActorAuth } from '../src/index.js';
import { PLATFORM_ENTRY_MODULE } from '../src/platform-entry.js';
import {
  WIRE_CONFIRM_ROWS_MAX,
  WIRE_READINESS_ADVISORY,
  WIRE_READINESS_REASONS as R,
  wireConfirmation,
  wireKeyDropSince,
  type WireBlocker,
  type WireReadinessReport,
} from '../src/wire-readiness.js';
import type { ScriptBinding, WireSettingsApi } from '../src/wire-settings.js';
import type { WireUploadSettings } from '../src/wire-upload.js';
import type { WireWalkPass } from '../src/wire-walk.js';
import { heldManifest } from './held-manifest.js';

const T0 = '2026-10-01T10:00:00.000Z';
const T1 = '2026-10-01T10:01:00.000Z';
const T2 = '2026-10-01T10:02:00.000Z';
/** A walk row as the route writes it. */
const pass = (over: Record<string, unknown>) => ({
  after: { apply: true, confirm: true, startedAt: T0, from: null, next: null, walked: 1, updated: [], held: [], released: [], skipped: [], failed: [], ...over },
});

describe('the last confirming walk, read from the walk’s rows (newest first); it fails closed', () => {
  it('a whole confirming walk, its passes chained from the start of the fleet to its end, confirms from when it began', () => {
    const rows = [pass({ from: 'b|', next: null, startedAt: T2 }), pass({ from: 'a|', next: 'b|', startedAt: T1 }), pass({ from: null, next: 'a|', startedAt: T0 })];
    expect(wireConfirmation(rows)).toEqual({ status: 'confirmed', startedAt: T0, passes: 3 });
    // Dry runs between its passes change nothing, and are passed over.
    const withDry = [rows[0]!, pass({ apply: false, confirm: false, from: 'x|', next: 'y|' }), rows[1]!, rows[2]!];
    expect(wireConfirmation(withDry)).toEqual({ status: 'confirmed', startedAt: T0, passes: 3 });
    // A single pass that walked the whole fleet.
    expect(wireConfirmation([pass({})])).toEqual({ status: 'confirmed', startedAt: T0, passes: 1 });
  });

  it('is unknown with no walk, or when the last applied walk was not a confirming one', () => {
    expect(wireConfirmation([])).toMatchObject({ status: 'unknown' });
    expect(wireConfirmation([pass({ apply: false })])).toMatchObject({ status: 'unknown' });
    expect(wireConfirmation([pass({ confirm: false }), pass({})])).toMatchObject({ status: 'unknown', reason: 'the last applied walk was not a confirming one' });
  });

  it('is unknown when an applied walk that was not confirming ran inside it', () => {
    const rows = [pass({ from: 'a|', next: null }), pass({ confirm: false, from: null, next: 'a|' }), pass({ from: null, next: 'a|' })];
    expect(wireConfirmation(rows)).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/not confirming ran inside/) });
  });

  it('is unknown with a gap between its passes, or when it did not reach the end of the fleet or back to its start', () => {
    expect(wireConfirmation([pass({ from: 'b|', next: null }), pass({ from: null, next: 'a|' })])).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/gap/) });
    expect(wireConfirmation([pass({ next: 'a|' })])).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/end of the fleet/) });
    expect(wireConfirmation([pass({ from: 'a|' })])).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/start of the fleet/) });
  });

  it('is unknown when a pass in it was refused or ended in an error', () => {
    expect(wireConfirmation([pass({ refused: 'rollout-refused: x' })])).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/refused or ended/) });
    expect(wireConfirmation([pass({ from: 'a|' }), pass({ next: 'a|', error: 'stopped' })])).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/refused or ended/) });
  });

  it('is unknown for a row it cannot read, and for a pass that does not record when it began', () => {
    expect(wireConfirmation([pass({}), { after: { apply: 'yes' } }])).toMatchObject({ status: 'unknown', reason: 'a fleet walk row could not be read' });
    expect(wireConfirmation([{ after: null }])).toMatchObject({ status: 'unknown' });
    expect(wireConfirmation([pass({ startedAt: undefined })])).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/when it began/) });
    expect(wireConfirmation([pass({ startedAt: 'yesterday' })])).toMatchObject({ status: 'unknown', reason: 'a fleet walk row could not be read' });
  });

  it('is unknown when the walk runs past the rows read, and confirmed when it ends inside them', () => {
    // A walk of more passes than the report reads: its start is beyond the read.
    const long = Array.from({ length: WIRE_CONFIRM_ROWS_MAX + 1 }, (_, i) =>
      pass({ from: `v${WIRE_CONFIRM_ROWS_MAX - i}|`, next: i === 0 ? null : `v${WIRE_CONFIRM_ROWS_MAX - i + 1}|` }),
    );
    expect(wireConfirmation(long)).toMatchObject({ status: 'unknown', reason: 'the last confirming walk runs past the rows read' });
    // More rows than the read, but the walk is whole inside it.
    const older = Array.from({ length: WIRE_CONFIRM_ROWS_MAX }, () => pass({ apply: false }));
    expect(wireConfirmation([pass({}), ...older])).toEqual({ status: 'confirmed', startedAt: T0, passes: 1 });
    // A read cut before any applied walk.
    expect(wireConfirmation(Array.from({ length: WIRE_CONFIRM_ROWS_MAX + 1 }, () => pass({ apply: false })))).toMatchObject({
      status: 'unknown',
      reason: 'no applied walk is among the rows read',
    });
  });
});

describe('a key drop’s since', () => {
  const now = new Date('2026-10-02T00:00:00.000Z');
  it('is refused missing, unreadable or in the future, each with a fixed sentence; an instant in the past is taken', () => {
    expect(wireKeyDropSince(undefined, now)).toEqual({ refused: 'a key drop names since: when the control plane’s list stopped naming the key' });
    expect(wireKeyDropSince('', now)).toMatchObject({ refused: expect.stringMatching(/names since/) });
    expect(wireKeyDropSince('last tuesday', now)).toEqual({ refused: 'since is an ISO 8601 instant' });
    expect(wireKeyDropSince(42, now)).toEqual({ refused: 'since is an ISO 8601 instant' });
    expect(wireKeyDropSince('2026-10-03T00:00:00.000Z', now)).toEqual({ refused: 'since is not in the future' });
    expect(wireKeyDropSince(T0, now)).toBe(T0);
  });
});

describe('the readiness report', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const person = platformActorId.parse(ulid());
  let scripts: Map<string, ScriptBinding[]>;
  let settingsCalls: number;
  let moduleFetches: number;
  let keys: { router: string[]; platform: string[] };
  let kids: { router: string[]; platform: string[] };
  const tenants: string[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-wire-readiness-'));
    host = new SqliteScopeHost({ dir });
    scripts = new Map();
    settingsCalls = 0;
    moduleFetches = 0;
    tenants.length = 0;
    const pairs = await Promise.all([1, 2, 3, 4, 5].map(() => generateScopeStoreKeyPair()));
    keys = { router: [pairs[0]!.publicKey, pairs[1]!.publicKey, pairs[4]!.publicKey], platform: [pairs[2]!.publicKey, pairs[3]!.publicKey] };
    kids = { router: await Promise.all(keys.router.map(scopeStoreKeyId)), platform: await Promise.all(keys.platform.map(scopeStoreKeyId)) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
        if (init?.method === 'PUT' && init.body instanceof FormData) {
          const meta = JSON.parse(await (init.body.get('metadata') as File).text());
          scripts.set(decodeURIComponent(url.split('/scripts/')[1]!.split('/')[0]!), meta.bindings ?? []);
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

  const settingsApi: WireSettingsApi = {
    async read(script) {
      settingsCalls++;
      return (scripts.get(script) ?? []).map((b) => ({ ...b }));
    },
    async write(script, body) {
      settingsCalls++;
      const kept = (scripts.get(script) ?? []).filter((b) => body.keep_bindings.includes(b.type));
      scripts.set(script, [...body.bindings.map((b) => ({ ...b })), ...kept]);
    },
  };
  const appWith = (wireUpload: WireUploadSettings) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      humanStaffActor: async (r) => (r.headers.get(DEV_ACTOR_HEADER) === person ? person : null),
      deployVertical: createWfpUploader({ accountId: 'acct', namespace: 'ns', apiToken: 'tok' }),
      fetchVerticalModules: async () => {
        moduleFetches++;
        const kind = 'application/javascript+module';
        return [
          { name: PLATFORM_ENTRY_MODULE, content: new TextEncoder().encode('export default {}'), contentType: kind },
          { name: 'worker.js', content: new TextEncoder().encode('export default {}'), contentType: kind },
        ];
      },
      wireSettings: settingsApi,
      wireUpload,
    });
  /** The lists as given: the key in use and its standby for each issuer. */
  const fleet = (router = keys.router.slice(0, 2), platform = keys.platform): WireUploadSettings => ({ rollout: 'fleet', routerKeys: router.join(','), platformKeys: platform.join(',') });

  const vertical = async (app: ReturnType<typeof createControlPlaneApi>, slug: string) => {
    const id = tenantId.parse(ulid());
    tenants.push(id);
    await host.admin.createTenant(person, { id, slug, name: slug });
    const push = async () => {
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
      fd.set('tenant', slug);
      fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
      const res = await app.request('/verticals/crm/deploy', { method: 'POST', headers: { [DEV_ACTOR_HEADER]: person }, body: fd });
      expect(res.status, await res.clone().text()).toBe(201);
      return (await res.json()) as { id: string; verticalSlug: string };
    };
    const served = await push();
    const res = await app.request(`/verticals/${encodeURIComponent(served.verticalSlug)}/channels/prod/promote`, {
      method: 'POST',
      headers: { [DEV_ACTOR_HEADER]: person, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: served.id }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const preview = await push();
    const s = served.verticalSlug;
    return { slug: s, scripts: [stableDeploymentRefFor(s), deploymentRefFor(s, served.id), deploymentRefFor(s, preview.id)] };
  };
  const post = (app: ReturnType<typeof createControlPlaneApi>, path: string, body: unknown, headers: Record<string, string> = { [DEV_ACTOR_HEADER]: person }) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const walkAll = async (app: ReturnType<typeof createControlPlaneApi>, body: Record<string, unknown>) => {
    let cursor: string | null = null;
    do {
      const res = await post(app, '/wire-auth/walk', { limit: 2, ...body, ...(cursor ? { cursor } : {}) });
      expect(res.status, await res.clone().text()).toBe(200);
      cursor = ((await res.json()) as WireWalkPass).next;
    } while (cursor !== null);
  };
  const confirmWalk = (app: ReturnType<typeof createControlPlaneApi>) => walkAll(app, { apply: true, confirm: true });
  /** Every page of the report, from the start of the fleet, joined. */
  const report = async (app: ReturnType<typeof createControlPlaneApi>, body: Record<string, unknown> = {}) => {
    const pages: WireReadinessReport[] = [];
    let cursor: string | null = null;
    do {
      const res = await post(app, '/wire-auth/readiness', { limit: 2, ...body, ...(cursor ? { cursor } : {}) });
      expect(res.status, await res.clone().text()).toBe(200);
      const page = (await res.json()) as WireReadinessReport;
      pages.push(page);
      cursor = page.next;
    } while (cursor !== null && pages.length < 50);
    const scriptBlockers = (pick: (p: WireReadinessReport) => readonly WireBlocker[] | undefined) =>
      pages.flatMap((p) => (pick(p) ?? []).filter((b) => b.kind === 'script'));
    return {
      pages,
      first: pages[0]!,
      scripts: pages.flatMap((p) => p.scripts),
      signedOnly: scriptBlockers((p) => p.blockers.signedOnly),
      keyDrop: scriptBlockers((p) => p.blockers.keyDrop),
      withdrawal: scriptBlockers((p) => p.blockers.credentialWithdrawal),
      fleetWide: (pick: (p: WireReadinessReport) => readonly WireBlocker[] | undefined) => (pick(pages[0]!) ?? []).filter((b) => b.kind !== 'script'),
    };
  };
  const reasonsFor = (blockers: readonly WireBlocker[], ref: string) => blockers.filter((b) => b.deploymentRef === ref).map((b) => b.reason);
  const directory = () => new Database(join(dir, '_directory.sqlite'));
  const recordOf = async (slug: string, ref: string) =>
    (await host.admin.listWireAuth!(person, { reach: { fleet: true }, verticalSlug: slug, limit: LIST_PAGE_MAX })).find((r) => r.deploymentRef === ref)!;
  const rewrite = (r: DeploymentWireAuth, record: Partial<DeploymentWireAuth['record']>, recordedAt = new Date().toISOString()) =>
    host.admin.recordWireAuth!(person, { deploymentRef: r.deploymentRef, verticalSlug: r.verticalSlug, versionId: r.versionId, record: { ...r.record, ...record }, recordedAt });
  /** No reason, anywhere in a report, names a key, a key id or a tenant. */
  const expectNothingSecret = (pages: readonly WireReadinessReport[]) => {
    const reasons = JSON.stringify(pages.flatMap((p) => [...p.blockers.signedOnly, ...(p.blockers.keyDrop ?? []), ...p.blockers.credentialWithdrawal].map((b) => b.reason)));
    for (const value of [...keys.router, ...keys.platform, ...kids.router, ...kids.platform, ...tenants]) expect(reasons).not.toContain(value);
  };

  it('over a clean, confirmed fleet: only the standing blockers, the unsigned upload route named with its reason; advisory, read-only, writing nothing', async () => {
    const app = appWith(fleet());
    const v = await vertical(app, 'ready-clean');
    await confirmWalk(app);
    const rowsBefore = (await host.admin.auditLog(person)).length;
    const [calls, fetches] = [settingsCalls, moduleFetches];
    const r = await report(app);
    expect(r.first.advisory).toBe(WIRE_READINESS_ADVISORY);
    expect(r.first.advisory).toMatch(/no tooling enforces it yet \(follow-on 7\)/);
    expect(r.first.confirmation).toMatchObject({ status: 'confirmed' });
    expect(r.scripts.map((s) => [s.deploymentRef, s.status, s.state, s.confirmed])).toEqual(v.scripts.map((s) => [s, 'verifies', 'dual', true]));
    expect([r.signedOnly, r.withdrawal]).toEqual([[], []]);
    // The standing blockers of signed-only: every unsigned route by method, path and reason, and the counters.
    expect(r.fleetWide((p) => p.blockers.signedOnly).map((b) => b.reason)).toEqual([
      ...WIRE_UNSIGNED_ROUTES.map((u) => `${u.method} ${u.path}: ${u.reason}`),
      R.counters,
    ]);
    expect(r.fleetWide((p) => p.blockers.signedOnly)[0]!.reason).toMatch(/^POST \/internal\/connector-attachment-stream: /);
    expect(r.fleetWide((p) => p.blockers.credentialWithdrawal).map((b) => b.reason)).toEqual([R.notSignedOnly, R.upChannel, R.perDeployment]);
    // Read-only: no admin row, no settings call, no module read.
    expect((await host.admin.auditLog(person)).length).toBe(rowsBefore);
    expect([settingsCalls, moduleFetches]).toEqual([calls, fetches]);
    expectNothingSecret(r.pages);
  });

  it('a script the walk holds, one it could not verify, and one with no record are unknown, and block every gate', async () => {
    const app = appWith(fleet());
    const v = await vertical(app, 'ready-unknown');
    await confirmWalk(app);
    const [serving, served, preview] = v.scripts as [string, string, string];
    await rewrite(await recordOf(v.slug, serving), { walkHold: { reason: 'verify', bindings: ['SUBSTRAT_WIRE_STATE'], at: new Date().toISOString() as never } });
    await rewrite(await recordOf(v.slug, served), {
      state: 'legacy-only', audience: null, routerKids: [], platformKids: [], withheld: 'unverified',
      walkHold: { reason: 'serve-in-flight', bindings: [], at: new Date().toISOString() as never },
    });
    const db = directory();
    db.prepare('DELETE FROM vertical_wire_auth WHERE deployment_ref = ?').run(preview);
    db.close();
    const r = await report(app, { keyDrop: { issuer: 'router', kid: kids.router[2], since: new Date(Date.now() - 60_000).toISOString() } });
    expect(r.scripts.map((s) => [s.deploymentRef, s.status, s.confirmed])).toEqual([[serving, 'unknown', null], [served, 'unknown', null], [preview, 'unknown', null]]);
    for (const blockers of [r.signedOnly, r.keyDrop, r.withdrawal]) {
      expect(reasonsFor(blockers, serving)).toEqual([R.held]);
      // A held record that says unverified reads as held: either way, unknown.
      expect(reasonsFor(blockers, served)).toEqual([R.held]);
      expect(reasonsFor(blockers, preview)).toEqual([R.noRecord]);
    }
    // Its twin: the same scripts released by a fresh record read as fact again.
    await rewrite(await recordOf(v.slug, serving), { walkHold: undefined });
    expect(reasonsFor((await report(app)).signedOnly, serving)).toEqual([]);
    // Unverified with no hold cannot be written (the record refuses it), so unverified is always held.
    await expect(rewrite(await recordOf(v.slug, serving), { state: 'legacy-only', audience: null, routerKids: [], platformKids: [], withheld: 'unverified' })).rejects.toThrow();
  });

  it('a record written before the last confirming walk began is unconfirmed, and blocks signed-only and a key drop', async () => {
    const app = appWith(fleet());
    const v = await vertical(app, 'ready-unconfirmed');
    await confirmWalk(app);
    const [serving] = v.scripts as [string];
    await rewrite(await recordOf(v.slug, serving), {}, '2020-01-01T00:00:00.000Z');
    const r = await report(app, { keyDrop: { issuer: 'router', kid: kids.router[2], since: '2020-01-01T00:00:00.000Z' } });
    expect(r.scripts.find((s) => s.deploymentRef === serving)).toMatchObject({ status: 'verifies', confirmed: false });
    expect(reasonsFor(r.signedOnly, serving)).toEqual([R.unconfirmed]);
    expect(reasonsFor(r.keyDrop, serving)).toEqual([R.unconfirmed]);
    // The others, written by the walk, are confirmed.
    expect(r.scripts.filter((s) => s.deploymentRef !== serving).map((s) => s.confirmed)).toEqual([true, true]);
  });

  it('with no confirming walk, or one a later applied walk followed, confirmation is unknown and blocks signed-only and a key drop', async () => {
    const app = appWith(fleet());
    await vertical(app, 'ready-no-confirm');
    const since = new Date(Date.now() - 60_000).toISOString();
    const none = await report(app, { keyDrop: { issuer: 'router', kid: kids.router[2], since } });
    expect(none.first.confirmation).toEqual({ status: 'unknown', reason: 'no applied confirming walk is recorded' });
    for (const gate of [none.fleetWide((p) => p.blockers.signedOnly), none.fleetWide((p) => p.blockers.keyDrop)]) {
      expect(gate.filter((b) => b.kind === 'confirmation').map((b) => b.reason)).toEqual([`${R.confirmationUnknown}: no applied confirming walk is recorded`]);
    }
    expect(none.scripts.every((s) => s.confirmed === null)).toBe(true);
    // Confirmed, then walked again without confirming: unknown again until the next confirming walk.
    await confirmWalk(app);
    expect((await report(app)).first.confirmation).toMatchObject({ status: 'confirmed' });
    await walkAll(app, { apply: true });
    expect((await report(app)).first.confirmation).toEqual({ status: 'unknown', reason: 'the last applied walk was not a confirming one' });
    // A dry run after it changes nothing.
    await confirmWalk(app);
    await walkAll(app, { confirm: true });
    expect((await report(app)).first.confirmation).toMatchObject({ status: 'confirmed' });
  });

  it('a key drop: the key still listed, still trusted, the key in use missing, a confirming walk from before; then clean once walked and confirmed', async () => {
    const before = fleet([keys.router[0]!, keys.router[1]!]);
    const v = await vertical(appWith(before), 'ready-drop');
    await confirmWalk(appWith(before));
    const dropped = kids.router[1]!;
    const later = async () => (await new Promise((r) => setTimeout(r, 5)), new Date().toISOString());
    // Asked while the control plane still lists it, after the confirming walk began.
    const listed = await report(appWith(before), { keyDrop: { issuer: 'router', kid: dropped, since: await later() } });
    expect(listed.fleetWide((p) => p.blockers.keyDrop).map((b) => b.reason)).toEqual([R.stillListed, R.confirmedBeforeSince]);
    for (const s of v.scripts) expect(reasonsFor(listed.keyDrop, s), s).toEqual([R.stillTrusted]);
    // The list moved on: the key dropped, a new standby beside the key in use.
    const after = fleet([keys.router[0]!, keys.router[2]!]);
    const since = await later();
    const moved = await report(appWith(after), { keyDrop: { issuer: 'router', kid: dropped, since } });
    expect(moved.first.keyDrop).toEqual({ issuer: 'router', since });
    expect(moved.fleetWide((p) => p.blockers.keyDrop).map((b) => b.reason)).toEqual([R.confirmedBeforeSince]);
    for (const s of v.scripts) expect(reasonsFor(moved.keyDrop, s), s).toEqual([R.stillTrusted, R.lacksKeyInUse]);
    // signed-only reads them as not carrying what is given now.
    for (const s of v.scripts) expect(reasonsFor(moved.signedOnly, s), s).toEqual([R.stale]);
    // Walked (applied) but not confirmed: confirmation is unknown, which blocks.
    await walkAll(appWith(after), { apply: true });
    const walked = await report(appWith(after), { keyDrop: { issuer: 'router', kid: dropped, since } });
    expect(walked.fleetWide((p) => p.blockers.keyDrop).map((b) => b.kind)).toEqual(['confirmation']);
    expect(walked.keyDrop).toEqual([]);
    // Confirmed: nothing blocks the drop.
    await confirmWalk(appWith(after));
    const clean = await report(appWith(after), { keyDrop: { issuer: 'router', kid: dropped, since } });
    expect(clean.pages.flatMap((p) => p.blockers.keyDrop ?? [])).toEqual([]);
    expectNothingSecret([...listed.pages, ...moved.pages, ...clean.pages]);
    // The issuer's only key cannot be dropped.
    const single = fleet([keys.router[0]!]);
    const only = await report(appWith(single), { keyDrop: { issuer: 'router', kid: kids.router[0], since } });
    expect(only.fleetWide((p) => p.blockers.keyDrop).map((b) => b.reason)).toEqual(expect.arrayContaining([R.stillListed, R.listWouldEmpty]));
  });

  it('a script with no standby key, and one uploaded without the entry, block signed-only by name', async () => {
    const single = fleet([keys.router[0]!], [keys.platform[0]!]);
    const app = appWith(single);
    const v = await vertical(app, 'ready-standby');
    await confirmWalk(app);
    const r = await report(app);
    for (const s of v.scripts) expect(reasonsFor(r.signedOnly, s), s).toEqual([R.noRouterStandby, R.noPlatformStandby]);
    const [serving] = v.scripts as [string];
    await rewrite(await recordOf(v.slug, serving), { envelope: null, entrySkipped: 'it writes its own invocation line' });
    const unwrapped = await report(app);
    expect(unwrapped.scripts.find((s) => s.deploymentRef === serving)).toMatchObject({ status: 'not-verifying' });
    expect(reasonsFor(unwrapped.signedOnly, serving)).toEqual([R.noEntry]);
    expect(reasonsFor(unwrapped.withdrawal, serving)).toEqual([R.noEntry]);
  });

  it('a rollout that is not fleet-wide, or refused settings, block at the settings', async () => {
    const v = await vertical(appWith({ rollout: 'off' }), 'ready-settings');
    const off = await report(appWith({ rollout: 'off', routerKeys: keys.router.slice(0, 2).join(','), platformKeys: keys.platform.join(',') }));
    expect(off.fleetWide((p) => p.blockers.signedOnly).map((b) => b.reason)).toContain(R.rolloutNotFleet);
    for (const s of v.scripts) expect(reasonsFor(off.signedOnly, s)[0], s).toBe(`${R.noLists} (unconfigured)`);
    const canary = await report(appWith({ ...fleet(), rollout: `canary:${v.slug}` }));
    expect(canary.fleetWide((p) => p.blockers.signedOnly).map((b) => b.reason)).toContain(R.rolloutNotFleet);
    const refused = await report(appWith({ rollout: 'fleet', routerKeys: 'not-a-key', platformKeys: keys.platform.join(',') }));
    const settings = refused.fleetWide((p) => p.blockers.signedOnly).filter((b) => b.kind === 'settings');
    expect(settings.map((b) => b.reason)).toEqual([expect.stringMatching(/^the control plane’s wire settings are refused \(lists-refused\): WIRE_ROUTER_PUBLIC_KEYS/)]);
    expect(refused.fleetWide((p) => p.blockers.credentialWithdrawal).map((b) => b.kind)).toContain('settings');
  });

  it('is bounded and resumable: a limit out of range is refused, not clamped; a cursor it did not answer is refused; pages cover the fleet once', async () => {
    const app = appWith(fleet());
    const a = await vertical(app, 'ready-page-a');
    const b = await vertical(app, 'ready-page-b');
    for (const limit of [0, 51, 1.5, '10']) {
      const res = await post(app, '/wire-auth/readiness', { limit });
      expect(res.status, String(limit)).toBe(400);
    }
    expect((await post(app, '/wire-auth/readiness', { limit: 50 })).status).toBe(200);
    expect((await post(app, '/wire-auth/readiness', { cursor: 'no-bar' })).status).toBe(422);
    expect((await post(app, '/wire-auth/readiness', { extra: true })).status).toBe(400);
    const one = await report(app, { limit: 1 });
    expect(one.pages.map((p) => p.scripts.length)).toEqual(one.pages.map(() => 1));
    expect(one.scripts.map((s) => s.deploymentRef).sort()).toEqual([...a.scripts, ...b.scripts].sort());
    expect(one.pages.at(-1)!.next).toBeNull();
    // The standing blockers ride every page.
    for (const p of one.pages) expect(p.blockers.signedOnly.filter((x) => x.kind === 'standing').length).toBe(WIRE_UNSIGNED_ROUTES.length + 1);
  });

  it('a key drop’s since is refused missing, unreadable or in the future, with its fixed sentence; staff only, never a service token', async () => {
    const app = appWith(fleet());
    await vertical(app, 'ready-since');
    for (const [since, sentence] of [
      [undefined, 'a key drop names since: when the control plane’s list stopped naming the key'],
      ['soon', 'since is an ISO 8601 instant'],
      [new Date(Date.now() + 3_600_000).toISOString(), 'since is not in the future'],
    ] as const) {
      const res = await post(app, '/wire-auth/readiness', { keyDrop: { issuer: 'router', kid: kids.router[0], ...(since !== undefined ? { since } : {}) } });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain(sentence);
    }
    expect((await post(app, '/wire-auth/readiness', { keyDrop: { issuer: 'both', kid: 'k', since: T0 } })).status).toBe(400);
    // Not a person: refused.
    const service = await post(app, '/wire-auth/readiness', {}, { [DEV_ACTOR_HEADER]: platformActorId.parse(ulid()) });
    expect(service.status).toBe(403);
    // No key drop asked: none answered.
    const plain = (await (await post(app, '/wire-auth/readiness', {})).json()) as WireReadinessReport;
    expect(plain.keyDrop).toBeUndefined();
    expect(plain.blockers.keyDrop).toBeUndefined();
  });
});
