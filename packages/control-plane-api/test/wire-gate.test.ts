import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { problemForStatus, PROBLEM_CONTENT_TYPE } from '@substrat-run/contracts';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import { assertPlatformCall } from '@substrat-run/contracts/wire-auth';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/contracts/wire-headers';
import {
  importWireSigningKey,
  signWireEnvelope,
  WIRE_AUDIENCE_VAR,
  WIRE_ENVELOPE_HEADER,
  WIRE_PLATFORM_KEYS_VAR,
  WIRE_ROUTER_KEYS_VAR,
  WIRE_SIGNATURE_HEADER,
  WIRE_REPLAY_FREE_CALLS,
  WIRE_STATE_VAR,
  wireEndpoint,
  wireRequestBinding,
  type WireEnvelopeInput,
  type WireNonceCache,
  type WireSigningKey,
  type WireVerificationLine,
} from '@substrat-run/contracts/wire-signing';
import { readRoutedNode, withInvocationLog } from '@substrat-run/vertical-host';
import {
  WIRE_CLAIM_TIMEOUT_MS,
  WIRE_FAULT_BODY,
  WIRE_REFUSAL_BODY,
  withWireGate,
  type GatedWorker,
  type WireGateOptions,
} from '../platform-entry/wire-gate.js';

/**
 * The wire-signing verifier the platform's entry wraps around every vertical (RFC wire-signing
 * §5, step 1). Run here against vertical-host's own `readRoutedNode` and contracts' own
 * `assertPlatformCall`, the legacy checks the entry composes, and envelopes from contracts' own
 * signer. `platform-entry.workerd.test.ts` runs the emitted entry on workerd.
 */

const ROUTER_VALUE = 'router-legacy-value-0001';
const CALL_VALUE = 'call-legacy-value-0002';
const AUD = 'acme-widgets-deployment';
const TENANT = '01JZ0000000000000000TEN001';
const SCOPE = '01JZ0000000000000000SCP001';
const OTHER_SCOPE = '01JZ0000000000000000SCP002';
const VERTICAL = 'acme/widgets';
/** Every envelope here is minted at this instant, and the gate's clock reads it. */
const NOW = 1_800_000_000;

type Env = Record<string, string | undefined>;

let router: WireSigningKey;
let platform: WireSigningKey;
let stranger: WireSigningKey;
let keyLists: { router: string; platform: string };
beforeAll(async () => {
  const [r, p, s] = await Promise.all([generateScopeStoreKeyPair(), generateScopeStoreKeyPair(), generateScopeStoreKeyPair()]);
  [router, platform, stranger] = await Promise.all([importWireSigningKey(r.privateKey), importWireSigningKey(p.privateKey), importWireSigningKey(s.privateKey)]);
  keyLists = { router: r.publicKey, platform: p.publicKey };
});

afterEach(() => vi.restoreAllMocks());

/** A deployment's env: its legacy credentials, and the wire settings an upload would give it. */
function envOf(state?: string, extra: Env = {}): Env {
  return {
    ROUTER_SECRET: ROUTER_VALUE,
    CALL_SECRET: CALL_VALUE,
    SUBSTRAT_VERSION_ID: '01JZ0000000000000000VER001',
    [WIRE_ROUTER_KEYS_VAR]: keyLists.router,
    [WIRE_PLATFORM_KEYS_VAR]: keyLists.platform,
    [WIRE_AUDIENCE_VAR]: AUD,
    ...(state === undefined ? {} : { [WIRE_STATE_VAR]: state }),
    ...extra,
  };
}

/** The env of a deployment no upload gave keys: every deployment today. */
const legacyEnv = (): Env => ({ ROUTER_SECRET: ROUTER_VALUE, CALL_SECRET: CALL_VALUE });

/**
 * A vertical running its own legacy checks, as every vertical-host build does: a router
 * assertion through `readRoutedNode`, and the `/internal/*` gate through `assertPlatformCall`.
 * It answers with the identity and the body it was handed, and never with a header.
 */
function vertical() {
  const seen: Request[] = [];
  const worker = {
    async fetch(request: Request, env: Env): Promise<Response> {
      seen.push(request);
      let node;
      try {
        node = readRoutedNode(request.headers, { expectedSecret: env['ROUTER_SECRET'] });
      } catch {
        return new Response('router assertion refused', { status: 400 });
      }
      if (new URL(request.url).pathname.startsWith('/internal/')) {
        try {
          assertPlatformCall(request.headers, { expectedSecret: env['CALL_SECRET'] });
        } catch {
          return new Response('not a platform call', { status: 403 });
        }
      }
      return Response.json({ node, body: await request.text() });
    },
  };
  return { worker, seen };
}

/** A vertical that answers without reading its body. */
function unreading() {
  const seen: Request[] = [];
  return { worker: { fetch: (request: Request) => (seen.push(request), new Response('ok', { status: 202 })) }, seen };
}

function gated(extra: Partial<WireGateOptions<Env>> = {}, v: { worker: object; seen: Request[] } = vertical()) {
  const lines: string[] = [];
  const gate = withWireGate<Env>(v.worker as GatedWorker<Env>, {
    routedNode: (headers, env) => readRoutedNode(headers, { expectedSecret: env['ROUTER_SECRET'] }),
    routerSecret: (env) => env['ROUTER_SECRET'],
    platformSecret: (env) => env['CALL_SECRET'],
    clock: () => NOW * 1000,
    log: (line) => lines.push(line),
    ...extra,
  });
  const fetch = (request: Request, env: Env) => gate.fetch!(request, env, {}) as Promise<Response>;
  const wire = () => lines.map((l) => JSON.parse(l) as WireVerificationLine);
  return { fetch, seen: v.seen, lines, wire };
}

/** The router's legacy headers, as `assertNode` sets them. */
const legacyRoute = (over: Record<string, string> = {}) => ({
  'x-substrat-tenant': TENANT,
  'x-substrat-scope': SCOPE,
  'x-substrat-surface': 'app',
  'x-substrat-vertical': VERTICAL,
  'x-substrat-router': ROUTER_VALUE,
  ...over,
});

async function sign(key: WireSigningKey, input: Omit<WireEnvelopeInput, 'method' | 'target'> & { method?: string; url: string }) {
  const { url, method = 'GET', ...rest } = input;
  const binding = wireRequestBinding({ method, url });
  const issued = await signWireEnvelope(key, { iat: NOW, ...rest, method: binding.method, target: binding.target });
  return { [WIRE_ENVELOPE_HEADER]: issued.header, [WIRE_SIGNATURE_HEADER]: issued.signature };
}

const URL_ROUTE = 'https://acme.example/api/things?page=2';
const PROVISION = 'https://vertical/internal/provision';
/** A call that takes a body and changes nothing, so keeps no nonce. */
const QUERY = 'https://vertical/internal/query';

/** A route envelope for `URL_ROUTE` naming the router's identity, unless told otherwise. */
const routeEnvelope = (over: Partial<WireEnvelopeInput> & { url?: string; method?: string } = {}, key = router) =>
  sign(key, { iss: 'router', kind: 'route', aud: AUD, tenantId: TENANT, scopeId: SCOPE, surface: 'app', vertical: VERTICAL, url: URL_ROUTE, ...over });

const callEnvelope = (url: string, body: string, over: Partial<WireEnvelopeInput> & { method?: string } = {}, key = platform) =>
  sign(key, { iss: 'platform', kind: 'call', aud: AUD, method: 'POST', body, url, ...over });

const nodeOf = async (res: Response) => ((await res.json()) as { node: { tenantId: string; scopeId: string; surface: string; verticalSlug: string | null } | null }).node;
const bodyOf = async (res: Response) => ((await res.json()) as { body: string }).body;

