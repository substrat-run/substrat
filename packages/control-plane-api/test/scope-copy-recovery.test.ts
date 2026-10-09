import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  CARRIED_AWAY_KEY, COPY_RESTORE_FENCE_LAPSED, SCOPE_COPY_LEASE_MS, carriedAwayDump, copyRestoreFenceLapsed, dumpMetaValue, ulid,
  webCryptoSecretBox, type CopyRestoreFence, type LoadMarker,
} from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import {
  ControlPlaneError,
  createControlPlaneApi,
  settleExpiredScopeScriptCopies,
  sweepScopeScriptCopies,
  reapScopeScriptCopies,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  type VerticalClient,
} from '../src/index.js';

/**
 * Crash recovery for the copy ledger (#1722), on the pure adapter. A carry records both ends of
 * its move, leased to it, before it restores anything; this suite kills one at the two points
 * that leave a pending move behind (after recording, before the restore; after the restore,
 * before the bind) by never letting it continue. Erasure and reap must then answer retry-later,
 * not finalize over a copy nobody would reach again; the sweep, once the lease has run out,
 * settles the move; and both then succeed. The workerd twin is in adapter-cloudflare
 * `preview-carry.test.ts`.
 *
 * Each fake deployment fences the way a real one does: a restore that expects a marker is
 * refused when the store moved, and a wipe runs only on the load stamp it expects.
 */
