import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
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
  type WireVerificationLine,
} from '@substrat-run/contracts/wire-signing';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { readRoutedNode, withInvocationLog } from '@substrat-run/vertical-host';
import { withWireGate, type GatedWorker } from '../platform-entry/wire-gate.js';
import { platformCallScope, platformSignedFetch } from '../src/platform-wire.js';
import { PAGE_CALL_DEADLINE_MS, VerticalClient } from '../src/vertical-client.js';

/**
 * RFC wire-signing step 2, the control plane's signer: a `call` envelope, issuer `platform`, on
 * every call a `VerticalClient` makes, beside the legacy header. Each signed call is also run
 * through the verifier the platform's entry wraps around a deployment (#2511).
 */

const T = tenantId.parse('01JZ0000000000000000TEN001');
const S = scopeId.parse('01JZ0000000000000000SCP001');
const AUD = 'acme-widgets-01jz';
const SECRET = 'platform-legacy-value';

let active: { privateKey: string; publicKey: string };
let standby: { privateKey: string; publicKey: string };
let routerPair: { publicKey: string };
beforeAll(async () => {
  [active, standby, routerPair] = await Promise.all([generateScopeStoreKeyPair(), generateScopeStoreKeyPair(), generateScopeStoreKeyPair()]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const claimsOf = (request: Request): WireClaims => decodeWireEnvelope(request.headers.get(WIRE_ENVELOPE_HEADER) ?? '')!.claims;

/** A deployment that records what it was sent and answers 200 with `{}`. */
function recorder() {
  const sent: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input, init));
    return Response.json({});
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

/** `send` behind the control plane's signer, flag on, for `AUD`. */
const signed = (send: typeof fetch, key: string = active.privateKey, log?: (line: string) => void, aud = AUD) =>
  platformSignedFetch({ sign: 'on', key, ...(log ? { log } : {}) }, aud, send);

describe('platformSignedFetch: off by default', () => {
  it.each([undefined, '', 'off', 'ON', '1', 'true'])('flag %j: the client is handed the very fetch it would have had', (flag) => {
    const send = recorder().fetch;
    expect(platformSignedFetch({ sign: flag, key: active.privateKey }, AUD, send)).toBe(send);
  });

  it('without a signer, a client hands its fetch exactly the arguments it always did', async () => {
    const calls: unknown[][] = [];
    const fetch = (async (...args: unknown[]) => (calls.push(args), Response.json([]))) as typeof globalThis.fetch;
    const plain = new VerticalClient({ fetch, platformSecret: SECRET });
    await plain.listPlatformRequests(T, S);
    await plain.listScopeTables(S);
    expect(calls).toEqual([
      ['https://vertical.invalid/internal/platform-requests?tenantId=01JZ0000000000000000TEN001&scopeId=01JZ0000000000000000SCP001', { headers: { 'x-substrat-platform': SECRET } }],
      ['https://vertical.invalid/internal/tables?scopeId=01JZ0000000000000000SCP001', { headers: { 'x-substrat-platform': SECRET } }],
    ]);
  });
});

describe('platformCallScope: the tenant and scope a call names itself', () => {
  const body = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).buffer as ArrayBuffer;
  const URL_ = 'https://vertical.invalid/internal/x';
  const at = (url: string, contentType = 'application/json') => new Request(url, { headers: { 'content-type': contentType } });

  it('a body naming both names them; a query naming both names them; a body wins over its query', () => {
    expect(platformCallScope(at(URL_), body({ tenantId: T, scopeId: S, other: 1 }))).toEqual({ tenantId: T, scopeId: S });
    expect(platformCallScope(at(`${URL_}?tenantId=${T}&scopeId=${S}`), undefined)).toEqual({ tenantId: T, scopeId: S });
    const other = '01JZ0000000000000000SCP002';
    expect(platformCallScope(at(`${URL_}?tenantId=${T}&scopeId=${other}`), body({ tenantId: T, scopeId: S }))).toEqual({ tenantId: T, scopeId: S });
  });

  it('half a pair, a malformed id, an array or no JSON names neither', () => {
    expect(platformCallScope(at(`${URL_}?scopeId=${S}`), undefined)).toBeNull();
    expect(platformCallScope(at(URL_), body({ scopeId: S }))).toBeNull();
    expect(platformCallScope(at(URL_), body({ tenantId: T.toLowerCase(), scopeId: S }))).toBeNull();
    expect(platformCallScope(at(URL_), body({ tenantId: 7, scopeId: S }))).toBeNull();
    expect(platformCallScope(at(URL_), body([{ tenantId: T, scopeId: S }]))).toBeNull();
    expect(platformCallScope(at(URL_), body('not json'))).toBeNull();
    expect(platformCallScope(at(URL_), new ArrayBuffer(0))).toBeNull();
  });

  it('a body of bytes (multipart, an octet stream) is not read for a scope; its query still is', () => {
    const json = body({ tenantId: T, scopeId: S });
    expect(platformCallScope(at(URL_, 'multipart/form-data; boundary=x'), json)).toBeNull();
    expect(platformCallScope(at(URL_, 'application/octet-stream'), json)).toBeNull();
    expect(platformCallScope(at(`${URL_}?tenantId=${T}&scopeId=${S}`, 'multipart/form-data; boundary=x'), json)).toEqual({ tenantId: T, scopeId: S });
  });
});

describe('on: every call a client makes carries a call envelope beside the legacy header', () => {
  it('a POST names the pair its body names and binds its exact body; a GET binds the empty one', async () => {
    const r = recorder();
    const client = new VerticalClient({ fetch: signed(r.fetch), platformSecret: SECRET });
    await client.provisionInstance({ tenantId: T, scopeId: S, owner: principalId.parse('01JZ0000000000000000PRNCP1'), slug: 'acme', name: 'Acme' } as never);
    await client.listScopeTables(S);
    const [post, get] = r.sent;
    const body = await post!.clone().text();
    expect(claimsOf(post!)).toMatchObject({
      iss: 'platform',
      kind: 'call',
      aud: AUD,
      tenantId: T,
      scopeId: S,
      surface: null,
      vertical: null,
      method: 'POST',
      targetDigest: await wireDigest('/internal/provision'),
      bodyDigest: await wireDigest(body),
    });
    expect(JSON.parse(body)).toMatchObject({ tenantId: T, scopeId: S, slug: 'acme' });
    expect(post!.headers.get('x-substrat-platform')).toBe(SECRET);
    expect(post!.headers.get('content-type')).toBe('application/json');
    // A scope alone is not a pair: the GET names neither, and binds the empty body.
    expect(claimsOf(get!)).toMatchObject({ method: 'GET', tenantId: null, scopeId: null, bodyDigest: await wireDigest('') });
    expect(get!.headers.get('x-substrat-platform')).toBe(SECRET);
  });

  it('each call is signed afresh: two calls, two nonces', async () => {
    const r = recorder();
    const client = new VerticalClient({ fetch: signed(r.fetch), platformSecret: SECRET });
    await client.listScopeTables(S);
    await client.listScopeTables(S);
    expect(claimsOf(r.sent[0]!).nonce).not.toBe(claimsOf(r.sent[1]!).nonce);
  });

  it('counts each call it signs, by deployment', async () => {
    const lines: string[] = [];
    const client = new VerticalClient({ fetch: signed(recorder().fetch, active.privateKey, (l) => lines.push(l)), platformSecret: SECRET });
    await client.listScopeTables(S);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ substrat: 'wire-sign', issuer: 'platform', aud: AUD, outcome: 'signed' }]);
  });

  it('a call’s deadline still aborts it: the signed request carries the caller’s signal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    let aborted = false;
    const fetch = (async (input: RequestInfo | URL) => {
      const request = input as Request;
      reached();
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    }) as typeof globalThis.fetch;
    const client = new VerticalClient({ fetch: signed(fetch), platformSecret: SECRET });
    const pending = client.exportScopePage(S, null).catch((e: unknown) => e);
    await arrived;
    await vi.advanceTimersByTimeAsync(PAGE_CALL_DEADLINE_MS);
    const error = await pending;
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect((error as ControlPlaneError).status).toBe(504);
    expect(aborted).toBe(true);
  });
});

