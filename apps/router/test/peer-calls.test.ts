import { describe, expect, it } from 'vitest';
import { handlePeerCall, type Env } from '../src/worker.js';

/**
 * The router's peer entrypoint (#1706) — the hop that says WHO is calling.
 *
 * Every refusal here is a security property, so each has a test AND its positive twin: the
 * same call, with only the refused fact changed, must go through. A gate that refuses
 * everything would pass a suite of refusals alone.
 *
 * What this hop does NOT decide: which operation the peer may invoke, and holding which
 * keys. That is the target scope's own door (#1714). The dispatch below is the boundary of
 * this file's responsibility.
 */

const TENANT = '01JZ0000000000000000TENANT';
const CALLER_SCOPE = '01JZ0000000000000000CA11R2';
const TARGET_SCOPE = '01JZ0000000000000000TARGET';
const SECRET = 'platform-shhh';

type CallerState = 'ok' | 'unknown' | 'not-primary' | 'inactive';

interface DirectoryShape {
  callerState?: CallerState;
  callerStatus?: string | null;
  outcome?: 'resolved' | 'not-installed' | 'ambiguous';
  count?: number;
  deploymentRef?: string | null;
  targetCalls?: string[] | null;
  targetHosts?: string[] | null;
}

/** A control-plane namespace answering one `peerCallTarget`, recording what it was asked. */
function directory(shape: DirectoryShape = {}) {
  const asked: { tenantId: string; callerScopeId: string; callerVertical: string; vertical: string }[] = [];
  const outcome = shape.outcome ?? 'resolved';
  const ns = {
    idFromName: () => 'id',
    get: () => ({
      peerCallTarget: async (
        tenantId: string,
        callerScopeId: string,
        callerVertical: string,
        vertical: string,
      ) => {
        asked.push({ tenantId, callerScopeId, callerVertical, vertical });
        return {
          caller: { state: shape.callerState ?? 'ok', status: shape.callerStatus ?? 'active' },
          outcome,
          count: shape.count ?? 0,
          target:
            outcome === 'resolved'
              ? {
                  scope_id: TARGET_SCOPE,
                  tenant_id: tenantId,
                  vertical,
                  deployment_ref: shape.deploymentRef === undefined ? 'crm-01jz' : shape.deploymentRef,
                  outbound_json: JSON.stringify(shape.targetHosts ?? []),
                  calls_json: shape.targetCalls === undefined ? null : JSON.stringify(shape.targetCalls),
                }
              : null,
        };
      },
    }),
  };
  return Object.assign(ns as unknown as DurableObjectNamespace, { asked: () => asked });
}

/** A dispatch namespace recording the script, the request and the outbound parameters. */
function dispatch(status = 200, body: unknown = { result: { listed: 3 } }) {
  const seen: { name: string; args: unknown; request?: Request }[] = [];
  const ns = {
    get: (name: string, _args: unknown, options?: { outbound?: Record<string, unknown> }) => {
      const entry: { name: string; args: unknown; request?: Request } = { name, args: options?.outbound };
      seen.push(entry);
      return {
        fetch: async (request: Request) => {
          entry.request = request;
          return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        },
      } as unknown as Fetcher;
    },
  };
  return Object.assign(ns, { seen: () => seen });
}

/**
 * A dispatch namespace that throws `Worker not found.` for its first `throwTimes` fetches —
 * the K-29 propagation gap, which is raised BEFORE the target's code runs.
 */