describe('legacy-only: a deployment with no key lists is untouched', () => {
  it('hands the vertical the very request, returns what it returned without awaiting, and logs nothing', () => {
    const sentinel = { status: 200, marker: 'the vertical’s own return value' };
    const received: unknown[] = [];
    const lines: string[] = [];
    const console_ = vi.spyOn(console, 'log');
    const gate = withWireGate<Env>(
      { fetch: (request) => (received.push(request), sentinel) },
      {
        routedNode: () => {
          throw new Error('the legacy check must not run in legacy-only');
        },
        routerSecret: () => {
          throw new Error('no setting is read beyond the state');
        },
        platformSecret: () => {
          throw new Error('no setting is read beyond the state');
        },
        clock: () => {
          throw new Error('no clock is read in legacy-only');
        },
        log: (line) => lines.push(line),
      },
    );
    // A request that records every property read: in legacy-only none happens.
    const reads: PropertyKey[] = [];
    const request = new Proxy(new Request(URL_ROUTE, { headers: legacyRoute() }), {
      get(target, key) {
        reads.push(key);
        return Reflect.get(target, key);
      },
    });
    for (const env of [legacyEnv(), { ...envOf('dual'), [WIRE_ROUTER_KEYS_VAR]: ' ', [WIRE_PLATFORM_KEYS_VAR]: '' }, envOf('legacy-only')]) {
      // Synchronously the vertical's own value: not a promise, so nothing was awaited on the way.
      expect(gate.fetch!(request, env, {})).toBe(sentinel);
    }
    // Taken before any assertion below walks the proxy itself.
    const readByGate = [...reads];
    expect(received).toHaveLength(3);
    expect(received.every((r) => r === request)).toBe(true);
    expect(readByGate).toEqual([]);
    expect(lines).toEqual([]);
    expect(console_).not.toHaveBeenCalled();
  });

  it('its positive twin: given key lists, the same gate judges the request and writes one wire line', async () => {
    const g = gated();
    const pending = g.fetch(new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope()) } }), envOf());
    expect(pending).toBeInstanceOf(Promise);
    expect((await pending).status).toBe(200);
    expect(g.wire()).toHaveLength(1);
  });

  it('writes no wire line through the default console either', async () => {
    const console_ = vi.spyOn(console, 'log').mockImplementation(() => {});
    const g = gated({ log: undefined, clock: undefined });
    await g.fetch(new Request(URL_ROUTE, { headers: legacyRoute() }), legacyEnv());
    expect(console_).not.toHaveBeenCalled();
    // Positive twin: in dual the default sink is the console, and it hears exactly the wire line.
    await g.fetch(new Request(URL_ROUTE, { headers: legacyRoute() }), envOf('dual'));
    expect(console_).toHaveBeenCalledTimes(1);
    expect(JSON.parse(console_.mock.calls[0]![0] as string)).toMatchObject({ substrat: 'wire', outcome: 'legacy-accepted', reason: 'missing' });
  });

  it('passes the stamp’s other handlers through as they are, and leaves a worker with no fetch untouched', async () => {
    const worker = { marker: 7, fetch: () => new Response('ok'), scheduled(this: { marker: number }) { return this.marker; } };
    const options = { routedNode: () => null, routerSecret: () => undefined, platformSecret: () => undefined };
    // What the entry wraps: the stamp's output, whose handlers are its own, bound to the vertical.
    const stamped = withInvocationLog(worker as unknown as Parameters<typeof withInvocationLog>[0]) as GatedWorker<Env>;
    const gate = withWireGate<Env>(stamped, options);
    expect(gate['scheduled']).toBe(stamped['scheduled']);
    expect((gate['scheduled'] as () => number)()).toBe(7);
    const classEntrypoint = { scheduled: () => 1 };
    expect(withWireGate<Env>(classEntrypoint as unknown as GatedWorker<Env>, options)).toBe(classEntrypoint);
  });
});

describe('dual, a routed request: the legacy credential serves it as today', () => {
  it('both valid and agreeing: the very request reaches the vertical, counted signed-accepted', async () => {
    const g = gated();
    const request = new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope()) } });
    const res = await g.fetch(request, envOf('dual'));
    expect(res.status).toBe(200);
    expect(g.seen[0]).toBe(request);
    expect(g.wire()).toEqual([
      {
        substrat: 'wire',
        state: 'dual',
        issuer: 'router',
        kind: 'route',
        outcome: 'signed-accepted',
        reason: null,
        fault: null,
        legacy: 'valid',
        tenantId: TENANT,
        scopeId: SCOPE,
        versionId: '01JZ0000000000000000VER001',
      },
    ]);
  });

  it('a missing or unknown state with key lists reads as dual', async () => {
    for (const state of [undefined, 'bogus']) {
      const g = gated();
      const res = await g.fetch(new Request(URL_ROUTE, { headers: legacyRoute() }), envOf(state));
      expect(res.status).toBe(200);
      expect(g.wire()[0]).toMatchObject({ state: 'dual', outcome: 'legacy-accepted', reason: 'missing' });
    }
  });

  it.each([
    ['scope', { scopeId: OTHER_SCOPE }],
    ['tenant', { tenantId: '01JZ0000000000000000TEN002' }],
    ['surface', { surface: 'back-office' }],
    ['vertical', { vertical: 'acme/other' }],
    ['vertical left out', { vertical: null }],
  ])('a disagreement on the %s is served through the legacy identity and counted dual-mismatch', async (_, over) => {
    const g = gated();
    const request = new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope(over)) } });
    const res = await g.fetch(request, envOf('dual'));
    expect(res.status).toBe(200);
    expect(g.seen[0]).toBe(request);
    expect(await nodeOf(res)).toEqual({ tenantId: TENANT, scopeId: SCOPE, surface: 'app', verticalSlug: VERTICAL });
    expect(g.wire()[0]).toMatchObject({ outcome: 'dual-mismatch', reason: null, legacy: 'valid', tenantId: TENANT, scopeId: SCOPE });
  });

  const refusals: Array<[string, () => Promise<Record<string, string>>]> = [
    ['missing', async () => ({})],
    ['malformed', async () => ({ [WIRE_ENVELOPE_HEADER]: 'not-an-envelope', [WIRE_SIGNATURE_HEADER]: 'x' })],
    ['kid', async () => routeEnvelope({}, stranger)],
    ['signature', async () => ({ ...(await routeEnvelope()), [WIRE_SIGNATURE_HEADER]: (await routeEnvelope({ scopeId: OTHER_SCOPE }))[WIRE_SIGNATURE_HEADER]! })],
    ['audience', async () => routeEnvelope({ aud: 'another-deployment' })],
    ['expired', async () => routeEnvelope({ iat: NOW - 200, exp: NOW - 100 })],
    ['not-yet-valid', async () => routeEnvelope({ iat: NOW + 100 })],
    ['method', async () => routeEnvelope({ method: 'POST' })],
    ['target', async () => routeEnvelope({ url: 'https://acme.example/api/things?page=3' })],
    ['issuer', async () => sign(platform, { iss: 'platform', kind: 'call', aud: AUD, body: '', url: URL_ROUTE })],
    ['kind', async () => sign(router, { iss: 'router', kind: 'call', aud: AUD, body: '', url: URL_ROUTE })],
  ];

  it.each(refusals)('an envelope refused for %s beside a valid legacy credential is served as today, counted legacy-accepted', async (reason, envelope) => {
    const g = gated();
    const request = new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await envelope()) } });
    const res = await g.fetch(request, envOf('dual'));
    expect(res.status).toBe(200);
    expect(g.seen[0]).toBe(request);
    expect(g.wire()[0]).toMatchObject({ outcome: 'legacy-accepted', reason, legacy: 'valid', tenantId: TENANT, scopeId: SCOPE });
  });
});