describe('on, a signer that cannot sign: the call goes with its legacy header and its whole body', () => {
  it.each([
    ['unset', '', 'unset'],
    ['not base64url', '!!not-a-key!!', 'encoding'],
    ['not PKCS8', 'AAAA', 'not-pkcs8-v1'],
  ])('a key that is %s: unsigned, counted failed with its reason, never its value', async (_, key, reason) => {
    const lines: string[] = [];
    const r = recorder();
    const client = new VerticalClient({ fetch: signed(r.fetch, key, (l) => lines.push(l)), platformSecret: SECRET });
    await client.provisionInstance({ tenantId: T, scopeId: S, owner: principalId.parse('01JZ0000000000000000PRNCP1'), slug: 'acme', name: 'Acme' } as never);
    const sent = r.sent[0]!;
    expect(sent.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
    expect(sent.headers.has(WIRE_SIGNATURE_HEADER)).toBe(false);
    expect(sent.headers.get('x-substrat-platform')).toBe(SECRET);
    expect(JSON.parse(await sent.text())).toMatchObject({ tenantId: T, scopeId: S, slug: 'acme' });
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ substrat: 'wire-sign', issuer: 'platform', aud: AUD, outcome: 'failed', reason }]);
    if (key) expect(lines.join('')).not.toContain(key);
  });

  it('claims the encoder refuses (an over-long deployment name): unsigned, counted failed, and its twin signs', async () => {
    const lines: string[] = [];
    const r = recorder();
    await new VerticalClient({ fetch: signed(r.fetch, active.privateKey, (l) => lines.push(l), 'a'.repeat(256)), platformSecret: SECRET }).listScopeTables(S);
    expect(r.sent[0]!.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
    expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'failed', reason: 'claims' });
    const twin = recorder();
    await new VerticalClient({ fetch: signed(twin.fetch, active.privateKey, () => {}, 'a'.repeat(255)), platformSecret: SECRET }).listScopeTables(S);
    expect(claimsOf(twin.sent[0]!).aud).toBe('a'.repeat(255));
  });
});

