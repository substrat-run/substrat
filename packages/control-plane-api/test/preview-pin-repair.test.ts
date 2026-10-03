import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable } from '@substrat-run/contracts';
import {
  ControlPlaneError,
  createControlPlaneApi,
  firstBuilderAuth,
  firstPlatformActorAuth,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  serviceTokenAuth,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
  type VerticalClient,
} from '../src/index.js';

/**
 * The one-time fleet repair of legacy preview pins over HTTP (#1724):
 * `POST /previews/repair-serving-pins`.
 *
 * A preview adopted onto the serving script before #1731 still routes by
 * `COALESCE(servingRef, deploymentRef)`, so it serves production code. #1962 heals one on its
 * next bind; this is the pass over the ones nobody binds again. Each fake deployment keeps its
 * own scope → dump map, so "what the preview serves" is read off the stores and off the
 * hostname the router resolves, never assumed. The workerd twin
 * (adapter-cloudflare `preview-carry.test.ts`) runs the same repair on real Durable Object
 * namespaces.
 *
 * Who can call it: staff only. The path is on neither the builder allowlist nor the tenant
 * credential's, so both are refused before the handler runs.
 */
describe('the fleet repair of legacy preview serving pins (#1724)', () => {
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const slug = 'pin-vert';
  const SERVING = 'pin-vert-serving';
  const REPAIR = '/previews/repair-serving-pins';

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let asTenant: Record<string, string>;
  let asOtherTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let v1: string;
  let v2: string;
  let v3: string; // a version with no script of its own
  let prod: ReturnType<typeof scopeId.parse>; // the production install previews fork from
  let failRestoreInto: string | null = null;
  // #1722: a fenced wipe whose answer is lost in transit (Codex #2008 r1).
  let wipeAnswerLost = false;

  const refOf = new Map<string, string>(); // versionId → its script
  const scripts = new Map<string, Map<string, ScopeDumpTable[]>>(); // script → scope → dump
  const calls: string[] = [];
  const storeOf = (ref: string) => {
    if (!scripts.has(ref)) scripts.set(ref, new Map());
    return scripts.get(ref)!;
  };
  const deployment = (ref: string): VerticalClient =>
    ({
      exportScope: async (sid: string) => {
        calls.push(`export ${ref} ${sid}`);
        return storeOf(ref).get(sid) ?? [];
      },
      // A deployment built before the load stamp (#1722) answers none.
      exportScopeStamped: async (sid: string) => {
        calls.push(`export ${ref} ${sid}`);
        return { tables: storeOf(ref).get(sid) ?? [], loadStamp: null };
      },
      restoreScope: async (_t: string, sid: string, tables: ScopeDumpTable[]) => {
        calls.push(`restore ${ref} ${sid}`);
        if (failRestoreInto === ref) throw new ControlPlaneError(503, `storage blip in ${ref}`);
        storeOf(ref).set(sid, tables);
        return { tables: tables.length };
      },
      snapshotScope: async (input: { sourceScopeId: string; newScopeId: string }) => {
        storeOf(ref).set(input.newScopeId, storeOf(ref).get(input.sourceScopeId) ?? []);
        return { tables: 1 };
      },
      deleteScope: async (input: { scopeId: string }) => {
        storeOf(ref).delete(input.scopeId);
      },
      // #1722: a deployment built before the fenced wipe, so the carry's cleanup takes the
      // tombstone load; the meta read is what the cleanup checks a destination with.
      wipeCarriedCopy: async () => {
        if (wipeAnswerLost) throw new ControlPlaneError(502, "reading the vertical's answer to wipe-carried failed (reset)");
        return 'unfenced';
      },
      loadMarker: async () => 'unfenced',
      readScopeTable: async (sid: string) => {
        const meta = storeOf(ref).get(sid)?.find((tb) => tb.name === '_substrat_meta');
        return { table: '_substrat_meta', columns: meta?.columns ?? ['key', 'value'], rows: meta?.rows ?? [] };
      },
    }) as unknown as VerticalClient;
  const table = (...ids: string[]): ScopeDumpTable[] => [
    { name: 't', ddl: 'CREATE TABLE t(id TEXT)', columns: ['id'], rows: ids.map((id) => [id]) },
  ];
  const rowsOf = (ref: string, sid: string) => storeOf(ref).get(sid)?.[0]?.rows;

  const publish = async (version: string, withScript = true): Promise<string> => {
    const id = ulid();
    const ref = `${slug}-${id.toLowerCase()}`;
    await host.admin.publishVersion(staff, {
      id, verticalSlug: slug, version, manifestDigest: `m-${version}`,
      permissionDigest: 'p', migrationDigest: 'g', deploymentRef: withScript ? ref : null,
    });
    if (withScript) refOf.set(id, ref);
    return id;
  };
  const repair = (headers: Record<string, string>, body: object = {}) =>
    app.request(REPAIR, { method: 'POST', headers, body: JSON.stringify(body) });
  const repairRaw = (headers: Record<string, string>, body: string | undefined) =>
    app.request(REPAIR, { method: 'POST', headers, body });
  type Pass = {
    dryRun: boolean;
    repaired: { tenantId: string; scopeId: string; from: string; to: string; tables: number }[];
    candidates: { tenantId: string; scopeId: string; servingRef: string }[];
    skipped: { scopeId: string; reason: string }[];
    failed: { scopeId: string; status: number; error: string }[];
    nextCursor: string | null;
  };
  const pass = async (body: object = {}): Promise<Pass> => {
    const res = await repair(asStaff, body);
    expect(res.status).toBe(200);
    return (await res.json()) as Pass;
  };
  const recordOf = async (sid: string) => (await host.admin.getScopeRecord(staff, t, scopeId.parse(sid)))!;

  /** A preview born the way a push makes one, then put back in the state #1731 left behind. */
  const legacyPreview = async (tag: string, versionId: string, ...serving: string[]) => {
    const res = await app.request(`/verticals/${slug}/previews`, {
      method: 'POST', headers: asStaff, body: JSON.stringify({ tag, versionId, ttlHours: null, sourceScopeId: prod }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const created = (await res.json()) as { scopeId: string; hostname: string };
    await host.admin.setScopeServingRef(staff, t, scopeId.parse(created.scopeId), SERVING);
    storeOf(SERVING).set(created.scopeId, table(...serving));
    return created;
  };
  const sinceStart = async (sid: string, action: 'bindScopeVersion' | 'setScopeServingRef') =>
    (await host.admin.auditLog(staff, { tenantId: t, scopeId: scopeId.parse(sid), action })).length;

  const baseOptions = () => ({
    host,
    authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
    authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
    tenantTokenSecret: TENANT_SECRET,
    pushTokenSecret: PUSH_SECRET,
    platformBaseDomains: ['global.substrat.run'],
    provisionRetryDelaysMs: [1],
    resolveVerticalVersion: async (s: string, versionId: string) => {
      const ref = s === slug ? refOf.get(versionId) : undefined;
      return ref ? deployment(ref) : undefined;
    },
    resolveVerticalRef: async (ref: string) => deployment(ref),
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-preview-pin-repair-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({ ...baseOptions(), authenticate: UNSAFE_devPlatformActorAuth() });
    await host.admin.createTenant(staff, { id: t, slug: 'pin-co', name: 'Pin Co' });
    await host.admin.createTenant(staff, { id: other, slug: 'other-co', name: 'Other Co' });
    // PRIVATE (owned, unlisted), so every push self-admits, as a builder's does.
    await host.admin.registerVertical(staff, { slug, name: 'Pin Vert', source: 'cli', ownerTenant: t });
    v1 = await publish('1.0.0');
    v2 = await publish('1.0.1');
    v3 = await publish('1.0.2', false);
    for (const [tenant, headers] of [[t, 'asTenant'], [other, 'asOtherTenant']] as const) {
      const minted = await app.request('/tenant-tokens', { method: 'POST', headers: asStaff, body: JSON.stringify({ tenantId: tenant }) });
      expect(minted.status).toBe(201);
      const h = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
      if (headers === 'asTenant') asTenant = h;
      else asOtherTenant = h;
    }
    // The production install previews fork from: a preview URL derives from its hostname.
    prod = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: prod, vertical: slug });
    await host.admin.activateScope(staff, t, prod);
    await host.admin.bindScopeVersion(staff, t, prod, v1);
    await host.admin.bindHostname(staff, {
      hostname: 'pin-acme.global.substrat.run', tenantId: t, scopeId: prod, surface: 'app', region: null, canonical: true,
    });
    storeOf(refOf.get(v1)!).set(prod, table('prod-row'));
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: 'pin-co' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push, 'content-type': 'application/json' };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Scopes the later tests must leave alone, made once: an install and a snapshot fork that
  // both carry a serving ref (a fork keeps `forkedFrom`, an install keeps no preview kind).
  let install: string;
  let fork: string;
  let unpinned: string;
  let a: { scopeId: string; hostname: string };
  let b: { scopeId: string; hostname: string };

  it('lists the candidates on a dry run and touches nothing', async () => {
    install = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: install, vertical: slug });
    await host.admin.activateScope(staff, t, install);
    await host.admin.bindScopeVersion(staff, t, install, v1);
    await host.admin.setScopeServingRef(staff, t, install, SERVING);
    storeOf(SERVING).set(install, table('install-row'));

    a = await legacyPreview('legacy-a', v1, 'a-row');
    b = await legacyPreview('legacy-b', v2, 'b-row');
    // A fork (snapshot) of a preview that carries a pin: not a preview, so not this pass's.
    fork = await host.snapshotScope(staff, t, scopeId.parse(a.scopeId));
    await host.admin.setScopeServingRef(staff, t, fork, SERVING);
    // A preview with no pin: born unpinned, as every preview is since #1731.
    const fresh = await app.request(`/verticals/${slug}/previews`, {
      method: 'POST', headers: asStaff, body: JSON.stringify({ tag: 'clean', versionId: v1, ttlHours: null, sourceScopeId: prod }),
    });
    expect(fresh.status).toBe(201);
    unpinned = ((await fresh.json()) as { scopeId: string }).scopeId;
    // A pinned preview that is suspended is not served, so it is not visited.
    const sleeping = await legacyPreview('legacy-asleep', v1, 'asleep-row');
    await host.admin.suspendScope(staff, t, scopeId.parse(sleeping.scopeId));

    calls.length = 0;
    const out = await pass({ dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.candidates.map((c) => c.scopeId).sort()).toEqual([a.scopeId, b.scopeId].sort());
    expect(out.candidates.every((c) => c.servingRef === SERVING)).toBe(true);
    expect(out.repaired).toEqual([]);
    expect(out.nextCursor).toBeNull();
    expect(calls).toEqual([]);
    expect((await recordOf(a.scopeId)).servingRef).toBe(SERVING);
    expect((await recordOf(b.scopeId)).servingRef).toBe(SERVING);
  });

  it('heals every legacy preview: data carried, pin cleared, hostname on its own version', async () => {
    // Before: the router sends the preview to the serving script, whatever it is bound to.
    expect(await host.admin.resolveHostname(a.hostname)).toMatchObject({ scopeId: a.scopeId, deploymentRef: SERVING });
    const bindsBefore = await sinceStart(a.scopeId, 'bindScopeVersion');
    const clearsBefore = await sinceStart(a.scopeId, 'setScopeServingRef');

    calls.length = 0;
    const out = await pass();
    expect(out.repaired.map((r) => r.scopeId).sort()).toEqual([a.scopeId, b.scopeId].sort());
    expect(out.failed).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(out.nextCursor).toBeNull();
    expect(out.repaired.find((r) => r.scopeId === a.scopeId)).toMatchObject({
      tenantId: t, from: SERVING, to: refOf.get(v1), tables: 1,
    });
    // Each preview's data went from the serving script into the script of the version it was
    // bound to, and only those two scopes were touched. The copy left on the serving script
    // was then wiped (#1722), which is a load of the tombstone there.
    expect(calls.sort()).toEqual(
      [
        `export ${SERVING} ${a.scopeId}`, `restore ${refOf.get(v1)} ${a.scopeId}`, `restore ${SERVING} ${a.scopeId}`,
        `export ${SERVING} ${b.scopeId}`, `restore ${refOf.get(v2)} ${b.scopeId}`, `restore ${SERVING} ${b.scopeId}`,
      ].sort(),
    );
    expect(rowsOf(refOf.get(v1)!, a.scopeId)).toEqual([['a-row']]);
    expect(rowsOf(refOf.get(v2)!, b.scopeId)).toEqual([['b-row']]);
    for (const p of [a, b]) {
      expect(storeOf(SERVING).get(p.scopeId)).toEqual([
        expect.objectContaining({ name: '_substrat_meta', rows: [['carried_away', expect.stringContaining(`"to":`)]] }),
      ]);
    }
    for (const [p, v] of [[a, v1], [b, v2]] as const) {
      const rec = await recordOf(p.scopeId);
      expect(rec.verticalVersionId).toBe(v); // never advanced
      expect(rec.servingRef ?? null).toBeNull();
      expect(await host.admin.resolveHostname(p.hostname)).toMatchObject({ scopeId: p.scopeId, deploymentRef: refOf.get(v) });
    }
    // Each repair wrote its admin-log rows: the bind, and the pin clear with the old pin in `before`.
    expect(await sinceStart(a.scopeId, 'bindScopeVersion')).toBe(bindsBefore + 1);
    expect(await sinceStart(a.scopeId, 'setScopeServingRef')).toBe(clearsBefore + 1);
    const clear = (await host.admin.auditLog(staff, { scopeId: scopeId.parse(a.scopeId), action: 'setScopeServingRef' })).at(-1)!;
    expect(clear.before).toEqual({ servingRef: SERVING });
    expect(clear.after).toEqual({ servingRef: null });
    expect(clear.actor).toBe(staff);
  });

  it('leaves an install, a fork, an unpinned preview and a suspended one exactly as they were', async () => {
    const installRec = await recordOf(install);
    expect(installRec).toMatchObject({ verticalVersionId: v1, servingRef: SERVING });
    expect(rowsOf(SERVING, install)).toEqual([['install-row']]);
    expect((await recordOf(fork)).servingRef).toBe(SERVING);
    expect((await recordOf(unpinned)).servingRef ?? null).toBeNull();
    // Nothing was exported for them in the pass above.
    expect(calls.some((c) => c.includes(install) || c.includes(fork) || c.includes(unpinned))).toBe(false);
    // And the suspended pinned preview still has its pin: the pass only visits active scopes.
    const stillPinned = (await host.admin.listScopes(staff, { tenantId: t, status: ['suspended'] }))
      .filter((s) => s.kind === 'preview' && s.servingRef);
    expect(stillPinned).toHaveLength(1);
  });

  it('a re-run is a no-op: nothing is exported, restored or logged', async () => {
    const writes = () => host.admin.auditLog(staff, { tenantId: t, action: ['bindScopeVersion', 'setScopeServingRef'] });
    const before = (await writes()).length;
    expect(before).toBeGreaterThan(0); // the repair above did log
    calls.length = 0;
    const out = await pass();
    expect(out).toMatchObject({ repaired: [], candidates: [], skipped: [], failed: [], nextCursor: null });
    expect(calls).toEqual([]);
    expect((await writes()).length).toBe(before);
  });

  it('a failed carry leaves the pin and the binding, is reported, and does not hold the others up', async () => {
    const bad = await legacyPreview('legacy-bad', v2, 'bad-row');
    const good = await legacyPreview('legacy-good', v1, 'good-row');
    failRestoreInto = refOf.get(v2)!;
    calls.length = 0;
    const out = await pass();
    failRestoreInto = null;
    expect(out.repaired.map((r) => r.scopeId)).toEqual([good.scopeId]);
    expect(out.failed).toMatchObject([{ scopeId: bad.scopeId, status: 503 }]);
    expect(out.failed[0]!.error).toContain('storage blip');
    // #1962's contract: the route and the binding stay where the data is.
    expect(await recordOf(bad.scopeId)).toMatchObject({ verticalVersionId: v2, servingRef: SERVING });
    expect(rowsOf(refOf.get(v2)!, bad.scopeId)).toEqual([['prod-row']]); // the fork's own data, as born
    expect(rowsOf(SERVING, bad.scopeId)).toEqual([['bad-row']]);
    expect(await host.admin.resolveHostname(bad.hostname)).toMatchObject({ deploymentRef: SERVING });
    // The failure is on the ops record, like a failed preview carry.
    await new Promise((r) => setTimeout(r, 20)); // the recorder is fire-and-forget
    const recorded = (await host.admin.listOpsFailures(staff, { scopeId: scopeId.parse(bad.scopeId) })).find((f) => f.stage === 'repair');
    expect(recorded).toMatchObject({ operation: 'preview.repair-serving-pin', status: 503 });

    // A write while the pin is still in place must survive the retry, which carries again.
    storeOf(SERVING).set(bad.scopeId, table('bad-row', 'after-failure'));
    calls.length = 0;
    const retried = await pass();
    expect(retried.repaired.map((r) => r.scopeId)).toEqual([bad.scopeId]);
    expect(calls).toEqual([
      `export ${SERVING} ${bad.scopeId}`,
      `restore ${refOf.get(v2)} ${bad.scopeId}`,
      `restore ${SERVING} ${bad.scopeId}`, // #1722: the serving script's copy, wiped once the bind landed
    ]);
    expect(rowsOf(refOf.get(v2)!, bad.scopeId)).toEqual([['bad-row'], ['after-failure']]);
    expect((await recordOf(bad.scopeId)).servingRef ?? null).toBeNull();
  });

  it('a pin that fails to clear after the bind is retried from the still-serving script', async () => {
    const stuck = await legacyPreview('legacy-stuck', v1, 'stuck-row');
    const clear = vi.spyOn(host.admin, 'setScopeServingRef').mockRejectedValueOnce(new Error('pin clear unavailable'));
    try {
      const out = await pass();
      expect(out.failed).toMatchObject([{ scopeId: stuck.scopeId, status: 500 }]);
      expect(await recordOf(stuck.scopeId)).toMatchObject({ verticalVersionId: v1, servingRef: SERVING });
      // #1722: the bind landed but the route did not move, so the copy the route reaches stays.
      expect(rowsOf(SERVING, stuck.scopeId)).toEqual([['stuck-row']]);
    } finally {
      clear.mockRestore();
    }
    storeOf(SERVING).set(stuck.scopeId, table('stuck-row', 'after-failed-clear'));
    const retried = await pass();
    expect(retried.repaired.map((r) => r.scopeId)).toEqual([stuck.scopeId]);
    expect(rowsOf(refOf.get(v1)!, stuck.scopeId)).toEqual([['stuck-row'], ['after-failed-clear']]);
    expect((await recordOf(stuck.scopeId)).servingRef ?? null).toBeNull();
    // #1722: the copy on the serving script stayed while the pin still routed there, and goes
    // only once the retry cleared it.
    expect(storeOf(SERVING).get(stuck.scopeId)?.[0]?.name).toBe('_substrat_meta');
  });

  it('a re-assert that fails after the route moved still wipes the copy left behind (#1722)', async () => {
    const moved = await legacyPreview('legacy-reassert', v1, 'reassert-row');
    const reassert = vi.spyOn(host.admin, 'reassertSystemSwitches').mockRejectedValueOnce(new Error('re-assert unavailable'));
    try {
      const out = await pass();
      expect(out.failed).toMatchObject([{ scopeId: moved.scopeId, status: 500 }]);
    } finally {
      reassert.mockRestore();
    }
    // The bind and the pin clear landed, so no later pass visits this preview again: the copy on
    // the serving script had to go now, or it never would.
    expect((await recordOf(moved.scopeId)).servingRef ?? null).toBeNull();
    expect(rowsOf(refOf.get(v1)!, moved.scopeId)).toEqual([['reassert-row']]);
    expect(storeOf(SERVING).get(moved.scopeId)?.[0]?.name).toBe('_substrat_meta');
  });

  it('a fenced wipe whose answer is lost never falls back to the unconditional wipe, and is recorded (#1722)', async () => {
    const lost = await legacyPreview('legacy-lost-answer', v1, 'lost-row');
    wipeAnswerLost = true;
    calls.length = 0;
    try {
      const out = await pass();
      expect(out.repaired.map((r) => r.scopeId)).toContain(lost.scopeId);
    } finally {
      wipeAnswerLost = false;
    }
    // The carry and the bind landed; the cleanup did not load a tombstone over the serving copy.
    expect(calls).toEqual([`export ${SERVING} ${lost.scopeId}`, `restore ${refOf.get(v1)} ${lost.scopeId}`]);
    expect(rowsOf(SERVING, lost.scopeId)).toEqual([['lost-row']]);
    await new Promise((r) => setTimeout(r, 20)); // the recorder is fire-and-forget
    const recorded = (await host.admin.listOpsFailures(staff, { scopeId: scopeId.parse(lost.scopeId) })).find(
      (f) => f.stage === 'source-copy',
    );
    expect(recorded).toMatchObject({ operation: 'scope.carry', status: 502 });
  });

  it('skips a preview whose bound version has no script of its own, and keeps its pin', async () => {
    const orphan = await legacyPreview('legacy-orphan', v1, 'orphan-row');
    // Bound to a version with nowhere to receive the data: clearing the pin would strand it.
    await host.admin.bindScopeVersion(staff, t, scopeId.parse(orphan.scopeId), v3);
    calls.length = 0;
    const out = await pass();
    expect(out.repaired).toEqual([]);
    expect(out.skipped).toMatchObject([{ scopeId: orphan.scopeId, reason: expect.stringContaining('no script of its own') }]);
    expect(calls).toEqual([]);
    expect((await recordOf(orphan.scopeId)).servingRef).toBe(SERVING);
    // Unbind the fixture so later passes do not trip over it.
    await host.admin.setScopeServingRef(staff, t, scopeId.parse(orphan.scopeId), null);
  });

  it('pages: at most `limit` repairs a pass, a cursor resumes, and each preview is repaired once', async () => {
    const made = [
      await legacyPreview('page-1', v1, 'p1'),
      await legacyPreview('page-2', v2, 'p2'),
      await legacyPreview('page-3', v1, 'p3'),
    ].map((p) => p.scopeId);
    const seen: string[] = [];
    let cursor: string | undefined;
    let passes = 0;
    do {
      const out = await pass({ limit: 1, ...(cursor ? { cursor } : {}) });
      expect(out.repaired.length).toBeLessThanOrEqual(1);
      seen.push(...out.repaired.map((r) => r.scopeId));
      cursor = out.nextCursor ?? undefined;
      passes += 1;
      expect(passes).toBeLessThan(50);
    } while (cursor);
    expect(seen.sort()).toEqual([...made].sort());
    expect(new Set(seen).size).toBe(seen.length);
    for (const sid of made) expect((await recordOf(sid)).servingRef ?? null).toBeNull();
  });

  it('does not bind a preview back when a push re-pointed it since it was listed', async () => {
    const racing = await legacyPreview('legacy-race', v1, 'race-row');
    // The push lands between the pass reading the row and binding it: it moves the preview to
    // v2 (carrying from the serving script, as a bind does), and only then does the pass bind.
    const bind = host.admin.bindScopeVersion.bind(host.admin);
    const spy = vi.spyOn(host.admin, 'bindScopeVersion').mockImplementationOnce(async (actor, tenant, sid, versionId, opts) => {
      await bind(actor, tenant, sid, v2);
      return bind(actor, tenant, sid, versionId, opts);
    });
    try {
      const out = await pass();
      expect(out.repaired).toEqual([]);
      expect(out.failed).toMatchObject([{ scopeId: racing.scopeId, status: 412 }]);
    } finally {
      spy.mockRestore();
    }
    // The preview stays where the push put it, and keeps its pin for the next pass to heal.
    expect(await recordOf(racing.scopeId)).toMatchObject({ verticalVersionId: v2, servingRef: SERVING });
    const healed = await pass();
    expect(healed.repaired.map((r) => r.scopeId)).toEqual([racing.scopeId]);
    expect((await recordOf(racing.scopeId)).verticalVersionId).toBe(v2);
  });

  it('refuses a body it cannot read as the request, before touching anything', async () => {
    const pinned = await legacyPreview('legacy-validate', v1, 'v-row');
    calls.length = 0;
    // Wrong types and bounds, a key the route does not know (a typo for `dryRun` would otherwise
    // start a real pass), and JSON that is not an object.
    for (const body of [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '5' }, { cursor: 'not-a-scope-id' }, { cursor: 7 },
      { dryRun: 'yes' }, { dryrun: true }, { limit: 5, extra: 1 },
    ]) {
      const res = await repair(asStaff, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Malformed JSON must not fall back to the defaults, which are a REAL pass.
    for (const raw of ['{', '{"dryRun": true', 'dryRun=true', '[]', 'null', '"x"', '5', ' ', '\n', ' \t\n ', '\uFEFF', '\uFEFF \n']) {
      const res = await repairRaw(asStaff, raw);
      expect(res.status, raw).toBe(400);
    }
    expect(calls).toEqual([]);
    expect((await recordOf(pinned.scopeId)).servingRef).toBe(SERVING);

    // A BOM in front of JSON is still JSON.
    const bom = await repairRaw(asStaff, '\uFEFF{"dryRun": true}');
    expect(bom.status).toBe(200);
    expect(((await bom.json()) as Pass).candidates.map((c) => c.scopeId)).toEqual([pinned.scopeId]);

    // A genuinely empty body, or none, is the defaults: a real pass.
    const empty = await repairRaw(asStaff, '');
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as Pass)).toMatchObject({ dryRun: false, repaired: [{ scopeId: pinned.scopeId }] });
    expect((await recordOf(pinned.scopeId)).servingRef ?? null).toBeNull();
    const none = await repairRaw(asStaff, undefined);
    expect(none.status).toBe(200);
    expect(((await none.json()) as Pass).repaired).toEqual([]);
  });

  describe('who can call it', () => {
    it('is staff only: a builder, a tenant credential (own or foreign) and a stranger are refused, and nothing moves', async () => {
      const pinned = await legacyPreview('legacy-denied', v1, 'denied-row');
      calls.length = 0;
      const body = { limit: 100 };
      // Same shape, three credentials a tenant or a builder can hold.
      expect((await repair(asBuilder, body)).status).toBe(403);
      expect((await repair(asTenant, body)).status).toBe(403);
      expect((await repair(asOtherTenant, body)).status).toBe(403);
      expect((await repair(asTenant, { ...body, dryRun: true })).status).toBe(403);
      // Naming its own tenant in the query does not open it to a tenant credential either.
      expect((await app.request(`${REPAIR}?tenantId=${t}`, { method: 'POST', headers: asTenant, body: JSON.stringify(body) })).status).toBe(403);
      expect((await repair({ 'content-type': 'application/json' }, body)).status).toBe(401);
      expect(calls).toEqual([]);
      expect((await recordOf(pinned.scopeId)).servingRef).toBe(SERVING);

      // The allowed case, with the same body.
      const ok = await repair(asStaff, body);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as Pass).repaired.map((r) => r.scopeId)).toEqual([pinned.scopeId]);
      expect((await recordOf(pinned.scopeId)).servingRef ?? null).toBeNull();
    });

    it('is reachable through the production service-token auth, and only with the right token', async () => {
      // The composition the deployed control plane uses, not the dev actor header.
      const svc = createControlPlaneApi({
        ...baseOptions(),
        authenticate: firstPlatformActorAuth(serviceTokenAuth('svc-secret', serviceActor)),
      });
      const call = (headers: Record<string, string>) =>
        svc.request(REPAIR, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
      const pinned = await legacyPreview('legacy-service', v1, 'svc-row');
      expect((await call({ [SERVICE_TOKEN_HEADER]: 'wrong-secret' })).status).toBe(401);
      expect((await call({ [DEV_ACTOR_HEADER]: staff })).status).toBe(401); // the dev header is not a credential here
      expect((await recordOf(pinned.scopeId)).servingRef).toBe(SERVING);

      const ok = await call({ [SERVICE_TOKEN_HEADER]: 'svc-secret' });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as Pass).repaired.map((r) => r.scopeId)).toEqual([pinned.scopeId]);
      expect((await recordOf(pinned.scopeId)).servingRef ?? null).toBeNull();
      // The admin log names the service actor, not staff.
      const clear = (await host.admin.auditLog(staff, { scopeId: scopeId.parse(pinned.scopeId), action: 'setScopeServingRef' })).at(-1)!;
      expect(clear.actor).toBe(serviceActor);
    });
  });

  it('walks past a full page of unrelated scopes by cursor, rather than reporting the fleet done', async () => {
    // Active scopes older than the pinned preview, enough to fill the pass's scan page, so the
    // candidate is on the NEXT page and a pass that called an unfinished walk finished would
    // leave it pinned for good.
    for (let i = 0; i < 505; i += 1) {
      const filler = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: filler, vertical: slug });
      await host.admin.activateScope(staff, t, filler);
    }
    const late = await legacyPreview('legacy-late', v1, 'late-row');
    const first = await pass();
    expect(first.repaired).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await pass({ cursor: first.nextCursor! });
    expect(second.repaired.map((r) => r.scopeId)).toEqual([late.scopeId]);
    expect(second.nextCursor).toBeNull();
    expect((await recordOf(late.scopeId)).servingRef ?? null).toBeNull();
  }, 120_000);
});