describe('dual, a routed request the legacy credential does not prove', () => {
  it('an envelope alone admits it, and the vertical sees the identity the envelope proved', async () => {
    const g = gated();
    const res = await g.fetch(new Request(URL_ROUTE, { headers: await routeEnvelope() }), envOf('dual'));
    expect(res.status).toBe(200);
    expect(await nodeOf(res)).toEqual({ tenantId: TENANT, scopeId: SCOPE, surface: 'app', verticalSlug: VERTICAL });
    expect(g.wire()[0]).toMatchObject({ outcome: 'signed-accepted', legacy: 'absent', tenantId: TENANT, scopeId: SCOPE });
  });

  it('beside a legacy credential that fails, the envelope’s identity is the only one the vertical sees', async () => {
    const g = gated();
    const headers = { ...legacyRoute({ 'x-substrat-router': 'wrong', 'x-substrat-scope': OTHER_SCOPE, 'x-substrat-surface': 'back-office' }), ...(await routeEnvelope({ vertical: null })) };
    const res = await g.fetch(new Request(URL_ROUTE, { headers }), envOf('dual'));
    expect(res.status).toBe(200);
    expect(await nodeOf(res)).toEqual({ tenantId: TENANT, scopeId: SCOPE, surface: 'app', verticalSlug: null });
    expect(g.wire()[0]).toMatchObject({ outcome: 'signed-accepted', legacy: 'invalid', scopeId: SCOPE });
  });

  it('neither credential: the very request goes on, and the vertical’s own check answers it as today', async () => {
    const g = gated();
    const bare = new Request(URL_ROUTE);
    expect((await g.fetch(bare, envOf('dual'))).status).toBe(200);
    expect(g.seen[0]).toBe(bare);
    const forged = new Request(URL_ROUTE, { headers: { ...legacyRoute({ 'x-substrat-router': 'wrong' }), ...(await routeEnvelope({ aud: 'elsewhere' })) } });
    const res = await g.fetch(forged, envOf('dual'));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('router assertion refused');
    expect(g.seen[1]).toBe(forged);
    expect(g.wire().map((l) => [l.outcome, l.reason, l.legacy, l.tenantId])).toEqual([
      ['refused', 'missing', 'absent', null],
      ['refused', 'audience', 'invalid', null],
    ]);
  });
});

