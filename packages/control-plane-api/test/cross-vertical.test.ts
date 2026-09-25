import { describe, it, expect } from 'vitest';
import { eventId, platformActorId, scopeId, tenantId, type Scope } from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type FetchLike, type ScopeHost } from '@substrat-run/kernel';
import { ControlPlaneError, VerticalClient, hostedCrossVerticalReach } from '../src/index.js';

/**
 * The hosted transport for cross-vertical events (#1705 PR 2), as the control plane sees it:
 * the three `VerticalClient` verbs and the reach the scheduled sweep and the router kick run on.
 * The far ends are exercised on workerd (adapter-cloudflare `vertical-events.test.ts`); here the
 * wire is faked so each rule is held on its own.
 */

const t = tenantId.parse(ulid());
const s = scopeId.parse(ulid());
const ACTOR = platformActorId.parse(ulid());
const read = { consumer: 'acme/board', after: null, wants: [{ type: 'crm.a', schemaVersion: 1 }], limit: 10 } as never;
const emptyBatch = { events: [], withheld: [], unexported: [], paused: null, next: null, more: false };
const batch = {
  source: { vertical: 'acme/crm', scopeId: s },
  after: null,
  next: eventId.parse(ulid()),
  events: [],
  withheld: [],
} as never;

const answering = (res: () => Response, seen: { method: string; path: string; body: unknown }[] = []) =>
  new VerticalClient({
    fetch: (async (u: string, init?: RequestInit) => {
      seen.push({
        method: init?.method ?? 'GET',
        path: new URL(u).pathname + new URL(u).search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return res();
    }) as unknown as typeof fetch,
    platformSecret: 'secret',
  });
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ControlPlaneError);

describe('VerticalClient — the cross-vertical verbs (#1705 PR 2)', () => {
  const verbs = {
    exportedEvents: (c: VerticalClient) => c.exportedEvents({ tenantId: t, scopeId: s, input: read }),
    importState: (c: VerticalClient) => c.importState({ tenantId: t, scopeId: s }),
    importEvents: (c: VerticalClient) => c.importEvents({ tenantId: t, scopeId: s, batch }),
  };

  it('each verb reaches its route with the pair the platform resolved', async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    await verbs.exportedEvents(answering(() => new Response(JSON.stringify(emptyBatch)), seen));
    await verbs.importState(answering(() => new Response(JSON.stringify({ consumes: [], cursors: [] })), seen));
    await verbs.importEvents(
      answering(
        () =>
          new Response(
            JSON.stringify({ delivered: 0, deadLettered: 0, duplicates: 0, withheld: 0, cursor: null, stale: false, paused: null }),
          ),
        seen,
      ),
    );
    expect(seen).toEqual([
      { method: 'POST', path: '/internal/exported-events', body: { tenantId: t, scopeId: s, input: read } },
      { method: 'GET', path: `/internal/import-state?tenantId=${t}&scopeId=${s}`, body: undefined },
      { method: 'POST', path: '/internal/import-events', body: { tenantId: t, scopeId: s, batch } },
    ]);
  });

  it('an empty export list is a real answer, and comes back as one', async () => {
    await expect(verbs.exportedEvents(answering(() => new Response(JSON.stringify(emptyBatch))))).resolves.toEqual(emptyBatch);
  });

  describe.each(Object.entries(verbs))('%s', (_name, call) => {
    it.each([
      ['a route the deployment does not have (404)', () => new Response('404 Not Found', { status: 404 })],
      ['an SPA shell (200, not JSON)', () => new Response('<!doctype html><html></html>', { status: 200 })],
    ])('%s is a 501 that says to redeploy — never an empty answer', async (_why, res) => {
      const err = await failure(call(answering(res)));
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect(err!.status).toBe(501);
      expect(err!.message).toMatch(/predates cross-vertical events \(#1705\) — redeploy the vertical/);
    });

    it("the far end's own 501 (a host without the verb) passes through verbatim", async () => {
      const err = await failure(
        call(answering(() => new Response(JSON.stringify({ error: 'this deployment cannot … (#1705) — redeploy it' }), { status: 501 }))),
      );
      expect(err!.status).toBe(501);
      expect(err!.message).toBe('this deployment cannot … (#1705) — redeploy it');
    });

    it("the far end's served-here refusal stays a 409, not a redeploy", async () => {
      const err = await failure(
        call(answering(() => new Response(JSON.stringify({ error: 'does not serve it' }), { status: 409 }))),
      );
      expect(err!.status).toBe(409);
      expect(err!.message).toBe('does not serve it');
    });

    it('a 200 JSON of the wrong shape is a 502, never a guess', async () => {
      const err = await failure(call(answering(() => new Response(JSON.stringify({ ok: true })))));
      expect(err!.status).toBe(502);
      expect(err!.message).toMatch(/unexpected shape/);
    });

    it('a transport failure is the 502 it is', async () => {
      const client = new VerticalClient({
        fetch: (() => Promise.reject(new Error('Network connection lost'))) as unknown as typeof fetch,
        platformSecret: 'secret',
      });
      const err = await failure(call(client));
      expect(err!.status).toBe(502);
      expect(err!.message).toMatch(/unreachable during .*Network connection lost/);
    });
  });
});

/**
 * The cost bound, on the reach the control plane actually passes (#1705 PR 2). Every scope call
 * is a Durable Object wake plus an `/internal` hop, and the phase runs on a fleet-wide cron, so
 * which scopes it calls is decided from the version registry. A fleet whose running versions
 * import nothing makes no `/internal` call at all.
 */
describe('hostedCrossVerticalReach — the hosted cost bound (#1705 PR 2)', () => {
  const NONE = '01JZ0000000000000000000V01';
  const IMPORTS = '01JZ0000000000000000000V02';
  const manifests: Record<string, string> = {
    [NONE]: JSON.stringify({ registry: { permissions: [], roles: [] } }),
    [IMPORTS]: JSON.stringify({
      registry: {
        permissions: [],
        roles: [],
        imports: [{ from: 'acme/crm', type: 'crm.a', schemaVersion: 1, declaredBy: ['@x/board'] }],
      },
    }),
  };
  const scopesOn = (n: number, versionId: string): Scope[] =>
    Array.from(
      { length: n },
      () =>
        ({
          id: scopeId.parse(ulid()),
          tenantId: t,
          status: 'active',
          vertical: 'acme/board',
          verticalVersionId: versionId,
          kind: 'app',
          forkedFrom: null,
        }) as unknown as Scope,
    );
  /** One pass over `scopes` through the real reach, with a client that records each call. */
  const run = async (
    scopes: Scope[],
    clientForScope?: Parameters<typeof hostedCrossVerticalReach>[0]['clientForScope'],
  ) => {
    const calls: string[] = [];
    const client = new VerticalClient({
      fetch: (async (u: string) => {
        calls.push(new URL(u).pathname + new URL(u).search);
        return new Response(JSON.stringify({ consumes: [], cursors: [] }));
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const admin = {
      listScopes: async () => scopes,
      listConnections: async () => [],
      listVerticals: async () => [],
      versionManifest: async (_a: unknown, _slug: string, v: string) => manifests[v] ?? null,
      getScopeRecord: async (_a: unknown, _t: unknown, id: string) => scopes.find((x) => x.id === id),
    };
    const report = await runPlatformSweep({ admin } as unknown as ScopeHost, {
      actor: ACTOR,
      fetch: (() => Promise.reject(new Error('unused'))) as unknown as FetchLike,
      sweepers: {},
      drainRetries: false,
      gcSnapshots: false,
      reconcileMigrations: false,
      runSchedules: false,
      crossVertical: {
        reach: hostedCrossVerticalReach({
          admin: admin as never,
          actor: ACTOR,
          clientForScope: clientForScope ?? (async () => client),
        }),
      },
    });
    return { calls, report };
  };

  it('a fleet whose versions import nothing makes zero /internal calls', async () => {
    const { calls, report } = await run(scopesOn(300, NONE));
    expect(calls).toEqual([]);
    expect(report.crossVertical).toMatchObject({ candidates: 0, edges: [] });
  });

  it('the scopes whose running version imports are the only ones called', async () => {
    const importing = scopesOn(2, IMPORTS);
    const { calls } = await run([...scopesOn(100, NONE), ...importing]);
    expect(calls.sort()).toEqual(importing.map((x) => `/internal/import-state?tenantId=${t}&scopeId=${x.id}`).sort());
  });

  it('one resolution per scope per reach, and a failed one is asked again', async () => {
    const [only] = scopesOn(1, IMPORTS);
    const client = new VerticalClient({
      fetch: (async () => new Response(JSON.stringify({ consumes: [], cursors: [] }))) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    let resolutions = 0;
    const reach = hostedCrossVerticalReach({
      admin: { getScopeRecord: async () => only } as never,
      actor: ACTOR,
      clientForScope: async () => (++resolutions === 1 ? undefined : client),
    });
    await expect(reach.importState(t, only!.id)).rejects.toThrow(/no deployment serving scope/);
    await reach.importState(t, only!.id);
    await reach.importState(t, only!.id);
    expect(resolutions).toBe(2);
  });

  it('a scope with no serving deployment fails its edge loudly, never answers "imports nothing"', async () => {
    const [only] = scopesOn(1, IMPORTS);
    const { report } = await run([only!], async () => undefined);
    expect(report.errors).toEqual([
      expect.objectContaining({ kind: 'vertical-events', id: only!.id, error: expect.stringMatching(/no deployment serving scope/) }),
    ]);
  });
});
