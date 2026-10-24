import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import { assertPlatformCall } from '@substrat-run/contracts/wire-auth';
import {
  decodeWireEnvelope,
  WIRE_AUDIENCE_VAR,
  WIRE_ENVELOPE_HEADER,
  WIRE_PLATFORM_KEYS_VAR,
  WIRE_ROUTER_KEYS_VAR,
  WIRE_SIGNATURE_HEADER,
  WIRE_STATE_VAR,
  wireDigest,
  type WireClaims,
  type WireNonceCache,
  type WireVerificationLine,
} from '@substrat-run/contracts/wire-signing';
import { readRoutedNode, withInvocationLog } from '@substrat-run/vertical-host';
import worker, { handlePeerCall, type Env } from '../src/worker.js';

/**
 * The router's wire signer (RFC wire-signing §5, §9 step 2): a route envelope on every dispatch
 * into the namespace, a router `call` on every peer invocation, each beside the legacy headers,
 * which stay. Off by default, and off means the router sends exactly what it sent before signing
 * existed. Every request it signs is also run through the verifier the platform's entry wraps
 * around a deployment (#2511), in `dual` and `signed-only`.
 */

const T = '01JZ0000000000000000000001';
const S = '01JZ0000000000000000000002';
const TARGET_SCOPE = '01JZ0000000000000000TARGET';
const CALLER_SCOPE = '01JZ0000000000000000CA11R2';
const SECRET = 'router-legacy-value';
const CALL_SECRET = 'platform-legacy-value';
const REF = 'fsm-01ky535a';
const PEER_REF = 'crm-01jz';

let active: { privateKey: string; publicKey: string };
let standby: { privateKey: string; publicKey: string };
let platformPair: { publicKey: string };

/** The verifier the platform's entry wraps around a deployment, typed by the part these tests use. */
type Gate = <E>(
  worker: { fetch(request: Request, env: E, ctx: unknown): unknown },
  options: {
    routedNode: (headers: Headers, env: E) => { tenantId: string; scopeId: string; surface: string; verticalSlug: string | null } | null;
    routerSecret: (env: E) => string | undefined;
    platformSecret: (env: E) => string | undefined;
    nonceCache?: (env: E, scopeId: string) => WireNonceCache | undefined;
    log?: (line: string) => void;
  },
) => { fetch?(request: Request, env: E, ctx: unknown): unknown };
let withWireGate: Gate;

beforeAll(async () => {
  [active, standby, platformPair] = await Promise.all([generateScopeStoreKeyPair(), generateScopeStoreKeyPair(), generateScopeStoreKeyPair()]);
  // Entry source outside any package export, reached by path as vertical-egress's suites reach
  // control-plane-api's store entry.
  const gatePath = fileURLToPath(new URL('../../../packages/control-plane-api/platform-entry/wire-gate.ts', import.meta.url));
  ({ withWireGate } = (await import(/* @vite-ignore */ gatePath)) as { withWireGate: Gate });
});

afterEach(() => vi.restoreAllMocks());

/** A control-plane namespace answering one hostname with a bound version. */
function directory(over: Record<string, unknown> = {}) {
  const row = { tenant_id: T, scope_id: S, vertical_slug: 'fsm', surface: 'app', region: null, status: 'active', deployment_ref: REF, ...over };
  return {
    idFromName: () => 'id',
    get: () => ({ readRoute: async (hostname: string) => (hostname === 'acme.example.com' ? row : undefined) }),
  } as unknown as DurableObjectNamespace;
}

/** A dispatch namespace whose scripts record what they were sent, or answer through `serve`. */
function namespace(serve?: (request: Request) => Promise<Response> | Response) {
  const seen: { name: string; request: Request }[] = [];
  const ns = {
    get: (name: string) => ({
      fetch: async (request: Request) => {
        seen.push({ name, request });
        return serve ? serve(request) : new Response('ok');
      },
    }),
  };
  return Object.assign(ns, { seen: () => seen });
}

function routerEnv(dispatch: ReturnType<typeof namespace>, wire: Record<string, string | undefined> = {}, over: Record<string, unknown> = {}): Env {
  return { ROUTER_SECRET: SECRET, PLATFORM_SECRET: CALL_SECRET, CONTROL_PLANE: directory(), DISPATCH: dispatch, ...wire, ...over } as unknown as Env;
}