describe('dual, a call to the internal surface', () => {
  const EXPORT = `https://vertical/internal/export?scopeId=${SCOPE}`;
  const callHeaders = (legacy: boolean) => (legacy ? { [PLATFORM_SECRET_HEADER]: CALL_VALUE } : {});

  it('a read verified beside the legacy credential is counted signed-accepted, and no nonce is asked for', async () => {
    const nonceCache = vi.fn();
    const g = gated({ nonceCache });
    const headers = { ...callHeaders(true), ...(await callEnvelope(EXPORT, '', { method: 'GET', tenantId: TENANT, scopeId: SCOPE })) };
    const res = await g.fetch(new Request(EXPORT, { headers }), envOf('dual'));
    expect(res.status).toBe(200);
    expect(nonceCache).not.toHaveBeenCalled();
    expect(g.wire()[0]).toMatchObject({ issuer: 'platform', kind: 'call', outcome: 'signed-accepted', legacy: 'valid', tenantId: TENANT, scopeId: SCOPE });
  });

  it('a scoped call that changes state, on a version with no nonce store, is served through the legacy credential and counted as the fault', async () => {
    const g = gated();
    const body = JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, owner: 'someone' });
    const headers = { ...callHeaders(true), ...(await callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE })) };
    const res = await g.fetch(new Request(PROVISION, { method: 'POST', headers, body }), envOf('dual'));
    expect(res.status).toBe(200);
    // The body was read to be verified, and the vertical still receives every byte of it.
    expect(await bodyOf(res)).toBe(body);
    expect(g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'no-nonce-store', reason: null, legacy: 'valid' });
  });

  it('the same call with no valid legacy credential beside it goes on as it came, and the vertical’s own gate refuses it', async () => {
    for (const [legacy, credential] of [
      [{}, 'absent'],
      [{ [PLATFORM_SECRET_HEADER]: 'wrong' }, 'invalid'],
    ] as const) {
      const g = gated();
      const body = JSON.stringify({ scopeId: SCOPE });
      const headers = { ...legacy, ...(await callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE })) };
      const res = await g.fetch(new Request(PROVISION, { method: 'POST', headers, body }), envOf('dual'));
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('not a platform call');
      expect(g.seen).toHaveLength(1);
      expect(g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'no-nonce-store', legacy: credential });
    }
  });

  it.each([
    ['a scope named', PROVISION, { tenantId: TENANT, scopeId: SCOPE }],
    ['no scope named', PROVISION, {}],
    ['an endpoint the table has never heard of', 'https://vertical/internal/brand-new-verb', {}],
    ['another spelling of a replay-free endpoint', 'https://vertical/internal/%71uery', {}],
  ])('a call that changes state keeps nonces with %s: fail closed, the counted fault', async (_, url, scope) => {
    const body = '{"ping":true}';
    const headers = { ...callHeaders(true), ...(await callEnvelope(url, body, scope)) };
    const dual = gated();
    const served = await dual.fetch(new Request(url, { method: 'POST', headers, body }), envOf('dual'));
    expect(await bodyOf(served)).toBe(body);
    // The envelope passed every check before the claim, so the fault is filed under what it named.
    expect(dual.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'no-nonce-store', legacy: 'valid', issuer: 'platform', tenantId: scope.tenantId ?? null, scopeId: scope.scopeId ?? null });
    const signedOnly = gated();
    expect((await signedOnly.fetch(new Request(url, { method: 'POST', headers, body }), envOf('signed-only'))).status).toBe(503);
    expect(signedOnly.seen).toEqual([]);
  });

  it.each(WIRE_REPLAY_FREE_CALLS)('a call the table lists as changing nothing keeps no nonce: %s', async (path) => {
    const url = `https://vertical${path}`;
    const nonceCache = vi.fn();
    const g = gated({ nonceCache });
    const headers = { ...callHeaders(true), ...(await callEnvelope(url, '{}', { tenantId: TENANT, scopeId: SCOPE })) };
    const res = await g.fetch(new Request(url, { method: 'POST', headers, body: '{}' }), envOf('signed-only'));
    expect(res.status).toBe(200);
    expect(nonceCache).not.toHaveBeenCalled();
    expect(g.wire()[0]).toMatchObject({ outcome: 'signed-accepted', fault: null });
  });

  it('an envelope signed over another body is refused for the body, and the legacy credential still serves it', async () => {
    const g = gated();
    const headers = { ...callHeaders(true), ...(await callEnvelope(PROVISION, '{"a":1}')) };
    const res = await g.fetch(new Request(PROVISION, { method: 'POST', headers, body: '{"a":2}' }), envOf('dual'));
    expect(await bodyOf(res)).toBe('{"a":2}');
    expect(g.wire()[0]).toMatchObject({ outcome: 'legacy-accepted', reason: 'body' });
  });

  it('an envelope alone admits a call: the vertical’s own internal gate passes and the body arrives intact', async () => {
    const g = gated();
    const body = '{"ping":true}';
    const res = await g.fetch(new Request(QUERY, { method: 'POST', headers: await callEnvelope(QUERY, body), body }), envOf('dual'));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toBe(body);
    expect(g.wire()[0]).toMatchObject({ outcome: 'signed-accepted', legacy: 'absent' });
  });

  it('only a peer invocation admits the router as the issuer of a call; the control plane is admitted everywhere internal', async () => {
    const INVOKE = 'https://vertical/internal/vertical-invoke';
    const body = '{"operation":"x"}';
    const routerCall = (url: string) => sign(router, { iss: 'router', kind: 'call', aud: AUD, method: 'POST', body, url });
    // A peer invocation runs an operation, so it keeps nonces: an envelope that passes every check
    // reaches the nonce store, which this version lacks, and is counted as that fault.
    // The line names the issuer it verified; a refused envelope's own claim is not taken.
    const expired = { iat: NOW - 200, exp: NOW - 100 };
    const cases: Array<[string, Record<string, string>, Record<string, unknown>]> = [
      [INVOKE, await routerCall(INVOKE), { outcome: 'fault', fault: 'no-nonce-store', issuer: 'router' }],
      [INVOKE, await callEnvelope(INVOKE, body), { outcome: 'fault', fault: 'no-nonce-store', issuer: 'platform' }],
      [PROVISION, await routerCall(PROVISION), { outcome: 'refused', reason: 'issuer', issuer: 'platform' }],
      [INVOKE, await sign(router, { iss: 'router', kind: 'call', aud: AUD, method: 'POST', body, url: INVOKE, ...expired }), { outcome: 'refused', reason: 'expired', issuer: null }],
      [INVOKE, await callEnvelope(INVOKE, body, expired), { outcome: 'refused', reason: 'expired', issuer: null }],
    ];
    for (const [url, envelope, line] of cases) {
      const g = gated();
      await g.fetch(new Request(url, { method: 'POST', headers: envelope, body }), envOf('dual'));
      expect(g.wire()[0]).toMatchObject(line);
    }
  });

  it.each([
    ['/internal/provision', 'issuer'],
    ['/internal/vertical-invoke', 'kind'],
  ])('a route envelope never opens the internal surface: %s refuses it for the %s', async (path, reason) => {
    const g = gated();
    const url = `https://acme.example${path}`;
    const res = await g.fetch(new Request(url, { method: 'POST', headers: { ...legacyRoute(), ...(await routeEnvelope({ url, method: 'POST' })) }, body: '{}' }), envOf('dual'));
    expect(res.status).toBe(403);
    expect(g.wire()[0]).toMatchObject({ kind: 'call', outcome: 'refused', reason, legacy: 'absent' });
  });

  describe('the nonce store seam (RFC §4), for when a version has one', () => {
    const scopedCall = async (env: Env, options: Partial<WireGateOptions<Env>>) => {
      const g = gated(options);
      const body = '{"x":1}';
      const headers = { ...callHeaders(true), ...(await callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE })) };
      const res = await g.fetch(new Request(PROVISION, { method: 'POST', headers, body }), env);
      return { res, g };
    };

    it('claims the nonce in the scope the envelope pins, until exp plus skew, and accepts on exactly true', async () => {
      const claim = vi.fn<WireNonceCache['claim']>(() => true);
      const nonceCache = vi.fn((_env: Env, _scope: string) => ({ claim }));
      const { res, g } = await scopedCall(envOf('dual'), { nonceCache });
      expect(res.status).toBe(200);
      expect(nonceCache).toHaveBeenCalledTimes(1);
      expect(nonceCache).toHaveBeenCalledWith(expect.anything(), SCOPE);
      expect(claim).toHaveBeenCalledWith(expect.any(String), NOW + 60 + 30);
      expect(g.wire()[0]).toMatchObject({ outcome: 'signed-accepted' });
    });

    it('reaches the store only at the claim: after the body is read, so after every check before it', async () => {
      let pulled = false;
      const reachedAfterBody: boolean[] = [];
      const g = gated({ nonceCache: () => (reachedAfterBody.push(pulled), { claim: () => true }) });
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled = true;
            controller.enqueue(new TextEncoder().encode('{"x":1}'));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const headers = { ...callHeaders(true), ...(await callEnvelope(PROVISION, '{"x":1}', { tenantId: TENANT, scopeId: SCOPE })) };
      await g.fetch(new Request(PROVISION, { method: 'POST', headers, body, duplex: 'half' } as RequestInit), envOf('dual'));
      expect(reachedAfterBody).toEqual([true]);
      expect(g.wire()[0]).toMatchObject({ outcome: 'signed-accepted' });
    });

    /** Envelopes for the scoped call that fail before the claim, each naming a scope in its unverified claims. */
    const refusedBeforeTheClaim: Array<[string, (body: string) => Promise<Record<string, string>>]> = [
      // The envelope names the scope, and its signature never came.
      ['missing', async (body) => ({ [WIRE_ENVELOPE_HEADER]: (await callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE }))[WIRE_ENVELOPE_HEADER]! })],
      [
        'signature',
        // The header names another scope; the signature is the genuine envelope's.
        async (body) => ({
          ...(await callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: OTHER_SCOPE })),
          [WIRE_SIGNATURE_HEADER]: (await callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE }))[WIRE_SIGNATURE_HEADER]!,
        }),
      ],
      ['kid', async (body) => callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE }, stranger)],
      ['audience', async (body) => callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE, aud: 'another-deployment' })],
      ['expired', async (body) => callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE, iat: NOW - 200, exp: NOW - 100 })],
      ['body', async () => callEnvelope(PROVISION, '{"signed":"another body"}', { tenantId: TENANT, scopeId: SCOPE })],
    ];

    it.each(refusedBeforeTheClaim)('an envelope refused for %s never reaches the store, and a store that throws cannot change its answer', async (reason, envelope) => {
      const body = '{"x":1}';
      for (const state of ['dual', 'signed-only']) {
        const nonceCache = vi.fn((_env: Env, _scope: string): WireNonceCache => {
          throw new Error('the store must not be reached');
        });
        const g = gated({ nonceCache });
        const headers = { ...callHeaders(true), ...(await envelope(body)) };
        const res = await g.fetch(new Request(PROVISION, { method: 'POST', headers, body }), envOf(state));
        expect(nonceCache).not.toHaveBeenCalled();
        if (state === 'dual') {
          // Served through the legacy credential, as it would be with no store at all.
          expect(res.status).toBe(200);
          expect(await bodyOf(res)).toBe(body);
          expect(g.wire()[0]).toMatchObject({ outcome: 'legacy-accepted', reason, fault: null });
        } else {
          expect(res.status).toBe(401);
          expect(await res.text()).toBe(WIRE_REFUSAL_BODY);
          expect(g.wire()[0]).toMatchObject({ outcome: 'refused', reason, fault: null });
        }
      }
    });

    it('a spent nonce is refused as a replay, which the legacy credential still serves in dual', async () => {
      const { res, g } = await scopedCall(envOf('dual'), { nonceCache: () => ({ claim: () => false }) });
      expect(res.status).toBe(200);
      expect(g.wire()[0]).toMatchObject({ outcome: 'legacy-accepted', reason: 'replay' });
    });

    it('a store that throws is the platform’s fault in every state: the fixed 503, never the legacy path', async () => {
      for (const state of ['dual', 'signed-only']) {
        const { res, g } = await scopedCall(envOf(state), {
          nonceCache: () => ({
            claim() {
              throw new Error(`store detail ${CALL_VALUE}`);
            },
          }),
        });
        expect(res.status).toBe(503);
        expect(await res.text()).toBe(WIRE_FAULT_BODY);
        expect(g.seen).toEqual([]);
        expect(g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'nonce-store' });
        expect(g.lines.join('\n')).not.toContain('store detail');
      }
    });

    it('a claim that never settles times out as the store’s failure', async () => {
      const { res, g } = await scopedCall(envOf('dual'), { nonceCache: () => ({ claim: () => new Promise<boolean>(() => {}) }), claimTimeoutMs: 20 });
      expect(res.status).toBe(503);
      expect(g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'nonce-store' });
      expect(WIRE_CLAIM_TIMEOUT_MS).toBe(1000);
    });

    it('a store that cannot even be reached, for an envelope that passed every other check, is the store’s failure in every state', async () => {
      for (const state of ['dual', 'signed-only']) {
        const { res, g } = await scopedCall(envOf(state), {
          nonceCache: () => {
            throw new Error('no binding');
          },
        });
        expect(res.status).toBe(503);
        expect(await res.text()).toBe(WIRE_FAULT_BODY);
        expect(g.seen).toEqual([]);
        expect(g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'nonce-store' });
      }
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
    ])('a seam that answers %s says this version has no store: the static fault, which dual serves through the legacy credential', async (_, answer) => {
      const nonceCache = vi.fn(() => answer as unknown as WireNonceCache | undefined);
      const dual = await scopedCall(envOf('dual'), { nonceCache });
      expect(dual.res.status).toBe(200);
      expect(await bodyOf(dual.res)).toBe('{"x":1}');
      // Asked once, for the scope the envelope named, and counted as the version's own static fault.
      expect(nonceCache).toHaveBeenCalledTimes(1);
      expect(nonceCache).toHaveBeenCalledWith(expect.anything(), SCOPE);
      expect(dual.g.wire()).toEqual([
        expect.objectContaining({ outcome: 'fault', fault: 'no-nonce-store', reason: null, legacy: 'valid', issuer: 'platform', tenantId: TENANT, scopeId: SCOPE }),
      ]);
      // Its twin: signed-only has no legacy path to hand it to, so the fault is answered.
      const signedOnly = await scopedCall(envOf('signed-only'), { nonceCache });
      expect(signedOnly.res.status).toBe(503);
      expect(await signedOnly.res.text()).toBe(WIRE_FAULT_BODY);
      expect(signedOnly.g.seen).toEqual([]);
      expect(signedOnly.g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'no-nonce-store' });
    });

    it('a seam with no store, beside no valid legacy credential, hands the call on as it came, to the vertical’s own gate', async () => {
      const g = gated({ nonceCache: () => undefined });
      const body = '{"x":1}';
      const headers = { [PLATFORM_SECRET_HEADER]: 'wrong', ...(await callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE })) };
      const request = new Request(PROVISION, { method: 'POST', headers, body });
      const res = await g.fetch(request, envOf('dual'));
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('not a platform call');
      expect(g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'no-nonce-store', legacy: 'invalid' });
    });
  });

  it('a request the gate cannot hand on as the envelope proved it is the fixed 503, counted, and never the vertical’s', async () => {
    const g = gated({
      routerSecret: () => {
        throw new Error('unreadable');
      },
    });
    const res = await g.fetch(new Request(URL_ROUTE, { headers: await routeEnvelope() }), envOf('dual'));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(WIRE_FAULT_BODY);
    expect(g.seen).toEqual([]);
    expect(g.wire()).toEqual([expect.objectContaining({ outcome: 'fault', fault: 'verifier' })]);
  });
});