describe('a crashed carry is settled by the copy-ledger sweep (#1722)', () => {
  const staff = platformActorId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const t = tenantId.parse(ulid());
  const slug = 'crash-vert';

  type Store = { tables: ScopeDumpTable[]; loadStamp: string | null; revision: string | null };
  type Hook = (ref: string, sid: string) => Promise<void>;
  const hooks: { restore?: Hook; marker?: Hook; read?: Hook; slugResolved?: Hook } = {};
  let failRestoreInto: string | null = null;
  /** Scripts built before `/internal/delete-scope`: their delete answers 501. */
  const noDeleteVerb = new Set<string>();
  const scripts = new Map<string, Map<string, Store>>();
  const redacted: string[] = [];
  const storesOf = (ref: string) => {
    if (!scripts.has(ref)) scripts.set(ref, new Map());
    return scripts.get(ref)!;
  };
  const storeOf = (ref: string, sid: string): Store =>
    storesOf(ref).get(sid) ?? { tables: [], loadStamp: null, revision: null };
  const deployment = (ref: string): VerticalClient =>
    ({
      exportScope: async (sid: string) => storeOf(ref, sid).tables,
      exportScopeStamped: async (sid: string) => storeOf(ref, sid),
      loadMarker: async (sid: string): Promise<LoadMarker> => {
        await hooks.marker?.(ref, sid);
        const { loadStamp, revision } = storeOf(ref, sid);
        return { loadStamp, revision };
      },
      restoreScope: async (_t: string, sid: string, tables: ScopeDumpTable[],
        opts?: { loadStamp?: string; expect?: LoadMarker; fence?: CopyRestoreFence }) => {
        await hooks.restore?.(ref, sid);
        if (failRestoreInto === ref) throw new ControlPlaneError(503, `storage blip in ${ref}`);
        // As the scope DO does, first in the load: the move's lease, against the store's clock.
        if (opts?.fence && copyRestoreFenceLapsed(opts.fence, Date.now())) {
          throw new ControlPlaneError(412, COPY_RESTORE_FENCE_LAPSED);
        }
        const now = storeOf(ref, sid);
        if (opts?.expect && (opts.expect.loadStamp !== now.loadStamp || opts.expect.revision !== now.revision)) {
          throw new ControlPlaneError(412, `store ${sid} in ${ref} moved since the carry read it`);
        }
        storesOf(ref).set(sid, { tables, loadStamp: opts?.loadStamp ?? ulid(), revision: null });
        return { tables: tables.length };
      },
      wipeCarriedCopy: async (input: { scopeId: string; expectLoadStamp: string | null; expectRevision?: string | null; carriedTo: string; at: string }) => {
        const now = storeOf(ref, input.scopeId);
        if (now.loadStamp !== input.expectLoadStamp ||
            (input.expectRevision !== undefined && now.revision !== input.expectRevision)) return { wiped: false };
        storesOf(ref).set(input.scopeId, { tables: carriedAwayDump({ to: input.carriedTo, at: input.at }), loadStamp: ulid(), revision: null });
        return { wiped: true };
      },
      readScopeTable: async (sid: string) => {
        await hooks.read?.(ref, sid);
        const meta = storeOf(ref, sid).tables.find((tb) => tb.name === '_substrat_meta');
        return { table: '_substrat_meta', columns: meta?.columns ?? ['key', 'value'], rows: meta?.rows ?? [] };
      },
      keptCopy: async () => null,
      // A fork inside one script: the vertical copies the store under the new id.
      snapshotScope: async (input: { sourceScopeId: string; newScopeId: string }) => {
        storesOf(ref).set(input.newScopeId, { ...storeOf(ref, input.sourceScopeId), loadStamp: ulid() });
        return { tables: storeOf(ref, input.sourceScopeId).tables.length };
      },
      deleteScope: async (input: { scopeId: string }) => {
        if (noDeleteVerb.has(ref)) throw new ControlPlaneError(501, `${ref} does not implement POST /internal/delete-scope`);
        storesOf(ref).delete(input.scopeId);
      },
      redactSubject: async (sid: string) => {
        redacted.push(`${ref} ${sid}`);
        return { events: 0, intents: 0, jobRuns: 0, idempotencyResults: 0, intentIds: [],
          vertical: { verticalRows: [], hookRows: [], unreachedEntities: [] } };
      },
    }) as unknown as VerticalClient;

  const refOf = new Map<string, string>();
  const versions: Record<'v1' | 'v2', string> = { v1: '', v2: '' };
  const notes = (...ids: string[]): ScopeDumpTable[] => [
    { name: 'notes', ddl: 'CREATE TABLE notes(id TEXT)', columns: ['id'], rows: ids.map((id) => [id]) },
  ];

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  /** The same control plane with a lease a test can outlive in real time. */
  let shortLease: ReturnType<typeof createControlPlaneApi>;
  /** The same control plane resolving a vertical by slug too, as the hosted one does: to its
   *  serving script (`resolveVerticalFor`). Set once the serving script exists. */
  let bySlug: ReturnType<typeof createControlPlaneApi>;
  const LEASE = 600;
  const cleanup = () => ({ admin: host.admin, actor: staff, resolveRef: async (ref: string) => deployment(ref) });
  const afterLease = () => new Date(Date.now() + SCOPE_COPY_LEASE_MS + 60_000);

  const push = (tag: string, v: 'v1' | 'v2', extra: object = {}) =>
    app.request(`/verticals/${slug}/previews`, {
      method: 'POST', headers: asStaff, body: JSON.stringify({ tag, versionId: versions[v], empty: true, ...extra }),
    });
  const fresh = async (tag: string) => {
    const res = await push(tag, 'v1', { ttlHours: null });
    expect(res.status, await res.clone().text()).toBe(201);
    const { scopeId: sid } = (await res.json()) as { scopeId: ScopeId };
    storesOf(refOf.get(versions.v1)!).set(sid, { tables: notes('kept'), loadStamp: ulid(), revision: '1' });
    return sid;
  };
  const shred = (sid: ScopeId, subject: string) =>
    app.request(`/tenants/${t}/scopes/${sid}/subjects/${subject}/shred`, { method: 'POST', headers: asStaff });
  const reap = (tag: string) => app.request(`/verticals/${slug}/previews/${tag}`, { method: 'DELETE', headers: asStaff });
  /** The carry's two entries, by version. The preview's own creation also ledgered v1, as the
   *  destination of its first restore, and is left out. */
  const ledgerOf = async (sid: ScopeId) =>
    Object.fromEntries((await host.admin.listScopeScriptCopies(staff, { tenantId: t, scopeId: sid }))
      .filter((copy) => !(copy.scriptRef === refOf.get(versions.v1) && copy.role === 'destination'))
      .map((copy) => [copy.scriptRef === refOf.get(versions.v1) ? 'v1' : 'v2', copy.state]));
  /** A carry that stops where `hook` matches and never continues: the crash. */
  const crashAt = (which: 'restore' | 'marker', ref: string, sid: ScopeId) => {
    let reached!: () => void;
    const at = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    hooks[which] = async (r, s) => {
      if (r !== ref || s !== sid) return;
      reached();
      await held;
    };
    return { at, release };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-copy-recovery-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(3)) });
    const options = {
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      platformBaseDomains: ['global.substrat.run'],
      provisionRetryDelaysMs: [1],
      resolveVerticalVersion: async (s: string, versionId: string) => {
        const ref = s === slug ? refOf.get(versionId) : undefined;
        return ref ? deployment(ref) : undefined;
      },
      resolveVerticalRef: async (ref: string) => deployment(ref),
    };
    app = createControlPlaneApi(options);
    shortLease = createControlPlaneApi({ ...options, copyLeaseMs: LEASE });
    bySlug = createControlPlaneApi({
      ...options,
      // As the hosted resolver: the vertical's serving script, read live.
      resolveVertical: async (s: string) => {
        if (s !== slug) return undefined;
        const ref = (await host.admin.verticalServing(staff, slug))?.ref;
        if (!ref) return undefined;
        await hooks.slugResolved?.(ref, '');
        return deployment(ref);
      },
    });
    await host.admin.createTenant(staff, { id: t, slug: 'crash-co', name: 'Crash Co' });
    await host.admin.registerVertical(staff, { slug, name: 'Crash Vert', source: 'cli', ownerTenant: t });
    for (const v of ['v1', 'v2'] as const) {
      const id = ulid();
      const ref = `${slug}-${id.toLowerCase()}`;
      await host.admin.publishVersion(staff, {
        id, verticalSlug: slug, version: v === 'v1' ? '1.0.0' : '1.0.1', manifestDigest: `m-${v}`,
        permissionDigest: 'p', migrationDigest: 'g', deploymentRef: ref,
      });
      refOf.set(id, ref);
      versions[v] = id;
    }
  });

  afterEach(() => {
    delete hooks.restore;
    delete hooks.marker;
    delete hooks.read;
    delete hooks.slugResolved;
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('crash after the move is recorded and before the restore: retry-later, swept, then erasure and reap land', async () => {
    const sid = await fresh('crash-before-restore');
    const subject = ulid();
    const [sealed] = await host.admin.sealSubjectPayloads(staff, t, sid, [{ subjectId: subject, plaintext: 'private' }]);
    const crash = crashAt('restore', refOf.get(versions.v2)!, sid);
    void push('crash-before-restore', 'v2'); // never resumes
    await crash.at;
    expect(await ledgerOf(sid)).toEqual({ v1: 'pending', v2: 'pending' });

    expect((await shred(sid, subject)).status).toBe(412);
    expect(await host.admin.openSubjectPayloads(staff, t, sid, [{ subjectId: subject, sealed: sealed! }])).toEqual(['private']);
    expect((await reap('crash-before-restore')).status).toBe(412);
    expect(await host.admin.getScopeRecord(staff, t, sid)).toBeDefined();

    // Inside the lease the move still owns its entries: the sweep takes nothing.
    expect(await settleExpiredScopeScriptCopies(cleanup())).toEqual({ claimed: 0, settled: 0, failed: 0 });
    expect(await ledgerOf(sid)).toEqual({ v1: 'pending', v2: 'pending' });

    const swept = await settleExpiredScopeScriptCopies(cleanup(), { now: afterLease() });
    expect(swept.failed).toBe(0);
    // The source is still the route; the destination never received this move's restore, and a
    // move that is slow rather than dead could still deliver it, so its entry stays reachable.
    expect(await ledgerOf(sid)).toEqual({ v1: 'done', v2: 'retained' });
    expect(await settleExpiredScopeScriptCopies(cleanup(), { now: afterLease() })).toEqual({ claimed: 0, settled: 0, failed: 0 });

    redacted.length = 0;
    expect((await shred(sid, subject)).status).toBe(200);
    expect(redacted.sort()).toEqual([`${refOf.get(versions.v1)} ${sid}`, `${refOf.get(versions.v2)} ${sid}`].sort());
    expect(await host.admin.openSubjectPayloads(staff, t, sid, [{ subjectId: subject, sealed: sealed! }])).toEqual([null]);
    expect((await reap('crash-before-restore')).status).toBe(200);
    expect(await host.admin.getScopeRecord(staff, t, sid)).toBeUndefined();
    expect(storesOf(refOf.get(versions.v1)!).has(sid)).toBe(false);
    expect(storesOf(refOf.get(versions.v2)!).has(sid)).toBe(false);
  });

  it('crash after the restore and before the bind: the sweep wipes the unbound copy, and the late bind loses', async () => {
    const sid = await fresh('crash-before-bind');
    const subject = ulid();
    const [sealed] = await host.admin.sealSubjectPayloads(staff, t, sid, [{ subjectId: subject, plaintext: 'private' }]);
    // The source's marker is read again right before the bind: the carry stops there.
    const crash = crashAt('marker', refOf.get(versions.v1)!, sid);
    const moving = push('crash-before-bind', 'v2');
    await crash.at;
    expect(storeOf(refOf.get(versions.v2)!, sid).tables).toEqual(notes('kept'));
    expect(await ledgerOf(sid)).toEqual({ v1: 'pending', v2: 'pending' });

    expect((await shred(sid, subject)).status).toBe(412);
    expect((await reap('crash-before-bind')).status).toBe(412);

    const swept = await settleExpiredScopeScriptCopies(cleanup(), { now: afterLease() });
    expect(swept.failed).toBe(0);
    expect(await ledgerOf(sid)).toEqual({ v1: 'done', v2: 'done' });
    expect(dumpMetaValue(storeOf(refOf.get(versions.v2)!, sid).tables, CARRIED_AWAY_KEY)).not.toBeNull();

    // The carry was only slow. It now reaches its bind, which its lease no longer covers: the
    // bind is refused, the route stays on the source, and the data is where it always was.
    crash.release();
    expect((await moving).status).toBe(412);
    const scope = (await host.admin.getScopeRecord(staff, t, sid))!;
    expect(scope.verticalVersionId).toBe(versions.v1);
    expect(storeOf(refOf.get(versions.v1)!, sid).tables).toEqual(notes('kept'));
    expect(await ledgerOf(sid)).toEqual({ v1: 'done', v2: 'done' });

    expect((await shred(sid, subject)).status).toBe(200);
    expect(await host.admin.openSubjectPayloads(staff, t, sid, [{ subjectId: subject, sealed: sealed! }])).toEqual([null]);
    expect((await reap('crash-before-bind')).status).toBe(200);
    expect(await host.admin.getScopeRecord(staff, t, sid)).toBeUndefined();
  });

  it('a carry inside its lease confirms with its bind and leaves the sweep nothing', async () => {
    const sid = await fresh('live-carry');
    const pushed = await push('live-carry', 'v2');
    expect(pushed.status, await pushed.clone().text()).toBe(200);
    expect(await ledgerOf(sid)).toEqual({ v1: 'done', v2: 'done' });
    expect(dumpMetaValue(storeOf(refOf.get(versions.v1)!, sid).tables, CARRIED_AWAY_KEY)).not.toBeNull();
    expect(storeOf(refOf.get(versions.v2)!, sid).tables).toEqual(notes('kept'));
    const swept = await settleExpiredScopeScriptCopies(cleanup(), { now: afterLease() });
    expect(swept.claimed).toBe(0);
  });

  // The destination restore carries the move's lease and refuses itself past it (#1722), so a
  // carry that is slow rather than dead cannot land a copy after the sweep, reap or erasure that
  // waited for its lease.
  const pushShort = (tag: string) => shortLease.request(`/verticals/${slug}/previews`, {
    method: 'POST', headers: asStaff, body: JSON.stringify({ tag, versionId: versions.v2, empty: true }),
  });
  const outlive = () => new Promise((resolve) => setTimeout(resolve, LEASE + 100));

  it('a restore that resumes after its lease ran out is refused and writes nothing', async () => {
    const sid = await fresh('fence-lapsed');
    const crash = crashAt('restore', refOf.get(versions.v2)!, sid);
    const moving = pushShort('fence-lapsed');
    await crash.at;
    await outlive();
    crash.release();
    const refused = await moving;
    expect(refused.status).toBe(412);
    expect(await refused.text()).toContain('lease ran out');
    expect(storesOf(refOf.get(versions.v2)!).has(sid)).toBe(false);
    expect(storeOf(refOf.get(versions.v1)!, sid).tables).toEqual(notes('kept'));
    expect((await host.admin.getScopeRecord(staff, t, sid))!.verticalVersionId).toBe(versions.v1);
  });

  it('a restore that resumes after the scope was reaped is refused and writes nothing', async () => {
    const sid = await fresh('fence-reaped');
    const crash = crashAt('restore', refOf.get(versions.v2)!, sid);
    const moving = pushShort('fence-reaped');
    await crash.at;
    await outlive();
    expect((await settleExpiredScopeScriptCopies(cleanup())).failed).toBe(0);
    expect((await reap('fence-reaped')).status).toBe(200);
    expect(await host.admin.getScopeRecord(staff, t, sid)).toBeUndefined();
    crash.release();
    expect((await moving).status).toBe(412);
    expect(storesOf(refOf.get(versions.v1)!).has(sid)).toBe(false);
    expect(storesOf(refOf.get(versions.v2)!).has(sid)).toBe(false);
  });

  it('a restore inside its lease lands', async () => {
    const sid = await fresh('fence-live');
    const pushed = await pushShort('fence-live');
    expect(pushed.status, await pushed.clone().text()).toBe(200);
    expect(storeOf(refOf.get(versions.v2)!, sid).tables).toEqual(notes('kept'));
  });

  // The decided adopt/rebind policy (#1722): once the move is confirmed, the old copy is not a
  // backout. It is eligible, and the sweep wipes it under the same fence as a carry's source:
  // a copy that took a write since the export is kept for staff, never deleted. A move that
  // fails keeps its source. Rollback is an explicit snapshot taken before the move.
  const install = async () => {
    const sid = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: sid, vertical: slug });
    await host.admin.activateScope(staff, t, sid);
    await host.admin.bindScopeVersion(staff, t, sid, versions.v1);
    // A legacy install: routed by its version's own script, not born on the serving one.
    await host.admin.setScopeServingRef(staff, t, sid, null);
    storesOf(refOf.get(versions.v1)!).set(sid, { tables: notes('kept'), loadStamp: ulid(), revision: '1' });
    return sid;
  };
  const SERVING = `${slug}-serving`;
  const TARGET = 'crash-dst';
  const TARGET_SERVING = `${TARGET}-serving`;
  const ledgerByRef = async (sid: ScopeId) =>
    Object.fromEntries((await host.admin.listScopeScriptCopies(staff, { tenantId: t, scopeId: sid }))
      .map((copy) => [copy.scriptRef, copy.state]));
  const wiped = (ref: string, sid: ScopeId) => dumpMetaValue(storeOf(ref, sid).tables, CARRIED_AWAY_KEY) !== null;
  const servingOnce = (() => {
    let done: Promise<void> | undefined;
    return () => (done ??= (async () => {
      await host.admin.setVerticalServing(staff, slug, { ref: SERVING, versionId: versions.v2, doClasses: [], migrationTag: 't1' });
      await host.admin.registerVertical(staff, { slug: TARGET, name: 'Crash Dst', source: 'cli', ownerTenant: t });
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id, verticalSlug: TARGET, version: '1.0.0', manifestDigest: 'm-dst', permissionDigest: 'p', migrationDigest: 'g',
        deploymentRef: `${TARGET}-${id.toLowerCase()}`,
      });
      await host.admin.setVerticalServing(staff, TARGET, { ref: TARGET_SERVING, versionId: id, doClasses: [], migrationTag: 't1' });
    })());
  })();

  for (const [move, to, call] of [
    ['adopt', SERVING, (sid: ScopeId) => app.request(`/tenants/${t}/scopes/${sid}/adopt-serving`, { method: 'POST', headers: asStaff })],
    ['rebind', TARGET_SERVING, (sid: ScopeId) => app.request(`/tenants/${t}/scopes/${sid}/rebind-vertical`, {
      method: 'POST', headers: asStaff, body: JSON.stringify({ vertical: TARGET }),
    })],
  ] as const) {
    it(`a confirmed ${move} leaves the old copy eligible, and the sweep wipes it`, async () => {
      await servingOnce();
      const sid = await install();
      const from = refOf.get(versions.v1)!;
      const res = await call(sid);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await ledgerByRef(sid)).toEqual({ [from]: 'eligible', [to]: 'done' });
      expect(storeOf(from, sid).tables).toEqual(notes('kept')); // nothing is wiped before the sweep
      await sweepScopeScriptCopies(cleanup());
      expect(await ledgerByRef(sid)).toEqual({ [from]: 'done', [to]: 'done' });
      expect(wiped(from, sid)).toBe(true);
      expect(storeOf(to, sid).tables).toEqual(notes('kept'));
      // Erasure as before: the route, and nothing the ledger has settled.
      redacted.length = 0;
      expect((await shred(sid, ulid())).status).toBe(200);
      expect(redacted).toEqual([`${to} ${sid}`]);
    });

    it(`a ${move} whose old copy took a write after the export keeps it for staff`, async () => {
      await servingOnce();
      const sid = await install();
      const from = refOf.get(versions.v1)!;
      expect((await call(sid)).status).toBe(200);
      const before = storeOf(from, sid);
      storesOf(from).set(sid, { ...before, tables: notes('kept', 'late write'), revision: '2' });
      await sweepScopeScriptCopies(cleanup());
      expect((await ledgerByRef(sid))[from]).toBe('kept');
      expect(storeOf(from, sid).tables).toEqual(notes('kept', 'late write'));
    });

    it(`a ${move} that fails keeps its source, and the sweep leaves it`, async () => {
      await servingOnce();
      const sid = await install();
      const from = refOf.get(versions.v1)!;
      failRestoreInto = to;
      try {
        expect((await call(sid)).status).toBeGreaterThanOrEqual(500);
      } finally {
        failRestoreInto = null;
      }
      expect(await ledgerByRef(sid)).toEqual({ [from]: 'retained', [to]: 'retained' });
      expect((await host.admin.getScopeRecord(staff, t, sid))!.servingRef ?? null).toBeNull();
      await sweepScopeScriptCopies(cleanup());
      expect(await ledgerByRef(sid)).toEqual({ [from]: 'retained', [to]: 'retained' });
      expect(storeOf(from, sid).tables).toEqual(notes('kept'));
    });
  }

  // A fork writes a copy into a script before anything routes the new scope there: the preview's
  // restore into the PR version's script, a snapshot's copy inside its source's script. Both are
  // in the ledger before the write (#1722), so a bind that fails afterwards (or a request that
  // dies there) leaves a copy that reap and erasure still reach, not an orphan of the source's
  // data. Each test fails the fork's bind once.
  const failNextBind = () => vi.spyOn(host.admin, 'bindScopeVersion')
    .mockRejectedValueOnce(new ControlPlaneError(503, 'directory unavailable'));
  const forkedPreview = async (tag: string) => {
    await servingOnce();
    const prod = await install();
    // A preview URL derives from its source's hostname.
    await host.admin.bindHostname(staff, {
      hostname: `${tag}-acme.global.substrat.run`, tenantId: t, scopeId: prod, surface: 'app', region: null, canonical: true,
    });
    const bind = failNextBind();
    try {
      const res = await app.request(`/verticals/${slug}/previews`, {
        method: 'POST', headers: asStaff, body: JSON.stringify({ tag, versionId: versions.v2, sourceScopeId: prod, ttlHours: null }),
      });
      expect(res.status, await res.clone().text()).toBeGreaterThanOrEqual(500);
    } finally {
      bind.mockRestore();
    }
    const preview = (await host.admin.listScopes(staff, { tenantId: t })).find((sc) => sc.forkedFrom === prod)!;
    expect(storeOf(refOf.get(versions.v2)!, preview.id).tables).toEqual(notes('kept'));
    return { prod, preview: preview.id };
  };
  const forkedSnapshot = async () => {
    await servingOnce();
    const prod = await install();
    const bind = failNextBind();
    try {
      const res = await app.request(`/tenants/${t}/scopes/${prod}/snapshots`, { method: 'POST', headers: asStaff, body: '{}' });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      bind.mockRestore();
    }
    const snap = (await host.admin.listScopes(staff, { tenantId: t })).find((sc) => sc.forkedFrom === prod)!;
    expect(storeOf(refOf.get(versions.v1)!, snap.id).tables).toEqual(notes('kept'));
    return { prod, snap: snap.id };
  };

  it('a preview fork whose bind failed is still reaped from the script it was restored into', async () => {
    const { preview } = await forkedPreview('fork-reap');
    expect((await reap('fork-reap')).status).toBe(200);
    expect(await host.admin.getScopeRecord(staff, t, preview)).toBeUndefined();
    expect(storesOf(refOf.get(versions.v2)!).has(preview)).toBe(false);
  });

  it('a preview fork whose bind failed is still reached by erasure', async () => {
    const { preview } = await forkedPreview('fork-erase');
    redacted.length = 0;
    expect((await shred(preview, ulid())).status).toBe(200);
    expect(redacted).toContain(`${refOf.get(versions.v2)} ${preview}`);
  });

  it('a snapshot fork whose bind failed is still reaped from the script it was copied into', async () => {
    const { snap } = await forkedSnapshot();
    expect((await app.request(`/tenants/${t}/scopes/${snap}`, { method: 'DELETE', headers: asStaff })).status).toBe(200);
    expect(await host.admin.getScopeRecord(staff, t, snap)).toBeUndefined();
    expect(storesOf(refOf.get(versions.v1)!).has(snap)).toBe(false);
  });

  it('a snapshot fork whose bind failed is still reached by erasure', async () => {
    const { snap } = await forkedSnapshot();
    redacted.length = 0;
    expect((await shred(snap, ulid())).status).toBe(200);
    expect(redacted).toContain(`${refOf.get(versions.v1)} ${snap}`);
  });

  it('a fork whose bind lands is confirmed with it, and its entry is done', async () => {
    await servingOnce();
    const prod = await install();
    await host.admin.bindHostname(staff, {
      hostname: 'fork-ok-acme.global.substrat.run', tenantId: t, scopeId: prod, surface: 'app', region: null, canonical: true,
    });
    const res = await app.request(`/verticals/${slug}/previews`, {
      method: 'POST', headers: asStaff, body: JSON.stringify({ tag: 'fork-ok', versionId: versions.v2, sourceScopeId: prod, ttlHours: null }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { scopeId: preview } = (await res.json()) as { scopeId: ScopeId };
    expect(await ledgerByRef(preview)).toEqual({ [refOf.get(versions.v2)!]: 'done' });
    const snap = await app.request(`/tenants/${t}/scopes/${prod}/snapshots`, { method: 'POST', headers: asStaff, body: '{}' });
    expect(snap.status).toBe(201);
    const { id: snapId } = (await snap.json()) as { id: ScopeId };
    expect(await ledgerByRef(snapId)).toEqual({ [refOf.get(versions.v1)!]: 'done' });
  });

  // Review r1: the carry's bind confirms its source `retained`; the tail promotes it to
  // `eligible` only after checking the destination was not overtaken, so a sweep in between
  // cannot wipe the one copy a re-carry would need.
  it('a sweep between the bind and the overtaken-destination check leaves the source alone', async () => {
    const sid = await fresh('sweep-before-check');
    const from = refOf.get(versions.v1)!;
    let reached!: () => void;
    const at = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    hooks.read = async (ref, s) => {
      if (ref !== refOf.get(versions.v2) || s !== sid) return;
      reached();
      await held;
    };
    const moving = push('sweep-before-check', 'v2');
    await at;
    expect((await ledgerOf(sid)).v1).toBe('retained');
    await sweepScopeScriptCopies(cleanup());
    expect(storeOf(from, sid).tables).toEqual(notes('kept'));
    release();
    expect((await moving).status).toBe(200);
    expect(await ledgerOf(sid)).toEqual({ v1: 'done', v2: 'done' });
    expect(wiped(from, sid)).toBe(true);
  });

  // Review r1: every reap drains the ledger when the platform can resolve scripts by ref, even
  // for a scope nothing routes (a fork whose bind never landed), as the preview and GC reaps do.
  it('the scope reap route drains a copy the ledger names though the scope has no route', async () => {
    const prod = await install();
    const fork = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: fork, vertical: slug, forkedFrom: prod, kind: 'archive' });
    await host.admin.setScopeServingRef(staff, t, fork, null);
    const ref = refOf.get(versions.v1)!;
    const move = ulid();
    await host.admin.recordScopeScriptCopy(staff, t, fork, ref, move, { role: 'destination' });
    await host.admin.settleScopeScriptCopy(staff, t, fork, ref, move, 'retained');
    storesOf(ref).set(fork, { tables: notes('forked'), loadStamp: ulid(), revision: '1' });
    const record = (await host.admin.getScopeRecord(staff, t, fork))!;
    expect([record.servingRef ?? null, record.verticalVersionId ?? null]).toEqual([null, null]);
    expect((await app.request(`/tenants/${t}/scopes/${fork}`, { method: 'DELETE', headers: asStaff })).status).toBe(200);
    expect(await host.admin.getScopeRecord(staff, t, fork)).toBeUndefined();
    expect(storesOf(ref).has(fork)).toBe(false);
  });

  // Review r2: a scope nothing routes (no pin, no bound version) keeps its store where its vertical
  // resolves by slug. With per-script resolution wired, reap and erasure must still reach it, and a
  // script that predates the delete verb strands its bytes (200 + storageStranded), never 501s.
  const unrouted = async (opts: { fork?: boolean; archived?: boolean } = {}) => {
    await servingOnce();
    const prod = await install();
    const sid = scopeId.parse(ulid());
    await host.provisionScope(staff, {
      tenantId: t, scopeId: sid, vertical: slug, ...(opts.fork ? { forkedFrom: prod, kind: 'archive' } : {}),
    });
    await host.admin.activateScope(staff, t, sid);
    await host.admin.setScopeServingRef(staff, t, sid, null);
    if (opts.archived) await host.admin.archiveScope(staff, t, sid);
    storesOf(SERVING).set(sid, { tables: notes('unrouted'), loadStamp: ulid(), revision: '1' });
    const record = (await host.admin.getScopeRecord(staff, t, sid))!;
    expect([record.servingRef ?? null, record.verticalVersionId ?? null]).toEqual([null, null]);
    return { prod, sid };
  };

  it('deleting an unrouted fork removes its store where the vertical resolves by slug', async () => {
    const { sid } = await unrouted({ fork: true });
    const res = await bySlug.request(`/tenants/${t}/scopes/${sid}`, { method: 'DELETE', headers: asStaff });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).not.toHaveProperty('storageStranded');
    expect(storesOf(SERVING).has(sid)).toBe(false);
  });

  it('reaping an unrouted archived scope removes its store where the vertical resolves by slug', async () => {
    const { sid } = await unrouted({ archived: true });
    const res = await bySlug.request(`/tenants/${t}/scopes/${sid}/reap`, {
      method: 'POST', headers: asStaff, body: JSON.stringify({ backup: false }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(storesOf(SERVING).has(sid)).toBe(false);
  });

  it('erasure of an unrouted scope reaches its store where the vertical resolves by slug', async () => {
    const { sid } = await unrouted();
    redacted.length = 0;
    expect((await bySlug.request(`/tenants/${t}/scopes/${sid}/subjects/${ulid()}/shred`, { method: 'POST', headers: asStaff })).status)
      .toBe(200);
    expect(redacted).toEqual([`${SERVING} ${sid}`]);
  });

  it('a snapshot of an unrouted scope ledgers the slug-resolved script it lands in', async () => {
    const { sid } = await unrouted();
    const res = await bySlug.request(`/tenants/${t}/scopes/${sid}/snapshots`, { method: 'POST', headers: asStaff, body: '{}' });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id: snap } = (await res.json()) as { id: ScopeId };
    expect(storeOf(SERVING, snap).tables).toEqual(notes('unrouted'));
    // Routed onto the script its copy landed in, by the write that confirmed the move.
    expect(await ledgerByRef(snap)).toEqual({ [SERVING]: 'done' });
    expect((await host.admin.getScopeRecord(staff, t, snap))?.servingRef).toBe(SERVING);
    expect((await bySlug.request(`/tenants/${t}/scopes/${snap}`, { method: 'DELETE', headers: asStaff })).status).toBe(200);
    expect(storesOf(SERVING).has(snap)).toBe(false);
  });

  it('a script without the delete verb strands its bytes: 200 and storageStranded, by either reap route', async () => {
    const old = `${slug}-predates-delete`;
    noDeleteVerb.add(old);
    try {
      for (const route of ['delete', 'reap'] as const) {
        await servingOnce();
        const prod = await install();
        const sid = scopeId.parse(ulid());
        await host.provisionScope(staff, {
          tenantId: t, scopeId: sid, vertical: slug, ...(route === 'delete' ? { forkedFrom: prod, kind: 'archive' } : {}),
        });
        await host.admin.activateScope(staff, t, sid);
        await host.admin.setScopeServingRef(staff, t, sid, old);
        if (route === 'reap') await host.admin.archiveScope(staff, t, sid);
        storesOf(old).set(sid, { tables: notes('stranded'), loadStamp: ulid(), revision: '1' });
        const res = route === 'delete'
          ? await bySlug.request(`/tenants/${t}/scopes/${sid}`, { method: 'DELETE', headers: asStaff })
          : await bySlug.request(`/tenants/${t}/scopes/${sid}/reap`, { method: 'POST', headers: asStaff, body: JSON.stringify({ backup: false }) });
        expect(res.status, await res.clone().text()).toBe(200);
        expect(await res.json()).toMatchObject({ storageStranded: true });
      }
    } finally {
      noDeleteVerb.delete(old);
    }
  });

  // Review r3: the slug-resolved script is resolved once, and the copy goes through that ref, so a
  // serving move between the resolution and the ledger read cannot split the bytes from the entry.
  it('a snapshot taken while the serving script moves is ledgered, routed and reaped where its bytes land', async () => {
    const { sid } = await unrouted();
    const moved = `${slug}-serving-next`;
    storesOf(moved).set(sid, { tables: notes('unrouted'), loadStamp: ulid(), revision: '1' });
    hooks.slugResolved = async () => {
      delete hooks.slugResolved; // once: the serving script moves right after the first resolution
      await host.admin.setVerticalServing(staff, slug, { ref: moved, versionId: versions.v2, doClasses: [], migrationTag: 't2' });
    };
    try {
      const res = await bySlug.request(`/tenants/${t}/scopes/${sid}/snapshots`, { method: 'POST', headers: asStaff, body: '{}' });
      expect(res.status, await res.clone().text()).toBe(201);
      const { id: snap } = (await res.json()) as { id: ScopeId };
      const landed = [SERVING, moved].filter((ref) => storesOf(ref).has(snap));
      expect(landed).toHaveLength(1);
      const [where] = landed;
      expect(await ledgerByRef(snap)).toEqual({ [where!]: 'done' });
      expect((await host.admin.getScopeRecord(staff, t, snap))?.servingRef).toBe(where);
      redacted.length = 0;
      expect((await bySlug.request(`/tenants/${t}/scopes/${snap}/subjects/${ulid()}/shred`, { method: 'POST', headers: asStaff })).status)
        .toBe(200);
      expect(redacted).toContain(`${where} ${snap}`);
      expect((await bySlug.request(`/tenants/${t}/scopes/${snap}`, { method: 'DELETE', headers: asStaff })).status).toBe(200);
      expect(storesOf(where!).has(snap)).toBe(false);
    } finally {
      await host.admin.setVerticalServing(staff, slug, { ref: SERVING, versionId: versions.v2, doClasses: [], migrationTag: 't1' });
    }
  });

  // Review r3: a 501 strands bytes for every reap caller, so the reap itself records it.
  it('a reap that strands storage records it for every caller, the preview reap and the GC sweep included', async () => {
    const old = `${slug}-predates-delete`;
    noDeleteVerb.add(old);
    try {
      // The preview reap answers the flag.
      const sid = await fresh('stranded-preview');
      await host.admin.setScopeServingRef(staff, t, sid, old);
      const res = await app.request(`/verticals/${slug}/previews/stranded-preview`, { method: 'DELETE', headers: asStaff });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toMatchObject({ deleted: sid, storageStranded: true });
      // The GC sweep's reaps call reapScopeScriptCopies directly and drop the row after it: the
      // record is written inside it, before the row goes.
      const gc = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: gc, vertical: slug });
      await host.admin.setScopeServingRef(staff, t, gc, old);
      expect(await reapScopeScriptCopies(cleanup(), t, gc)).toEqual({ storageStranded: true });
      for (const reaped of [sid, gc]) {
        const failures = await host.admin.listOpsFailures(staff, { scopeId: reaped });
        expect(failures.filter((f) => f.stage === 'storage-stranded').map((f) => ({ operation: f.operation, status: f.status })))
          .toEqual([{ operation: 'scope.reap', status: 501 }]);
      }
      // A reap that strands nothing records nothing.
      const clean = await fresh('clean-preview');
      expect((await app.request(`/verticals/${slug}/previews/clean-preview`, { method: 'DELETE', headers: asStaff })).status).toBe(200);
      expect((await host.admin.listOpsFailures(staff, { scopeId: clean })).filter((f) => f.stage === 'storage-stranded')).toEqual([]);
    } finally {
      noDeleteVerb.delete(old);
    }
  });

  // Review r4: a fork of a bound source routes by its bound version, not by a pin to that
  // version's script, so binding the fork onward carries its data like any other scope's.
  it('a snapshot of a bound source routes by its version, and a later bind carries its data', async () => {
    await servingOnce();
    const prod = await install();
    const res = await app.request(`/tenants/${t}/scopes/${prod}/snapshots`, { method: 'POST', headers: asStaff, body: '{}' });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id: snap } = (await res.json()) as { id: ScopeId };
    const before = (await host.admin.getScopeRecord(staff, t, snap))!;
    expect([before.servingRef ?? null, before.verticalVersionId]).toEqual([null, versions.v1]);
    expect(await ledgerByRef(snap)).toEqual({ [refOf.get(versions.v1)!]: 'done' });
    const bound = await app.request(`/tenants/${t}/scopes/${snap}/version`, {
      method: 'POST', headers: asStaff, body: JSON.stringify({ versionId: versions.v2 }),
    });
    expect(bound.status, await bound.clone().text()).toBe(200);
    const after = (await host.admin.getScopeRecord(staff, t, snap))!;
    expect([after.servingRef ?? null, after.verticalVersionId]).toEqual([null, versions.v2]);
    expect(storeOf(refOf.get(versions.v2)!, snap).tables).toEqual(notes('kept'));
  });

  // Review r4: the reap routes' slug fallback records the storage it strands, as the ledger reap does.
  it('the slug fallback records what it strands, by either reap route', async () => {
    noDeleteVerb.add(SERVING);
    try {
      for (const route of ['delete', 'reap'] as const) {
        const { sid } = await unrouted(route === 'delete' ? { fork: true } : { archived: true });
        const res = route === 'delete'
          ? await bySlug.request(`/tenants/${t}/scopes/${sid}`, { method: 'DELETE', headers: asStaff })
          : await bySlug.request(`/tenants/${t}/scopes/${sid}/reap`, { method: 'POST', headers: asStaff, body: JSON.stringify({ backup: false }) });
        expect(res.status, await res.clone().text()).toBe(200);
        expect(await res.json()).toMatchObject({ storageStranded: true });
        const stranded = (await host.admin.listOpsFailures(staff, { scopeId: sid })).filter((f) => f.stage === 'storage-stranded');
        expect(stranded.map((f) => ({ operation: f.operation, status: f.status }))).toEqual([{ operation: 'scope.reap', status: 501 }]);
      }
    } finally {
      noDeleteVerb.delete(SERVING);
    }
  });
});