const ON = () => ({ WIRE_SIGN: 'on', WIRE_ROUTER_KEY: active.privateKey });

/** A request as it left the router: method, url, every header, and the body. */
async function shapeOf(request: Request) {
  return { method: request.method, url: request.url, headers: [...request.headers].sort(), body: await request.text() };
}

const claimsOf = (request: Request): WireClaims => decodeWireEnvelope(request.headers.get(WIRE_ENVELOPE_HEADER) ?? '')!.claims;

/** Console lines written as JSON, by discriminator. */
function captured() {
  const out: Record<string, unknown>[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string') out.push(JSON.parse(line) as Record<string, unknown>);
  });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    err.push(String(line));
  });
  return { requestLine: () => out.find((l) => l['router'] === 'request'), lines: out, errors: err };
}

const post = () => new Request('https://acme.example.com/api/orders?draft=1', { method: 'POST', body: '{"total":"100.00"}', headers: { 'content-type': 'application/json', cookie: 'session=abc' } });
const get = () => new Request('https://acme.example.com/api/orders?page=2', { headers: { cookie: 'session=abc' } });

const peer = (env: Env, context?: unknown) =>
  handlePeerCall(env, { vertical: 'acme/board-room', tenantId: T, scopeId: CALLER_SCOPE, calls: ['acme/crm'], depth: 0 }, { vertical: 'acme/crm', operation: 'customer/list' }, context);

/** A directory that resolves one peer target, at `ref`. */
function peerDirectory(ref = PEER_REF) {
  return {
    idFromName: () => 'id',
    get: () => ({
      peerCallTarget: async (tenantId: string, _callerScope: string, _callerVertical: string, vertical: string) => ({
        caller: { state: 'ok', status: 'active' },
        outcome: 'resolved',
        count: 0,
        target: { scope_id: TARGET_SCOPE, tenant_id: tenantId, vertical, deployment_ref: ref, outbound_json: '[]', calls_json: null },
      }),
    }),
  } as unknown as DurableObjectNamespace;
}

const peerEnv = (dispatch: ReturnType<typeof namespace>, wire: Record<string, string | undefined> = {}) =>
  ({ PLATFORM_SECRET: CALL_SECRET, CONTROL_PLANE: peerDirectory(), DISPATCH: dispatch, ...wire }) as unknown as Env;

const PEER_ANSWER = () => Response.json({ result: { listed: 3 } });