describe('signed-only: the envelope alone decides', () => {
  it('a valid envelope is served as the envelope says, whatever the legacy headers claim', async () => {
    const g = gated();
    const headers = { ...legacyRoute({ 'x-substrat-scope': OTHER_SCOPE }), ...(await routeEnvelope()) };
    const res = await g.fetch(new Request(URL_ROUTE, { headers }), envOf('signed-only'));
    expect(res.status).toBe(200);
    expect(await nodeOf(res)).toEqual({ tenantId: TENANT, scopeId: SCOPE, surface: 'app', verticalSlug: VERTICAL });
    // The two disagree: still the router defect the counter shows, after the flip as before it.
    expect(g.wire()[0]).toMatchObject({ state: 'signed-only', outcome: 'dual-mismatch', legacy: 'valid', scopeId: SCOPE });
    // Its twin: legacy headers that agree are plain acceptance.
    const agreeing = gated();
    await agreeing.fetch(new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope()) } }), envOf('signed-only'));
    expect(agreeing.wire()[0]).toMatchObject({ state: 'signed-only', outcome: 'signed-accepted', legacy: 'valid' });
  });

  it('every refusal is the same status and the same body, and the vertical never runs', async () => {
    const answers = new Set<string>();
    for (const [reason, envelope] of [
      ['missing', async () => ({})],
      ['kid', async () => routeEnvelope({}, stranger)],
      ['audience', async () => routeEnvelope({ aud: 'another-deployment' })],
      ['expired', async () => routeEnvelope({ iat: NOW - 200, exp: NOW - 100 })],
      ['target', async () => routeEnvelope({ url: 'https://acme.example/elsewhere' })],
    ] as const) {
      const g = gated();
      const res = await g.fetch(new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await envelope()) } }), envOf('signed-only'));
      answers.add(`${res.status} ${res.headers.get('content-type')} ${await res.text()}`);
      expect(g.seen).toEqual([]);
      // The reason went to the counter, and only there.
      expect(g.wire()[0]).toMatchObject({ outcome: 'refused', reason });
    }
    expect([...answers]).toEqual([`401 ${PROBLEM_CONTENT_TYPE} ${WIRE_REFUSAL_BODY}`]);
  });

  it('a call that needs a nonce store this version lacks is the fixed 503; one that changes nothing is served', async () => {
    const body = '{}';
    const scoped = gated();
    const res = await scoped.fetch(new Request(PROVISION, { method: 'POST', headers: await callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE }), body }), envOf('signed-only'));
    expect(res.status).toBe(503);
    const replayFree = gated();
    const twin = await replayFree.fetch(new Request(QUERY, { method: 'POST', headers: await callEnvelope(QUERY, body, { tenantId: TENANT, scopeId: SCOPE }), body }), envOf('signed-only'));
    expect(twin.status).toBe(200);
  });

  it('a valid legacy credential does not carry a call past a missing nonce store: only dual serves it', async () => {
    const body = '{}';
    const answers: number[] = [];
    for (const state of ['signed-only', 'dual']) {
      const g = gated();
      const headers = { [PLATFORM_SECRET_HEADER]: CALL_VALUE, ...(await callEnvelope(PROVISION, body, { tenantId: TENANT, scopeId: SCOPE })) };
      const res = await g.fetch(new Request(PROVISION, { method: 'POST', headers, body }), envOf(state));
      answers.push(res.status);
      expect(g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'no-nonce-store', legacy: 'valid' });
    }
    expect(answers).toEqual([503, 200]);
  });
});

