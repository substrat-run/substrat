import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { CONNECTOR_CALL_PATH, CONNECTOR_PROBE_PATH, PLATFORM_SECRET_HEADER } from '@substrat-run/contracts';
import { ConnectorRefusal, type ConnectorResponse, type FetchLike } from '@substrat-run/kernel';
import {
  declareConnectorEvents,
  defineConnectors,
  runConnectorCall,
  type ConnectorCallDeps,
  type ConnectorDefinition,
} from '../src/connectors.js';
import { mountPlatformSurface, type VerticalScopeHost } from '../src/index.js';

const CONN = '01JZ0000000000000000CNX001';
const TENANT = '01JZ0000000000000000TEN001';
const SCOPE = '01JZ0000000000000000SCP001';
const EVENT = '01JZ0000000000000000EVT001';
const P = 'acme.docbox';

const fields = [{ key: 'password', label: 'Password', secret: true }];
// A probe may answer `{ ok: true }` alone; the three nullables default to null.
const PROBED = { ok: true };
const PROBE_ANSWER = { ok: true, refused: false, accountRef: null, accountLabel: null, error: null, facts: [] };
const probes = {
  probeCandidate: async () => PROBED,
  probe: async () => PROBED,
};
const def = (extra: Partial<ConnectorDefinition> = {}): ConnectorDefinition => ({
  label: 'docbox',
  description: 'A document box.',
  fields,
  ...probes,
  ...extra,
});

const connection = {
  id: CONN,
  tenantId: TENANT,
  vertical: 'todo',
  provider: P,
  externalAccountRef: null,
  expiresAt: null,
  secret: { password: 'hunter2' },
};
const binding = { scopeId: SCOPE, operation: 'docs/land', permission: 'documents:land', options: { folder: 'inbox' }, declared: { folder: 'inbox' }, boundAt: '2026-10-01T00:00:00.000Z' };
const sweepReq = (state: { key: string; value: unknown }[] = []) => ({ role: 'sweep', provider: P, connection, binding, state });
const event = {
  id: EVENT,
  type: 'documents.files-requested',
  schemaVersion: 1,
  occurredAt: '2026-10-01T00:00:00.000Z',
  tenantId: TENANT,
  scopeId: SCOPE,
  actor: '01JZ0000000000000000PRN001',
  entity: { entityType: 'request', entityId: 'R1' },
  piiClass: 'none',
  payload: {},
};

function harness(d: ConnectorDefinition, fetchImpl?: FetchLike) {
  const calls: unknown[][] = [];
  const host: ConnectorCallDeps['host'] = {
    connectorInvokeLocal: async (...args) => {
      calls.push(['invoke', ...args]);
      return { landed: true };
    },
    connectorAttachmentUploadLocal: async () => null,
    connectorAttachmentOpenLocal: async (...args) => {
      calls.push(['open', ...args]);
      return null;
    },
  };
  const fetch: FetchLike =
    fetchImpl ?? (async () => ({ ok: true, status: 200 }) as unknown as ConnectorResponse);
  const deps = { connectors: defineConnectors({ [P]: d }), host, fetch };
  return { calls, run: (req: unknown) => runConnectorCall(req, deps) };
}

describe('defineConnectors', () => {
  it.each([
    ['a provider without a dot', { scrive: def() }, /namespace>\.<name/],
    ['routed events with no dispatch', { [P]: def({ events: ['documents.files-requested'] }) }, /no dispatch/],
    ['a dispatch nothing routes to', { [P]: def({ dispatch: async () => {} }) }, /routes no events/],
  ])('refuses %s at define time', (_, defs, message) => {
    expect(() => defineConnectors(defs)).toThrow(message);
  });

  it('declares the static half with hook flags and defaults', () => {
    const c = defineConnectors({
      [P]: def({ sweep: async () => {} }),
      'acme.mailbox': def({ grants: ['documents:land'], events: ['documents.files-requested'], dispatch: async () => {}, bind: async (_, o) => o }),
    });
    expect(c.providers).toEqual([P, 'acme.mailbox']);
    expect(c.declarations()).toEqual([
      { provider: P, label: 'docbox', description: 'A document box.', fields, grants: [], events: [], sweeps: true, binds: false, dispatches: false },
      {
        provider: 'acme.mailbox', label: 'docbox', description: 'A document box.', fields,
        grants: ['documents:land'], events: ['documents.files-requested'], sweeps: false, binds: true, dispatches: true,
      },
    ]);
  });
});