describe('off by default: the router sends exactly what it sent before signing existed', () => {
  const OFF: [string, Record<string, string | undefined>][] = [
    ['a key with no flag', { WIRE_ROUTER_KEY: 'unread' }],
    ['the flag off', { WIRE_SIGN: 'off', WIRE_ROUTER_KEY: 'unread' }],
    ['the flag in another case', { WIRE_SIGN: 'ON', WIRE_ROUTER_KEY: 'unread' }],
    ['the flag as 1', { WIRE_SIGN: '1', WIRE_ROUTER_KEY: 'unread' }],
    ['an empty flag', { WIRE_SIGN: '', WIRE_ROUTER_KEY: 'unread' }],
  ];

  it.each(OFF)('%s: a dispatched route is the same request, and its line names no signing', async (_, wire) => {
    for (const make of [get, post]) {
      const today = namespace();
      const todayLog = captured();
      await worker.fetch(make(), routerEnv(today));
      vi.restoreAllMocks();
      const now = namespace();
      const log = captured();
      await worker.fetch(make(), routerEnv(now, wire));
      expect(await shapeOf(now.seen()[0]!.request)).toEqual(await shapeOf(today.seen()[0]!.request));
      expect(now.seen()[0]!.request.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
      expect(log.requestLine()).not.toHaveProperty('wire');
      expect(Object.keys(log.requestLine()!)).toEqual(Object.keys(todayLog.requestLine()!));
      expect(log.errors).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it.each(OFF)('%s: a peer invocation is the same request, and nothing more is logged', async (_, wire) => {
    const today = namespace(PEER_ANSWER);
    const todayLog = captured();
    await peer(peerEnv(today), { parentInvocationId: '01JZ0000000000000000PAR001' });
    vi.restoreAllMocks();
    const now = namespace(PEER_ANSWER);
    const log = captured();
    await peer(peerEnv(now, wire), { parentInvocationId: '01JZ0000000000000000PAR001' });
    expect(await shapeOf(now.seen()[0]!.request)).toEqual(await shapeOf(today.seen()[0]!.request));
    expect(log.lines).toEqual(todayLog.lines);
    expect(log.errors).toEqual([]);
  });

  it('its positive twin: the same flag spelled `on`, with a key, signs both', async () => {
    const routed = namespace();
    captured();
    await worker.fetch(get(), routerEnv(routed, ON()));
    expect(routed.seen()[0]!.request.headers.has(WIRE_ENVELOPE_HEADER)).toBe(true);
    const peered = namespace(PEER_ANSWER);
    await peer(peerEnv(peered, ON()));
    expect(peered.seen()[0]!.request.headers.has(WIRE_ENVELOPE_HEADER)).toBe(true);
  });
});

describe('on: a route envelope beside the legacy headers', () => {
  it('names the router, the dispatched deployment, the identity the router resolved, and this request', async () => {
    const d = namespace();
    const log = captured();
    await worker.fetch(post(), routerEnv(d, ON()));
    const { name, request } = d.seen()[0]!;
    expect(name).toBe(REF);
    expect(claimsOf(request)).toMatchObject({
      iss: 'router',
      kind: 'route',
      aud: REF,
      tenantId: T,
      scopeId: S,
      surface: 'app',
      vertical: 'fsm',
      method: 'POST',
      targetDigest: await wireDigest('/api/orders?draft=1'),
      bodyDigest: null,
    });
    expect(request.headers.get(WIRE_SIGNATURE_HEADER)).toMatch(/^[A-Za-z0-9_-]{86}$/);
    // The legacy headers stay, and so does everything the request carried.
    expect(request.headers.get('x-substrat-router')).toBe(SECRET);
    expect(request.headers.get('x-substrat-tenant')).toBe(T);
    expect(request.headers.get('cookie')).toBe('session=abc');
    expect(await request.text()).toBe('{"total":"100.00"}');
    expect(log.requestLine()).toMatchObject({ wire: 'signed' });
  });

  it('a route with no vertical slug names none', async () => {
    const d = namespace();
    captured();
    await worker.fetch(get(), routerEnv(d, ON(), { CONTROL_PLANE: directory({ vertical_slug: null }) }));
    expect(claimsOf(d.seen()[0]!.request).vertical).toBeNull();
    expect(d.seen()[0]!.request.headers.has('x-substrat-vertical')).toBe(false);
  });

  it('a caller-supplied envelope is stripped, never forwarded as the router’s', async () => {
    const d = namespace();
    captured();
    const forged = new Request('https://acme.example.com/api/orders', { headers: { [WIRE_ENVELOPE_HEADER]: 'forged', [WIRE_SIGNATURE_HEADER]: 'forged' } });
    await worker.fetch(forged, routerEnv(d));
    expect(d.seen()[0]!.request.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
    expect(d.seen()[0]!.request.headers.has(WIRE_SIGNATURE_HEADER)).toBe(false);
    // Its twin, signing on: the router's own envelope replaces it.
    const on = namespace();
    await worker.fetch(new Request(forged), routerEnv(on, ON()));
    expect(claimsOf(on.seen()[0]!.request).aud).toBe(REF);
  });

  it('never signs a request to a path the entry reads as the internal surface, in any spelling', async () => {
    for (const path of ['/internal/vertical-invoke', '/internal/provision', '/INTERNAL/query', '/api/../internal/x', '/%69nternal/x']) {
      const d = namespace();
      const log = captured();
      await worker.fetch(new Request(`https://acme.example.com${path}`), routerEnv(d, ON()));
      expect(d.seen()[0]!.request.headers.has(WIRE_ENVELOPE_HEADER), path).toBe(false);
      expect(log.requestLine(), path).not.toHaveProperty('wire');
      vi.restoreAllMocks();
    }
    // Its twin: a path that merely mentions the word is a route, and signed.
    const twin = namespace();
    captured();
    await worker.fetch(new Request('https://acme.example.com/api/internal-notes'), routerEnv(twin, ON()));
    expect(claimsOf(twin.seen()[0]!.request).kind).toBe('route');
  });

  it('does not try to sign for the static fallback binding, which no entry wraps', async () => {
    const binding = namespace();
    const log = captured();
    await worker.fetch(get(), routerEnv(namespace(), ON(), { CONTROL_PLANE: directory({ deployment_ref: null }), VERTICAL_FSM: binding.get('VERTICAL_FSM') }));
    expect(binding.seen()[0]!.request.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
    expect(binding.seen()[0]!.request.headers.get('x-substrat-router')).toBe(SECRET);
    // Not a failed signature either: no attempt, so no count and no alarm.
    expect(log.requestLine()).not.toHaveProperty('wire');
    expect(log.errors).toEqual([]);
  });

  it('re-signs the retry with a fresh nonce, so the retried request is not a replay', async () => {
    let attempts = 0;
    const d = namespace(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('Worker not found.');
      return new Response('ok');
    });
    captured();
    expect((await worker.fetch(get(), routerEnv(d, ON()))).status).toBe(200);
    const [first, second] = d.seen().map((s) => claimsOf(s.request));
    expect(first!.nonce).not.toBe(second!.nonce);
    expect(second).toMatchObject({ aud: REF, tenantId: T, kind: 'route' });
  });
});

describe('on, a signer that cannot sign: the legacy headers carry the request, and an alarm is written', () => {
  it.each([
    ['unset', undefined, 'unset'],
    ['not base64url', '!!not-a-key!!', 'encoding'],
    ['not a PKCS8 key', 'AAAA', 'not-pkcs8-v1'],
  ])('a key that is %s: served unsigned, the line says failed, the alarm names why and never the value', async (_, key, reason) => {
    const d = namespace();
    const log = captured();
    const res = await worker.fetch(get(), routerEnv(d, { WIRE_SIGN: 'on', WIRE_ROUTER_KEY: key }));
    expect(res.status).toBe(200);
    const sent = d.seen()[0]!.request;
    expect(sent.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
    expect(sent.headers.get('x-substrat-router')).toBe(SECRET);
    expect(log.requestLine()).toMatchObject({ wire: 'failed' });
    expect(log.errors.map((e) => JSON.parse(e) as Record<string, unknown>)).toEqual([{ router: 'wire-sign-failed', kind: 'route', aud: REF, reason }]);
    if (key) expect(log.errors.join('')).not.toContain(key);
  });

  it('claims no verifier would accept (an over-long deployment name) are not signed, and the request still goes', async () => {
    const d = namespace();
    const log = captured();
    const ref = 'r'.repeat(256);
    const res = await worker.fetch(post(), routerEnv(d, ON(), { CONTROL_PLANE: directory({ deployment_ref: ref }) }));
    expect(res.status).toBe(200);
    const sent = d.seen()[0]!.request;
    expect(sent.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
    expect(sent.headers.get('x-substrat-router')).toBe(SECRET);
    expect(await sent.text()).toBe('{"total":"100.00"}');
    expect(JSON.parse(log.errors[0]!)).toMatchObject({ router: 'wire-sign-failed', reason: 'claims' });
    expect(log.requestLine()).toMatchObject({ wire: 'failed' });
    // Its twin: a 255-character name is signed.
    vi.restoreAllMocks();
    const twin = namespace();
    captured();
    await worker.fetch(post(), routerEnv(twin, ON(), { CONTROL_PLANE: directory({ deployment_ref: 'r'.repeat(255) }) }));
    expect(claimsOf(twin.seen()[0]!.request).aud).toBe('r'.repeat(255));
  });
});

describe('on: a peer invocation is a router call', () => {
  it('names the target deployment, the scope the resolver chose and the target vertical, and binds the exact body', async () => {
    const d = namespace(PEER_ANSWER);
    const log = captured();
    expect(await peer(peerEnv(d, ON()), { parentInvocationId: '01JZ0000000000000000PAR001' })).toMatchObject({ ok: true });
    const { name, request } = d.seen()[0]!;
    expect(name).toBe(PEER_REF);
    const body = await request.clone().text();
    expect(claimsOf(request)).toMatchObject({
      iss: 'router',
      kind: 'call',
      aud: PEER_REF,
      tenantId: T,
      scopeId: TARGET_SCOPE,
      surface: null,
      vertical: 'acme/crm',
      method: 'POST',
      targetDigest: await wireDigest('/internal/vertical-invoke'),
      bodyDigest: await wireDigest(body),
    });
    // The legacy credential and the informational headers stay beside it.
    expect(request.headers.get('x-substrat-platform')).toBe(CALL_SECRET);
    expect(request.headers.get('x-substrat-parent-request-id')).toBe('01JZ0000000000000000PAR001');
    expect(log.lines).toContainEqual({ router: 'wire-sign', kind: 'call', aud: PEER_REF, outcome: 'signed' });
  });

  it('re-signs the retry, and the retried body is the whole body again', async () => {
    let attempts = 0;
    const d = namespace(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('Worker not found.');
      return PEER_ANSWER();
    });
    captured();
    expect(await peer(peerEnv(d, ON()))).toMatchObject({ ok: true });
    const [first, second] = d.seen();
    expect(claimsOf(first!.request).nonce).not.toBe(claimsOf(second!.request).nonce);
    expect(claimsOf(second!.request).bodyDigest).toBe(await wireDigest(await second!.request.text()));
  });

  it('claims the encoder refuses, after the body was read to be signed: the invocation goes with its whole body', async () => {
    const d = namespace(PEER_ANSWER);
    const log = captured();
    const env = { ...peerEnv(d, ON()), CONTROL_PLANE: peerDirectory('r'.repeat(256)) } as unknown as Env;
    expect(await peer(env)).toMatchObject({ ok: true });
    const sent = d.seen()[0]!.request;
    expect(sent.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
    expect(JSON.parse(await sent.text())).toMatchObject({ operation: 'customer/list', scopeId: TARGET_SCOPE });
    expect(JSON.parse(log.errors[0]!)).toMatchObject({ router: 'wire-sign-failed', kind: 'call', reason: 'claims' });
    expect(log.lines.filter((l) => l['router'] === 'wire-sign')).toEqual([
      { router: 'wire-sign', kind: 'call', aud: 'r'.repeat(256), outcome: 'failed', reason: 'claims' },
    ]);
  });

  it('a key that will not import: the invocation goes with its legacy credential and its whole body', async () => {
    const d = namespace(PEER_ANSWER);
    const log = captured();
    expect(await peer(peerEnv(d, { WIRE_SIGN: 'on', WIRE_ROUTER_KEY: 'AAAA' }))).toMatchObject({ ok: true });
    const sent = d.seen()[0]!.request;
    expect(sent.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
    expect(sent.headers.get('x-substrat-platform')).toBe(CALL_SECRET);
    expect(JSON.parse(await sent.text())).toMatchObject({ operation: 'customer/list', scopeId: TARGET_SCOPE });
    // The alarm, naming why, and the count beside it (RFC §8): a peer invocation's line is written
    // whatever the outcome, so a report counting by outcome sees the failure too.
    expect(log.errors.map((e) => JSON.parse(e) as unknown)).toEqual([{ router: 'wire-sign-failed', kind: 'call', aud: PEER_REF, reason: 'not-pkcs8-v1' }]);
    expect(log.lines.filter((l) => l['router'] === 'wire-sign')).toEqual([
      { router: 'wire-sign', kind: 'call', aud: PEER_REF, outcome: 'failed', reason: 'not-pkcs8-v1' },
    ]);
  });
});

/**
 * Round trips: the router's own requests into a deployment wrapped by the platform entry's
 * verifier, which judges them with the legacy checks every vertical-host build runs.
 */
describe('the router’s envelopes, judged by the entry’s verifier', () => {
  const deploymentEnv = (state: string, routerKeys = active.publicKey, aud = REF) => ({
    ROUTER_SECRET: SECRET,
    CALL_SECRET,
    [WIRE_ROUTER_KEYS_VAR]: routerKeys,
    [WIRE_PLATFORM_KEYS_VAR]: platformPair.publicKey,
    [WIRE_AUDIENCE_VAR]: aud,
    [WIRE_STATE_VAR]: state,
  });
  type DeploymentEnv = ReturnType<typeof deploymentEnv>;

  /** A deployment behind the entry's verifier: the vertical answers with the identity it was handed. */
  function deployment(env: DeploymentEnv, extra: { nonceCache?: (env: DeploymentEnv, scopeId: string) => WireNonceCache | undefined } = {}) {
    const lines: WireVerificationLine[] = [];
    const handed: Request[] = [];
    const gate = withWireGate<DeploymentEnv>(
      {
        fetch: async (request: Request, e: DeploymentEnv) => {
          handed.push(request);
          const node = readRoutedNode(request.headers, { expectedSecret: e.ROUTER_SECRET });
          if (new URL(request.url).pathname.startsWith('/internal/')) {
            assertPlatformCall(request.headers, { expectedSecret: e.CALL_SECRET });
            return Response.json({ result: { node, body: JSON.parse(await request.text()) as unknown } });
          }
          return Response.json({ node });
        },
      },
      {
        routedNode: (headers, e) => readRoutedNode(headers, { expectedSecret: e.ROUTER_SECRET }),
        routerSecret: (e) => e.ROUTER_SECRET,
        platformSecret: (e) => e.CALL_SECRET,
        log: (line) => lines.push(JSON.parse(line) as WireVerificationLine),
        ...extra,
      },
    );
    const d = namespace((request) => gate.fetch!(request, env, {}) as Promise<Response>);
    return Object.assign(d, { lines, handed });
  }

  it('no verifier configured: the envelope is carried and ignored, by a current entry with no key lists, the entry before it, and no entry at all', async () => {
    const seen: Request[] = [];
    const lines: string[] = [];
    // What a vertical runs itself, as every vertical-host build does: its own legacy check.
    const vertical = {
      fetch: async (request: Request, e: { ROUTER_SECRET: string }) => {
        seen.push(request);
        return Response.json({ node: readRoutedNode(request.headers, { expectedSecret: e.ROUTER_SECRET }) });
      },
    };
    const env = { ROUTER_SECRET: SECRET, CALL_SECRET };
    const current = withWireGate<typeof env>(withInvocationLog<typeof env>(vertical as never, { routerSecret: (e) => e.ROUTER_SECRET }) as never, {
      routedNode: (headers, e) => readRoutedNode(headers, { expectedSecret: e.ROUTER_SECRET }),
      routerSecret: (e) => e.ROUTER_SECRET,
      platformSecret: (e) => e.CALL_SECRET,
      log: (line) => lines.push(line),
    });
    const before = withInvocationLog<typeof env>(vertical as never, { routerSecret: (e) => e.ROUTER_SECRET });
    captured();
    for (const deployed of [current, before, vertical]) {
      seen.length = 0;
      const d = namespace((request) => deployed.fetch!(request, env, {}) as Promise<Response>);
      const res = await worker.fetch(post(), routerEnv(d, ON()));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { node: unknown }).node).toEqual({ tenantId: T, scopeId: S, surface: 'app', verticalSlug: 'fsm' });
      // Carried: the envelope reached the vertical beside the legacy headers, and changed nothing.
      expect(seen[0]!.headers.has(WIRE_ENVELOPE_HEADER)).toBe(true);
      expect(seen[0]!.headers.get('x-substrat-router')).toBe(SECRET);
      expect(await seen[0]!.text()).toBe('{"total":"100.00"}');
    }
    // Ignored: with no key lists the current entry judges nothing and writes no wire line.
    expect(lines).toEqual([]);
  });

  it('dual: a signed route is counted signed-accepted, with no mismatch, and served as the router resolved it', async () => {
    const d = deployment(deploymentEnv('dual'));
    captured();
    const res = await worker.fetch(post(), routerEnv(d, ON()));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { node: unknown }).node).toEqual({ tenantId: T, scopeId: S, surface: 'app', verticalSlug: 'fsm' });
    expect(d.lines).toEqual([expect.objectContaining({ state: 'dual', issuer: 'router', kind: 'route', outcome: 'signed-accepted', reason: null, legacy: 'valid', tenantId: T, scopeId: S })]);
    // Its twin: the same deployment, the router not signing, counts the legacy acceptance.
    const unsigned = deployment(deploymentEnv('dual'));
    await worker.fetch(post(), routerEnv(unsigned));
    expect(unsigned.lines).toEqual([expect.objectContaining({ outcome: 'legacy-accepted', reason: 'missing' })]);
  });

  it('dual: a route with no vertical slug agrees with its legacy headers too', async () => {
    const d = deployment(deploymentEnv('dual'));
    captured();
    await worker.fetch(get(), routerEnv(d, ON(), { CONTROL_PLANE: directory({ vertical_slug: null }) }));
    expect(d.lines).toEqual([expect.objectContaining({ outcome: 'signed-accepted', legacy: 'valid' })]);
  });

  it('a deployment named otherwise refuses the envelope as another audience’s', async () => {
    const d = deployment(deploymentEnv('dual', active.publicKey, 'another-script'));
    captured();
    await worker.fetch(get(), routerEnv(d, ON()));
    expect(d.lines).toEqual([expect.objectContaining({ outcome: 'legacy-accepted', reason: 'audience' })]);
  });

  it('signed-only: a signed route is served on its envelope alone, and a sampled one still arms the field walk', async () => {
    const d = deployment(deploymentEnv('signed-only'));
    captured();
    const res = await worker.fetch(get(), routerEnv(d, ON(), { FIELD_COVERAGE_SAMPLE_RATE: '1' }));
    expect(res.status).toBe(200);
    const handed = d.handed[0]!;
    expect(handed.headers.get('x-substrat-field-coverage')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(d.lines).toEqual([expect.objectContaining({ state: 'signed-only', outcome: 'signed-accepted' })]);
    // Its twin: the router not signing is refused there, and the vertical never runs.
    const refused = deployment(deploymentEnv('signed-only'));
    expect((await worker.fetch(get(), routerEnv(refused))).status).toBe(401);
    expect(refused.handed).toEqual([]);
  });

  it('dual: a signed peer invocation is accepted as the router’s call, its nonce claimed in the target scope', async () => {
    const claimed: string[] = [];
    const d = deployment(deploymentEnv('dual', active.publicKey, PEER_REF), {
      nonceCache: (_env, scopeId) => ({ claim: () => (claimed.push(scopeId), true) }),
    });
    captured();
    expect(await peer(peerEnv(d, ON()), { parentInvocationId: '01JZ0000000000000000PAR001' })).toMatchObject({ ok: true });
    expect(d.lines).toEqual([expect.objectContaining({ issuer: 'router', kind: 'call', outcome: 'signed-accepted', legacy: 'valid' })]);
    expect(claimed).toEqual([TARGET_SCOPE]);
  });

  it('signed-only: a signed peer invocation reaches the target with its vertical and its parent id, and nothing else unsigned', async () => {
    const d = deployment(deploymentEnv('signed-only', active.publicKey, PEER_REF), { nonceCache: () => ({ claim: () => true }) });
    captured();
    expect(await peer(peerEnv(d, ON()), { parentInvocationId: '01JZ0000000000000000PAR001' })).toMatchObject({ ok: true });
    const handed = d.handed[0]!;
    expect(handed.headers.get('x-substrat-vertical')).toBe('acme/crm');
    expect(handed.headers.get('x-substrat-parent-request-id')).toBe('01JZ0000000000000000PAR001');
    expect([...handed.headers.keys()].filter((n) => n.startsWith('x-substrat-')).sort()).toEqual(
      ['x-substrat-parent-request-id', 'x-substrat-platform', 'x-substrat-vertical'],
    );
  });

  it('rotation: a deployment listing the active and the standby key accepts the router signing with either', async () => {
    const both = `${active.publicKey},${standby.publicKey}`;
    for (const key of [active.privateKey, standby.privateKey]) {
      const d = deployment(deploymentEnv('signed-only', both));
      captured();
      expect((await worker.fetch(get(), routerEnv(d, { WIRE_SIGN: 'on', WIRE_ROUTER_KEY: key }))).status).toBe(200);
      expect(d.lines).toEqual([expect.objectContaining({ outcome: 'signed-accepted' })]);
      vi.restoreAllMocks();
    }
    // Its twin: a deployment the standby key never reached refuses a router switched to it.
    const stale = deployment(deploymentEnv('dual', active.publicKey));
    captured();
    await worker.fetch(get(), routerEnv(stale, { WIRE_SIGN: 'on', WIRE_ROUTER_KEY: standby.privateKey }));
    expect(stale.lines).toEqual([expect.objectContaining({ outcome: 'legacy-accepted', reason: 'kid' })]);
  });
});