describe('the router’s prefix, as the vertical sees it', () => {
  /** Headers under the prefix that no envelope signs, in mixed case. */
  const unsigned = {
    'X-Substrat-Field-Coverage': '01JZ0000000000000000FLD001',
    'X-SUBSTRAT-EXTRA': 'forged',
    'x-Substrat-Parent-Request-Id': '01JZ0000000000000000PAR001',
  };
  const prefixed = (r: Request) => [...r.headers.keys()].filter((name) => name.startsWith('x-substrat-')).sort();
  /** A routed request carrying an envelope, the unsigned headers, and identity headers sent twice, in two cases. */
  async function crowded(legacy: Record<string, string>) {
    const headers = new Headers({ ...unsigned, ...legacy, ...(await routeEnvelope()) });
    headers.append('x-substrat-scope', OTHER_SCOPE);
    headers.append('X-Substrat-Tenant', '01JZ0000000000000000TEN002');
    return new Request(URL_ROUTE, { headers });
  }
  const IDENTITY = ['x-substrat-router', 'x-substrat-scope', 'x-substrat-surface', 'x-substrat-tenant', 'x-substrat-vertical'];

  it.each(['dual', 'signed-only'])('%s, an envelope alone: only what it proved, whatever was sent beside it', async (state) => {
    for (const legacy of [{}, legacyRoute()]) {
      const g = gated();
      const res = await g.fetch(await crowded(legacy), envOf(state));
      expect(res.status).toBe(200);
      const seen = g.seen[0]!;
      expect(prefixed(seen)).toEqual(IDENTITY);
      expect(seen.headers.get('x-substrat-tenant')).toBe(TENANT);
      expect(seen.headers.get('x-substrat-scope')).toBe(SCOPE);
      expect(seen.headers.get('x-substrat-vertical')).toBe(VERTICAL);
      expect(await nodeOf(res)).toEqual({ tenantId: TENANT, scopeId: SCOPE, surface: 'app', verticalSlug: VERTICAL });
    }
  });

  it('an envelope alone admitting a call: only the credential and the listed parent id, and nothing else it did not sign', async () => {
    const g = gated();
    const headers = new Headers({ ...unsigned, ...(await callEnvelope(QUERY, '{}')) });
    headers.append('x-substrat-tenant', TENANT);
    const res = await g.fetch(new Request(QUERY, { method: 'POST', headers, body: '{}' }), envOf('dual'));
    expect(res.status).toBe(200);
    // The parent id is listed as carrying no authority on a call (RFC §5); the field-coverage
    // value here is not a ULID, and the rest are not listed.
    expect(prefixed(g.seen[0]!)).toEqual(['x-substrat-parent-request-id', PLATFORM_SECRET_HEADER]);
  });

  it('a peer invocation the router signs is handed the vertical it names, and no other; a call that names none gets none', async () => {
    const INVOKE = 'https://vertical/internal/vertical-invoke';
    const body = '{"operation":"x"}';
    // A peer invocation keeps nonces, so it is admitted on its envelope alone only where a store is.
    const stored = { nonceCache: () => ({ claim: () => true }) };
    const routerSigned = new Headers(await sign(router, { iss: 'router', kind: 'call', aud: AUD, method: 'POST', body, url: INVOKE, vertical: VERTICAL, tenantId: TENANT, scopeId: SCOPE }));
    routerSigned.set('X-Substrat-Vertical', 'acme/forged');
    const g = gated(stored);
    expect((await g.fetch(new Request(INVOKE, { method: 'POST', headers: routerSigned, body }), envOf('dual'))).status).toBe(200);
    expect(g.seen[0]!.headers.get('x-substrat-vertical')).toBe(VERTICAL);
    expect(g.wire()[0]).toMatchObject({ outcome: 'signed-accepted', issuer: 'router' });

    const platformSigned = new Headers(await callEnvelope(INVOKE, body, { tenantId: TENANT, scopeId: SCOPE }));
    platformSigned.set('x-substrat-vertical', 'acme/forged');
    const twin = gated(stored);
    expect((await twin.fetch(new Request(INVOKE, { method: 'POST', headers: platformSigned, body }), envOf('dual'))).status).toBe(200);
    expect(twin.seen[0]!.headers.has('x-substrat-vertical')).toBe(false);
  });

  describe('the headers listed as carrying no authority (RFC §5, step 2)', () => {
    const COVERAGE = '01JZ0000000000000000CVG001';
    const PARENT = '01JZ0000000000000000PAR001';
    const INVOKE = 'https://vertical/internal/vertical-invoke';
    const stored = { nonceCache: () => ({ claim: () => true }) };

    it.each(['dual', 'signed-only'])('%s, a route admitted on its envelope alone: a field-coverage ULID is handed on, nothing else unsigned is', async (state) => {
      const g = gated();
      const headers = new Headers({ ...(await routeEnvelope()), 'X-Substrat-Field-Coverage': COVERAGE, 'x-substrat-parent-request-id': PARENT, 'x-substrat-extra': COVERAGE });
      expect((await g.fetch(new Request(URL_ROUTE, { headers }), envOf(state))).status).toBe(200);
      const seen = g.seen[0]!;
      expect(seen.headers.get('x-substrat-field-coverage')).toBe(COVERAGE);
      // The parent id rides a call, never a route, and a header nobody listed is still dropped.
      expect(prefixed(seen)).toEqual([...IDENTITY, 'x-substrat-field-coverage'].sort());
    });

    it.each([
      ['not a ULID', 'not-a-dispatch-id'],
      ['lower case', COVERAGE.toLowerCase()],
      ['empty', ''],
    ])('a field-coverage value that fails its reader’s check (%s) is dropped', async (_, value) => {
      const g = gated();
      const headers = new Headers({ ...(await routeEnvelope()), 'x-substrat-field-coverage': value });
      await g.fetch(new Request(URL_ROUTE, { headers }), envOf('signed-only'));
      expect(g.seen[0]!.headers.has('x-substrat-field-coverage')).toBe(false);
      expect(prefixed(g.seen[0]!)).toEqual(IDENTITY);
    });

    it('a field-coverage header sent twice is dropped whole, even when both values are ULIDs', async () => {
      const g = gated();
      const headers = new Headers(await routeEnvelope());
      headers.append('x-substrat-field-coverage', COVERAGE);
      headers.append('X-Substrat-Field-Coverage', COVERAGE);
      await g.fetch(new Request(URL_ROUTE, { headers }), envOf('signed-only'));
      expect(g.seen[0]!.headers.has('x-substrat-field-coverage')).toBe(false);
    });

    it('a peer invocation admitted on its envelope alone: a parent-id ULID is handed on; a field-coverage header and a bad parent id are not', async () => {
      const body = '{"operation":"x"}';
      const envelope = await sign(router, { iss: 'router', kind: 'call', aud: AUD, method: 'POST', body, url: INVOKE, vertical: VERTICAL, tenantId: TENANT, scopeId: SCOPE });
      const g = gated(stored);
      const headers = new Headers({ ...envelope, 'X-Substrat-Parent-Request-Id': PARENT, 'x-substrat-field-coverage': COVERAGE });
      expect((await g.fetch(new Request(INVOKE, { method: 'POST', headers, body }), envOf('signed-only'))).status).toBe(200);
      expect(g.seen[0]!.headers.get('x-substrat-parent-request-id')).toBe(PARENT);
      expect(prefixed(g.seen[0]!)).toEqual(['x-substrat-parent-request-id', PLATFORM_SECRET_HEADER, 'x-substrat-vertical'].sort());

      const twin = gated(stored);
      const bad = new Headers({ ...envelope, 'x-substrat-parent-request-id': `${PARENT},${PARENT}` });
      await twin.fetch(new Request(INVOKE, { method: 'POST', headers: bad, body }), envOf('signed-only'));
      expect(twin.seen[0]!.headers.has('x-substrat-parent-request-id')).toBe(false);
    });

    it('signed-only, through the real stamp: a sampled route still arms the field walk, and an unsampled one does not', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      // What the operation route asks before it walks a response: the stamp's armed dispatch id.
      const armed = (request: Request) =>
        (globalThis as unknown as Record<symbol, WeakMap<object, { fieldCoverageId?: string }> | undefined>)[Symbol.for('substrat.invocation-stamp')]?.get(request)
          ?.fieldCoverageId ?? null;
      const stamped = withInvocationLog<Env>(
        { fetch: (request: Request) => Response.json({ armed: armed(request) }) } as unknown as Parameters<typeof withInvocationLog<Env>>[0],
        { routerSecret: (env) => env['ROUTER_SECRET'] },
      ) as GatedWorker<Env>;
      const g = gated({}, { worker: stamped, seen: [] });
      const sampled = await g.fetch(new Request(URL_ROUTE, { headers: { ...(await routeEnvelope()), 'x-substrat-field-coverage': COVERAGE } }), envOf('signed-only'));
      expect(await sampled.json()).toEqual({ armed: COVERAGE });
      const unsampled = await g.fetch(new Request(URL_ROUTE, { headers: await routeEnvelope() }), envOf('signed-only'));
      expect(await unsampled.json()).toEqual({ armed: null });
    });
  });

  it.each(['legacy-only', 'dual'])('%s, a valid legacy credential: the request goes on exactly as it came, as today', async (state) => {
    const g = gated();
    const request = new Request(URL_ROUTE, { headers: { ...unsigned, ...legacyRoute(), ...(await routeEnvelope()) } });
    await g.fetch(request, state === 'legacy-only' ? legacyEnv() : envOf(state));
    expect(g.seen[0]).toBe(request);
    expect(prefixed(g.seen[0]!)).toEqual(
      ['x-substrat-extra', 'x-substrat-field-coverage', 'x-substrat-parent-request-id', 'x-substrat-wire-envelope', 'x-substrat-wire-signature', ...IDENTITY].sort(),
    );
  });
});