describe('runConnectorCall', () => {
  it('refuses a request that does not parse, and a provider this version does not declare', async () => {
    const { run } = harness(def());
    expect(await run({ role: 'probe' })).toMatchObject({ ok: false, refused: true, uses: [] });
    expect(await run({ role: 'probe-candidate', provider: 'acme.other', secret: {} })).toEqual({
      ok: false, refused: true, error: 'this version declares no connector acme.other', uses: [],
    });
  });

  it('answers a probe parsed by connectionProbe, with the secret but no secret in the connection view', async () => {
    let seen: unknown;
    const { run } = harness(def({ probe: async (ctx) => ((seen = { connection: ctx.connection, secret: ctx.secret }), { ok: false, refused: true, accountRef: 'C1' }) }));
    const answer = await run({ role: 'probe', provider: P, connection, state: [] });
    expect(answer).toMatchObject({ ok: true, result: { ...PROBE_ANSWER, ok: false, refused: true, accountRef: 'C1' } });
    const { secret, ...view } = connection;
    expect(seen).toEqual({ connection: view, secret });
  });

  it('a ConnectorRefusal is refused, any other throw is not, and neither carries state', async () => {
    const thrower = (e: Error) => def({ sweep: async (ctx) => { await ctx.state.put('cursor', 9); throw e; } });
    const refused = await harness(thrower(new ConnectorRefusal('gone'))).run(sweepReq());
    const failed = await harness(thrower(new Error('x'.repeat(900)))).run(sweepReq());
    expect(refused).toEqual({ ok: false, refused: true, error: 'gone', uses: [] });
    expect(failed).toMatchObject({ ok: false, refused: false });
    expect(failed).not.toHaveProperty('state');
    expect((failed as { error: string }).error).toHaveLength(600);
  });

  it('returns the final value of every touched key on success, a delete as null', async () => {
    const { run } = harness(
      def({
        sweep: async (ctx) => {
          expect(await ctx.state.list('c')).toEqual([{ key: 'cursor', value: 1 }]);
          await ctx.state.put('cursor', 2);
          await ctx.state.put('cursor', 3);
          await ctx.state.put('seen', null);
          expect(await ctx.state.get('seen')).toBeUndefined();
          return { landed: 1 };
        },
      }),
    );
    const answer = await run(sweepReq([{ key: 'cursor', value: 1 }, { key: 'seen', value: ['a'] }]));
    expect(answer).toEqual({
      ok: true,
      result: { landed: 1, more: false },
      state: [{ key: 'cursor', value: 3 }, { key: 'seen', value: null }],
      uses: [],
    });
  });

  it('refuses writes over the caps rather than answering them', async () => {
    const { run } = harness(def({ sweep: async (ctx) => { await ctx.state.put('blob', 'x'.repeat(600 * 1024)); } }));
    expect(await run(sweepReq())).toMatchObject({ ok: false, refused: false, error: expect.stringMatching(/^connector state writes exceed/) });
  });

  it('records every fetch as a use, a failed one included', async () => {
    let n = 0;
    const fetch: FetchLike = async () => {
      if (n++ === 1) throw new Error('ECONNRESET');
      return { ok: n === 1, status: n === 1 ? 200 : 503 } as unknown as ConnectorResponse;
    };
    const { run } = harness(
      def({
        probe: async (ctx) => {
          await ctx.fetch('https://docbox.example/me');
          await ctx.fetch('https://docbox.example/me').catch(() => {});
          await ctx.fetch('https://docbox.example/me');
          return PROBED;
        },
      }),
      fetch,
    );
    const answer = await run({ role: 'probe', provider: P, connection, state: [] });
    expect(answer.uses).toEqual([
      expect.objectContaining({ ok: true, status: 200 }),
      expect.objectContaining({ ok: false, error: 'ECONNRESET', timedOut: false }),
      expect.objectContaining({ ok: false, error: `HTTP 503 from ${P}`, status: 503 }),
    ]);
  });

  it('lands through the binding operation as the connection, in the binding scope', async () => {
    const { run, calls } = harness(def({ sweep: async (ctx) => { await ctx.land({ file: 'a.pdf' }); return { landed: 1, more: true }; } }));
    expect(await run(sweepReq())).toMatchObject({ ok: true, result: { landed: 1, more: true } });
    expect(calls).toEqual([['invoke', CONN, TENANT, SCOPE, 'docs/land', { file: 'a.pdf' }]]);
  });

  it('refuses land with no binding, and opens an attachment for the dispatched event only', async () => {
    const { run, calls } = harness(
      def({
        events: ['documents.files-requested'],
        dispatch: async (ctx, e) => {
          expect(ctx.scope).toEqual({ tenantId: TENANT, scopeId: SCOPE, operation: null, options: {} });
          await ctx.attachments.open('ATT1');
          await ctx.land({ id: e.id });
        },
      }),
    );
    const answer = await run({ role: 'dispatch', provider: P, connection, scopeId: SCOPE, binding: null, event, state: [] });
    expect(answer).toMatchObject({ ok: false, refused: true, error: expect.stringMatching(/no binding/) });
    expect(calls).toEqual([['open', CONN, TENANT, SCOPE, 'ATT1', EVENT]]);
  });

  it('binds through the hook, or refuses options a connector without one cannot take', async () => {
    const bindReq = (options: Record<string, unknown>) => ({ role: 'bind', provider: P, connection, scopeId: SCOPE, options });
    const hooked = harness(def({ bind: async (ctx, o) => ({ ...o, scope: ctx.scope.scopeId }) }));
    expect(await hooked.run(bindReq({ folder: '/in' }))).toMatchObject({ ok: true, result: { options: { folder: '/in', scope: SCOPE } } });
    const bare = harness(def());
    expect(await bare.run(bindReq({}))).toMatchObject({ ok: true, result: { options: {} } });
    expect(await bare.run(bindReq({ folder: '/in' }))).toMatchObject({ ok: false, refused: true, error: expect.stringMatching(/takes no binding options/) });
  });
});

