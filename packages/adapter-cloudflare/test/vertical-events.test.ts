import { env } from 'cloudflare:test';
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
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import {
  BOARD_VERTICAL,
  CRM_VERTICAL,
  boardImportMod,
  crmExportMod,
  verticalEventsContractSuite,
} from '@substrat-run/contract-tests';
import { runPlatformSweep, ulid, webCryptoSecretBox, type FetchLike, type ModuleRegistration } from '@substrat-run/kernel';
import { mountPlatformSurface, type VerticalScopeHost } from '@substrat-run/vertical-host';
import { ControlPlaneError, VerticalClient, hostedCrossVerticalReach } from '@substrat-run/control-plane-api';
import { CloudflareScopeHost, type EventDrainDelegation } from '../src/host.js';
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
  return { producer, consumer, cleanup: async () => {} };
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
  });
  return {
    producer,
    consumer,
    transport,
    afterInstall: async (t, s, vertical) => {
      await (vertical === CRM_VERTICAL ? crm : board).provision(t, s);
    },
    // The suite ran over the wire, not around it: every verb crossed its deployment's
    // `/internal` surface. Without this, a suite that fell back to the in-process reach would
    // pass here and prove nothing about the transport.
    cleanup: async () => {
      expect(crm.paths).toContain('/internal/exported-events');
      expect(board.paths).toEqual(expect.arrayContaining(['/internal/import-state', '/internal/import-events']));
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

  it('over the wire the refusal is a 409, never an empty answer and never a "redeploy"', async () => {
    const e = await refusal(crm.client.exportedEvents({ tenantId: t, scopeId: foreign, input: read }));
    expect(e).toBeInstanceOf(ControlPlaneError);
    expect((e as ControlPlaneError).status).toBe(409);
    expect((e as ControlPlaneError).message).toContain('does not serve it');
    const s = await refusal(board.client.importState({ tenantId: u, scopeId: c }));
    expect((s as ControlPlaneError).status).toBe(409);
    // The twin: the same calls for the served pair answer.
    await expect(crm.client.exportedEvents({ tenantId: t, scopeId: p, input: read })).resolves.toMatchObject({ events: [] });
    // The batch the first case applied moved this watermark: the answer is the scope's real state.
    expect((await board.client.importState({ tenantId: t, scopeId: c })).cursors).toEqual([
      expect.objectContaining({ source: p, cursor: batch.next }),
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

  const sweepWith = async (crm: ReturnType<typeof deployment>) => {
    const reach = hostedCrossVerticalReach({
      admin: dir.admin,
      actor: staff,
      clientForScope: routeTo(crm, board),
    });
    const report = await runPlatformSweep(dir, {
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

  it('the same edge, once the producer is redeployed, delivers the backlog', async () => {
    const edge = await sweepWith(current);
    expect(edge).toMatchObject({ state: 'delivered', delivered: 1 });
  });
});