describe('time, and the counter, as the gate holds them', () => {
  const scopedHeaders = async () => ({ [PLATFORM_SECRET_HEADER]: CALL_VALUE, ...(await callEnvelope(PROVISION, '{}', { tenantId: TENANT, scopeId: SCOPE })) });

  it('judges the envelope’s window at arrival, whatever the clock reads afterwards', async () => {
    let reads = 0;
    const g = gated({ clock: () => (reads++ === 0 ? NOW : NOW + 1000) * 1000 });
    await g.fetch(new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope()) } }), envOf('dual'));
    expect(g.wire()[0]).toMatchObject({ outcome: 'signed-accepted', reason: null });
    // Its twin: the same envelope on a request that arrives that late is expired.
    const late = gated({ clock: () => (NOW + 1000) * 1000 });
    await late.fetch(new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope()) } }), envOf('dual'));
    expect(late.wire()[0]).toMatchObject({ outcome: 'legacy-accepted', reason: 'expired' });
  });

  it('a body slow enough to outlast the window is refused at the claim, never claimed, never read as expired', async () => {
    let now = NOW;
    const claim = vi.fn<WireNonceCache['claim']>(() => true);
    const g = gated({ clock: () => now * 1000, nonceCache: () => ({ claim }) });
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          now = NOW + 200;
          controller.enqueue(new TextEncoder().encode('{}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    await g.fetch(new Request(PROVISION, { method: 'POST', headers: await scopedHeaders(), body, duplex: 'half' } as RequestInit), envOf('dual'));
    expect(g.wire()[0]).toMatchObject({ outcome: 'legacy-accepted', reason: 'claim-after-until' });
    expect(claim).not.toHaveBeenCalled();
  });

  it('a body too slow for the window meets the claim clock before a seam that has no store: refused, not the store fault', async () => {
    const lateCall = (nonceCache?: () => undefined) => {
      let now = NOW;
      const g = gated({ clock: () => now * 1000, ...(nonceCache ? { nonceCache } : {}) });
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            now = NOW + 200;
            controller.enqueue(new TextEncoder().encode('{}'));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      return { g, run: async () => g.fetch(new Request(PROVISION, { method: 'POST', headers: await scopedHeaders(), body, duplex: 'half' } as RequestInit), envOf('dual')) };
    };
    const seam = vi.fn(() => undefined);
    const withSeam = lateCall(seam);
    await withSeam.run();
    expect(withSeam.g.wire()[0]).toMatchObject({ outcome: 'legacy-accepted', reason: 'claim-after-until', fault: null });
    expect(seam).not.toHaveBeenCalled();
    // Its twin: with no seam at all the claim clock never runs, and the same call is the static fault.
    const noSeam = lateCall();
    await noSeam.run();
    expect(noSeam.g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'no-nonce-store', reason: null });
  });

  it('gives a nonce claim one second by default, and no longer', async () => {
    let reached!: () => void;
    const claimed = new Promise<void>((resolve) => (reached = resolve));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const g = gated({ nonceCache: () => ({ claim: () => (reached(), new Promise<boolean>(() => {})) }) });
      let settled = false;
      const pending = g.fetch(new Request(PROVISION, { method: 'POST', headers: await scopedHeaders(), body: '{}' }), envOf('dual'));
      void pending.then(() => (settled = true));
      await claimed;
      await vi.advanceTimersByTimeAsync(WIRE_CLAIM_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((await pending).status).toBe(503);
      expect(g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'nonce-store' });
      expect(WIRE_CLAIM_TIMEOUT_MS).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a counter that throws never fails the request, in dual or in signed-only', async () => {
    const throwing = { log: () => { throw new Error('the sink is down'); } };
    const dual = gated(throwing);
    expect((await dual.fetch(new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope()) } }), envOf('dual'))).status).toBe(200);
    const signedOnly = gated(throwing);
    const refused = await signedOnly.fetch(new Request(URL_ROUTE, { headers: legacyRoute() }), envOf('signed-only'));
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(WIRE_REFUSAL_BODY);
  });
});

describe('a call’s body is read only once its envelope has passed every cheaper check', () => {
  /** A call whose body never arrives, recording whether anything asked for it. */
  function stalledCall(headers: Record<string, string>) {
    const asked = { pulled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          asked.pulled = true;
          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    return { asked, request: new Request(PROVISION, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit) };
  }

  it('with no envelope, dual hands the call on unread, and signed-only refuses it unread', async () => {
    const dual = gated({}, unreading());
    const handedOn = stalledCall({ [PLATFORM_SECRET_HEADER]: CALL_VALUE });
    expect((await dual.fetch(handedOn.request, envOf('dual'))).status).toBe(202);
    expect(dual.seen[0]).toBe(handedOn.request);
    expect(handedOn.asked.pulled).toBe(false);
    expect(dual.wire()[0]).toMatchObject({ outcome: 'legacy-accepted', reason: 'missing' });

    const signedOnly = gated({}, unreading());
    const refused = stalledCall({ [PLATFORM_SECRET_HEADER]: CALL_VALUE });
    expect((await signedOnly.fetch(refused.request, envOf('signed-only'))).status).toBe(401);
    expect(refused.asked.pulled).toBe(false);
    expect(signedOnly.seen).toEqual([]);
  });

  it.each([
    ['signature', async () => ({ ...(await callEnvelope(PROVISION, '{}')), [WIRE_SIGNATURE_HEADER]: (await callEnvelope(PROVISION, '{"other":1}'))[WIRE_SIGNATURE_HEADER]! })],
    ['kid', async () => callEnvelope(PROVISION, '{}', {}, stranger)],
    ['audience', async () => callEnvelope(PROVISION, '{}', { aud: 'another-deployment' })],
    ['expired', async () => callEnvelope(PROVISION, '{}', { iat: NOW - 200, exp: NOW - 100 })],
    ['method', async () => callEnvelope(PROVISION, '{}', { method: 'PUT' })],
    ['target', async () => callEnvelope('https://vertical/internal/restore', '{}')],
  ])('an envelope refused for %s, before the body, never reads it', async (reason, envelope) => {
    const g = gated({}, unreading());
    const { asked, request } = stalledCall({ [PLATFORM_SECRET_HEADER]: CALL_VALUE, ...(await envelope()) });
    expect((await g.fetch(request, envOf('dual'))).status).toBe(202);
    expect(g.seen[0]).toBe(request);
    expect(asked.pulled).toBe(false);
    expect(g.wire()[0]).toMatchObject({ outcome: 'legacy-accepted', reason });
  });

  it('a body that fails to arrive is refused for the body, never read as the empty body an envelope signed', async () => {
    const g = gated({}, unreading());
    const broken = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.error(new Error('the connection dropped'));
        },
      },
      { highWaterMark: 0 },
    );
    const headers = { [PLATFORM_SECRET_HEADER]: CALL_VALUE, ...(await callEnvelope(QUERY, '')) };
    await g.fetch(new Request(QUERY, { method: 'POST', headers, body: broken, duplex: 'half' } as RequestInit), envOf('dual'));
    expect(g.wire()[0]).toMatchObject({ outcome: 'legacy-accepted', reason: 'body' });
    // Its twin: a body that really is empty verifies against the same envelope.
    const empty = gated();
    await empty.fetch(new Request(QUERY, { method: 'POST', headers, body: '' }), envOf('dual'));
    expect(empty.wire()[0]).toMatchObject({ outcome: 'signed-accepted' });
  });

  it('its positive twin: an envelope that passes them reads the body, and the vertical receives it', async () => {
    const g = gated();
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode('{"ping":true}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const headers = { [PLATFORM_SECRET_HEADER]: CALL_VALUE, ...(await callEnvelope(QUERY, '{"ping":true}')) };
    const res = await g.fetch(new Request(QUERY, { method: 'POST', headers, body, duplex: 'half' } as RequestInit), envOf('dual'));
    expect(pulled).toBe(true);
    expect(await bodyOf(res)).toBe('{"ping":true}');
    expect(g.wire()[0]).toMatchObject({ outcome: 'signed-accepted' });
  });
});

