import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  errorCodeOf,
  eventId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type RoleDefinition,
  type Scope,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  BOARD_VERTICAL,
  CRM_VERTICAL,
  boardImportMod,
  crmExportMod,
  testMod,
  verticalEventsContractSuite,
} from '@substrat-run/contract-tests';
import { crossVerticalHealth, runPlatformSweep, ulid, webCryptoSecretBox, type CandidatesHint, type FetchLike, type ModuleRegistration, type SweepRunInput } from '@substrat-run/kernel';
import { mountPlatformSurface, type VerticalScopeHost } from '@substrat-run/vertical-host';
import { ControlPlaneError, VerticalClient, hostedCrossVerticalReach } from '@substrat-run/control-plane-api';
import { CloudflareScopeHost, type EventDrainDelegation } from '../src/host.js';
import { kickCoalescerName, type KickCoalescerDo, type KickOutcome } from '../src/kick-coalescer-do.js';
import { warmControlPlane } from './do-warmup.js';

// #1705 on workerd: the export read (the (type, id) seek and the recursive hop walk), the
// import journal and the watermark's compare-and-set are DO SQL here, run by real Durable
// Objects. Two deployments, one class each, over a directory of their own.
verticalEventsContractSuite('adapter-cloudflare (workerd)', async () => {
  await warmControlPlane(env.VE_CONTROL_PLANE);
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const producer = new CloudflareScopeHost({ scope: env.CRM_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
  producer.registerModule(crmExportMod);
  const consumer = new CloudflareScopeHost({ scope: env.BOARD_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
  consumer.registerModule(boardImportMod);
  // Edge health's door read. This directory host serves the scopes itself and has no peer-switch
  // delegation, so its `peerGrantsStatus` refuses a scope bound to a vertical. The far end is the
  // same read the shared control plane's delegation makes.
  return { producer, consumer, door: async (_t, s) => consumer.peerGrantsStatusLocal(s), cleanup: async () => {} };
});

/**
 * #1705 on the SHARED control plane, which serves no scope's storage itself: every
 * cross-vertical verb refuses a scope bound to a vertical rather than answering from its own
 * module-less placeholder DO. Answering there is not a failure a caller would notice — the
 * read reports a hosted producer as having nothing to export, and a delivery journals a batch
 * into a scope that is not the one it names.
 *
 * `servesScopesElsewhere` is any delegation being set (#1706's own rule), so one delegation
 * that is never called stands the host up in that shape.
 */
describe('cross-vertical verbs on the shared control plane (#1705)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const hosted = scopeId.parse(ulid());
  const ownScope = scopeId.parse(ulid());
  const wants = [{ type: 'crm.customer-created', schemaVersion: 1 }];
  const batch = (scope: typeof hosted) => ({
    source: { vertical: CRM_VERTICAL, scopeId: scopeId.parse(ulid()) },
    after: null,
    next: eventId.parse(ulid()),
    events: [],
    withheld: [],
  });
  const unreached: EventDrainDelegation = {
    readUndrained: async () => {
      throw new Error('the delegation is never called by these verbs');
    },
    markDrained: async () => {
      throw new Error('the delegation is never called by these verbs');
    },
    redrain: async () => {
      throw new Error('the delegation is never called by these verbs');
    },
  };
  let shared: CloudflareScopeHost;

  beforeAll(async () => {
    await warmControlPlane(env.VE_CONTROL_PLANE);
    const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
    // The shape of the shared control plane: a delegation set, and the consumer vertical's
    // modules registered so `importState` gets past its "this deployment imports nothing" answer.
    shared = new CloudflareScopeHost({
      scope: env.BOARD_SCOPE,
      controlPlane: env.VE_CONTROL_PLANE,
      secretBox,
      eventDrainDelegation: unreached,
    });
    shared.registerModule(boardImportMod);
    await shared.admin.createTenant(staff, { id: t, slug: `ve-cp-${t.toLowerCase()}`, name: 'Shared CP' });
    await shared.admin.grantEntitlement(staff, t, 'board-import');
    await shared.admin.grantEntitlement(staff, t, 'crm-export');
    // One scope served by a vertical's own deployment, and one this host serves itself.
    await shared.provisionScope(staff, { tenantId: t, scopeId: hosted, vertical: BOARD_VERTICAL });
    await shared.admin.activateScope(staff, t, hosted);
    await shared.provisionScope(staff, { tenantId: t, scopeId: ownScope });
    await shared.admin.activateScope(staff, t, ownScope);
  });

  it('refuses the producer read, the consumer state read and a delivery for a hosted scope', async () => {
    const served = `is served by the '${BOARD_VERTICAL}' deployment`;
    await expect(
      shared.admin.readExportedEvents(staff, t, hosted, { consumer: BOARD_VERTICAL, after: null, wants, limit: 10 }),
    ).rejects.toThrow(served);
    await expect(shared.admin.importState(staff, t, hosted)).rejects.toThrow(served);
    await expect(shared.deliverToPeer(t, hosted, batch(hosted))).rejects.toThrow(served);
  });

  it('edge health with no reach says it cannot answer, rather than reporting no edges (#1705 PR 3)', async () => {
    const view = await crossVerticalHealth(shared, { actor: staff, tenantId: t });
    expect(view.unavailable).toMatch(/cannot reach the deployments/);
    expect(view.edges).toEqual([]);
    // The twin: the same host handed a reach answers (here: nothing imports into this tenant yet).
    const reached = await crossVerticalHealth(shared, {
      actor: staff,
      tenantId: t,
      crossVertical: {
        reach: {
          candidates: () => [],
          importState: async () => ({ consumes: [], cursors: [] }),
          readExports: async () => {
            throw new Error('not reached');
          },
          deliver: async () => {
            throw new Error('not reached');
          },
        },
      },
    });
    expect(reached.unavailable).toBeNull();
  });

  it('answers for a scope it does serve — the refusal is about WHERE the storage is, not the verb', async () => {
    const read = await shared.admin.readExportedEvents(staff, t, ownScope, {
      consumer: BOARD_VERTICAL,
      after: null,
      wants,
      limit: 10,
    });
    expect(read).toMatchObject({ events: [], paused: null });
    expect((await shared.admin.importState(staff, t, ownScope)).consumes.length).toBeGreaterThan(0);
  });
});

// -- #1705 PR 2: the hosted transport -------------------------------------------------------
//
// On the hosted path each vertical is its own deployment: a CP-less host over its own Durable
// Object class, reachable only through the platform-secret-gated `/internal` surface that
// `mountPlatformSurface` mounts. The control plane holds the directory and runs the phase, and
// reaches both ends of every edge with `hostedCrossVerticalReach` over `VerticalClient`. The
// fixtures below are exactly that: two deployments, one directory, and HTTP between them.

const PLATFORM_SECRET = 'hosted-vertical-events-secret';
const key = (k: string) => permissionKey.parse(k);
const CRM_OWNER: RoleDefinition = { key: 'crm-owner', permissions: [key('customer:write')], source: 'vertical' };
const BOARD_OWNER: RoleDefinition = { key: 'board-owner', permissions: [key('association:read')], source: 'vertical' };

/** The three cross-vertical routes and the host verb each calls: what an older script lacks. */
const CROSS_VERTICAL_ROUTES = {
  '/internal/exported-events': 'exportedEventsLocal',
  '/internal/import-state': 'importStateLocal',
  '/internal/import-events': 'importEventsLocal',
  '/internal/import-cursor': 'importCursorLocal',
} as const;
const CROSS_VERTICAL_VERBS = new Set<string>(Object.values(CROSS_VERTICAL_ROUTES));

/**
 * One vertical's deployment. `era` says how old its script is:
 * - `current`: this PR's routes over this PR's host;
 * - `host-predates`: the routes exist, but the host has no far end (the route answers 501);
 * - `routes-predate`: a script built before the routes (the paths are 404).
 */
function deployment(
  scope: DurableObjectNamespace,
  mod: ModuleRegistration,
  owner: RoleDefinition,
  era: 'current' | 'host-predates' | 'routes-predate' = 'current',
) {
  const app = new Hono<{ Bindings: Record<string, never> }>();
  if (era === 'routes-predate') {
    for (const path of Object.keys(CROSS_VERTICAL_ROUTES)) app.all(path, (c) => c.notFound());
  }
  const hostFor = (): CloudflareScopeHost => {
    const host = new CloudflareScopeHost({ scope });
    host.registerModule(mod);
    return host;
  };
  const surfaceHost = (): VerticalScopeHost => {
    const host = hostFor();
    if (era !== 'host-predates') return host;
    return new Proxy(host, {
      get: (target, prop) => {
        if (typeof prop === 'string' && CROSS_VERTICAL_VERBS.has(prop)) return undefined;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  mountPlatformSurface(app, {
    platformSecret: () => PLATFORM_SECRET,
    hostFor: surfaceHost,
    roles: [owner],
    ownerRoleKey: owner.key,
  });
  const paths: string[] = [];
  const client = new VerticalClient({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      paths.push(new URL(req.url).pathname);
      return app.fetch(req, {});
    }) as typeof fetch,
    platformSecret: PLATFORM_SECRET,
  });
  /** The vertical's own `/internal/provision` half of an install, and the owner it seats. */
  const provision = async (t: TenantId, s: ScopeId): Promise<PrincipalId> => {
    const ownerId = principalId.parse(ulid());
    await client.provisionInstance({ tenantId: t, scopeId: s, owner: ownerId, slug: 'hosted', name: 'hosted' });
    return ownerId;
  };
  return { client, hostFor, paths, provision };
}

/** The platform's routing for the two fixture verticals: each scope to its vertical's deployment. */
const routeTo =
  (crm: { client: VerticalClient }, board: { client: VerticalClient }) =>
  async (rec: { vertical: string | null }): Promise<VerticalClient | undefined> =>
    rec.vertical === CRM_VERTICAL ? crm.client : rec.vertical === BOARD_VERTICAL ? board.client : undefined;

verticalEventsContractSuite('adapter-cloudflare (workerd, hosted transport)', async () => {
  await warmControlPlane(env.VE_CONTROL_PLANE);
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  // The directory side, and the suite's own window into each scope for setup and assertions.
  const producer = new CloudflareScopeHost({ scope: env.CRM_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
  producer.registerModule(crmExportMod);
  const consumer = new CloudflareScopeHost({ scope: env.BOARD_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
  consumer.registerModule(boardImportMod);
  // The two deployments the platform reaches over `/internal`.
  const crm = deployment(env.CRM_SCOPE, crmExportMod, CRM_OWNER);
  const board = deployment(env.BOARD_SCOPE, boardImportMod, BOARD_OWNER);
  const { candidates: _registry, ...transport } = hostedCrossVerticalReach({
    admin: consumer.admin,
    actor: platformActorId.parse(ulid()),
    clientForScope: routeTo(crm, board),
    readImports: (slug, versionId) => consumer.versionImports(slug, versionId),
  });
  // #1705 PR 3: the replay lever as the shared control plane pulls it. The directory resolves the
  // producer and writes the admin rows, and the delegation moves the watermark in the consumer's
  // deployment, over its `/internal/import-cursor`, as `importCursorDelegationFor` does.
  const leverActor = platformActorId.parse(ulid());
  const leverHost = new CloudflareScopeHost({
    scope: env.BOARD_SCOPE,
    controlPlane: env.VE_CONTROL_PLANE,
    secretBox,
    // Edge health's door read, as the shared control plane makes it: over the consumer
    // deployment's `/internal/peer-grants`, with the admin log's reason joined here.
    peerSwitchDelegation: {
      switch: async () => {
        throw new Error('the suite switches peers on the deployments directly');
      },
      status: async (a) => {
        const rec = await consumer.admin.getScopeRecord(leverActor, a.tenantId, a.scopeId);
        const client = rec ? await routeTo(crm, board)(rec) : undefined;
        if (!client) throw new Error(`no deployment serving scope ${a.scopeId}`);
        return client.peerGrantsStatus({ scopeId: a.scopeId });
      },
    },
    importCursorDelegation: {
      move: async (a) => {
        const rec = await consumer.admin.getScopeRecord(leverActor, a.tenantId, a.scopeId);
        const client = rec ? await routeTo(crm, board)(rec) : undefined;
        if (!client) throw new Error(`no deployment serving scope ${a.scopeId}`);
        return client.importCursorMove(a);
      },
    },
  });
  return {
    producer,
    consumer,
    transport,
    lever: (t, s, move) => leverHost.admin.moveImportCursor(leverActor, t, s, move),
    door: (t, s) => leverHost.admin.peerGrantsStatus(leverActor, { tenantId: t, scopeId: s }),
    afterInstall: async (t, s, vertical) => {
      await (vertical === CRM_VERTICAL ? crm : board).provision(t, s);
    },
    // The suite ran over the wire, not around it: every verb crossed its deployment's
    // `/internal` surface. Without this, a suite that fell back to the in-process reach would
    // pass here and prove nothing about the transport.
    cleanup: async () => {
      expect(crm.paths).toContain('/internal/exported-events');
      expect(board.paths).toEqual(
        expect.arrayContaining(['/internal/import-state', '/internal/import-events', '/internal/import-cursor']),
      );
    },
  };
});

/**
 * #1705 PR 2: a CP-less deployment has no directory to say which scopes it serves, and an
 * unprovisioned Durable Object answers every read with a plausible empty result: "nothing to
 * export", "never read anything". Each far end therefore proves the scope was provisioned HERE,
 * for THIS tenant, before it answers, and refuses `conflict` otherwise, which the platform can
 * never mistake for "this deployment predates the route" (404 → 501).
 */
describe('the cross-vertical far ends refuse a scope this deployment does not serve (#1705 PR 2)', () => {
  const crm = deployment(env.CRM_SCOPE, crmExportMod, CRM_OWNER);
  const board = deployment(env.BOARD_SCOPE, boardImportMod, BOARD_OWNER);
  const t = tenantId.parse(ulid());
  const u = tenantId.parse(ulid());
  const p = scopeId.parse(ulid());
  const c = scopeId.parse(ulid());
  const foreign = scopeId.parse(ulid());
  const read = { consumer: BOARD_VERTICAL, after: null, wants: [{ type: 'crm.customer-created', schemaVersion: 1 }], limit: 10 };
  const batch = {
    source: { vertical: CRM_VERTICAL, scopeId: p },
    after: null,
    next: eventId.parse(ulid()),
    events: [],
    withheld: [],
  };
  const refusal = (x: Promise<unknown>) => x.then(() => undefined, (e: unknown) => e);

  beforeAll(async () => {
    await crm.provision(t, p);
    await board.provision(t, c);
  });

  it('answers for a scope it provisioned, for its tenant', async () => {
    await expect(crm.hostFor().exportedEventsLocal(t, p, read)).resolves.toMatchObject({ paused: null, events: [] });
    expect((await board.hostFor().importStateLocal(t, c)).consumes.length).toBeGreaterThan(0);
    await expect(board.hostFor().importEventsLocal(t, c, batch)).resolves.toMatchObject({ stale: false });
  });

  it('refuses a scope it never provisioned — each of the three verbs', async () => {
    expect(errorCodeOf(await refusal(crm.hostFor().exportedEventsLocal(t, foreign, read)))).toBe('conflict');
    expect(errorCodeOf(await refusal(board.hostFor().importStateLocal(t, foreign)))).toBe('conflict');
    expect(errorCodeOf(await refusal(board.hostFor().importEventsLocal(t, foreign, batch)))).toBe('conflict');
  });

  it('refuses its own scope named under another tenant (K-3)', async () => {
    expect(errorCodeOf(await refusal(crm.hostFor().exportedEventsLocal(u, p, read)))).toBe('conflict');
    expect(errorCodeOf(await refusal(board.hostFor().importStateLocal(u, c)))).toBe('conflict');
    expect(errorCodeOf(await refusal(board.hostFor().importEventsLocal(u, c, batch)))).toBe('conflict');
  });

  it('the replay lever\'s far end refuses a scope it never provisioned, or its own under another tenant (#1705 PR 3)', async () => {
    const at = {
      move: { mode: 'skip' as const, from: CRM_VERTICAL, through: 'now' as const, acknowledge: 'skip-events' as const, reason: 'r' },
      source: { vertical: CRM_VERTICAL, scopeId: p },
      replayId: ulid(),
    };
    expect(errorCodeOf(await refusal(board.hostFor().importCursorLocal(t, foreign, at)))).toBe('conflict');
    expect(errorCodeOf(await refusal(board.hostFor().importCursorLocal(u, c, at)))).toBe('conflict');
    // The twin: its own scope, for its own tenant, moves.
    await expect(board.hostFor().importCursorLocal(t, c, at)).resolves.toMatchObject({ mode: 'skip', replayId: at.replayId });
  });

  it('a deployment that imports nothing still refuses a scope it does not serve, before saying so', async () => {
    // Its "imports nothing" is a fact about its code. Given for a foreign scope it would read, to
    // the platform, as a scope that imports nothing, when the truth is that it asked the wrong
    // deployment.
    const importsNothing = new CloudflareScopeHost({ scope: env.CRM_SCOPE });
    importsNothing.registerModule(testMod);
    expect(errorCodeOf(await refusal(importsNothing.importStateLocal(t, foreign)))).toBe('conflict');
    await expect(importsNothing.importStateLocal(t, p)).resolves.toEqual({ consumes: [], cursors: [] });
  });

  it('a host WITH a directory decides from the directory, not from projected roles', async () => {
    const staff = platformActorId.parse(ulid());
    const d = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await warmControlPlane(env.VE_CONTROL_PLANE);
    const full = new CloudflareScopeHost({
      scope: env.CRM_SCOPE,
      controlPlane: env.VE_CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    full.registerModule(crmExportMod);
    await full.admin.createTenant(staff, { id: d, slug: `ve-full-${d.toLowerCase()}`, name: 'Full' });
    // Provisioned through the directory only: no local provision, so no projected role rows.
    await full.provisionScope(staff, { tenantId: d, scopeId: s, vertical: CRM_VERTICAL });
    await full.admin.activateScope(staff, d, s);
    await expect(full.exportedEventsLocal(d, s, read)).resolves.toMatchObject({ events: [] });
    // The twin: a pair the directory does not know is refused, as on a CP-less host.
    expect(errorCodeOf(await refusal(full.exportedEventsLocal(d, foreign, read)))).toBe('conflict');
    expect(errorCodeOf(await refusal(full.exportedEventsLocal(u, s, read)))).toBe('conflict');
  });

  it('over the wire the refusal is a 409, never an empty answer and never a "redeploy"', async () => {
    const e = await refusal(crm.client.exportedEvents({ tenantId: t, scopeId: foreign, input: read }));
    expect(e).toBeInstanceOf(ControlPlaneError);
    expect((e as ControlPlaneError).status).toBe(409);
    expect((e as ControlPlaneError).message).toContain('does not serve it');
    const s = await refusal(board.client.importState({ tenantId: u, scopeId: c }));
    expect((s as ControlPlaneError).status).toBe(409);
    // The twin: the same calls for the served pair answer.
    await expect(crm.client.exportedEvents({ tenantId: t, scopeId: p, input: read })).resolves.toMatchObject({ events: [] });
    // Self-contained: apply this case's own batch from wherever the watermark stands, over the
    // wire, then read it back. The answer is the scope's real state, not an empty default.
    const before = await board.client.importState({ tenantId: t, scopeId: c });
    const mine = {
      ...batch,
      after: before.cursors.find((x) => x.source === p)?.cursor ?? null,
      next: eventId.parse(ulid()),
    };
    await expect(board.client.importEvents({ tenantId: t, scopeId: c, batch: mine })).resolves.toMatchObject({ stale: false });
    expect((await board.client.importState({ tenantId: t, scopeId: c })).cursors).toEqual([
      expect.objectContaining({ source: p, cursor: mine.next }),
    ]);
  });
});

/**
 * #1705 PR 2 — version skew. A producer whose deployment predates the routes must stop its
 * edges with a "redeploy", never answer as a producer with nothing new: an empty export list and
 * "this deployment cannot answer" must not look alike, or an edge sits `idle` forever over a
 * backlog. Held through the whole phase, on the control plane's own reach.
 */
describe('a producer deployment that predates the cross-vertical routes (#1705 PR 2)', () => {
  const staff = platformActorId.parse(ulid());
  const noFetch: FetchLike = async () => new Response('unused');
  let dir: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const p = scopeId.parse(ulid());
  const c = scopeId.parse(ulid());
  const current = deployment(env.CRM_SCOPE, crmExportMod, CRM_OWNER);
  const board = deployment(env.BOARD_SCOPE, boardImportMod, BOARD_OWNER);

  const sweepWith = async (crm: ReturnType<typeof deployment>, consumer = board, runs: SweepRunInput[] = []) => {
    const reach = hostedCrossVerticalReach({
      admin: dir.admin,
      actor: staff,
      clientForScope: routeTo(crm, consumer),
      readImports: (slug, versionId) => dir.versionImports(slug, versionId),
    });
    const report = await runPlatformSweep(dir, {
      recordSweepRun: (e) => runs.push(e),
      actor: staff,
      fetch: noFetch,
      sweepers: {},
      drainRetries: false,
      gcSnapshots: false,
      reconcileMigrations: false,
      runSchedules: false,
      crossVertical: { reach: { ...reach, candidates: (scopes) => scopes.filter((s) => s.tenantId === t) } },
    });
    return (report.crossVertical?.edges ?? []).find((e) => e.consumer.scopeId === c);
  };

  beforeAll(async () => {
    await warmControlPlane(env.VE_CONTROL_PLANE);
    const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
    dir = new CloudflareScopeHost({ scope: env.BOARD_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
    dir.registerModule(boardImportMod);
    const crmDir = new CloudflareScopeHost({ scope: env.CRM_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
    crmDir.registerModule(crmExportMod);
    await dir.admin.createTenant(staff, { id: t, slug: `ve-skew-${t.toLowerCase()}`, name: 'Skew' });
    await crmDir.provisionScope(staff, { tenantId: t, scopeId: p, vertical: CRM_VERTICAL });
    await dir.admin.activateScope(staff, t, p);
    await dir.provisionScope(staff, { tenantId: t, scopeId: c, vertical: BOARD_VERTICAL });
    await dir.admin.activateScope(staff, t, c);
    const owner = await current.provision(t, p);
    await board.provision(t, c);
    await (await current.hostFor().getScope(owner, t, p)).invoke('crm/create', { name: 'Waiting' });
  });

  for (const era of ['routes-predate', 'host-predates'] as const) {
    it(`${era}: the edge fails naming the redeploy, and the watermark holds`, async () => {
      const old = deployment(env.CRM_SCOPE, crmExportMod, CRM_OWNER, era);
      const edge = await sweepWith(old);
      expect(edge).toMatchObject({ state: 'failed', delivered: 0 });
      expect(edge?.reason).toMatch(/redeploy/);
      expect(old.paths).toContain('/internal/exported-events');
      expect((await board.client.importState({ tenantId: t, scopeId: c })).cursors).toEqual([]);
    });
  }

  // The consumer's two routes, on an old CONSUMER deployment: each is a 501 saying to redeploy,
  // from the route itself (`host-predates`) or from the client reading the 404 (`routes-predate`).
  // Never "imports nothing" or a batch reported as applied.
  for (const era of ['routes-predate', 'host-predates'] as const) {
    it(`${era} consumer: import-state and import-events answer 501, naming the redeploy`, async () => {
      const old = deployment(env.BOARD_SCOPE, boardImportMod, BOARD_OWNER, era);
      const said = era === 'routes-predate' ? /predates cross-vertical events/ : /cannot import events.*redeploy it/;
      const batch = {
        source: { vertical: CRM_VERTICAL, scopeId: p },
        after: null,
        next: eventId.parse(ulid()),
        events: [],
        withheld: [],
      };
      for (const call of [
        () => old.client.importState({ tenantId: t, scopeId: c }),
        () => old.client.importEvents({ tenantId: t, scopeId: c, batch }),
      ]) {
        const e = (await call().then(() => null, (err: unknown) => err)) as ControlPlaneError;
        expect(e).toBeInstanceOf(ControlPlaneError);
        expect(e.status).toBe(501);
        expect(e.message).toMatch(said);
      }
      expect(old.paths).toEqual(['/internal/import-state', '/internal/import-events']);
    });

    // #1705 PR 3: the lever on an old consumer deployment. A 501 either way, and "nothing moved"
    // is true, because the route never ran. Never a move reported as made.
    it(`${era} consumer: import-cursor answers 501, and the watermark holds`, async () => {
      const old = deployment(env.BOARD_SCOPE, boardImportMod, BOARD_OWNER, era);
      const said = era === 'routes-predate' ? /predates cross-vertical events/ : /cannot move an import watermark.*redeploy it/;
      const before = (await board.client.importState({ tenantId: t, scopeId: c })).cursors;
      const e = (await old.client
        .importCursorMove({
          tenantId: t,
          scopeId: c,
          at: {
            move: { mode: 'skip', from: CRM_VERTICAL, through: 'now', acknowledge: 'skip-events', reason: 'skew' },
            source: { vertical: CRM_VERTICAL, scopeId: p },
            replayId: ulid(),
          },
        })
        .then(() => null, (err: unknown) => err)) as ControlPlaneError;
      expect(e).toBeInstanceOf(ControlPlaneError);
      expect(e.status).toBe(501);
      expect(e.message).toMatch(said);
      expect((await board.client.importState({ tenantId: t, scopeId: c })).cursors).toEqual(before);
    });
  }

  it('an old consumer deployment is a failed edge to "*" in the sweep-run rows, never a silent skip', async () => {
    const runs: SweepRunInput[] = [];
    const edge = await sweepWith(current, deployment(env.BOARD_SCOPE, boardImportMod, BOARD_OWNER, 'routes-predate'), runs);
    expect(edge).toMatchObject({ state: 'failed', producer: { vertical: '*' } });
    // The board consumer's rows. (crm imports from board too, and reads through the same old
    // deployment, so its own producer-side edge fails beside this one, as it should.)
    expect(runs.filter((r) => r.unit.startsWith(`${c}:`))).toEqual([
      expect.objectContaining({ kind: 'vertical-events', unit: `${c}:*`, outcome: 'failed', error: expect.stringMatching(/redeploy/) }),
    ]);
  });

  it('the same edge, once the producer is redeployed, delivers the backlog', async () => {
    const edge = await sweepWith(current);
    expect(edge).toMatchObject({ state: 'delivered', delivered: 1 });
  });
});

/**
 * #1705 PR 2 — the control plane's narrowing against a REAL directory and stored manifests,
 * not a fake admin. Which scopes the phase calls is read from each running version's pushed
 * manifest, through the unaudited `versionImports`: a fleet whose versions import nothing makes
 * zero `/internal` calls, and passes over known versions write no access row.
 */
describe('the hosted narrowing over a real directory (#1705 PR 2)', () => {
  const staff = platformActorId.parse(ulid());
  const sweeper = platformActorId.parse(ulid());
  const noFetch: FetchLike = async () => new Response('unused');
  const t = tenantId.parse(ulid());
  const NONE = ulid();
  const IMPORTS = ulid();
  const quiet = [ulid(), ulid(), ulid(), ulid()].map((id) => scopeId.parse(id));
  const importer = scopeId.parse(ulid());
  let dir: CloudflareScopeHost;
  const board = deployment(env.BOARD_SCOPE, boardImportMod, BOARD_OWNER);

  const manifest = (registry: object) =>
    JSON.stringify({
      version: '1.0.0',
      entry: 'worker.js',
      compatibilityDate: '2025-01-01',
      doClasses: ['ScopeDO'],
      bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
      digests: { manifest: 'm', permission: 'p', migration: 'g' },
      registry,
    });

  const pass = async () => {
    const reach = hostedCrossVerticalReach({
      admin: dir.admin,
      actor: sweeper,
      clientForScope: async (rec) => (rec.vertical === BOARD_VERTICAL ? board.client : undefined),
      readImports: (slug, versionId) => dir.versionImports(slug, versionId),
    });
    const real = reach.candidates!;
    // The real narrowing, over this tenant's rows. The directory is shared with the other
    // describes here, whose scopes carry no version and would (rightly) be kept as doubt.
    const scoped = { ...reach, candidates: (all: readonly Scope[], hint?: CandidatesHint) => real(all.filter((x) => x.tenantId === t), hint) };
    return runPlatformSweep(dir, {
      actor: sweeper,
      fetch: noFetch,
      sweepers: {},
      drainRetries: false,
      gcSnapshots: false,
      reconcileMigrations: false,
      runSchedules: false,
      crossVertical: { reach: scoped },
    });
  };

  beforeAll(async () => {
    await warmControlPlane(env.VE_CONTROL_PLANE);
    const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
    dir = new CloudflareScopeHost({ scope: env.BOARD_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
    dir.registerModule(boardImportMod);
    await dir.admin.createTenant(staff, { id: t, slug: `ve-narrow-${t.toLowerCase()}`, name: 'Narrow' });
    await dir.admin.registerVertical(staff, { slug: BOARD_VERTICAL, name: 'Board', source: 'cli', ownerTenant: t });
    const publish = (id: string, registry: object) =>
      dir.admin.publishVersion(staff, {
        id,
        verticalSlug: BOARD_VERTICAL,
        version: id,
        manifestDigest: `m-${id}`,
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: `board-${id.toLowerCase()}`,
        manifestJson: manifest(registry),
      });
    await publish(NONE, { permissions: [], roles: [], entityGrants: [] });
    await publish(IMPORTS, {
      permissions: [],
      roles: [],
      entityGrants: [],
      imports: [{ from: CRM_VERTICAL, type: 'crm.customer-created', schemaVersion: 1, declaredBy: ['@test/board-import'] }],
    });
    for (const [s, v] of [...quiet.map((q) => [q, NONE] as const), [importer, IMPORTS] as const]) {
      await dir.provisionScope(staff, { tenantId: t, scopeId: s, vertical: BOARD_VERTICAL });
      await dir.admin.activateScope(staff, t, s);
      await dir.admin.bindScopeVersion(staff, t, s, v);
    }
  });

  it('a version whose manifest imports nothing costs its scopes zero /internal calls; the importing one is asked', async () => {
    board.paths.length = 0;
    await pass();
    // Four scopes on a version that imports nothing: never called. One on a version that does: asked once.
    expect(board.paths).toEqual(['/internal/import-state']);
  });

  it('passes over known versions write no access row, where the audited read would write one per call', async () => {
    // Every actor, not only the sweeper's: a registry read audited under ANY actor is the cost.
    const registryRows = async () =>
      [
        ...(await dir.admin.accessLog(staff, { method: 'versionManifest' })),
        ...(await dir.admin.accessLog(staff, { method: 'versionImports' })),
      ].length;
    await pass();
    await pass();
    await pass();
    expect(await registryRows()).toBe(0);
    // The twin: the audited verb does write one, which is why the narrowing does not use it.
    await dir.admin.versionManifest(sweeper, BOARD_VERTICAL, NONE);
    expect((await dir.admin.accessLog(staff, { actor: sweeper, method: 'versionManifest' })).length).toBe(1);
  });
});

/**
 * #1705 PR 2 — the router kick's global bound. A tenant's code sets the response header that
 * asks for a kick, so it can ask on every response. One Durable Object per producer holds the
 * only state that decides how often a pass runs: passes for one producer start at least a window
 * apart, and a burst costs one pass plus one trailing pass, whatever the tenant sends.
 */
describe('the cross-vertical kick is coalesced per producer, fleet-wide (#1705 PR 2)', () => {
  const log = () => env.KICK_LOG.get(env.KICK_LOG.idFromName('log')) as unknown as { lines(): Promise<string[]> };
  const passesFor = async (s: string) => (await log().lines()).filter((l) => l.endsWith(`:${s}`) && l.startsWith('pass:'));
  const coalescer = (ns: DurableObjectNamespace, t: string, s: string) =>
    ns.get(ns.idFromName(kickCoalescerName(tenantId.parse(t), scopeId.parse(s))));
  const kick = (stub: DurableObjectStub, t: string, s: string): Promise<KickOutcome> =>
    (stub as unknown as KickCoalescerDo).kick(tenantId.parse(t), scopeId.parse(s));

  /** Move the recorded start of the last pass back past the window, instead of waiting it out. */
  const windowOver = (stub: DurableObjectStub) =>
    runInDurableObject(stub, async (_i, state) => {
      const st = await state.storage.get<{ lastStartedAt: number }>('state');
      if (st) await state.storage.put('state', { ...st, lastStartedAt: st.lastStartedAt - 61_000 });
    });
  const storageOf = (stub: DurableObjectStub) =>
    runInDurableObject(stub, async (_i, state) => ({
      keys: [...(await state.storage.list()).keys()],
      alarm: await state.storage.getAlarm(),
    }));

  it('a burst of kicks inside the window is one pass, then one trailing pass by alarm, then the object clears', async () => {
    const t = ulid();
    const s = ulid();
    const stub = coalescer(env.KICK_TEST, t, s);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => kick(stub, t, s)));
    expect(outcomes.filter((o) => o === 'ran')).toHaveLength(1);
    expect(outcomes.filter((o) => o !== 'ran')).toHaveLength(7);
    expect(await passesFor(s)).toHaveLength(1);
    // The trailing pass is armed for the window's end, not run now.
    expect((await storageOf(stub)).alarm).not.toBeNull();
    await windowOver(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await passesFor(s)).toHaveLength(2);
    // Nothing was kicked since the trailing pass started: its window's end runs no third pass,
    // and clears the object, so a producer that kicked once leaves no storage behind.
    await windowOver(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await passesFor(s)).toHaveLength(2);
    expect(await storageOf(stub)).toEqual({ keys: [], alarm: null });
  });

  it('a kick during a pass that has outlasted its window joins it, never a second pass beside it', async () => {
    const t = ulid();
    const s = ulid();
    const stub = coalescer(env.KICK_SLOW, t, s);
    const lines = async () => (await log().lines()).filter((l) => l.endsWith(`:${s}`));
    const first = kick(stub, t, s);
    // Wait on the pass's own signal, not the clock.
    for (let i = 0; i < 3000 && !(await lines()).includes(`start:${s}`); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(await kick(stub, t, s)).toBe('coalesced');
    await (env.KICK_LOG.get(env.KICK_LOG.idFromName('log')) as unknown as { record(l: string): Promise<void> }).record(`release:${s}`);
    expect(await first).toBe('ran');
    // One pass, start to end, with nothing started inside it.
    expect(await lines()).toEqual([`start:${s}`, `release:${s}`, `end:${s}`]);
  });

  it('an alarm before the window has passed runs nothing and re-arms', async () => {
    const t = ulid();
    const s = ulid();
    const stub = coalescer(env.KICK_TEST, t, s);
    expect(await kick(stub, t, s)).toBe('ran');
    expect(await kick(stub, t, s)).toBe('deferred');
    await runDurableObjectAlarm(stub);
    expect(await passesFor(s)).toHaveLength(1);
    expect((await storageOf(stub)).alarm).not.toBeNull();
  });

  it('two producers do not coalesce with each other', async () => {
    const t = ulid();
    const [a, b] = [ulid(), ulid()];
    expect(await kick(coalescer(env.KICK_TEST, t, a), t, a)).toBe('ran');
    expect(await kick(coalescer(env.KICK_TEST, t, b), t, b)).toBe('ran');
    expect(await passesFor(a)).toHaveLength(1);
    expect(await passesFor(b)).toHaveLength(1);
  });

  it('a pass that throws does not fail the kick: it is lost, and the sweep is the backstop', async () => {
    const t = ulid();
    const s = ulid();
    await expect(kick(coalescer(env.KICK_THROW, t, s), t, s)).resolves.toBe('ran');
  });

  it('holds no authority: a kick naming a fork, a preview, or another tenant, runs no edge through the real pass', async () => {
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const u = tenantId.parse(ulid());
    const p = scopeId.parse(ulid());
    await warmControlPlane(env.VE_CONTROL_PLANE);
    const dir = new CloudflareScopeHost({
      scope: env.CRM_SCOPE,
      controlPlane: env.VE_CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    dir.registerModule(crmExportMod);
    await dir.admin.createTenant(staff, { id: t, slug: `ve-kick-${t.toLowerCase()}`, name: 'Kick' });
    await dir.provisionScope(staff, { tenantId: t, scopeId: p, vertical: CRM_VERTICAL });
    await dir.admin.activateScope(staff, t, p);
    const fork = await dir.snapshotScope(staff, t, p);
    // A CLEAN-ROOM preview: fresh, not forked, so only its kind says it is not the install.
    // (A snapshot preview is also a fork, and the fork rule would refuse it first.)
    const preview = scopeId.parse(ulid());
    await dir.provisionScope(staff, { tenantId: t, scopeId: preview, vertical: CRM_VERTICAL, kind: 'preview' });
    await dir.admin.activateScope(staff, t, preview);
    expect(await dir.admin.getScopeRecord(staff, t, preview)).toMatchObject({ kind: 'preview', forkedFrom: null });
    const lines = async (s: string) => (await log().lines()).filter((l) => l.includes(s));

    await kick(coalescer(env.KICK_REAL, t, fork), t, fork);
    await kick(coalescer(env.KICK_REAL, t, preview), t, preview);
    await kick(coalescer(env.KICK_REAL, u, p), u, p);
    // Each pass ran, and none got as far as asking for a consumer.
    expect(await lines(fork)).toEqual([`pass:${fork}`]);
    expect(await lines(preview)).toEqual([`pass:${preview}`]);
    expect((await lines(p)).filter((l) => l.startsWith('candidates:'))).toEqual([]);

    // The twin: the real producer, under its own tenant, is resolved and its consumers asked for.
    await kick(coalescer(env.KICK_REAL, t, p), t, p);
    expect((await lines(p)).filter((l) => l.startsWith('candidates:'))).toEqual([`candidates:${p}:${CRM_VERTICAL}`]);
  });
});