/**
 * Round trips: the client's own calls into a deployment wrapped by the platform entry's verifier,
 * which judges them with the legacy checks every vertical-host build runs.
 */
describe('the control plane’s envelopes, judged by the entry’s verifier', () => {
  type Env = Record<string, string>;
  const deploymentEnv = (state: string, platformKeys = active.publicKey, aud = AUD): Env => ({
    ROUTER_SECRET: 'router-legacy-value',
    CALL_SECRET: SECRET,
    [WIRE_ROUTER_KEYS_VAR]: routerPair.publicKey,
    [WIRE_PLATFORM_KEYS_VAR]: platformKeys,
    [WIRE_AUDIENCE_VAR]: aud,
    [WIRE_STATE_VAR]: state,
  });

  /** A deployment behind the verifier; its `/internal/*` gate is the legacy one. */
  function deployment(env: Env, nonceCache?: (env: Env, scopeId: string) => { claim: () => boolean }) {
    const lines: WireVerificationLine[] = [];
    const handed: Request[] = [];
    const gate = withWireGate<Env>(
      {
        fetch: async (request: Request, e: Env) => {
          handed.push(request);
          assertPlatformCall(request.headers, { expectedSecret: e['CALL_SECRET'] });
          return Response.json(request.method === 'GET' ? [] : {});
        },
      } as GatedWorker<Env>,
      {
        routedNode: (headers, e) => readRoutedNode(headers, { expectedSecret: e['ROUTER_SECRET'] }),
        routerSecret: (e) => e['ROUTER_SECRET'],
        platformSecret: (e) => e['CALL_SECRET'],
        log: (line) => lines.push(JSON.parse(line) as WireVerificationLine),
        ...(nonceCache ? { nonceCache } : {}),
      },
    );
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => gate.fetch!(new Request(input, init), env, {})) as typeof globalThis.fetch;
    return { fetch, lines, handed };
  }

  it('no verifier configured: the envelope is carried and ignored, by a current entry with no key lists, the entry before it, and no entry at all', async () => {
    const seen: Request[] = [];
    const lines: string[] = [];
    // What a vertical runs itself on its internal surface, as every vertical-host build does.
    const vertical = {
      fetch: async (request: Request, e: Env) => {
        seen.push(request);
        assertPlatformCall(request.headers, { expectedSecret: e['CALL_SECRET'] });
        return Response.json({ body: JSON.parse(await request.text()) as unknown });
      },
    };
    const env: Env = { ROUTER_SECRET: 'router-legacy-value', CALL_SECRET: SECRET };
    const stamped = withInvocationLog<Env>(vertical as never, { routerSecret: (e) => e['ROUTER_SECRET'] });
    const current = withWireGate<Env>(stamped as GatedWorker<Env>, {
      routedNode: (headers, e) => readRoutedNode(headers, { expectedSecret: e['ROUTER_SECRET'] }),
      routerSecret: (e) => e['ROUTER_SECRET'],
      platformSecret: (e) => e['CALL_SECRET'],
      log: (line) => lines.push(line),
    });
    for (const deployed of [current, stamped as GatedWorker<Env>, vertical as GatedWorker<Env>]) {
      seen.length = 0;
      const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => deployed.fetch!(new Request(input, init), env, {})) as typeof globalThis.fetch;
      const ack = await new VerticalClient({ fetch: signed(fetch), platformSecret: SECRET }).provisionInstance({
        tenantId: T,
        scopeId: S,
        owner: principalId.parse('01JZ0000000000000000PRNCP1'),
        slug: 'acme',
        name: 'Acme',
      } as never);
      expect(ack).toMatchObject({ tenantId: T, scopeId: S });
      // Carried beside the legacy header, with the body whole; nothing else about the call changed.
      expect(seen[0]!.headers.has(WIRE_ENVELOPE_HEADER)).toBe(true);
      expect(seen[0]!.headers.get('x-substrat-platform')).toBe(SECRET);
    }
    // Ignored: with no key lists the current entry judges nothing and writes no wire line.
    expect(lines).toEqual([]);
  });

  it('dual: a read is counted signed-accepted with its legacy credential valid; unsigned, legacy-accepted', async () => {
    const d = deployment(deploymentEnv('dual'));
    await new VerticalClient({ fetch: signed(d.fetch), platformSecret: SECRET }).listScopeTables(S);
    expect(d.lines).toEqual([expect.objectContaining({ state: 'dual', issuer: 'platform', kind: 'call', outcome: 'signed-accepted', reason: null, legacy: 'valid' })]);
    const twin = deployment(deploymentEnv('dual'));
    await new VerticalClient({ fetch: twin.fetch, platformSecret: SECRET }).listScopeTables(S);
    expect(twin.lines).toEqual([expect.objectContaining({ outcome: 'legacy-accepted', reason: 'missing' })]);
  });

  it('dual: a call that changes state spends its nonce in the scope it names', async () => {
    const claimed: string[] = [];
    const d = deployment(deploymentEnv('dual'), (_e, scope) => ({ claim: () => (claimed.push(scope), true) }));
    await new VerticalClient({ fetch: signed(d.fetch), platformSecret: SECRET }).provisionInstance({
      tenantId: T,
      scopeId: S,
      owner: principalId.parse('01JZ0000000000000000PRNCP1'),
      slug: 'acme',
      name: 'Acme',
    } as never);
    expect(d.lines).toEqual([expect.objectContaining({ outcome: 'signed-accepted', legacy: 'valid', tenantId: T, scopeId: S })]);
    expect(claimed).toEqual([S]);
    // Its twin: with no store yet (every version until follow-on 5) the same call is the counted
    // fault, and in dual it is still served on its legacy credential.
    const noStore = deployment(deploymentEnv('dual'));
    const ack = await new VerticalClient({ fetch: signed(noStore.fetch), platformSecret: SECRET }).provisionInstance({
      tenantId: T,
      scopeId: S,
      owner: principalId.parse('01JZ0000000000000000PRNCP1'),
      slug: 'acme',
      name: 'Acme',
    } as never);
    expect(ack).toMatchObject({ tenantId: T, scopeId: S });
    expect(noStore.lines).toEqual([expect.objectContaining({ outcome: 'fault', fault: 'no-nonce-store', legacy: 'valid' })]);
  });

  it('signed-only: a signed read is served on its envelope alone; unsigned, it is refused and never reaches the vertical', async () => {
    const d = deployment(deploymentEnv('signed-only'));
    await new VerticalClient({ fetch: signed(d.fetch), platformSecret: SECRET }).listScopeTables(S);
    expect(d.handed).toHaveLength(1);
    expect(d.lines).toEqual([expect.objectContaining({ state: 'signed-only', outcome: 'signed-accepted' })]);
    const twin = deployment(deploymentEnv('signed-only'));
    await expect(new VerticalClient({ fetch: twin.fetch, platformSecret: SECRET }).listScopeTables(S)).rejects.toThrow();
    expect(twin.handed).toEqual([]);
  });

  it('a deployment named otherwise refuses the envelope as another audience’s', async () => {
    const d = deployment(deploymentEnv('dual', active.publicKey, 'another-script'));
    await new VerticalClient({ fetch: signed(d.fetch), platformSecret: SECRET }).listScopeTables(S);
    expect(d.lines).toEqual([expect.objectContaining({ outcome: 'legacy-accepted', reason: 'audience' })]);
  });

  it('rotation: a deployment listing the active and the standby key accepts the control plane signing with either', async () => {
    const both = `${active.publicKey},${standby.publicKey}`;
    for (const key of [active.privateKey, standby.privateKey]) {
      const d = deployment(deploymentEnv('signed-only', both));
      await new VerticalClient({ fetch: signed(d.fetch, key, () => {}), platformSecret: SECRET }).listScopeTables(S);
      expect(d.lines).toEqual([expect.objectContaining({ outcome: 'signed-accepted' })]);
    }
    // Its twin: a deployment the standby key never reached refuses a signer switched to it.
    const stale = deployment(deploymentEnv('dual', active.publicKey));
    await new VerticalClient({ fetch: signed(stale.fetch, standby.privateKey, () => {}), platformSecret: SECRET }).listScopeTables(S);
    expect(stale.lines).toEqual([expect.objectContaining({ outcome: 'legacy-accepted', reason: 'kid' })]);
  });

  it('a router key cannot sign as the platform: the same envelope signed with the router’s list is refused', async () => {
    // The deployment lists the active key as the ROUTER's: a platform envelope signed with it names
    // a kid the platform list does not hold.
    const d = deployment({ ...deploymentEnv('dual', standby.publicKey), [WIRE_ROUTER_KEYS_VAR]: active.publicKey });
    await new VerticalClient({ fetch: signed(d.fetch), platformSecret: SECRET }).listScopeTables(S as ScopeId);
    expect(d.lines).toEqual([expect.objectContaining({ outcome: 'legacy-accepted', reason: 'kid' })]);
  });
});