describe('a request is judged as the vertical’s router will route it', () => {
  /** Whether a path reaches vertical-host's `/internal/*` gate on Hono, the router it is mounted on. */
  async function honoRoutesInternal(url: string): Promise<boolean> {
    let internal = false;
    const app = new Hono();
    app.use('/internal/*', async (_c, next) => {
      internal = true;
      await next();
    });
    app.all('*', (c) => c.text('ok'));
    await app.fetch(new Request(url, { method: 'POST', body: '{}' }));
    return internal;
  }

  const paths = [
    '/internal/provision',
    '/%69nternal/provision',
    '/internal/%70rovision',
    '/%49nternal/provision',
    '/internal%2Fprovision',
    '/a/%2e%2e/internal/provision',
    '/./internal/provision',
    '//internal/provision',
    '/internal//provision',
    '/internal/',
    '/INTERNAL/provision',
    '/Internal',
    '/%69nternal/provision/%ff',
    '/%69nternal/%ff',
    '/internal/vertical-invoke',
    '/api/things',
    '/api/%69nternal/x',
    '/internals',
    '/docs/internal',
  ];

  it.each(paths)('never judges as a route a path Hono routes into the internal surface: %s', async (path) => {
    const url = `https://vertical${path}?next=/internal/provision`;
    const kind = wireEndpoint(new URL(url).pathname).kind;
    if (await honoRoutesInternal(url)) expect(kind).toBe('call');
    // Its twin: an ordinary route stays a route, whatever its query names.
    if (['/api/things', '/api/%69nternal/x', '/internals', '/docs/internal'].includes(path)) expect(kind).toBe('route');
  });

  it.each(['/%69nternal/provision/%ff', '/%69nternal/%ff'])('a path decodeURI cannot decode whole still reaches the internal surface, and is a call: %s', async (path) => {
    const url = `https://vertical${path}`;
    expect(await honoRoutesInternal(url)).toBe(true);
    expect(wireEndpoint(new URL(url).pathname)).toEqual({ kind: 'call', issuers: ['platform'] });
  });

  it('an escaped internal path is judged as a call: a route envelope for it is refused, a call envelope verified', async () => {
    const url = 'https://acme.example/%69nternal/provision';
    const asRoute = gated();
    await asRoute.fetch(new Request(url, { method: 'POST', headers: { ...legacyRoute(), ...(await routeEnvelope({ url, method: 'POST' })) }, body: '{}' }), envOf('dual'));
    expect(asRoute.wire()[0]).toMatchObject({ kind: 'call', outcome: 'refused', reason: 'issuer' });
    const asCall = gated();
    await asCall.fetch(new Request(url, { method: 'POST', headers: { [PLATFORM_SECRET_HEADER]: CALL_VALUE, ...(await callEnvelope(url, '{}')) }, body: '{}' }), envOf('dual'));
    expect(asCall.wire()[0]).toMatchObject({ kind: 'call', issuer: 'platform' });
    expect(asCall.wire()[0]!.outcome).not.toBe('refused');
  });

  it.each(['HEAD', 'OPTIONS', 'GET'])('a %s call is judged as a call and keeps no nonce', async (method) => {
    const url = `https://vertical/internal/export?scopeId=${SCOPE}`;
    const g = gated();
    const res = await g.fetch(new Request(url, { method, headers: { [PLATFORM_SECRET_HEADER]: CALL_VALUE, ...(await callEnvelope(url, '', { method, tenantId: TENANT, scopeId: SCOPE })) } }), envOf('dual'));
    expect(res.status).toBe(200);
    expect(g.wire()[0]).toMatchObject({ kind: 'call', outcome: 'signed-accepted', fault: null });
  });

  it('a route whose query names the internal surface is still a route', async () => {
    const url = 'https://acme.example/api/things?next=/internal/provision';
    const g = gated();
    const res = await g.fetch(new Request(url, { headers: { ...legacyRoute(), ...(await routeEnvelope({ url })) } }), envOf('dual'));
    expect(res.status).toBe(200);
    expect(g.wire()[0]).toMatchObject({ kind: 'route', outcome: 'signed-accepted' });
  });
});

describe('the deployment’s own faults', () => {
  const badLists: Array<[string, () => Env]> = [
    ['a malformed key list', () => ({ [WIRE_ROUTER_KEYS_VAR]: 'not-a-key' })],
    ['a key listed for both issuers', () => ({ [WIRE_PLATFORM_KEYS_VAR]: keyLists.router })],
  ];

  it.each(badLists)('%s in dual is counted, and every request is served as it would be today', async (_, extra) => {
    const env = { ...envOf('dual'), ...extra() };
    const g = gated();
    // A route with a valid legacy credential: the very request, served, the fault counted for its tenant.
    const routed = new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope()) } });
    expect((await g.fetch(routed, env)).status).toBe(200);
    expect(g.seen[0]).toBe(routed);
    // A call with a valid legacy credential, its body handed on unread.
    const call = new Request(PROVISION, { method: 'POST', headers: { [PLATFORM_SECRET_HEADER]: CALL_VALUE, ...(await callEnvelope(PROVISION, '{}')) }, body: '{}' });
    expect((await g.fetch(call, env)).status).toBe(200);
    expect(g.seen[1]).toBe(call);
    // A request no legacy credential proves goes on as it came, to the vertical's own answer.
    const bare = new Request(URL_ROUTE, { headers: await routeEnvelope() });
    expect((await g.fetch(bare, env)).status).toBe(200);
    expect(g.seen[2]).toBe(bare);
    expect(await nodeOf((await g.fetch(new Request(URL_ROUTE, { headers: await routeEnvelope() }), env)))).toBeNull();
    expect(g.wire().map((l) => [l.outcome, l.fault, l.legacy, l.tenantId])).toEqual([
      ['fault', 'keys', 'valid', TENANT],
      ['fault', 'keys', 'valid', null],
      ['fault', 'keys', 'absent', null],
      ['fault', 'keys', 'absent', null],
    ]);
  });

  it.each(badLists)('%s in signed-only is the fixed 503, and the vertical never runs', async (_, extra) => {
    const g = gated();
    const res = await g.fetch(new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope()) } }), { ...envOf('signed-only'), ...extra() });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(await res.text()).toBe(WIRE_FAULT_BODY);
    expect(g.seen).toEqual([]);
    expect(g.wire()[0]).toMatchObject({ outcome: 'fault', fault: 'keys', legacy: 'valid' });
  });

  it('a deployment with keys and no audience refuses every envelope on the audience check', async () => {
    const g = gated();
    const res = await g.fetch(new Request(URL_ROUTE, { headers: await routeEnvelope() }), envOf('signed-only', { [WIRE_AUDIENCE_VAR]: undefined }));
    expect(res.status).toBe(401);
    expect(g.wire()[0]).toMatchObject({ outcome: 'refused', reason: 'audience' });
  });
});

describe('what the gate answers and writes', () => {
  it('its two fixed bodies are the platform’s problem documents', () => {
    expect(JSON.parse(WIRE_REFUSAL_BODY)).toEqual(problemForStatus(401, 'unauthorized'));
    expect(JSON.parse(WIRE_FAULT_BODY)).toEqual(problemForStatus(503, 'this request could not be verified'));
  });

  it('never carries a legacy credential in a response, a response header or a line, whatever the path', async () => {
    const out: string[] = [];
    const console_ = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => void out.push(a.join(' ')));
    const error = vi.spyOn(console, 'error').mockImplementation((...a) => void out.push(a.join(' ')));
    const scenarios: Array<[Env, () => Promise<Request>]> = [
      [envOf('dual'), async () => new Request(URL_ROUTE, { headers: await routeEnvelope() })],
      [envOf('dual'), async () => new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope({ scopeId: OTHER_SCOPE })) } })],
      [envOf('signed-only'), async () => new Request(URL_ROUTE, { headers: await routeEnvelope() })],
      [envOf('signed-only'), async () => new Request(URL_ROUTE, { headers: legacyRoute() })],
      [envOf('dual'), async () => new Request(PROVISION, { method: 'POST', headers: await callEnvelope(PROVISION, '{}'), body: '{}' })],
      [envOf('dual'), async () => new Request(PROVISION, { method: 'POST', headers: await callEnvelope(PROVISION, '{}', { tenantId: TENANT, scopeId: SCOPE }), body: '{}' })],
      [{ ...envOf('dual'), [WIRE_ROUTER_KEYS_VAR]: 'broken' }, async () => new Request(URL_ROUTE, { headers: legacyRoute() })],
    ];
    for (const [env, request] of scenarios) {
      const g = gated({ log: (line) => console.log(line) });
      const res = await g.fetch(await request(), env);
      out.push(String(res.status), await res.text(), JSON.stringify([...res.headers]));
    }
    const everything = out.join('\n');
    expect(everything).toContain('"substrat":"wire"');
    expect(everything).not.toContain(ROUTER_VALUE);
    expect(everything).not.toContain(CALL_VALUE);
  });

  it('a line carries exactly the published fields, and nothing from the request’s headers', async () => {
    const g = gated();
    await g.fetch(new Request(URL_ROUTE, { headers: { ...legacyRoute(), ...(await routeEnvelope()) } }), envOf('dual'));
    const [line] = g.lines;
    expect(Object.keys(JSON.parse(line!)).sort()).toEqual(
      ['substrat', 'state', 'issuer', 'kind', 'outcome', 'reason', 'fault', 'legacy', 'tenantId', 'scopeId', 'versionId'].sort(),
    );
    expect(line).not.toContain(ROUTER_VALUE);
  });
});