function flakyDispatch(throwTimes: number, body: unknown = { result: { listed: 3 } }) {
  const bodies: string[] = [];
  let attempts = 0;
  const ns = {
    get: () => ({
      fetch: async (request: Request) => {
        attempts += 1;
        bodies.push(await request.text());
        if (attempts <= throwTimes) throw new Error('Worker not found.');
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    }) as unknown as Fetcher,
  };
  return Object.assign(ns, { attempts: () => attempts, bodies: () => bodies });
}

const caller = (over: Record<string, unknown> = {}) => ({
  vertical: 'acme/board-room',
  tenantId: TENANT,
  scopeId: CALLER_SCOPE,
  calls: ['acme/crm'],
  depth: 0,
  ...over,
});

const request = (over: Record<string, unknown> = {}) => ({
  vertical: 'acme/crm',
  operation: 'customer/list',
  ...over,
});

/**
 * What `PeerCalls.invoke` calls, with the env it would hold. The entrypoint class itself is
 * three lines around this (`src/peer-calls.ts`), and lives in its own module so the workers
 * runtime import stays out of every module these node tests load.
 */
const entrypoint = (env: Partial<Env>) => ({
  invoke: (caller: unknown, request: unknown) =>
    handlePeerCall({ PLATFORM_SECRET: SECRET, ...env } as unknown as Env, caller, request),
});

describe('the router’s peer entrypoint (#1706)', () => {
  it('dispatches the resolved instance, with the platform secret and the caller the platform named', async () => {
    const cp = directory();
    const d = dispatch();
    const outcome = await entrypoint({ CONTROL_PLANE: cp, DISPATCH: d as never }).invoke(caller(), request());

    expect(outcome).toEqual({ ok: true, result: { listed: 3 } });
    // Asked about the CALLER's own scope, in the caller's tenant.
    expect(cp.asked()).toEqual([
      { tenantId: TENANT, callerScopeId: CALLER_SCOPE, callerVertical: 'acme/board-room', vertical: 'acme/crm' },
    ]);
    const [call] = d.seen();
    expect(call!.name).toBe('crm-01jz');
    const sent = call!.request!;
    expect(new URL(sent.url).pathname).toBe('/internal/vertical-invoke');
    expect(sent.headers.get('x-substrat-platform')).toBe(SECRET);
    expect(await sent.json()).toEqual({
      caller: { vertical: 'acme/board-room', scope: CALLER_SCOPE },
      tenantId: TENANT,
      scopeId: TARGET_SCOPE,
      operation: 'customer/list',
    });
  });

  it('the TARGET is dispatched one hop deeper, which is what bounds A→B→A', async () => {
    const d = dispatch();
    await entrypoint({ CONTROL_PLANE: directory(), DISPATCH: d as never }).invoke(caller({ depth: 1 }), request());
    expect(d.seen()[0]!.args).toEqual({
      OUTBOUND_POLICY: {
        slug: 'acme/crm',
        tenant: TENANT,
        hosts: [],
        scope: TARGET_SCOPE,
        calls: null,
        depth: 2,
      },
    });
  });

  it('refuses a chain at the bound — before it reads the directory', async () => {
    const cp = directory();
    const outcome = await entrypoint({ CONTROL_PLANE: cp, DISPATCH: dispatch() as never }).invoke(
      caller({ depth: 4 }),
      request(),
    );
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect((outcome as { message: string }).message).toMatch(/at most 4/);
    expect(cp.asked()).toHaveLength(0);
  });

  it('twin: one hop below the bound goes through', async () => {
    const outcome = await entrypoint({ CONTROL_PLANE: directory(), DISPATCH: dispatch() as never }).invoke(
      caller({ depth: 3 }),
      request(),
    );
    expect(outcome).toMatchObject({ ok: true });
  });

  it('refuses a target the caller did not declare, and says what to declare', async () => {
    const cp = directory();
    const outcome = await entrypoint({ CONTROL_PLANE: cp, DISPATCH: dispatch() as never }).invoke(
      caller({ calls: ['acme/somebody-else'] }),
      request(),
    );
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect((outcome as { message: string }).message).toMatch(/substrat\.calls/);
    expect(cp.asked()).toHaveLength(0);
  });

  it('twin: a version that predates the declaration (null) is unenforced, as a pre-#303 outbound is', async () => {
    const outcome = await entrypoint({ CONTROL_PLANE: directory(), DISPATCH: dispatch() as never }).invoke(
      caller({ calls: null }),
      request(),
    );
    expect(outcome).toMatchObject({ ok: true });
  });

  it('refuses a caller the directory does not know as that vertical', async () => {
    const outcome = await entrypoint({
      CONTROL_PLANE: directory({ callerState: 'unknown' }),
      DISPATCH: dispatch() as never,
    }).invoke(caller(), request());
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect((outcome as { message: string }).message).toMatch(/is not an instance of/);
  });

  it('refuses a PREVIEW caller, and the message names the local broker', async () => {
    const outcome = await entrypoint({
      CONTROL_PLANE: directory({ callerState: 'not-primary' }),
      DISPATCH: dispatch() as never,
    }).invoke(caller(), request());
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    const message = (outcome as { message: string }).message;
    expect(message).toMatch(/preview/);
    expect(message).toContain('@substrat-run/adapter-sqlite/vertical-broker');
  });

  it('refuses a suspended caller, naming its state', async () => {
    const outcome = await entrypoint({
      CONTROL_PLANE: directory({ callerState: 'inactive', callerStatus: 'suspended' }),
      DISPATCH: dispatch() as never,
    }).invoke(caller(), request());
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect((outcome as { message: string }).message).toMatch(/suspended/);
  });

  it('refuses a target that is not installed in this tenant', async () => {
    const outcome = await entrypoint({
      CONTROL_PLANE: directory({ outcome: 'not-installed' }),
      DISPATCH: dispatch() as never,
    }).invoke(caller(), request());
    expect(outcome).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses an ambiguous target rather than guessing, and says how many', async () => {
    const outcome = await entrypoint({
      CONTROL_PLANE: directory({ outcome: 'ambiguous', count: 2 }),
      DISPATCH: dispatch() as never,
    }).invoke(caller(), request());
    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect((outcome as { message: string }).message).toMatch(/runs 2 instances/);
  });

  it('refuses a target with no deployed version', async () => {
    const outcome = await entrypoint({
      CONTROL_PLANE: directory({ deploymentRef: null }),
      DISPATCH: dispatch() as never,
    }).invoke(caller(), request());
    expect(outcome).toMatchObject({ ok: false, status: 503 });
  });

  it('refuses every call when the platform secret is missing — a half-provisioned router is loud', async () => {
    const cp = directory();
    const outcome = await entrypoint({ CONTROL_PLANE: cp, DISPATCH: dispatch() as never, PLATFORM_SECRET: undefined }).invoke(
      caller(),
      request(),
    );
    expect(outcome).toMatchObject({ ok: false, status: 503 });
    expect(cp.asked()).toHaveLength(0);
  });

  it('passes the target door’s own refusal back with its status', async () => {
    const outcome = await entrypoint({
      CONTROL_PLANE: directory(),
      DISPATCH: dispatch(403, { error: "vertical 'acme/board-room' may not invoke 'customer/delete'" }) as never,
    }).invoke(caller(), request({ operation: 'customer/delete' }));
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect((outcome as { message: string }).message).toMatch(/may not invoke/);
  });

  it('a caller that names a tenant of its own gets nowhere: the parse takes only what the platform set', async () => {
    const cp = directory();
    await entrypoint({ CONTROL_PLANE: cp, DISPATCH: dispatch() as never }).invoke(
      // A forged `tenantId` in the CALLER object is the shape an attacker would try. The
      // entrypoint is only ever handed the dispatch parameters, so this is the egress
      // worker's contract as much as the router's: whatever arrives is parsed, and the
      // target is then searched in THAT tenant alone — never in two.
      caller({ tenantId: '01JZ0000000000000000THER22' }),
      request(),
    );
    expect(cp.asked()[0]!.tenantId).toBe('01JZ0000000000000000THER22');
    expect(cp.asked()).toHaveLength(1);
  });

  it('refuses a malformed caller or request rather than guessing at it', async () => {
    const e = entrypoint({ CONTROL_PLANE: directory(), DISPATCH: dispatch() as never });
    await expect(e.invoke(caller({ vertical: 'NOT A SLUG' }), request())).rejects.toThrow();
    await expect(e.invoke(caller(), { vertical: 'acme/crm' })).rejects.toThrow();
  });
});

/**
 * The K-29 propagation gap on the peer path (#1719 review). A freshly-deployed script is not
 * instantly reachable everywhere, and `Worker not found.` is raised by the dispatch before the
 * target runs — so nothing happened, and a retry is safe. This is an RPC entrypoint, so an
 * escaping exception reaches egress with no code to render: the last resort must be a
 * structured refusal, not a throw.
 */
describe('a target still propagating (#1706)', () => {
  it('retries once, on a FRESH request, and the target sees the whole body', async () => {
    const d = flakyDispatch(1);
    const outcome = await entrypoint({ CONTROL_PLANE: directory(), DISPATCH: d as never }).invoke(
      caller(),
      request({ input: { limit: 50 } }),
    );
    expect(outcome).toEqual({ ok: true, result: { listed: 3 } });
    expect(d.attempts()).toBe(2);
    // The retry's body is not empty: a POST body is a stream, and reusing one Request would
    // have sent the second attempt with nothing in it.
    expect(d.bodies()).toHaveLength(2);
    expect(JSON.parse(d.bodies()[1]!)).toMatchObject({ operation: 'customer/list', input: { limit: 50 } });
    expect(JSON.parse(d.bodies()[1]!)).toEqual(JSON.parse(d.bodies()[0]!));
  });

  it('a target that never answers is a structured 503 that says nothing ran, never an exception', async () => {
    const d = flakyDispatch(99);
    const outcome = await entrypoint({ CONTROL_PLANE: directory(), DISPATCH: d as never }).invoke(
      caller(),
      request(),
    );
    expect(outcome).toEqual({
      ok: false,
      status: 503,
      code: 'unavailable',
      message: expect.stringMatching(/Nothing ran; retry/),
    });
    // Bounded: twice is enough to tell a propagation gap from a script that is not there.
    expect(d.attempts()).toBe(2);
  });

  it('twin: a failure that is NOT the propagation gap is not retried and not swallowed', async () => {
    const boom = {
      get: () => ({ fetch: async () => { throw new Error('script exceeded CPU'); } }) as unknown as Fetcher,
    };
    await expect(
      entrypoint({ CONTROL_PLANE: directory(), DISPATCH: boom as never }).invoke(caller(), request()),
    ).rejects.toThrow(/exceeded CPU/);
  });
});
