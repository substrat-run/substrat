import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { errorCodeOf, platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId, type ScopeLineage, type TenantId } from '@substrat-run/contracts';
import { CARRIED_AWAY_KEY, LOAD_STAMP_KEY, WRITE_REVISION_KEY, dumpMetaValue, ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import {
  ControlPlaneError,
  createControlPlaneApi,
  retryScopeScriptCopies,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  stableDeploymentRefFor,
  type VerticalClient,
} from '@substrat-run/control-plane-api';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1710 on workerd. A hosted vertical's versions are separate scripts, and a Durable Object
 * namespace belongs to its script. So when a push re-points a preview at a new version,
 * the preview's data stays behind unless something moves it. That is a Cloudflare fact,
 * which node's one-database world cannot show. Here each version is its own DO class
 * (`PreviewV{1,2,3}ScopeDO`, identical code, three namespaces), the control-plane API runs
 * over a real `CloudflareScopeHost` directory, and "what the preview serves" is read the
 * way the router reads it: resolve the hostname to a script, then read the scope there.
 *
 * Each version's client calls the same host methods a vertical's `/internal/export`,
 * `/internal/restore`, `/internal/snapshot` and `/internal/delete-scope` routes call
 * (vertical-host), and turns a throw into the `ControlPlaneError` the HTTP hop would.
 */
describe('a preview keeps its data across pushes, on real Durable Object namespaces (#1710)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const slug = 'carry-vert';
  const prod = scopeId.parse(ulid());
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };

  let dir: CloudflareScopeHost;
  let api: ReturnType<typeof createControlPlaneApi>;
  const version: Record<'v1' | 'v2' | 'v3', string> = { v1: '', v2: '', v3: '' };
  const refOf = new Map<string, string>(); // versionId → its script
  const hostOf = new Map<string, CloudflareScopeHost>(); // script → its namespace
  // Makes v3's restore fail INSIDE the DO's transaction, after its drops: the dump gains a
  // table whose schema the DO refuses, so the import throws and SQLite rolls it all back.
  let sabotageV3 = false;
  // #1722: the scripts built before the fenced wipe (`/internal/wipe-carried` answers 404 there),
  // and hooks that hold one request at a chosen step so a test can interleave two of them.
  const unfenced = new Set<string>();
  type Hook = (ref: string, sid: ScopeId, tables?: ScopeDumpTable[]) => Promise<void>;
  // `marker` runs before a `loadMarker` read and `markerRead` after it: a carry reads the
  // destination's marker after its export, and the source's again right before its bind (r12).
  const hooks: {
    export?: Hook; marker?: Hook; markerRead?: Hook; kept?: Hook; restore?: Hook; restored?: Hook; read?: Hook; wipe?: Hook; release?: Hook; redact?: Hook;
  } = {};

  const notes = (...bodies: string[]): ScopeDumpTable[] => [
    {
      name: 'pv_notes',
      ddl: 'CREATE TABLE pv_notes (id TEXT PRIMARY KEY, body TEXT)',
      columns: ['id', 'body'],
      rows: bodies.map((b, i) => [`n${i}`, b]),
    },
  ];
  const bodiesIn = (tables: ScopeDumpTable[]): unknown[] =>
    tables.find((tb) => tb.name === 'pv_notes')?.rows.map((r) => r[1]) ?? [];
  const hostFor = (v: keyof typeof version) => hostOf.get(refOf.get(version[v])!)!;

  const relay = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      // A refused precondition answers 412 and a conflict 409 over the real hop, as the vertical's
      // error envelope does.
      const code = errorCodeOf(e);
      const status = code === 'precondition_failed' ? 412 : code === 'conflict' ? 409 : 500;
      throw new ControlPlaneError(status, e instanceof Error ? e.message : String(e));
    }
  };
  const clientFor = (ref: string): VerticalClient => {
    const host = hostOf.get(ref)!;
    return {
      exportScope: (sid: ScopeId) => relay(() => host.exportScopeLocal(sid)),
      exportScopeStamped: (sid: ScopeId) =>
        relay(async () => {
          await hooks.export?.(ref, sid);
          if (!unfenced.has(ref)) return host.exportScopeStampedLocal(sid);
          return { tables: await host.exportScopeLocal(sid), loadStamp: null, revision: null };
        }),
      restoreScope: (
        _t: unknown,
        sid: ScopeId,
        tables: ScopeDumpTable[],
        opts?: {
          sourceScopeId?: ScopeId;
          exact?: boolean;
          loadStamp?: string;
          expect?: { loadStamp: string | null; revision: string | null };
          markCopy?: ScopeLineage;
        },
      ) =>
        relay(async () => {
          await hooks.restore?.(ref, sid, tables);
          const out = await host.restoreScopeLocal(
            sid,
            sabotageV3 && ref === refOf.get(version.v3)
              ? [...tables, { name: 'zz_bad', ddl: 'CREATE TABLE not_zz_bad (x TEXT)', columns: ['x'], rows: [] }]
              : tables,
            // A script that cannot fence keeps no stamp and takes no expectation: it predates both.
            {
              // As the vertical's `/internal/restore` forwards them: a carry names its own scope as
              // the source, which is what keeps it from reading as a copy of another scope (#2003).
              sourceScopeId: opts?.sourceScopeId,
              exact: opts?.exact,
              ...(unfenced.has(ref) ? {} : { loadStamp: opts?.loadStamp, expect: opts?.expect }),
              ...(opts?.markCopy ? { markCopy: opts.markCopy } : {}),
            },
          );
          await hooks.restored?.(ref, sid, tables);
          return out;
        }),
      keptCopy: async (sid: ScopeId) => {
        await hooks.kept?.(ref, sid);
        return unfenced.has(ref) ? null : relay(() => host.keptCopyLocal(sid));
      },
      releaseKeptCopy: (input: { scopeId: ScopeId; revision: string | null; markCopy?: ScopeLineage; loadStamp?: string | null }) =>
        relay(async () => {
          await hooks.release?.(ref, input.scopeId);
          return host.releaseKeptCopyLocal(input.scopeId, input.revision, input.markCopy, input.loadStamp);
        }),
      discardKeptCopy: (input: {
        scopeId: ScopeId; revision: string | null; carriedTo: string; at: string; markCopy?: ScopeLineage; loadStamp?: string | null;
      }) =>
        relay(() =>
          host.discardKeptCopyLocal(
            input.scopeId, input.revision, { to: input.carriedTo, at: input.at }, input.markCopy, input.loadStamp,
          ),
        ),
      loadMarker: async (sid: ScopeId) => {
        await hooks.marker?.(ref, sid);
        if (unfenced.has(ref)) return 'unfenced';
        const read = await relay(() => host.loadMarkerLocal(sid));
        await hooks.markerRead?.(ref, sid);
        return read;
      },
      readScopeTable: (sid: ScopeId, input: { table: string; limit: number; offset: number }) =>
        relay(async () => {
          await hooks.read?.(ref, sid);
          return host.introspectScopeTable(sid, input);
        }),
      wipeCarriedCopy: async (input: {
        scopeId: ScopeId;
        expectLoadStamp: string | null;
        expectRevision?: string | null;
        protectIfChanged?: boolean;
        carriedTo: string;
        at: string;
        markCopy?: ScopeLineage;
      }) =>
        unfenced.has(ref)
          ? 'unfenced'
          : relay(async () => {
              await hooks.wipe?.(ref, input.scopeId);
              return {
                wiped: await host.wipeCarriedLocal(input.scopeId, input.expectLoadStamp, { to: input.carriedTo, at: input.at }, input),
              };
            }),
      snapshotScope: (input: { sourceScopeId: ScopeId; newScopeId: ScopeId }) =>
        relay(() => host.snapshotScopeLocal(input.sourceScopeId, input.newScopeId)),
      deleteScope: (input: { scopeId: ScopeId }) => relay(() => host.deleteScopeLocal(input.scopeId)),
      redactSubject: (sid: ScopeId, subject: string) => relay(async () => {
        await hooks.redact?.(ref, sid);
        return host.redactSubjectLocal(sid, subject);
      }),
      clearCopyMark: (sid: ScopeId, lineage: ScopeLineage, opts: { expect?: { loadStamp: string | null; revision: string | null } } = {}) =>
        relay(() => host.clearCopyMarkLocal(sid, lineage, ...(opts.expect ? [opts.expect] : []))),
    } as unknown as VerticalClient;
  };

  /** What a request to `hostname` is served from: the router's resolution, then that script's scope. */
  const served = async (hostname: string): Promise<{ ref: string; bodies: unknown[] }> => {
    const route = await dir.admin.resolveHostname(hostname);
    expect(route?.deploymentRef).toBeTruthy();
    const ref = route!.deploymentRef!;
    return { ref, bodies: bodiesIn(await hostOf.get(ref)!.exportScopeLocal(route!.scopeId)) };
  };
  const push = async (tag: string, v: keyof typeof version, extra: object = {}) => {
    const res = await api.request(`/verticals/${slug}/previews`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tag, versionId: version[v], ...extra }),
    });
    return { status: res.status, body: (await res.json()) as { scopeId: ScopeId; hostname: string; error?: string } };
  };
  const bindTo = async (sid: ScopeId, v: keyof typeof version) => {
    const res = await api.request(`/tenants/${t}/scopes/${sid}/version`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ versionId: version[v] }),
    });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };
  /** The `carried_away` tombstone in `v`'s copy of a scope, or null when it holds none. */
  const tombstoneIn = async (v: keyof typeof version, sid: ScopeId) =>
    dumpMetaValue(await hostFor(v).exportScopeLocal(sid), CARRIED_AWAY_KEY);
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };
  /** Holds the FIRST call that matches, until `release`; `reached` says it is being held. */
  const holdFirst = (match: (ref: string, sid: ScopeId, tables?: ScopeDumpTable[]) => boolean) => {
    const reached = deferred();
    const release = deferred();
    let held = false;
    const hook: Hook = async (ref, sid, tables) => {
      if (held || !match(ref, sid, tables)) return;
      held = true;
      reached.resolve();
      await release.promise;
    };
    return { hook, reached: reached.promise, release: release.resolve };
  };

  beforeAll(async () => {
    await warmControlPlane(env.PC_CONTROL_PLANE);
    // The directory. Its own scope namespace is not any version's: a hosted control plane
    // serves no vertical's storage.
    dir = new CloudflareScopeHost({ scope: env.PC_SCOPE, controlPlane: env.PC_CONTROL_PLANE, secretBox });
    await dir.admin.createTenant(staff, { id: t, slug: `carry-${t.toLowerCase()}`, name: 'Carry Co' });
    // PRIVATE (owned, unlisted), so each push self-admits, as a builder's does.
    await dir.admin.registerVertical(staff, { slug, name: 'Carry Vert', source: 'cli', ownerTenant: t });
    const namespaces = { v1: env.PC_V1_SCOPE, v2: env.PC_V2_SCOPE, v3: env.PC_V3_SCOPE };
    for (const v of ['v1', 'v2', 'v3'] as const) {
      const id = ulid();
      const ref = `carry-vert-${id.toLowerCase()}`;
      await dir.admin.publishVersion(staff, {
        id, verticalSlug: slug, version: `1.0.${v.slice(1)}`,
        manifestDigest: `m-${v}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: ref,
        manifestJson: JSON.stringify({
          version: `1.0.${v.slice(1)}`, entry: 'worker.js', compatibilityDate: '2025-01-01',
          doClasses: ['ScopeDO'],
          bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
          digests: { manifest: `m-${v}`, permission: 'p', migration: 'g' },
          registry: { permissions: [], roles: [], entityGrants: [] },
        }),
      });
      version[v] = id;
      refOf.set(id, ref);
      hostOf.set(ref, new CloudflareScopeHost({ scope: namespaces[v], controlPlane: env.PC_CONTROL_PLANE, secretBox }));
    }
    api = createControlPlaneApi({
      host: dir,
      authenticate: UNSAFE_devPlatformActorAuth(),
      platformBaseDomains: ['global.substrat.run'],
      provisionRetryDelaysMs: [1],
      // Upload is a seam; directory, routing and all data transfers use real workerd DOs.
      deployVertical: async () => {},
      fetchVerticalModules: async () => [
        { name: 'worker.js', content: new Uint8Array([1]), contentType: 'application/javascript+module' },
      ],
      resolveVerticalVersion: async (s, versionId) => {
        const ref = s === slug ? refOf.get(versionId) : undefined;
        return ref ? clientFor(ref) : undefined;
      },
      resolveVerticalRef: async (ref) => (hostOf.has(ref) ? clientFor(ref) : undefined),
    });
    // The app the previews fork: an install whose data lives in v1's script.
    await dir.provisionScope(staff, { tenantId: t, scopeId: prod, vertical: slug });
    await dir.admin.activateScope(staff, t, prod);
    await dir.admin.bindScopeVersion(staff, t, prod, version.v1);
    await dir.admin.bindHostname(staff, {
      hostname: 'carry-acme.global.substrat.run',
      tenantId: t, scopeId: prod, surface: 'app', region: null, canonical: true,
    });
    await dir.admin.setHostnameStatus(staff, 'carry-acme.global.substrat.run', 'active');
    await hostFor('v1').restoreScopeLocal(prod, notes('from prod'));
  });

  let preview: ScopeId;
  let url: string;

  it('re-pointing without a carry serves an empty store: the namespaces really are separate', async () => {
    // The bug, reproduced at the directory: a pointer-only rebind, which is all a reuse did.
    const created = await push('bug', 'v1');
    expect(created.status).toBe(201);
    expect((await served(created.body.hostname)).bodies).toEqual(['from prod']);
    await dir.admin.bindScopeVersion(staff, t, created.body.scopeId, version.v2);
    expect(await served(created.body.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: [] });
    // …and the data is still in v1's script, where nothing routes any more.
    expect(bodiesIn(await hostFor('v1').exportScopeLocal(created.body.scopeId))).toEqual(['from prod']);
  });

  it("a second push serves the preview's data from the new version's script", async () => {
    const created = await push('pr-1', 'v1');
    expect(created.status).toBe(201);
    preview = created.body.scopeId;
    url = created.body.hostname;
    expect(await served(url)).toEqual({ ref: refOf.get(version.v1), bodies: ['from prod'] });
    // A reviewer's write on the preview, in v1's script.
    await hostFor('v1').restoreScopeLocal(preview, notes('from prod', 'from review'));

    const second = await push('pr-1', 'v2');
    expect(second.status).toBe(200);
    expect(second.body.scopeId).toBe(preview);
    expect(await served(url)).toEqual({ ref: refOf.get(version.v2), bodies: ['from prod', 'from review'] });
  });

  it('a retried push of the same version carries nothing, so a write since the push survives', async () => {
    await hostFor('v2').restoreScopeLocal(preview, notes('from prod', 'from review', 'after push 2'));
    const retry = await push('pr-1', 'v2');
    expect(retry.status).toBe(200);
    // A re-carry from v1's script would have dropped the last row.
    expect(await served(url)).toEqual({
      ref: refOf.get(version.v2),
      bodies: ['from prod', 'from review', 'after push 2'],
    });
  });

  it("a carry that fails inside the target DO leaves the preview on its old script, and the target's store as it was", async () => {
    // A partial left in v3 by some earlier attempt.
    await hostFor('v3').restoreScopeLocal(preview, notes('stale partial'));
    sabotageV3 = true;
    const failed = await push('pr-1', 'v3');
    sabotageV3 = false;
    expect(failed.status).toBe(500);
    expect(failed.body.error).toMatch(/refusing this dump/);
    // Never re-pointed: the URL still serves v2's copy, whole.
    expect(await served(url)).toEqual({
      ref: refOf.get(version.v2),
      bodies: ['from prod', 'from review', 'after push 2'],
    });
    // The DO's transaction rolled back its own drops: v3 holds exactly what it held before.
    expect(bodiesIn(await hostFor('v3').exportScopeLocal(preview))).toEqual(['stale partial']);

    // CI's retry lands it, replacing the partial wholesale.
    const retried = await push('pr-1', 'v3');
    expect(retried.status).toBe(200);
    expect(await served(url)).toEqual({
      ref: refOf.get(version.v3),
      bodies: ['from prod', 'from review', 'after push 2'],
    });
  });

  it('scope bind carries a forked test environment into the version it binds', async () => {
    // The long-lived test environment: a pinned fork of prod, re-pointed by the merge job's
    // `substrat scope bind <id> --version <pushed>`.
    const created = await push('test', 'v1', { ttlHours: null });
    expect(created.status).toBe(201);
    const testEnv = created.body.scopeId;
    await hostFor('v1').restoreScopeLocal(testEnv, notes('from prod', 'qa data'));

    const res = await api.request(`/tenants/${t}/scopes/${testEnv}/version`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ versionId: version.v2 }),
    });
    expect(res.status).toBe(200);
    expect(await served(created.body.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['from prod', 'qa data'] });
  });

  it('production adoption leaves preview routes and real namespace data unchanged (#1724)', async () => {
    const stable = stableDeploymentRefFor(slug);
    // Use the third, independently stored namespace as the stable script for this test.
    hostOf.set(stable, hostFor('v3'));
    const clean = await push('clean-room', 'v1', { empty: true, ttlHours: null });
    const fork = await push('real-fork', 'v1');
    const pinned = await push('historical-pin', 'v1', { empty: true });
    for (const created of [clean, fork, pinned]) expect(created.status).toBe(201);
    expect((await dir.admin.getScopeRecord(staff, t, fork.body.scopeId))?.forkedFrom).toBe(prod);
    await hostFor('v1').restoreScopeLocal(clean.body.scopeId, notes('clean-room write'));
    await dir.admin.setScopeServingRef(staff, t, pinned.body.scopeId, stable);
    await hostOf.get(stable)!.restoreScopeLocal(pinned.body.scopeId, notes('historically adopted'));
    const previews = [clean, fork, pinned];
    const records = await Promise.all(previews.map((p) => dir.admin.getScopeRecord(staff, t, p.body.scopeId)));
    const routes = await Promise.all(previews.map((p) => served(p.body.hostname)));
    expect(routes).toEqual([
      { ref: refOf.get(version.v1), bodies: ['clean-room write'] },
      { ref: refOf.get(version.v1), bodies: ['from prod'] },
      { ref: stable, bodies: ['historically adopted'] },
    ]);
    for (let retry = 0; retry < 2; retry++) {
      const promoted = await api.request(`/verticals/${slug}/channels/prod/promote`, {
        method: 'POST', headers: auth, body: JSON.stringify({ versionId: version.v2 }),
      });
      expect(promoted.status).toBe(200);
      const adopted = await api.request(`/verticals/${slug}/adopt-serving`, { method: 'POST', headers: auth });
      expect(adopted.status).toBe(200);
      expect(await adopted.json()).toMatchObject({ adopted: [], alreadyAdopted: [prod] });
      expect(await Promise.all(previews.map((p) => dir.admin.getScopeRecord(staff, t, p.body.scopeId)))).toEqual(records);
      expect(await Promise.all(previews.map((p) => served(p.body.hostname)))).toEqual(routes);
      expect(await served('carry-acme.global.substrat.run')).toEqual({ ref: stable, bodies: ['from prod'] });
      expect((await dir.admin.getScopeRecord(staff, t, prod))?.verticalVersionId).toBe(version.v2);
      expect(bodiesIn(await hostOf.get(stable)!.exportScopeLocal(clean.body.scopeId))).toEqual([]);
    }
  });

  it('the fleet repair heals legacy-pinned previews on real namespaces and leaves installs and forks alone (#1724)', async () => {
    const stable = stableDeploymentRefFor(slug);
    hostOf.set(stable, hostFor('v3')); // the third namespace stands in for the serving script
    const repairPass = async (body: object = {}) => {
      const res = await api.request('/previews/repair-serving-pins', {
        method: 'POST', headers: auth, body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        repaired: { scopeId: string; from: string; to: string }[];
        failed: { scopeId: string; status: number; error: string }[];
        nextCursor: string | null;
      };
    };
    const pinTo = async (created: { body: { scopeId: ScopeId } }, ...bodies: string[]) => {
      await dir.admin.setScopeServingRef(staff, t, created.body.scopeId, stable);
      await hostOf.get(stable)!.restoreScopeLocal(created.body.scopeId, notes(...bodies));
    };
    const a = await push('repair-a', 'v1', { empty: true, ttlHours: null });
    const b = await push('repair-b', 'v2', { empty: true, ttlHours: null });
    const fork = await push('repair-fork', 'v1', { ttlHours: null });
    const clean = await push('repair-clean', 'v1', { empty: true, ttlHours: null });
    for (const created of [a, b, fork, clean]) expect(created.status).toBe(201);
    await pinTo(a, 'a was adopted');
    await pinTo(b, 'b was adopted');
    // The install the previous test adopted onto the serving script, and a real data fork.
    const record = (sid: ScopeId) => dir.admin.getScopeRecord(staff, t, sid);
    expect(await record(prod)).toMatchObject({ servingRef: stable });
    const controls = [prod, fork.body.scopeId, clean.body.scopeId] as const;
    const recordsBefore = await Promise.all(controls.map(record));
    const prodServed = await served('carry-acme.global.substrat.run');
    const forkServed = await served(fork.body.hostname);
    const cleanServed = await served(clean.body.hostname);

    // Before: both route to the serving script, whatever version they are bound to.
    expect(await served(a.body.hostname)).toEqual({ ref: stable, bodies: ['a was adopted'] });
    expect(await served(b.body.hostname)).toEqual({ ref: stable, bodies: ['b was adopted'] });

    const out = await repairPass();
    expect(out.failed).toEqual([]);
    expect(out.repaired.map((r) => r.scopeId)).toEqual(expect.arrayContaining([a.body.scopeId, b.body.scopeId]));
    expect(out.repaired.every((r) => r.from === stable)).toBe(true);
    // After: each hostname resolves to its own version's script, holding the data it served.
    expect(await served(a.body.hostname)).toEqual({ ref: refOf.get(version.v1), bodies: ['a was adopted'] });
    expect(await served(b.body.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['b was adopted'] });
    expect(await record(a.body.scopeId)).toMatchObject({ verticalVersionId: version.v1 });
    expect((await record(a.body.scopeId))!.servingRef ?? null).toBeNull();
    expect(await record(b.body.scopeId)).toMatchObject({ verticalVersionId: version.v2 });
    expect((await record(b.body.scopeId))!.servingRef ?? null).toBeNull();
    // The install and the forks: records and served data exactly as before.
    expect(await Promise.all(controls.map(record))).toEqual(recordsBefore);
    expect(await served('carry-acme.global.substrat.run')).toEqual(prodServed);
    expect(await served(fork.body.hostname)).toEqual(forkServed);
    expect(await served(clean.body.hostname)).toEqual(cleanServed);

    // A re-run is a no-op: nothing left pinned, so nothing moves.
    const again = await repairPass();
    expect(again.repaired.filter((r) => r.scopeId === a.body.scopeId || r.scopeId === b.body.scopeId)).toEqual([]);
    expect(await served(a.body.hostname)).toEqual({ ref: refOf.get(version.v1), bodies: ['a was adopted'] });

    // A carry that fails inside the target DO keeps the pin, the binding and the data.
    const c = await push('repair-c', 'v2', { empty: true, ttlHours: null });
    expect(c.status).toBe(201);
    await pinTo(c, 'c was adopted');
    const restore = hostFor('v2').restoreScopeLocal.bind(hostFor('v2'));
    // Every attempt, not one: the carry's restore is retried in-request, and the retry must fail too.
    const sabotage = vi.spyOn(hostFor('v2'), 'restoreScopeLocal').mockImplementation((sid, tables) =>
      restore(sid, [...tables, { name: 'zz_bad', ddl: 'CREATE TABLE not_zz_bad (x TEXT)', columns: ['x'], rows: [] }]),
    );
    let failed: Awaited<ReturnType<typeof repairPass>>;
    try {
      failed = await repairPass();
    } finally {
      sabotage.mockRestore();
    }
    expect(failed.repaired.filter((r) => r.scopeId === c.body.scopeId)).toEqual([]);
    expect(failed.failed).toMatchObject([{ scopeId: c.body.scopeId, error: expect.stringMatching(/refusing this dump/) }]);
    expect(await record(c.body.scopeId)).toMatchObject({ verticalVersionId: version.v2, servingRef: stable });
    expect(await served(c.body.hostname)).toEqual({ ref: stable, bodies: ['c was adopted'] });
    // …and the retry lands it.
    const retried = await repairPass();
    expect(retried.repaired.map((r) => r.scopeId)).toContain(c.body.scopeId);
    expect(await served(c.body.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['c was adopted'] });
  });

  describe('the copy a carry leaves behind is wiped, and no interleaving loses the data (#1722)', () => {
    const fresh = async (tag: string, ...bodies: string[]) => {
      const created = await push(tag, 'v1', { ttlHours: null });
      expect(created.status).toBe(201);
      await hostFor('v1').restoreScopeLocal(created.body.scopeId, notes(...bodies));
      return created.body;
    };
    it('three successive versions leave one serving copy and two wiped copies', async () => {
      const p = await fresh('three-versions', 'from v1');
      expect((await push('three-versions', 'v2')).status).toBe(200);
      await hostFor('v2').restoreScopeLocal(p.scopeId, notes('from v1', 'from v2'));
      expect((await push('three-versions', 'v3')).status).toBe(200);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v3), bodies: ['from v1', 'from v2'] });
      expect(await Promise.all((['v1', 'v2', 'v3'] as const).map(async (v) => ({
        bodies: bodiesIn(await hostFor(v).exportScopeLocal(p.scopeId)),
        wiped: (await tombstoneIn(v, p.scopeId)) !== null,
      })))).toEqual([
        { bodies: [], wiped: true },
        { bodies: [], wiped: true },
        { bodies: ['from v1', 'from v2'], wiped: false },
      ]);
    });
    it('records a failed source wipe and reaps its copy before deleting the preview row', async () => {
      const p = await fresh('failed-wipe-reap', 'copied data');
      hooks.wipe = async (ref, sid) => {
        if (ref === refOf.get(version.v1) && sid === p.scopeId) throw new Error('source wipe unavailable');
      };
      expect((await push('failed-wipe-reap', 'v2')).status).toBe(200);
      delete hooks.wipe;
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['copied data'] });
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['copied data']);
      expect((await dir.admin.listOpsFailures(staff, { scopeId: p.scopeId })).some((f) => f.stage === 'source-copy')).toBe(true);

      const pending = await dir.admin.listScopeScriptCopies(staff, { tenantId: t, scopeId: p.scopeId });
      expect(pending).toMatchObject([{ scriptRef: refOf.get(version.v1), state: 'eligible' }]);

      const reaped = await api.request('/verticals/carry-vert/previews/failed-wipe-reap', { method: 'DELETE', headers: auth });
      expect(reaped.status).toBe(200);
      expect(await dir.admin.getScopeRecord(staff, t, p.scopeId)).toBeUndefined();
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual([]);
      expect(await dir.admin.listScopeScriptCopies(staff, { tenantId: t, scopeId: p.scopeId })).toMatchObject([
        { scriptRef: refOf.get(version.v1), state: 'done' },
      ]);
    });
    it('retries a failed source wipe from the ledger', async () => {
      const p = await fresh('retry-wipe', 'kept until retry');
      hooks.wipe = async (ref, sid) => {
        if (ref === refOf.get(version.v1) && sid === p.scopeId) throw new Error('temporary wipe failure');
      };
      expect((await push('retry-wipe', 'v2')).status).toBe(200);
      delete hooks.wipe;
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['kept until retry']);
      const report = await retryScopeScriptCopies({ admin: dir.admin, actor: staff, resolveRef: async (ref) => clientFor(ref) });
      expect(report.done).toBeGreaterThan(0);
      expect(await tombstoneIn('v1', p.scopeId)).not.toBeNull();
      expect(await dir.admin.listScopeScriptCopies(staff, { tenantId: t, scopeId: p.scopeId })).toMatchObject([
        { scriptRef: refOf.get(version.v1), state: 'done' },
      ]);
    });
    it('does not destroy the subject key until every script copy confirms redaction', async () => {
      const p = await fresh('erase-pending', 'copy before erasure');
      hooks.wipe = async (ref, sid) => {
        if (ref === refOf.get(version.v1) && sid === p.scopeId) throw new Error('temporary wipe failure');
      };
      expect((await push('erase-pending', 'v2')).status).toBe(200);
      delete hooks.wipe;
      const subject = ulid();
      const [sealed] = await dir.admin.sealSubjectPayloads(staff, t, p.scopeId, [{ subjectId: subject, plaintext: 'private' }]);
      expect(sealed).not.toBeNull();
      hooks.redact = async (ref, sid) => {
        if (ref === refOf.get(version.v1) && sid === p.scopeId) throw new Error('old script unavailable');
      };
      const path = `/tenants/${t}/scopes/${p.scopeId}/subjects/${subject}/shred`;
      expect((await api.request(path, { method: 'POST', headers: auth })).status).toBeGreaterThanOrEqual(500);
      expect(await dir.admin.openSubjectPayloads(staff, t, p.scopeId, [{ subjectId: subject, sealed: sealed! }])).toEqual(['private']);
      delete hooks.redact;
      const reached: string[] = [];
      hooks.redact = async (ref) => { reached.push(ref); };
      expect((await api.request(path, { method: 'POST', headers: auth })).status).toBe(200);
      expect(reached.sort()).toEqual([refOf.get(version.v1)!, refOf.get(version.v2)!].sort());
      expect(await dir.admin.openSubjectPayloads(staff, t, p.scopeId, [{ subjectId: subject, sealed: sealed! }])).toEqual([null]);
    });
    afterEach(() => {
      for (const k of Object.keys(hooks) as (keyof typeof hooks)[]) delete hooks[k];
      unfenced.clear();
    });
    /** A write on `v`'s copy, as a module operation leaves one: a note row and its outbox event. */
    const writeOn = async (v: keyof typeof version, sid: ScopeId, id: string, body: string, tenant?: TenantId): Promise<string> => {
      const ns = { v1: env.PC_V1_SCOPE, v2: env.PC_V2_SCOPE, v3: env.PC_V3_SCOPE }[v];
      const stub = ns.get(ns.idFromName(sid)) as unknown as {
        testWrite(s: string, i: string, b: string, t?: string): Promise<string>;
      };
      return tenant ? stub.testWrite(sid, id, body, tenant) : stub.testWrite(sid, id, body);
    };
    /** The `drained_at` of one event in `v`'s copy of a scope. */
    const drainedAt = async (v: keyof typeof version, sid: ScopeId, eventId: string): Promise<unknown> => {
      const outbox = (await hostFor(v).exportScopeLocal(sid)).find((tb) => tb.name === '_substrat_outbox')!;
      const row = outbox.rows.find((r) => r[outbox.columns.indexOf('id')] === eventId);
      return row?.[outbox.columns.indexOf('drained_at')];
    };
    /**
     * Two pushes of the same version: the winner has restored v2 and is held before binding; the
     * loser exports, reads v2's marker (the winner's), finds the binding unchanged, and is held
     * before its restore. Then the winner binds, `afterBind` changes the live v2, and the loser is
     * released. Answers the loser's response.
     */
    const loserPastWinnersRestore = async (tag: string, afterBind: () => Promise<void>) => {
      const winnerRestored = deferred();
      const winnerGo = deferred();
      let winnerLanded = false;
      hooks.restored = async (ref, sid, tables) => {
        if (winnerLanded || ref !== refOf.get(version.v2) || dumpMetaValue(tables ?? [], CARRIED_AWAY_KEY) !== null) return;
        winnerLanded = true;
        winnerRestored.resolve();
        await winnerGo.promise;
      };
      const loserHeld = holdFirst((ref) => winnerLanded && ref === refOf.get(version.v2));
      hooks.restore = loserHeld.hook;
      const winner = push(tag, 'v2');
      await winnerRestored.promise;
      const loser = push(tag, 'v2');
      await loserHeld.reached;
      winnerGo.resolve();
      expect((await winner).status).toBe(200);
      await afterBind();
      loserHeld.release();
      return loser;
    };

    it('a retried push held before its restore cannot overwrite the live store the first run bound and wrote to', async () => {
      const p = await fresh('live', 'live data');
      // The loser read v2's marker and the binding, and is held right before its restore.
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v2) && sid === p.scopeId);
      hooks.restore = held.hook;
      const loser = push('live', 'v2');
      await held.reached;
      // The winner restores, binds, and the preview takes a write on v2.
      expect((await push('live', 'v2')).status).toBe(200);
      await writeOn('v2', p.scopeId, 'n-live', 'written after the bind');
      held.release();
      const refused = await loser;
      expect(refused.status).toBe(412);
      expect(refused.body.error).toMatch(/changed since the carry read it/);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['live data', 'written after the bind'] });
    });

    it("with no write at all, the winner's load alone refuses the held retry's restore", async () => {
      const p = await fresh('live-load', 'load data');
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v2) && sid === p.scopeId);
      hooks.restore = held.hook;
      const loser = push('live-load', 'v2');
      await held.reached;
      expect((await push('live-load', 'v2')).status).toBe(200);
      held.release();
      const refused = await loser;
      expect(refused.status).toBe(412);
      expect(refused.body.error).toMatch(/changed since the carry read it/);
    });

    it('nor can one that read the marker after the winner restored: the write after the bind moves it', async () => {
      const p = await fresh('live-write', 'write data');
      const loser = await loserPastWinnersRestore('live-write', async () => {
        await writeOn('v2', p.scopeId, 'n-live', 'written after the bind');
      });
      expect(loser.status).toBe(412);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['write data', 'written after the bind'] });
    });

    // Codex #2008 r2: a drain receipt is an UPDATE in place. It appends no event, and the fence
    // still has to see it, or the loser's older dump clears the receipt and the event ships twice.
    it("a drain receipt on the live store after the bind refuses the loser's restore, and the receipt stands", async () => {
      const p = await fresh('live-drain', 'drain data');
      const event = await writeOn('v1', p.scopeId, 'n-ev', 'an event to drain');
      const at = '2026-10-03T12:00:00.000Z';
      const loser = await loserPastWinnersRestore('live-drain', async () => {
        expect(await hostFor('v2').markEventsDrainedLocal(p.scopeId, [event], at)).toBe(1);
      });
      expect(loser.status).toBe(412);
      expect(await drainedAt('v2', p.scopeId, event)).toBe(at);
    });

    it("so does a redrain on the live store: the reopened event stays reopened", async () => {
      const p = await fresh('live-redrain', 'redrain data');
      const event = await writeOn('v1', p.scopeId, 'n-ev', 'an event drained before the push');
      await hostFor('v1').markEventsDrainedLocal(p.scopeId, [event], '2026-10-01T00:00:00.000Z');
      const loser = await loserPastWinnersRestore('live-redrain', async () => {
        expect(await hostFor('v2').redrainEventsLocal(p.scopeId, '2026-10-02T00:00:00.000Z')).toBe(1);
      });
      expect(loser.status).toBe(412);
      expect(await drainedAt('v2', p.scopeId, event)).toBeNull();
    });

    it('on a script that cannot fence the restore, the binding read just before it refuses one the winner made live', async () => {
      const p = await fresh('live-old', 'old data');
      unfenced.add(refOf.get(version.v2)!);
      // Held at its marker read, which a script built before #1722 cannot answer; the binding is
      // read right after it, and that read is the only guard there.
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v2) && sid === p.scopeId);
      hooks.marker = held.hook;
      const loser = push('live-old', 'v2');
      await held.reached;
      expect((await push('live-old', 'v2')).status).toBe(200);
      await writeOn('v2', p.scopeId, 'n-live', 'written after the bind');
      held.release();
      const refused = await loser;
      expect(refused.status).toBe(412);
      expect(refused.body.error).toMatch(/re-pointed while its data was being copied/);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['old data', 'written after the bind'] });
    });

    it('the fence: any load since the stamped export refuses the wipe, and nothing loaded lets it run', async () => {
      const sid = scopeId.parse(ulid());
      const v1 = hostFor('v1');
      await v1.restoreScopeLocal(sid, notes('kept'));
      const away = { to: 'elsewhere', at: '2026-10-03T00:00:00.000Z' };
      // A restore that names no stamp (a governed restore, not a carry) clears the one read.
      const { loadStamp: first } = await v1.exportScopeStampedLocal(sid);
      await v1.restoreScopeLocal(sid, notes('restored since'));
      expect(await v1.wipeCarriedLocal(sid, first, away)).toBe(false);
      expect(bodiesIn(await v1.exportScopeLocal(sid))).toEqual(['restored since']);
      // A dump that carries a stamp row of its own cannot forge the one read: the load drops it.
      const { loadStamp: forged } = await v1.exportScopeStampedLocal(sid);
      await v1.restoreScopeLocal(sid, [
        ...notes('forged'),
        {
          name: '_substrat_meta',
          ddl: 'CREATE TABLE _substrat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
          columns: ['key', 'value'],
          rows: [[LOAD_STAMP_KEY, forged]],
        },
      ]);
      expect(await v1.wipeCarriedLocal(sid, forged, away)).toBe(false);
      // So does a carry's load, which names its own.
      const { loadStamp: second } = await v1.exportScopeStampedLocal(sid);
      expect(second).not.toBe(first);
      await v1.restoreScopeLocal(sid, notes('carried in'), { loadStamp: ulid() });
      expect(await v1.wipeCarriedLocal(sid, second, away)).toBe(false);
      // The twin: nothing loaded since the read, so the wipe runs, and the stamp went with it.
      const { loadStamp: third } = await v1.exportScopeStampedLocal(sid);
      expect(await v1.exportScopeStampedLocal(sid)).toMatchObject({ loadStamp: third });
      expect(await v1.wipeCarriedLocal(sid, third, away)).toBe(true);
      expect(bodiesIn(await v1.exportScopeLocal(sid))).toEqual([]);
      expect(await v1.wipeCarriedLocal(sid, third, away)).toBe(false);
      // Never in a dump: a copy of this store carries no stamp of it.
      await v1.restoreScopeLocal(sid, notes('again'), { loadStamp: 'carry-stamp' });
      const dumped = await v1.exportScopeLocal(sid);
      expect(dumpMetaValue(dumped, LOAD_STAMP_KEY)).toBeNull();
      expect((await v1.exportScopeStampedLocal(sid)).loadStamp).toBe('carry-stamp');
    });

    it('the write revision only moves forward: two plain loads in a row never leave the same marker', async () => {
      const sid = scopeId.parse(ulid());
      const v1 = hostFor('v1');
      await v1.restoreScopeLocal(sid, notes('first'));
      const first = await v1.loadMarkerLocal(sid);
      expect(first.loadStamp).toBeNull();
      await v1.restoreScopeLocal(sid, notes('second'));
      const second = await v1.loadMarkerLocal(sid);
      expect(second).not.toEqual(first);
      // So a restore that read the first marker cannot land over the second load.
      await expect(v1.restoreScopeLocal(sid, notes('stale'), { expect: first })).rejects.toThrow(/changed since the carry read it/);
      expect(bodiesIn(await v1.exportScopeLocal(sid))).toEqual(['second']);
      // A read is not a write: reading the marker again leaves it where it was.
      expect(await v1.loadMarkerLocal(sid)).toEqual(second);
      // Never in a dump, so a copy of this store does not carry its revision.
      expect(dumpMetaValue(await v1.exportScopeLocal(sid), WRITE_REVISION_KEY)).toBeNull();
    });

    it('the revision advances once per synchronous run: a later run in the same call, and a write after a rollback, both count', async () => {
      const sid = scopeId.parse(ulid());
      const v1 = hostFor('v1');
      await v1.restoreScopeLocal(sid, notes('base'));
      const stub = env.PC_V1_SCOPE.get(env.PC_V1_SCOPE.idFromName(sid)) as unknown as {
        testWriteBatch(s: string, ops: number, rows: number, counted: boolean): Promise<void>;
        testRollbackThenWrite(id: string, body: string): Promise<void>;
      };
      const rev = async () => Number((await v1.loadMarkerLocal(sid)).revision);
      await stub.testWriteBatch(sid, 0, 0, true); // creates the helper's table, counted on its own
      const start = await rev();
      // Three operations, each its own run and transaction in one call: three bumps, not one.
      await stub.testWriteBatch(sid, 3, 2, true);
      expect(await rev()).toBe(start + 3);
      // A rolled-back transaction and then a landed write, in one run: still counted.
      const before = await v1.loadMarkerLocal(sid);
      await stub.testRollbackThenWrite('n-after', 'after the rollback');
      expect(await rev()).toBeGreaterThan(Number(before.revision));
      expect(bodiesIn(await v1.exportScopeLocal(sid))).toEqual(['base', 'after the rollback']);
      await expect(v1.restoreScopeLocal(sid, notes('stale'), { expect: before })).rejects.toThrow(/changed since the carry read it/);
    });

    it('the bump is in the transaction that commits the write, it fails the write when it cannot land, and a same-run read sees it', async () => {
      const sid = scopeId.parse(ulid());
      const v1 = hostFor('v1');
      await v1.restoreScopeLocal(sid, notes('base'));
      const stub = env.PC_V1_SCOPE.get(env.PC_V1_SCOPE.idFromName(sid)) as unknown as {
        testSyncTxRevision(id: string): Promise<[string | null, string | null]>;
        testSameRunMarker(id: string): Promise<[string | null, string | null]>;
        testBumpFailure(id: string): Promise<{ threw: boolean; landed: boolean }>;
      };
      // (a) Read straight after the transactionSync returns, before any microtask could run.
      const [a0, a1] = await stub.testSyncTxRevision('n-tx');
      expect(Number(a1)).toBe(Number(a0) + 1);
      // (c) Outside a transaction too: the read in the same run already sees it.
      const [c0, c1] = await stub.testSameRunMarker('n-run');
      expect(Number(c1)).toBe(Number(c0) + 1);
      // (b) No bump, no write.
      const before = await v1.loadMarkerLocal(sid);
      expect(await stub.testBumpFailure('n-fail')).toEqual({ threw: true, landed: false });
      expect(await v1.loadMarkerLocal(sid)).toEqual(before);
      expect(bodiesIn(await v1.exportScopeLocal(sid))).toEqual(['base', 'in a sync transaction', 'same run']);
    });

    // CodeRabbit #2008: a write that reached the old copy after the export (a request still routed
    // there before the bind) was never carried. The wipe is fenced on the revision too, so that
    // copy is kept, holding the write, and recorded for recovery rather than erased.
    /**
     * A push v1 → v2 whose source takes a write after the bind's re-check of it (r12): the window
     * the re-check cannot close, and the copy the carry keeps. (A write before the re-check is
     * carried by a fresh export instead; see below.)
     */
    const keptByLateWrite = async (tag: string) => {
      const p = await fresh(tag, 'carried');
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v1) && sid === p.scopeId);
      hooks.markerRead = held.hook; // the bind's re-check of the source, read; the bind is next
      const pushed = push(tag, 'v2');
      await held.reached;
      await writeOn('v1', p.scopeId, 'n-late', 'written after the export');
      held.release();
      expect((await pushed).status).toBe(200);
      delete hooks.markerRead;
      return p;
    };
    const resolve = (sid: ScopeId, body: object) =>
      api.request(`/tenants/${t}/scopes/${sid}/kept-copy/resolve`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

    it('a write that reaches the source after the export keeps the source copy, and is recorded', async () => {
      const p = await keptByLateWrite('late-write');
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['carried'] });
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['carried', 'written after the export']);
      expect(await tombstoneIn('v1', p.scopeId)).toBeNull();
      const kept = (await dir.admin.listOpsFailures(staff, { scopeId: p.scopeId })).find((f) => f.stage === 'source-copy-kept');
      expect(kept).toMatchObject({ operation: 'scope.carry', status: 409 });
    });

    // Codex #2008 r7: the kept copy is protected in the store. A bind back to it is refused
    // (409) rather than restoring v2's older data over the only copy of the late write.
    // Codex #2008 r12: a write that lands before the bind's re-check of the source is not kept for
    // staff: the carry runs again from a fresh export, which holds it, and binds that.
    it("a write before the bind's re-check of the source is carried by a fresh export, and the source is wiped", async () => {
      const p = await fresh('early-write', 'carried');
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v2) && sid === p.scopeId);
      hooks.marker = held.hook; // after the export, before the restore and the re-check
      const pushed = push('early-write', 'v2');
      await held.reached;
      await writeOn('v1', p.scopeId, 'n-early', 'written before the re-check');
      held.release();
      expect((await pushed).status).toBe(200);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['carried', 'written before the re-check'] });
      expect(await tombstoneIn('v1', p.scopeId)).not.toBeNull();
      expect(await hostFor('v1').keptCopyLocal(p.scopeId)).toBeNull();
    });

    it('a source that changes at every re-check is refused with a typed 409 after three exports, and nothing is bound', async () => {
      const p = await fresh('restless', 'carried');
      let writes = 0;
      hooks.marker = async (ref, sid) => {
        // Before each re-check's read of the source: every one finds it changed.
        if (ref !== refOf.get(version.v1) || sid !== p.scopeId) return;
        writes += 1;
        await writeOn('v1', p.scopeId, `n-${writes}`, `write ${writes}`);
      };
      const res = await bindTo(p.scopeId, 'v2');
      delete hooks.marker;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        carrySourceChanged: { scopeId: p.scopeId, from: refOf.get(version.v1), to: refOf.get(version.v2), attempts: 3 },
      });
      expect(writes).toBe(3);
      // Still served from v1, with every write; v2's copy was dropped, and nothing is kept.
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v1), bodies: ['carried', 'write 1', 'write 2', 'write 3'] });
      expect(await tombstoneIn('v2', p.scopeId)).not.toBeNull();
      expect(await hostFor('v1').keptCopyLocal(p.scopeId)).toBeNull();
    });

    it('a bind back to the kept copy is refused until it is resolved; restoring it forward keeps the late write', async () => {
      const p = await keptByLateWrite('kept-forward');
      const back = await api.request(`/tenants/${t}/scopes/${p.scopeId}/version`, {
        method: 'POST', headers: auth, body: JSON.stringify({ versionId: version.v1 }),
      });
      expect(back.status).toBe(409);
      expect(((await back.json()) as { error: string }).error).toMatch(/holds writes that were not carried/);
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['carried', 'written after the export']);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['carried'] });

      // What the staff read shows, and a restore forward refused until it names what it replaces.
      const v1ref = refOf.get(version.v1)!;
      const read = await api.request(`/tenants/${t}/scopes/${p.scopeId}/kept-copy?script=${v1ref}`, { headers: auth });
      const { kept } = (await read.json()) as { kept: { keptAt: string; revision: string; carriedTo: string } };
      expect(kept).toMatchObject({ carriedTo: refOf.get(version.v2) });
      expect((await resolve(p.scopeId, { script: v1ref, action: 'restore-forward', acknowledge: { replacesLiveWritesSince: 'yesterday' } })).status).toBe(409);
      const done = await resolve(p.scopeId, { script: v1ref, action: 'restore-forward', acknowledge: { replacesLiveWritesSince: kept.keptAt } });
      expect(done.status).toBe(200);
      // The late write now lives where the scope runs; the kept copy is wiped, the guard with it.
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['carried', 'written after the export'] });
      expect(await tombstoneIn('v1', p.scopeId)).not.toBeNull();
      const [logged] = await dir.admin.auditLog(staff, { action: 'resolveKeptCopy', scopeId: p.scopeId });
      expect(logged).toMatchObject({ before: { script: v1ref, keptAt: kept.keptAt }, after: { action: 'restore-forward', liveScript: refOf.get(version.v2) } });
      expect(Number((logged!.before as { revision: string }).revision)).toBeGreaterThan(Number(kept.revision));
      // And the bind back is an ordinary carry again.
      // (On the DO: a discard is fenced on the revision read, and refused where nothing is kept.)
      const v1host = hostFor('v1');
      const away = { to: 'x', at: '2026-10-03T00:00:00.000Z' };
      expect(await v1host.discardKeptCopyLocal(p.scopeId, '0', away)).toEqual({ refused: 'not-kept' });
      expect((await bindTo(p.scopeId, 'v1')).status).toBe(200);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v1), bodies: ['carried', 'written after the export'] });
      // Nothing left to resolve.
      expect((await resolve(p.scopeId, { script: v1ref, action: 'discard', acknowledge: { discard: true } })).status).toBe(409);
    });

    it('discarding the kept copy is acknowledged, logged, and lets the bind back carry again', async () => {
      const p = await keptByLateWrite('kept-discard');
      const v1ref = refOf.get(version.v1)!;
      // The kept copy's own dump, to reconcile by hand before choosing: raw with full=true,
      // masked by default, and access-logged like the governed export.
      const pulls = async () => (await dir.admin.accessLog(staff, { tenantId: t, method: 'exportScope' })).length;
      const before = await pulls();
      const raw = await api.request(`/tenants/${t}/scopes/${p.scopeId}/kept-copy/export?script=${v1ref}&full=true`, { headers: auth });
      expect(raw.status).toBe(200);
      const rawBody = (await raw.json()) as { tables: ScopeDumpTable[]; masked: boolean; kept: unknown };
      expect(rawBody.masked).toBe(false);
      expect(rawBody.kept).not.toBeNull();
      expect(bodiesIn(rawBody.tables)).toEqual(['carried', 'written after the export']);
      const masked = await api.request(`/tenants/${t}/scopes/${p.scopeId}/kept-copy/export?script=${v1ref}`, { headers: auth });
      expect(((await masked.json()) as { masked: boolean }).masked).toBe(true);
      expect(await pulls()).toBe(before + 2);
      // On the DO: a discard at a revision the copy has moved past is refused, and keeps it.
      const stale = await hostFor('v1').discardKeptCopyLocal(p.scopeId, '0', { to: 'x', at: '2026-10-03T00:00:00.000Z' });
      expect(stale).toEqual({ refused: 'changed' });
      expect(await hostFor('v1').keptCopyLocal(p.scopeId)).not.toBeNull();
      expect((await resolve(p.scopeId, { script: v1ref, action: 'discard', acknowledge: { discard: false } })).status).toBe(400);
      expect((await resolve(p.scopeId, { script: v1ref, action: 'discard', acknowledge: { discard: true } })).status).toBe(200);
      expect(await tombstoneIn('v1', p.scopeId)).not.toBeNull();
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['carried'] });
      const [logged] = await dir.admin.auditLog(staff, { action: 'resolveKeptCopy', scopeId: p.scopeId });
      expect(logged).toMatchObject({ after: { action: 'discard', liveScript: null } });
      // Discarded: nothing kept to export any more.
      expect((await api.request(`/tenants/${t}/scopes/${p.scopeId}/kept-copy/export?script=${v1ref}`, { headers: auth })).status).toBe(409);
      expect((await bindTo(p.scopeId, 'v1')).status).toBe(200);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v1), bodies: ['carried'] });
    });

    // Codex #2008 r8: a move that lands while a restore-forward runs. The kept copy goes only once
    // its data is in the store the scope still routes to; otherwise it stays kept, and the late
    // write is never left in an unmarked orphan.
    it('a bind that completes before the resolution reads the live store refuses it, and the kept copy stays', async () => {
      const p = await keptByLateWrite('kept-race-a');
      const v1ref = refOf.get(version.v1)!;
      const { kept } = (await (await api.request(`/tenants/${t}/scopes/${p.scopeId}/kept-copy?script=${v1ref}`, { headers: auth })).json()) as {
        kept: { keptAt: string };
      };
      // Held as it reads v2's marker; meanwhile a bind v2 → v3 lands whole, wiping v2.
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v2) && sid === p.scopeId);
      hooks.marker = held.hook;
      const resolving = resolve(p.scopeId, { script: v1ref, action: 'restore-forward', acknowledge: { replacesLiveWritesSince: kept.keptAt } });
      await held.reached;
      expect((await bindTo(p.scopeId, 'v3')).status).toBe(200);
      held.release();
      const refused = await resolving;
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toMatch(/re-pointed while the kept copy was being restored forward/);
      // The late write is still in v1, still kept; v2 is the tombstone the bind left.
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['carried', 'written after the export']);
      expect(await hostFor('v1').keptCopyLocal(p.scopeId)).not.toBeNull();
      expect(bodiesIn(await hostFor('v2').exportScopeLocal(p.scopeId))).toEqual([]);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v3), bodies: ['carried'] });
    });

    it("a bind that exported before the resolution's restore and binds after it keeps what the restore put in its source", async () => {
      const p = await keptByLateWrite('kept-race-b');
      const v1ref = refOf.get(version.v1)!;
      const { kept } = (await (await api.request(`/tenants/${t}/scopes/${p.scopeId}/kept-copy?script=${v1ref}`, { headers: auth })).json()) as {
        kept: { keptAt: string };
      };
      // The bind v2 → v3 has exported v2 (without the late write), restored, and re-checked v2, and
      // is held right before binding: the window its re-check cannot close (r12).
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v2) && sid === p.scopeId);
      hooks.markerRead = held.hook;
      const binding = bindTo(p.scopeId, 'v3');
      await held.reached;
      // The resolution runs whole meanwhile: restores v1 into v2, finds the binding unchanged, discards v1.
      expect((await resolve(p.scopeId, { script: v1ref, action: 'restore-forward', acknowledge: { replacesLiveWritesSince: kept.keptAt } })).status).toBe(200);
      expect(await tombstoneIn('v1', p.scopeId)).not.toBeNull();
      // The bind lands. Its source, v2, changed after its export, and it is kept, holding the write.
      held.release();
      expect((await binding).status).toBe(200);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v3), bodies: ['carried'] });
      expect(bodiesIn(await hostFor('v2').exportScopeLocal(p.scopeId))).toEqual(['carried', 'written after the export']);
      expect(await hostFor('v2').keptCopyLocal(p.scopeId)).not.toBeNull();
    });

    // Codex #2008 r13: a release or discard names the store it read (stamp and revision), not only
    // its revision. A kept copy refuses every load but its own resolution, so the stamp cannot move
    // under one; this pins that the act itself compares it too.
    it('a release or discard of a kept copy is refused for a load stamp other than the one read', async () => {
      const p = await fresh('kept-stamp', 'kept data');
      const v1 = hostFor('v1');
      expect(await v1.wipeCarriedLocal(p.scopeId, 'not-the-stamp', { to: 'x', at: '2026-10-03T00:00:00.000Z' }, { protectIfChanged: true })).toBe(false);
      const read = await v1.loadMarkerLocal(p.scopeId);
      const away = { to: 'elsewhere', at: '2026-10-03T00:00:00.000Z' };
      expect(await v1.releaseKeptCopyLocal(p.scopeId, read.revision, undefined, 'another-load')).toEqual({ refused: 'changed' });
      expect(await v1.discardKeptCopyLocal(p.scopeId, read.revision, away, undefined, 'another-load')).toEqual({ refused: 'changed' });
      expect(await v1.keptCopyLocal(p.scopeId)).not.toBeNull();
      expect(await v1.loadMarkerLocal(p.scopeId)).toEqual(read);
      // The stamp it does hold passes.
      expect(await v1.releaseKeptCopyLocal(p.scopeId, read.revision, undefined, read.loadStamp)).toEqual({ released: true });
    });

    it('a kept copy that is the live store is released, acknowledged and logged', async () => {
      const p = await fresh('kept-live', 'live data');
      const v1ref = refOf.get(version.v1)!;
      // Marked kept while live: what a carry's protection leaves when a rollback binds right after.
      const live = hostFor('v1');
      expect(await live.wipeCarriedLocal(p.scopeId, 'not-the-stamp', { to: 'elsewhere', at: '2026-10-03T00:00:00.000Z' }, { protectIfChanged: true })).toBe(false);
      expect(await live.keptCopyLocal(p.scopeId)).not.toBeNull();
      // Only `release` resolves a kept copy the scope routes to.
      expect((await resolve(p.scopeId, { script: v1ref, action: 'discard', acknowledge: { discard: true } })).status).toBe(409);
      expect((await resolve(p.scopeId, { script: v1ref, action: 'release', acknowledge: { release: true } })).status).toBe(200);
      expect(await live.keptCopyLocal(p.scopeId)).toBeNull();
      expect(await served(p.hostname)).toEqual({ ref: v1ref, bodies: ['live data'] });
      const [logged] = await dir.admin.auditLog(staff, { action: 'resolveKeptCopy', scopeId: p.scopeId });
      expect(logged).toMatchObject({ after: { action: 'release' } });
      // Nothing left to release.
      expect((await resolve(p.scopeId, { script: v1ref, action: 'release', acknowledge: { release: true } })).status).toBe(409);
    });

    // Codex #2008 r9: a release decided while the store was live must not clear the marker of a
    // copy the scope has since left. The carry that leaves a kept copy records it there, which
    // moves the revision every release is fenced on.
    it('a staff release read while the copy was live fails once a carry has left it, and the late write stays kept', async () => {
      const p = await fresh('rel-race', 'live data');
      const v1ref = refOf.get(version.v1)!;
      // v1 live and kept, as a carry's protection leaves it when a rollback binds right after.
      expect(await hostFor('v1').wipeCarriedLocal(p.scopeId, 'not-the-stamp', { to: 'x', at: '2026-10-03T00:00:00.000Z' }, { protectIfChanged: true })).toBe(false);
      // A carry v1 → v2 has exported v1, restored, and re-checked v1, and is held before binding.
      const carryHeld = holdFirst((ref, sid) => ref === refOf.get(version.v1) && sid === p.scopeId);
      hooks.markerRead = carryHeld.hook;
      const carry = bindTo(p.scopeId, 'v2');
      await carryHeld.reached;
      // The late write, after the carry's export.
      await writeOn('v1', p.scopeId, 'n-late', 'written after the export');
      // Staff release reads v1 live at the revision after the write, and is held before acting.
      const releaseHeld = holdFirst((ref, sid) => ref === v1ref && sid === p.scopeId);
      hooks.release = releaseHeld.hook;
      const releasing = resolve(p.scopeId, { script: v1ref, action: 'release', acknowledge: { release: true } });
      await releaseHeld.reached;
      // The carry binds v2, and its source wipe meets the kept marker.
      carryHeld.release();
      expect((await carry).status).toBe(200);
      releaseHeld.release();
      expect((await releasing).status).toBe(412);
      // v1 still kept, holding the only copy of the late write; the scope serves v2 without it.
      expect(await hostFor('v1').keptCopyLocal(p.scopeId)).toMatchObject({ leftAgain: { to: refOf.get(version.v2) } });
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['live data', 'written after the export']);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['live data'] });
    });

    it("a carry's auto-release read while the copy was live fails once another carry has left it", async () => {
      const p = await fresh('auto-rel', 'rb data');
      // A carries v1 → v2 and is held at its wipe of v1; R binds back to v1 whole.
      const aWipe = holdFirst((ref, sid) => ref === refOf.get(version.v1) && sid === p.scopeId);
      hooks.wipe = aWipe.hook;
      const a = bindTo(p.scopeId, 'v2');
      await aWipe.reached;
      expect((await bindTo(p.scopeId, 'v1')).status).toBe(200);
      // B carries v1 → v3 and is held after its re-check of v1; then the late write lands on v1.
      const bHeld = holdFirst((ref, sid) => ref === refOf.get(version.v1) && sid === p.scopeId);
      hooks.markerRead = bHeld.hook;
      const b = bindTo(p.scopeId, 'v3');
      await bHeld.reached;
      await writeOn('v1', p.scopeId, 'n-late', 'written after B exported');
      // A resumes: its wipe is refused and keeps v1; it reads v1 live and goes to release it, held.
      const aRelease = holdFirst((ref, sid) => ref === refOf.get(version.v1) && sid === p.scopeId);
      hooks.release = aRelease.hook;
      aWipe.release();
      await aRelease.reached;
      // B lands on v3 and leaves v1, meeting the kept marker.
      bHeld.release();
      expect((await b).status).toBe(200);
      // A's release now fails its revision check: v1 stays kept with the late write.
      aRelease.release();
      expect((await a).status).toBe(200);
      expect(await hostFor('v1').keptCopyLocal(p.scopeId)).not.toBeNull();
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['rb data', 'written after B exported']);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v3), bodies: ['rb data'] });
    });

    // Codex #2008 r7: a copy the carry wiped takes no write, so a stale request still routed to
    // it lands nowhere. A rollback's restore makes it a live store again, and it takes writes.
    it('a wiped copy refuses writes until a restore makes it live again', async () => {
      const p = await fresh('tomb-write', 'tomb data');
      expect((await push('tomb-write', 'v2')).status).toBe(200);
      await expect(writeOn('v1', p.scopeId, 'n-stale', 'a stale request')).rejects.toThrow(/carried to another script and wiped/);
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual([]);
      expect((await bindTo(p.scopeId, 'v1')).status).toBe(200);
      await writeOn('v1', p.scopeId, 'n-live', 'live again');
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['tomb data', 'live again']);
    });

    // CodeRabbit #2008: a restore that committed and lost its answer is retried with the same
    // expectation, which the first load itself moved. The store holding the retry's own stamp is
    // answered as applied, so the push lands instead of failing with a 412.
    it("a restore retried after its answer was lost is answered as applied, and the push lands", async () => {
      const p = await fresh('lost-answer', 'lost answer data');
      let lost = false;
      hooks.restored = async (ref, sid, tables) => {
        if (lost || ref !== refOf.get(version.v2) || sid !== p.scopeId || dumpMetaValue(tables ?? [], CARRIED_AWAY_KEY) !== null) return;
        lost = true;
        throw new Error('connection reset before the answer arrived');
      };
      expect((await push('lost-answer', 'v2')).status).toBe(200);
      expect(lost).toBe(true);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['lost answer data'] });
      expect(await tombstoneIn('v1', p.scopeId)).not.toBeNull();
    });

    it('a push wipes the copy in the old script, and a bind back to it restores into that same store', async () => {
      const p = await fresh('gone', 'from prod', 'gone data');
      expect((await push('gone', 'v2')).status).toBe(200);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['from prod', 'gone data'] });
      // Gone from v1's script, which keeps only the tombstone naming where the data went.
      expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual([]);
      expect(JSON.parse((await tombstoneIn('v1', p.scopeId))!)).toMatchObject({ to: refOf.get(version.v2) });
      // #2005: the preview's wiped copy is still marked a copy, so nothing reads it as primary.
      const v1stub = env.PC_V1_SCOPE.get(env.PC_V1_SCOPE.idFromName(p.scopeId)) as unknown as { isCopy(): Promise<boolean> };
      expect(await v1stub.isCopy()).toBe(true);
      // Not reaped: a rollback carries into that DO again and serves from it, and then v2's copy goes.
      expect((await bindTo(p.scopeId, 'v1')).status).toBe(200);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v1), bodies: ['from prod', 'gone data'] });
      expect(await tombstoneIn('v1', p.scopeId)).toBeNull();
      expect(bodiesIn(await hostFor('v2').exportScopeLocal(p.scopeId))).toEqual([]);
      expect(await tombstoneIn('v2', p.scopeId)).not.toBeNull();
    });

    // Codex #2008 r10: the directory's classification, not only the store's own marker, decides
    // that a carry's source is a copy — so one made before the marker leaves the carry marked,
    // whether the wipe tombstones it or keeps it. And marking is bookkeeping, not a data write: a
    // backfill that marks the source between the export and the wipe does not keep the copy.
    describe('copy marking across a carry (#2005 × #1722)', () => {
      type CopyStub = {
        isCopy(): Promise<boolean>;
        markCopy(): Promise<boolean>;
        testForgetCopyOrigin(): Promise<void>;
        testBookkeepingWrite(query: string, ...bindings: unknown[]): Promise<void>;
      };
      const v1stub = (sid: ScopeId) => env.PC_V1_SCOPE.get(env.PC_V1_SCOPE.idFromName(sid)) as unknown as CopyStub;
      /** A preview whose v1 copy predates the marker: no origin row, and no write revision moved. */
      const legacy = async (tag: string) => {
        const p = await fresh(tag, 'legacy data');
        await v1stub(p.scopeId).testForgetCopyOrigin();
        expect(await v1stub(p.scopeId).isCopy()).toBe(false);
        return p;
      };
      /** A push v1 → v2 held after its re-check of v1 (so after its export and restore, right before
       *  its bind), while `between` runs on v1. Answers the push. */
      const pushAround = async (tag: string, sid: ScopeId, between: () => Promise<void>) => {
        const held = holdFirst((ref, s) => ref === refOf.get(version.v1) && s === sid);
        hooks.markerRead = held.hook;
        const pushed = push(tag, 'v2');
        await held.reached;
        await between();
        held.release();
        const res = await pushed;
        delete hooks.markerRead;
        return res;
      };

      it('a copy made before the marker is marked by the carry that wipes it', async () => {
        const p = await legacy('legacy-wipe');
        expect((await push('legacy-wipe', 'v2')).status).toBe(200);
        expect(await tombstoneIn('v1', p.scopeId)).not.toBeNull();
        expect(await v1stub(p.scopeId).isCopy()).toBe(true);
      });

      it('and by the carry that keeps it for a late write', async () => {
        const p = await legacy('legacy-kept');
        const res = await pushAround('legacy-kept', p.scopeId, async () => {
          await writeOn('v1', p.scopeId, 'n-late', 'written after the export');
        });
        expect(res.status).toBe(200);
        expect(await hostFor('v1').keptCopyLocal(p.scopeId)).not.toBeNull();
        expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['legacy data', 'written after the export']);
        expect(await v1stub(p.scopeId).isCopy()).toBe(true);
      });

      it('a backfill that marks the source between the export and the wipe does not keep it', async () => {
        const p = await legacy('backfill-mark');
        const res = await pushAround('backfill-mark', p.scopeId, async () => {
          expect(await v1stub(p.scopeId).markCopy()).toBe(true);
        });
        expect(res.status).toBe(200);
        expect(await hostFor('v1').keptCopyLocal(p.scopeId)).toBeNull();
        expect(await tombstoneIn('v1', p.scopeId)).not.toBeNull();
        expect(await v1stub(p.scopeId).isCopy()).toBe(true);
        expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['legacy data'] });
      });

      it('while a data write in the same window still keeps it', async () => {
        const p = await legacy('backfill-and-write');
        const res = await pushAround('backfill-and-write', p.scopeId, async () => {
          expect(await v1stub(p.scopeId).markCopy()).toBe(true);
          await writeOn('v1', p.scopeId, 'n-late', 'written after the export');
        });
        expect(res.status).toBe(200);
        expect(await hostFor('v1').keptCopyLocal(p.scopeId)).not.toBeNull();
        expect(await tombstoneIn('v1', p.scopeId)).toBeNull();
        expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['legacy data', 'written after the export']);
        expect(await v1stub(p.scopeId).isCopy()).toBe(true);
      });

      it('the bookkeeping path refuses a data write, and a clear of the marker, which would otherwise move no revision', async () => {
        const p = await legacy('bookkeeping-refuses');
        expect(await v1stub(p.scopeId).markCopy()).toBe(true);
        const before = await hostFor('v1').loadMarkerLocal(p.scopeId);
        await expect(
          v1stub(p.scopeId).testBookkeepingWrite('INSERT INTO pv_notes (id, body) VALUES (?, ?)', 'n-unrevised', 'unrevised'),
        ).rejects.toThrow(/takes only the copy-marker insert/);
        await expect(v1stub(p.scopeId).testBookkeepingWrite('DELETE FROM _substrat_copy_origin WHERE id = 1')).rejects.toThrow(
          /takes only the copy-marker insert/,
        );
        expect(bodiesIn(await hostFor('v1').exportScopeLocal(p.scopeId))).toEqual(['legacy data']);
        expect(await v1stub(p.scopeId).isCopy()).toBe(true);
        expect(await hostFor('v1').loadMarkerLocal(p.scopeId)).toEqual(before);
      });

      // Codex #2008 r11–r12: clearing a primary's mistaken marker loosens the store (its executors
      // may run), so it is a write, and the clear is the fresher decision. Whichever side of the
      // bind's re-check of the source it lands on, the store the scope runs on ends up unmarked and
      // its executors run: no staff action is needed to finish what the clear started.
      describe("a staff clear of a primary's mistaken marker during a carry", () => {
        /** A primary install on v1 with a mistaken marker: its own tenant, routed by its version. */
        const mistaken = async () => {
          // Its own tenant: a second install in the owner's would make every later preview push
          // ambiguous about which install it forks.
          const t2 = tenantId.parse(ulid());
          await dir.admin.createTenant(staff, { id: t2, slug: `carry-${t2.toLowerCase()}`, name: 'Clear Co' });
          const install = scopeId.parse(ulid());
          await dir.provisionScope(staff, { tenantId: t2, scopeId: install, vertical: slug });
          await dir.admin.activateScope(staff, t2, install);
          await dir.admin.bindScopeVersion(staff, t2, install, version.v1);
          // Routed by its bound version, so the bind below carries rather than re-pointing a pin.
          // (An install made after an earlier test promoted prod is born on the serving script; the
          // per-version route is the backout `setScopeServingRef(null)` documents.)
          await dir.admin.setScopeServingRef(staff, t2, install, null);
          const rec = await dir.admin.getScopeRecord(staff, t2, install);
          expect([rec?.servingRef ?? null, rec?.verticalVersionId]).toEqual([null, version.v1]);
          await hostFor('v1').restoreScopeLocal(install, notes('install data'));
          // The mistake staff will repair: a marker with no events mark on a primary's store.
          await v1stub(install).testForgetCopyOrigin();
          expect(await v1stub(install).markCopy()).toBe(true);
          return { t2, install };
        };
        const bindV2 = (t2: TenantId, install: ScopeId) =>
          api.request(`/tenants/${t2}/scopes/${install}/version`, {
            method: 'POST', headers: auth, body: JSON.stringify({ versionId: version.v2 }),
          });
        const clear = async (t2: TenantId, install: ScopeId) => {
          const res = await api.request(`/tenants/${t2}/scopes/${install}/clear-copy-mark`, { method: 'POST', headers: auth });
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ cleared: true });
        };
        const v2stub = (sid: ScopeId) => env.PC_V2_SCOPE.get(env.PC_V2_SCOPE.idFromName(sid)) as unknown as CopyStub;
        /** Whether v2's store runs an executor, as a CP-LESS host decides it: by its own marker. */
        const runsExecutorsOnV2 = async (t2: TenantId, install: ScopeId): Promise<boolean> => {
          const cpless = new CloudflareScopeHost({ scope: env.PC_V2_SCOPE });
          const ran: string[] = [];
          cpless.registerExecutor('clear-effector', 'pv.noted', async (_admin, event) => {
            ran.push(event.id);
          });
          const eventId = await writeOn('v2', install, `n-${ulid()}`, 'after the race', t2);
          const report = await cpless.drainDue(t2, install);
          expect(report.attempted).toBeGreaterThan(0);
          return ran.includes(eventId) && !report.inert;
        };
        const keptFailures = async (install: ScopeId) =>
          (await dir.admin.listOpsFailures(staff, { scopeId: install })).filter((f) => f.stage === 'source-copy-kept');

        it('before the re-check: the bind carries a fresh export, so the store it binds is unmarked', async () => {
          const { t2, install } = await mistaken();
          const held = holdFirst((ref, s) => ref === refOf.get(version.v2) && s === install);
          hooks.marker = held.hook; // after the export, before the restore and the re-check
          const bound = bindV2(t2, install);
          await held.reached;
          await clear(t2, install);
          held.release();
          expect((await bound).status).toBe(200);
          expect(await v2stub(install).isCopy()).toBe(false);
          expect(await runsExecutorsOnV2(t2, install)).toBe(true);
          // The source went the ordinary way: wiped, and nothing kept or recorded.
          expect(await tombstoneIn('v1', install)).not.toBeNull();
          expect(await hostFor('v1').keptCopyLocal(install)).toBeNull();
          expect(await keptFailures(install)).toEqual([]);
          expect(bodiesIn(await hostFor('v2').exportScopeLocal(install))).toContain('install data');
        });

        it('after the re-check: the carry brings the clear to the store it bound, then discards the source', async () => {
          const { t2, install } = await mistaken();
          const held = holdFirst((ref, s) => ref === refOf.get(version.v1) && s === install);
          hooks.markerRead = held.hook; // the re-check of the source, read; the bind is next
          const bound = bindV2(t2, install);
          await held.reached;
          await clear(t2, install);
          held.release();
          expect((await bound).status).toBe(200);
          expect(await v2stub(install).isCopy()).toBe(false);
          expect(await runsExecutorsOnV2(t2, install)).toBe(true);
          // The source held nothing but the clear, which now lives where the scope runs: discarded.
          expect(await tombstoneIn('v1', install)).not.toBeNull();
          expect(await hostFor('v1').keptCopyLocal(install)).toBeNull();
          expect(await keptFailures(install)).toEqual([]);
        });

        // Codex #2008 r13: the clear brought forward is this carry's, so it is fenced on this
        // carry's load of v2. A governed restore that replaced v2 since brings a GENUINE copy
        // marker (a copy of another scope), which must survive, inert, and v1 stays kept.
        /** A governed restore into `install`'s v2 store of ANOTHER scope's data, empty outbox, that
         *  marks it a copy. Since #2009 a load of another scope's data classifies nothing by itself,
         *  so the restore carries the classification, as a restore onto a copy does. */
        const foreignRestoreIntoV2 = async (install: ScopeId) => {
          const other = scopeId.parse(ulid());
          await hostFor('v2').restoreScopeLocal(other, notes('foreign data'));
          await hostFor('v2').restoreScopeLocal(install, await hostFor('v2').exportScopeLocal(other), {
            sourceScopeId: other,
            markCopy: { kind: 'preview', forkedFrom: other },
          });
          expect(await v2stub(install).isCopy()).toBe(true);
        };
        const clearedThenReplaced = async (land: (t2: TenantId, install: ScopeId) => void) => {
          const { t2, install } = await mistaken();
          land(t2, install);
          const held = holdFirst((ref, s) => ref === refOf.get(version.v1) && s === install);
          const landing = hooks.markerRead; // a `land` that hooks the same read runs beside the hold
          hooks.markerRead = async (ref, s, tables) => {
            await held.hook(ref, s, tables); // the re-check of the source; the clear lands after it
            await landing?.(ref, s, tables);
          };
          const bound = bindV2(t2, install);
          await held.reached;
          await clear(t2, install);
          held.release();
          expect((await bound).status).toBe(200);
          // The foreign copy keeps its genuine marker, and its executors stay inert.
          expect(await v2stub(install).isCopy()).toBe(true);
          expect(bodiesIn(await hostFor('v2').exportScopeLocal(install))).toContain('foreign data');
          expect(await runsExecutorsOnV2(t2, install)).toBe(false);
          // v1 still holds the clear and the data, kept and recorded, for staff.
          expect(await hostFor('v1').keptCopyLocal(install)).toMatchObject({ clearedOnly: expect.anything() });
          expect(await tombstoneIn('v1', install)).toBeNull();
          expect(bodiesIn(await hostFor('v1').exportScopeLocal(install))).toEqual(['install data']);
          expect(await keptFailures(install)).toHaveLength(1);
        };

        it('a governed restore that replaced v2 before the platform reads it: the foreign copy stays marked, v1 stays kept', async () => {
          await clearedThenReplaced((_t2, install) => {
            // As the platform turns to bring the clear forward: it reads v1's kept marker first.
            let done = false;
            hooks.kept = async (ref, s) => {
              if (done || ref !== refOf.get(version.v1) || s !== install) return;
              done = true;
              await foreignRestoreIntoV2(install);
            };
          });
        });

        it("a governed restore between the platform's read of v2 and its clear: refused in the clear's own transaction", async () => {
          await clearedThenReplaced((t2, install) => {
            // Right after the platform's read of v2's marker once the bind has landed, so only the
            // stamp compared inside the clear can tell (the read itself saw this carry's load).
            let done = false;
            hooks.markerRead = async (ref, s) => {
              if (done || ref !== refOf.get(version.v2) || s !== install) return;
              if ((await dir.admin.getScopeRecord(staff, t2, install))?.verticalVersionId !== version.v2) return;
              done = true;
              await foreignRestoreIntoV2(install);
            };
          });
        });

        it('a data write as well as the clear after the re-check: the source is kept with the write, and recorded', async () => {
          const { t2, install } = await mistaken();
          const held = holdFirst((ref, s) => ref === refOf.get(version.v1) && s === install);
          hooks.markerRead = held.hook;
          const bound = bindV2(t2, install);
          await held.reached;
          await writeOn('v1', install, 'n-late', 'written after the re-check');
          await clear(t2, install);
          held.release();
          expect((await bound).status).toBe(200);
          // Not clear-only: the write is the only copy of itself, so nothing is discarded or moved.
          const kept = await hostFor('v1').keptCopyLocal(install);
          expect(kept).not.toBeNull();
          expect(kept?.clearedOnly).toBeUndefined();
          expect(await tombstoneIn('v1', install)).toBeNull();
          expect(bodiesIn(await hostFor('v1').exportScopeLocal(install))).toEqual(['install data', 'written after the re-check']);
          expect(await v1stub(install).isCopy()).toBe(false);
          expect(await keptFailures(install)).toHaveLength(1);
        });
      });
    });

    it('of two pushes that read the same binding, the second bind is refused and its copy is wiped', async () => {
      const p = await fresh('race', 'race data');
      // B has exported v1's intact copy and is about to restore it into v3 when A lands whole.
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v3) && sid === p.scopeId);
      hooks.restore = held.hook;
      const b = push('race', 'v3');
      await held.reached;
      expect((await push('race', 'v2')).status).toBe(200);
      held.release();
      const refused = await b;
      expect(refused.status).toBe(412);
      // A's bind stands, serving v1's data from v2; B's restored copy did not survive the refusal.
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['race data'] });
      expect(bodiesIn(await hostFor('v3').exportScopeLocal(p.scopeId))).toEqual([]);
      expect(await tombstoneIn('v3', p.scopeId)).not.toBeNull();
      expect(await tombstoneIn('v1', p.scopeId)).not.toBeNull();
    });

    it("an export that reaches a copy another push already wiped is refused before it restores anything", async () => {
      const p = await fresh('late', 'late data');
      // B is held before its export; A lands whole and wipes v1; then B exports the wiped store.
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v1) && sid === p.scopeId);
      hooks.export = held.hook;
      const b = push('late', 'v3');
      await held.reached;
      expect((await push('late', 'v2')).status).toBe(200);
      held.release();
      const refused = await b;
      expect(refused.status).toBe(412);
      expect(refused.body.error).toMatch(/re-pointed while its data was being copied/);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['late data'] });
      // Nothing reached v3: no copy, and no tombstone either.
      expect(bodiesIn(await hostFor('v3').exportScopeLocal(p.scopeId))).toEqual([]);
      expect(await tombstoneIn('v3', p.scopeId)).toBeNull();
    });

    it('a carry refuses to copy a wiped store, even when the binding names it again', async () => {
      const p = await fresh('aba', 'aba data');
      expect((await push('aba', 'v2')).status).toBe(200);
      // A pointer-only bind back to v1 (no carry), so the binding names the wiped copy again.
      await dir.admin.bindScopeVersion(staff, t, p.scopeId, version.v1);
      const refused = await push('aba', 'v3');
      expect(refused.status).toBe(412);
      expect(refused.body.error).toMatch(/already carried to another script and wiped/);
      // Nothing was bound and nothing reached v3; v2's copy, the data, is still there.
      expect((await dir.admin.getScopeRecord(staff, t, p.scopeId))?.verticalVersionId).toBe(version.v1);
      expect(bodiesIn(await hostFor('v3').exportScopeLocal(p.scopeId))).toEqual([]);
      expect(bodiesIn(await hostFor('v2').exportScopeLocal(p.scopeId))).toEqual(['aba data']);
    });

    it('a retried push of the same version never wipes the store the preview serves', async () => {
      const p = await fresh('retry', 'retry data');
      // Two runs of the same job, both carrying v1 → v2. On a v2 built before #1722 the second
      // restores into v2 after the first has bound it (no write lands in between: the window the
      // binding re-read leaves there), and its bind is refused. The copy it would discard is the
      // winner's live store, so it is kept. A fenced v2 refuses the restore itself (above).
      unfenced.add(refOf.get(version.v2)!);
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v2) && sid === p.scopeId);
      hooks.restore = held.hook;
      const second = push('retry', 'v2');
      await held.reached;
      expect((await push('retry', 'v2')).status).toBe(200);
      held.release();
      expect((await second).status).toBe(412);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v2), bodies: ['retry data'] });
      expect(await tombstoneIn('v2', p.scopeId)).toBeNull();
    });

    it("a rollback that restores into the old script while the push's wipe is in flight keeps its data (fenced)", async () => {
      const p = await fresh('rb', 'rb data');
      // A has bound v2 and its wipe of v1 is on the wire when R (a bind back to v1) carries v2
      // into v1, binds, and wipes v2. A's wipe then arrives: v1 was loaded since A read it.
      const held = holdFirst((ref, sid) => ref === refOf.get(version.v1) && sid === p.scopeId);
      hooks.wipe = held.hook;
      const a = bindTo(p.scopeId, 'v2');
      await held.reached;
      expect((await bindTo(p.scopeId, 'v1')).status).toBe(200);
      held.release();
      expect((await a).status).toBe(200);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v1), bodies: ['rb data'] });
      expect(await tombstoneIn('v1', p.scopeId)).toBeNull();
      expect(await tombstoneIn('v2', p.scopeId)).not.toBeNull();
      // A's refused wipe hit the live store again, which is not a kept copy to recover: the marker
      // its protection set while R had not yet bound comes off once A reads the route there.
      const failures = await dir.admin.listOpsFailures(staff, { scopeId: p.scopeId });
      expect(failures.filter((f) => f.stage === 'source-copy-kept')).toEqual([]);
      expect(await hostFor('v1').keptCopyLocal(p.scopeId)).toBeNull();
    });

    it('on a script that cannot fence the wipe, a rollback that lands first keeps the old script', async () => {
      const p = await fresh('rb-first', 'first data');
      unfenced.add(refOf.get(version.v1)!);
      // A has bound v2 and stops right before it reads the route again to wipe v1; R binds the
      // scope back to v1 meanwhile. A then finds the scope routing to v1 and leaves it.
      const read = dir.admin.getScopeRecord.bind(dir.admin);
      const release = deferred();
      const reached = deferred();
      let reads = 0;
      const spy = vi.spyOn(dir.admin, 'getScopeRecord').mockImplementation(async (...args) => {
        // The first read of the scope after A's bind landed is A's cleanup reading the route.
        const record = await read(...args);
        if (args[2] === p.scopeId && reads === 0 && record?.verticalVersionId === version.v2) {
          reads += 1;
          reached.resolve();
          await release.promise;
          return read(...args);
        }
        return record;
      });
      try {
        const a = bindTo(p.scopeId, 'v2');
        await reached.promise;
        expect((await bindTo(p.scopeId, 'v1')).status).toBe(200);
        release.resolve();
        expect((await a).status).toBe(200);
      } finally {
        spy.mockRestore();
      }
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v1), bodies: ['first data'] });
      expect(await tombstoneIn('v1', p.scopeId)).toBeNull();
    });

    it('on a script that cannot fence the wipe, a rollback the wipe overtook carries its source again', async () => {
      const p = await fresh('rb-old', 'old data');
      unfenced.add(refOf.get(version.v1)!);
      // A's unconditional wipe of v1 (a tombstone load through the restore verb) is held; R
      // carries v2 into v1 and binds; A's wipe lands just before R looks at what it bound to.
      const aWipe = holdFirst((ref, sid, tables) =>
        ref === refOf.get(version.v1) && sid === p.scopeId && dumpMetaValue(tables ?? [], CARRIED_AWAY_KEY) !== null,
      );
      hooks.restore = aWipe.hook;
      const wiped = deferred();
      hooks.restored = async (ref, sid, tables) => {
        if (ref === refOf.get(version.v1) && sid === p.scopeId && dumpMetaValue(tables ?? [], CARRIED_AWAY_KEY) !== null) {
          wiped.resolve();
        }
      };
      let checked = false;
      hooks.read = async (ref, sid) => {
        if (checked || ref !== refOf.get(version.v1) || sid !== p.scopeId) return;
        checked = true;
        aWipe.release();
        await wiped.promise;
      };
      const a = bindTo(p.scopeId, 'v2');
      await aWipe.reached;
      expect((await bindTo(p.scopeId, 'v1')).status).toBe(200);
      expect(checked).toBe(true);
      expect((await a).status).toBe(200);
      expect(await served(p.hostname)).toEqual({ ref: refOf.get(version.v1), bodies: ['old data'] });
      expect(await tombstoneIn('v1', p.scopeId)).toBeNull();
      expect(await tombstoneIn('v2', p.scopeId)).not.toBeNull();
    });
  });
});