describe('declareConnectorEvents', () => {
  // A stub host: a CP-less host's routing of the registration is the adapters' own suites'.
  it('registers each routed event under its provider, for routing only', async () => {
    const registered: { id: string; eventType: string; handler: () => Promise<void>; options: unknown }[] = [];
    const host = { registerConnector: (id: string, eventType: string, handler: never, options: unknown) => void registered.push({ id, eventType, handler, options }) };
    declareConnectorEvents(
      host,
      defineConnectors({ [P]: def({ events: ['documents.files-requested'], dispatch: async () => {} }), 'acme.quiet': def() }),
      { retry: { maxAttempts: 3 } },
    );
    expect(registered.map(({ id, eventType, options }) => ({ id, eventType, options }))).toEqual([
      { id: `${P}:documents.files-requested`, eventType: 'documents.files-requested', options: { maxAttempts: 3, provider: P } },
    ]);
    await expect(registered[0]!.handler()).rejects.toThrow(/routing only/);
  });
});

describe('mountPlatformSurface — the connector routes', () => {
  type Env = { PLATFORM_SECRET: string };
  const sweep = { role: 'sweep', provider: P, connection, binding, state: [] };
  const candidate = { role: 'probe-candidate', provider: P, secret: {} };
  const post = (path: string, body: unknown, headers: Record<string, string>, connectors?: ReturnType<typeof defineConnectors>) => {
    const app = new Hono<{ Bindings: Env }>();
    mountPlatformSurface<Env>(app, {
      platformSecret: (env) => env.PLATFORM_SECRET,
      hostFor: () => ({}) as VerticalScopeHost,
      roles: [],
      ownerRoleKey: 'admin',
      connectors,
    });
    const init = { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
    return app.request(path, init, { PLATFORM_SECRET: 's' });
  };
  const authed = { [PLATFORM_SECRET_HEADER]: 's' };
  const connectors = defineConnectors({ [P]: def({ sweep: async () => { throw new Error('ran'); } }) });

  it.each([CONNECTOR_PROBE_PATH, CONNECTOR_CALL_PATH])('%s is behind the platform secret', async (path) => {
    expect((await post(path, candidate, {}, connectors)).status).toBe(403);
    expect((await post(path, candidate, { [PLATFORM_SECRET_HEADER]: 'nope' }, connectors)).status).toBe(403);
  });

  it.each([CONNECTOR_PROBE_PATH, CONNECTOR_CALL_PATH])('%s 501s a deployment that mounted no connectors', async (path) => {
    expect((await post(path, candidate, authed)).status).toBe(501);
  });

  it('serves a probe on the probe path', async () => {
    const served = await post(CONNECTOR_PROBE_PATH, candidate, authed, connectors);
    expect(await served.json()).toEqual({ ok: true, result: PROBE_ANSWER, state: [], uses: [] });
  });

  it.each([
    [CONNECTOR_CALL_PATH, candidate],
    [CONNECTOR_PROBE_PATH, sweep],
  ])('%s refuses the other path\'s roles without running them', async (path, body) => {
    const res = await post(path, body, authed, connectors);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, refused: true, error: `${body.role} is not served on ${path}`, uses: [] });
  });
});
