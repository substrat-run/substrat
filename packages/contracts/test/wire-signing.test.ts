import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  generateScopeStoreKeyPair,
  parseScopeStoreEnvelope,
  scopeStoreBodyDigest,
  ScopeStoreKeyError,
  scopeStoreSignerPublicKey,
  verifyScopeStoreEnvelope,
} from '../src/scope-store-envelope.js';
import {
  canonicalWireEnvelope,
  decodeWireEnvelope,
  importWireSigningKey,
  parseWireEnvelope,
  signWireEnvelope,
  signWireRequest,
  verifyWireEnvelope,
  WIRE_UNSIGNED_HEADERS,
  wireSignerOf,
  wireSigningKeyOf,
  wireSigningOn,
  wireUnsignedHeadersOf,
  WIRE_CLOCK_SKEW_SECONDS,
  WIRE_ENVELOPE_HEADER,
  WIRE_ENVELOPE_VERSION,
  WIRE_ENVELOPE_LIFETIME_SECONDS,
  WIRE_ENVELOPE_MAX_LIFETIME_SECONDS,
  WIRE_REFUSAL_REASONS,
  WIRE_REFUSED,
  WIRE_SIGNATURE_HEADER,
  wireDigest,
  wireEndpoint,
  wireReplayOf,
  WIRE_REPLAY_FREE_CALLS,
  wireEnvelopeShape,
  WireClaimsError,
  WireKeyError,
  wireRequestBinding,
  wireStateOf,
  wireUploadSettings,
  wireVerificationKeys,
  WIRE_UPLOAD_STATE,
  WIRE_AUDIENCE_VAR,
  WIRE_PLATFORM_KEYS_VAR,
  WIRE_ROUTER_KEYS_VAR,
  WIRE_STATE_VAR,
  WIRE_STATES,
  type WireBodyReader,
  type WireBytes,
  type WireClaims,
  type WireEnvelopeInput,
  type WireExpectation,
  type WireIssuer,
  type WireNonceCache,
  type WireRefusalReason,
  type WireVerificationKeys,
} from '../src/wire-signing.js';
import { FIELD_COVERAGE_HEADER, PARENT_REQUEST_ID_HEADER } from '../src/invocation-record.js';
import { wireAuthRecord } from '../src/control-plane.js';
import { CONNECTOR_CALL_PATH, CONNECTOR_PROBE_PATH } from '../src/vertical-connector.js';

interface Vector {
  readonly name: string;
  readonly signer: WireIssuer;
  readonly input: WireEnvelopeInput & { readonly iat: number; readonly exp: number };
  readonly canonical: string;
  readonly header: string;
  readonly signature: string;
}
const fixture = JSON.parse(readFileSync(new URL('./vectors/wire-envelope.json', import.meta.url), 'utf8')) as {
  readonly clockSkewSeconds: number;
  readonly maxLifetimeSeconds: number;
  readonly keys: Record<WireIssuer, { readonly privateKeyPkcs8: string; readonly publicKey: string; readonly kid: string }>;
  readonly vectors: readonly Vector[];
  readonly invalid: readonly {
    readonly name: string;
    readonly header: string;
    readonly signature: string;
    readonly expected: Record<string, unknown>;
    readonly now: number;
    readonly reason: WireRefusalReason;
  }[];
  readonly invalidKeyLists: readonly {
    readonly name: string;
    readonly reason: 'small-order' | 'non-canonical' | 'both-issuers' | 'duplicate';
    readonly router?: string;
    readonly platform?: string;
  }[];
};
const storeVector = JSON.parse(readFileSync(new URL('./vectors/scope-store-envelope.json', import.meta.url), 'utf8')) as {
  readonly canonical: string;
  readonly header: string;
  readonly signature: string;
};

const [ROUTE, CALL, UNSCOPED, ROUTER_CALL] = fixture.vectors as [Vector, Vector, Vector, Vector];
const OTHER_ULID = '01JCV4Z3A7QWERTYX5N9M2K8HB';

const keysOf = (router: string | undefined = fixture.keys.router.publicKey, platform: string | undefined = fixture.keys.platform.publicKey) =>
  wireVerificationKeys({ router, platform });

const headersOf = (header: string | null, signature: string | null) => ({
  get: (name: string) => (name === WIRE_ENVELOPE_HEADER ? header : name === WIRE_SIGNATURE_HEADER ? signature : null),
});

/** What a deployment expects of the vector's own request. */
function expectationOf(vector: Vector): WireExpectation {
  const { iss, kind, aud, method, target, body } = vector.input;
  return kind === 'call' ? { iss, kind, aud, method, target, body: body!, replay: 'none' } : { iss, kind, aud, method, target };
}

interface Check {
  readonly vector?: Vector;
  readonly header?: string | null;
  readonly signature?: string | null;
  readonly expected?: Partial<WireExpectation> & { readonly body?: WireBytes | WireBodyReader };
  readonly now?: number;
  readonly keys?: WireVerificationKeys;
  /** A call's replay policy, as a cache (its scope pinned); the vector's own expectation says `'none'`. */
  readonly nonces?: WireNonceCache;
  /** When the nonce is claimed, after the body is read. Defaults to `now`. */
  readonly claimAt?: number;
}

/** Verify a vector (or what replaces part of it), collecting the reasons `onRefusal` hears. */
async function check(input: Check = {}) {
  const vector = input.vector ?? ROUTE;
  const reasons: WireRefusalReason[] = [];
  const verdict = await verifyWireEnvelope({
    headers: headersOf(input.header === undefined ? vector.header : input.header, input.signature === undefined ? vector.signature : input.signature),
    keys: input.keys ?? (await keysOf()),
    expected: {
      ...expectationOf(vector),
      ...(input.nonces ? { replay: input.nonces, scopeId: vector.input.scopeId } : {}),
      ...input.expected,
    } as WireExpectation,
    nowSeconds: input.now ?? vector.input.iat,
    clockSeconds: () => input.claimAt ?? input.now ?? vector.input.iat,
    onRefusal: (reason) => reasons.push(reason),
  });
  return { verdict, reasons };
}

/** The one reason a refused check gave, asserting the verdict is THE refusal and only one reason was heard. */
async function reason(input: Check = {}): Promise<WireRefusalReason> {
  const { verdict, reasons } = await check(input);
  expect(verdict).toBe(WIRE_REFUSED);
  expect(reasons).toHaveLength(1);
  return reasons[0]!;
}

const encode = (text: string) => bytesToBase64Url(new TextEncoder().encode(text));

/** The vector's canonical text with one line replaced. */
function withLine(vector: Vector, index: number, value: string): string {
  const lines = vector.canonical.split('\n');
  lines[index] = value;
  return lines.join('\n');
}

/** That text as a header, carried under the ORIGINAL signature. */
const tampered = (vector: Vector, index: number, value: string) => encode(withLine(vector, index, value));

/** The same bytes spelled differently: an 11- or 43-character base64url value has 2 unused trailing bits. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const alias = (value: string) => value.slice(0, -1) + ALPHABET[ALPHABET.indexOf(value.at(-1)!) ^ 1];

/** A fresh, validly signed envelope: the vector's input with `patch` over it. */
async function signed(vector: Vector, patch: Partial<WireEnvelopeInput> = {}, signer: WireIssuer = vector.signer) {
  const key = await importWireSigningKey(fixture.keys[signer].privateKeyPkcs8);
  return signWireEnvelope(key, { ...vector.input, ...patch });
}

/** Any canonical text, signed directly with a fixture key: for what the signer refuses to mint. */
async function rawSigned(canonical: string, signer: WireIssuer) {
  const { key } = await importWireSigningKey(fixture.keys[signer].privateKeyPkcs8);
  const bytes = new TextEncoder().encode(canonical);
  return { header: bytesToBase64Url(bytes), signature: bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes))) };
}

/** The route vector's times replaced, signed directly. */
const withTimes = (iat: number, exp: number) => {
  const lines = withLine(ROUTE, 12, String(iat)).split('\n');
  lines[13] = String(exp);
  return rawSigned(lines.join('\n'), 'router');
};

/** An in-memory nonce cache, recording its claims. */
function memoryNonces() {
  const spent = new Set<string>();
  const claims: [string, number][] = [];
  const cache: WireNonceCache = {
    claim(nonce, until) {
      claims.push([nonce, until]);
      if (spent.has(nonce)) return false;
      spent.add(nonce);
      return true;
    },
  };
  return { cache, claims };
}

describe('wire envelope: the shared vectors', () => {
  it('reproduces every vector byte for byte, and node\'s own Ed25519 and SHA-256 agree', async () => {
    expect(fixture.clockSkewSeconds).toBe(WIRE_CLOCK_SKEW_SECONDS);
    expect(fixture.maxLifetimeSeconds).toBe(WIRE_ENVELOPE_MAX_LIFETIME_SECONDS);
    for (const signer of ['router', 'platform'] as const) {
      const { privateKeyPkcs8, publicKey, kid } = fixture.keys[signer];
      expect(await importWireSigningKey(privateKeyPkcs8)).toMatchObject({ kid, publicKey });
      expect(bytesToBase64Url(createHash('sha256').update(base64UrlToBytes(publicKey)!).digest().subarray(0, 8))).toBe(kid);
    }
    for (const vector of fixture.vectors) {
      const issued = await signed(vector);
      expect(issued.canonical, vector.name).toBe(vector.canonical);
      expect(issued.header, vector.name).toBe(vector.header);
      expect(issued.signature, vector.name).toBe(vector.signature);
      expect(Buffer.from(vector.header, 'base64url').toString('utf8')).toBe(vector.canonical);
      const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: fixture.keys[vector.signer].publicKey }, format: 'jwk' });
      expect(nodeVerify(null, Buffer.from(vector.canonical, 'utf8'), publicKey, Buffer.from(vector.signature, 'base64url')), vector.name).toBe(true);
      // The target and body lines are SHA-256 of the input's own bytes, computed independently.
      const lines = vector.canonical.split('\n');
      expect(lines[10]).toBe(createHash('sha256').update(vector.input.target, 'utf8').digest('hex'));
      expect(lines[11]).toBe(vector.input.body === undefined ? '' : createHash('sha256').update(vector.input.body as string, 'utf8').digest('hex'));
      const { verdict } = await check({ vector });
      expect(verdict, vector.name).toEqual({ ok: true, claims: parseWireEnvelope(vector.canonical) });
    }
  });

  it('refuses every negative vector for the reason it names, and every invalid key list at load', async () => {
    expect(fixture.invalid.length).toBeGreaterThanOrEqual(15);
    const keys = await keysOf();
    for (const v of fixture.invalid) {
      const reasons: WireRefusalReason[] = [];
      const expected = (v.expected.kind === 'call' ? { ...v.expected, replay: 'none' } : v.expected) as unknown as WireExpectation;
      const verdict = await verifyWireEnvelope({ headers: headersOf(v.header, v.signature), keys, expected, nowSeconds: v.now, onRefusal: (r) => reasons.push(r) });
      expect(verdict, v.name).toBe(WIRE_REFUSED);
      expect(reasons, v.name).toEqual([v.reason]);
    }
    // S + L is refused by node's own Ed25519 too, so the vector is not just this module's opinion.
    const malleable = fixture.invalid.find((v) => v.name.startsWith('S + L'))!;
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: fixture.keys.router.publicKey }, format: 'jwk' });
    expect(nodeVerify(null, Buffer.from(malleable.header, 'base64url'), publicKey, Buffer.from(malleable.signature, 'base64url'))).toBe(false);
    const message = { 'small-order': /small-order/, 'non-canonical': /canonical/, 'both-issuers': /both issuers/, duplicate: /twice/ };
    expect(new Set(fixture.invalidKeyLists.map((l) => l.reason))).toEqual(new Set(Object.keys(message)));
    for (const { name, reason, ...list } of fixture.invalidKeyLists) {
      await expect(wireVerificationKeys(list), name).rejects.toThrow(message[reason]);
    }
    // The store-format negative is signed by the router's wire key under its listed kid, so only the
    // protocol is wrong with it: domain separation is what refuses it.
    const store = fixture.invalid.find((v) => v.name.startsWith('a scope-store envelope'))!;
    const storeCanonical = Buffer.from(store.header, 'base64url').toString('utf8');
    expect(parseScopeStoreEnvelope(storeCanonical)?.kid).toBe(fixture.keys.router.kid);
    // And its signature is valid for that key, so a regenerated fixture with a bad signature would
    // no longer pass as the vector whose only fault is the protocol.
    expect(await verifyScopeStoreEnvelope(fixture.keys.router.publicKey, storeCanonical, store.signature)).toBe(true);
  });

  it('carries what the router asserted on a route, and nulls what a call does not name', async () => {
    expect(await check({ vector: ROUTE })).toMatchObject({
      verdict: {
        ok: true,
        claims: { iss: 'router', kind: 'route', aud: 'todo', tenantId: ROUTE.input.tenantId, scopeId: ROUTE.input.scopeId, surface: 'app', vertical: 'todo', bodyDigest: null },
      },
    });
    expect(await check({ vector: UNSCOPED })).toMatchObject({
      verdict: { ok: true, claims: { iss: 'platform', kind: 'call', tenantId: null, scopeId: null, surface: null, vertical: null } },
    });
  });

  it('round-trips under a fresh key, with its defaults: now, sixty seconds, and a random nonce', async () => {
    const pair = await generateScopeStoreKeyPair();
    const key = await importWireSigningKey(pair.privateKey);
    expect(key.kid).toBe(pair.kid);
    expect(key.key.extractable).toBe(false);
    const before = Math.floor(Date.now() / 1000);
    const input = { iss: 'router', kind: 'route', aud: 'todo', tenantId: OTHER_ULID, scopeId: ROUTE.input.scopeId, surface: 'app', method: 'GET', target: '/' } as const;
    const a = await signWireEnvelope(key, input);
    const b = await signWireEnvelope(key, input);
    expect(a.claims.iat).toBeGreaterThanOrEqual(before);
    expect(a.claims.exp - a.claims.iat).toBe(WIRE_ENVELOPE_LIFETIME_SECONDS);
    expect(a.claims.nonce).not.toBe(b.claims.nonce);
    const keys = await wireVerificationKeys({ router: pair.publicKey });
    const verdict = await verifyWireEnvelope({
      headers: headersOf(a.header, a.signature),
      keys,
      expected: { iss: 'router', kind: 'route', aud: 'todo', method: 'GET', target: '/' },
      nowSeconds: a.claims.iat,
    });
    expect(verdict).toEqual({ ok: true, claims: a.claims });
  });
});

describe('wire envelope: one refusal for every failure', () => {
  it('every reason in the list is reached, and each returns the same frozen value with no detail on it', async () => {
    const other = await generateScopeStoreKeyPair();
    const nonces = memoryNonces();
    await check({ vector: CALL, nonces: nonces.cache });
    const cases: [WireRefusalReason, Check][] = [
      ['missing', { signature: null }],
      ['malformed', { header: 'not base64url!' }],
      ['issuer', { expected: { iss: 'platform' } }],
      ['kind', { vector: ROUTER_CALL, expected: { kind: 'route' } }],
      ['kid', { keys: await keysOf(other.publicKey) }],
      ['signature', { signature: CALL.signature }],
      ['audience', { expected: { aud: 'other' } }],
      ['lifetime', await withTimes(ROUTE.input.iat, ROUTE.input.iat)],
      ['not-yet-valid', { now: ROUTE.input.iat - WIRE_CLOCK_SKEW_SECONDS - 1 }],
      ['expired', { now: ROUTE.input.exp + WIRE_CLOCK_SKEW_SECONDS + 1 }],
      ['method', { expected: { method: 'POST' } }],
      ['target', { expected: { target: '/api/lists?page=3' } }],
      ['body', { vector: CALL, expected: { body: '{"hello":"World"}' } }],
      ['scope', { expected: { scopeId: OTHER_ULID } }],
      ['claim-after-until', { vector: CALL, nonces: memoryNonces().cache, claimAt: CALL.input.exp + WIRE_CLOCK_SKEW_SECONDS + 1 }],
      ['replay', { vector: CALL, nonces: nonces.cache }],
    ];
    expect(cases.map(([r]) => r)).toEqual([...WIRE_REFUSAL_REASONS]);
    for (const [expected, input] of cases) expect(await reason(input), expected).toBe(expected);
    expect(Object.isFrozen(WIRE_REFUSED)).toBe(true);
    expect(Object.keys(WIRE_REFUSED)).toEqual(['ok']);
  });

  it('a throw from onRefusal changes nothing, and so does leaving it out', async () => {
    const verdict = await verifyWireEnvelope({
      headers: headersOf(ROUTE.header, null),
      keys: await keysOf(),
      expected: expectationOf(ROUTE),
      nowSeconds: ROUTE.input.iat,
      onRefusal: () => {
        throw new Error('metrics are down');
      },
    });
    expect(verdict).toBe(WIRE_REFUSED);
    expect(await verifyWireEnvelope({ headers: headersOf(null, null), keys: await keysOf(), expected: expectationOf(ROUTE), nowSeconds: 0 })).toBe(WIRE_REFUSED);
  });

  it('an async onRefusal that rejects is caught, never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const verdict = await verifyWireEnvelope({
        headers: headersOf(ROUTE.header, null),
        keys: await keysOf(),
        expected: expectationOf(ROUTE),
        nowSeconds: ROUTE.input.iat,
        onRefusal: async () => {
          throw new Error('async metrics are down');
        },
      });
      expect(verdict).toBe(WIRE_REFUSED);
      // Let any rejection surface: unhandled rejections are reported after the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('wire envelope: what the signature binds', () => {
  it('a line changed under the original signature is refused as the signature, whichever line it is', async () => {
    const digest = await wireDigest('/api/other');
    // Lines: tag, iss, kind, kid, aud, tenant, scope, surface, vertical, method, target, body, iat, exp, nonce.
    for (const [index, value] of [
      [4, 'other'],
      [5, OTHER_ULID],
      [6, OTHER_ULID],
      [7, 'admin'],
      [8, 'other'],
      [8, ''],
      [9, 'POST'],
      [10, digest],
      [12, String(ROUTE.input.iat + 1)],
      [13, String(ROUTE.input.exp - 1)],
      [14, 'BAAAAAAAAAAAAAAAAAAAAA'],
    ] as const) {
      expect(await reason({ header: tampered(ROUTE, index, value) }), `line ${index} = ${value}`).toBe('signature');
    }
    expect(await reason({ vector: CALL, header: tampered(CALL, 11, digest) })).toBe('signature');
    // The kid rewritten to another LISTED key's id is still the first key's signature.
    const other = await generateScopeStoreKeyPair();
    const both = await keysOf(`${fixture.keys.router.publicKey},${other.publicKey}`);
    expect(await reason({ header: tampered(ROUTE, 3, other.kid), keys: both })).toBe('signature');
  });

  it('a validly signed envelope for another audience, method, target, body or scope is refused for that', async () => {
    const as = async (patch: Partial<WireEnvelopeInput>, vector: Vector = ROUTE) => {
      const issued = await signed(vector, patch);
      return { vector, header: issued.header, signature: issued.signature };
    };
    expect(await reason(await as({ aud: 'todo-preview' }))).toBe('audience');
    expect(await reason({ expected: { aud: '' } })).toBe('audience');
    expect(await reason(await as({ method: 'POST' }))).toBe('method');
    expect(await reason(await as({ target: '/api/lists?page=3' }))).toBe('target');
    expect(await reason(await as({ target: '/api/lists' }))).toBe('target');
    expect(await reason(await as({ body: '{"hello":"World"}' }, CALL))).toBe('body');
    expect(await reason(await as({ body: '' }, CALL))).toBe('body');
    // An untyped caller that passes no body is refused, even for a call whose signed body is empty.
    expect(await reason({ vector: UNSCOPED, expected: { body: undefined } })).toBe('body');
    // Nor is the null of a body read that failed read as an empty body.
    expect(await reason({ vector: UNSCOPED, expected: { body: null as unknown as string } })).toBe('body');
    // A call's body as bytes binds the same as the same text.
    expect((await check({ vector: CALL, expected: { body: new TextEncoder().encode(CALL.input.body as string) } })).verdict).toMatchObject({ ok: true });
    // Pinned tenant and scope are compared; unpinned they are reported, not judged.
    expect(await reason({ expected: { tenantId: OTHER_ULID } })).toBe('scope');
    expect(await reason({ expected: { scopeId: OTHER_ULID } })).toBe('scope');
    expect(await reason({ vector: UNSCOPED, expected: { scopeId: ROUTE.input.scopeId! } })).toBe('scope');
    expect((await check({ expected: { tenantId: ROUTE.input.tenantId!, scopeId: ROUTE.input.scopeId! } })).verdict).toMatchObject({ ok: true });
  });

  it('binds the method and target the URL API reads off the request, on both ends', async () => {
    expect(wireRequestBinding({ method: 'patch', url: 'https://todo.example/a/b?c=1&d=%20#frag' })).toEqual({ method: 'PATCH', target: '/a/b?c=1&d=%20' });
    expect(wireRequestBinding({ method: 'GET', url: 'https://todo.example/a?' })).toEqual({ method: 'GET', target: '/a' });
    expect(wireRequestBinding({ method: 'GET', url: 'https://todo.example' })).toEqual({ method: 'GET', target: '/' });
    // Any HTTP method token signs and verifies, not only letters.
    const search = await signed(ROUTE, { method: 'M-SEARCH' });
    expect((await check({ header: search.header, signature: search.signature, expected: { method: 'M-SEARCH' } })).verdict).toMatchObject({ ok: true });
    // The longest registered method signs too.
    const longest = await signed(ROUTE, { method: 'UPDATEREDIRECTREF' });
    expect((await check({ header: longest.header, signature: longest.signature, expected: { method: 'UPDATEREDIRECTREF' } })).verdict).toMatchObject({ ok: true });
    // End to end: the signer binds the request it sends, the verifier the request it receives.
    const sent = new Request('https://router.example/api/lists?page=2', { method: 'GET' });
    const issued = await signed(ROUTE, wireRequestBinding(sent));
    const received = new Request('https://todo.example/api/lists?page=2#ignored', { method: 'get', headers: { [WIRE_ENVELOPE_HEADER]: issued.header, [WIRE_SIGNATURE_HEADER]: issued.signature } });
    const verdict = await verifyWireEnvelope({
      headers: received.headers,
      keys: await keysOf(),
      expected: { ...expectationOf(ROUTE), ...wireRequestBinding(received) },
      nowSeconds: ROUTE.input.iat,
    });
    expect(verdict).toMatchObject({ ok: true });
    const moved = new Request('https://todo.example/api/lists?page=2&x=1', { method: 'GET' });
    expect(await reason({ header: issued.header, signature: issued.signature, expected: wireRequestBinding(moved) })).toBe('target');
  });

  it('digests the exact bytes: the store\'s body digest for a string, and the same for its bytes in any view', async () => {
    const text = '{"hello":"wörld"}';
    const bytes = new TextEncoder().encode(text);
    expect(await wireDigest(text)).toBe(await scopeStoreBodyDigest(text));
    expect(await wireDigest(bytes)).toBe(await scopeStoreBodyDigest(text));
    expect(await wireDigest(bytes.buffer)).toBe(await scopeStoreBodyDigest(text));
    const padded = new Uint8Array([0xff, ...bytes, 0xff]);
    expect(await wireDigest(new DataView(padded.buffer, 1, bytes.length))).toBe(await scopeStoreBodyDigest(text));
    expect(await wireDigest(new Uint8Array(padded.buffer, 1, bytes.length))).toBe(await scopeStoreBodyDigest(text));
    expect(await wireDigest('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('wire envelope: time', () => {
  it('admits the skew at both edges and refuses one second past either', async () => {
    const { iat, exp } = ROUTE.input;
    const skew = WIRE_CLOCK_SKEW_SECONDS;
    expect((await check({ now: iat - skew })).verdict).toMatchObject({ ok: true });
    expect((await check({ now: exp + skew })).verdict).toMatchObject({ ok: true });
    expect(await reason({ now: iat - skew - 1 })).toBe('not-yet-valid');
    expect(await reason({ now: exp + skew + 1 })).toBe('expired');
    // A clock that is not a number fails, rather than passing both comparisons.
    expect(await reason({ now: Number.NaN })).toBe('not-yet-valid');
  });

  it('refuses a lifetime that ends before it starts or runs past the maximum, which the signer never mints', async () => {
    const { iat } = ROUTE.input;
    expect(await reason({ ...(await withTimes(iat, iat)), now: iat })).toBe('lifetime');
    expect(await reason({ ...(await withTimes(iat, iat - 1)), now: iat })).toBe('lifetime');
    expect(await reason({ ...(await withTimes(iat, iat + WIRE_ENVELOPE_MAX_LIFETIME_SECONDS + 1)), now: iat })).toBe('lifetime');
    expect((await check({ ...(await withTimes(iat, iat + WIRE_ENVELOPE_MAX_LIFETIME_SECONDS)), now: iat })).verdict).toMatchObject({ ok: true });
    for (const exp of [iat, iat + WIRE_ENVELOPE_MAX_LIFETIME_SECONDS + 1]) {
      await expect(signed(ROUTE, { exp })).rejects.toThrow(/lifetime/);
    }
    expect((await signed(ROUTE, { exp: iat + WIRE_ENVELOPE_MAX_LIFETIME_SECONDS })).claims.exp).toBe(iat + WIRE_ENVELOPE_MAX_LIFETIME_SECONDS);
  });
});

describe('wire envelope: who signs', () => {
  it('the endpoint names the issuer and kind it accepts', async () => {
    expect(await reason({ expected: { iss: 'platform' } })).toBe('issuer');
    expect(await reason({ vector: CALL, expected: { iss: 'router' } })).toBe('issuer');
    expect(await reason({ vector: ROUTER_CALL, expected: { kind: 'route' } })).toBe('kind');
    expect(await reason({ vector: ROUTE, expected: { kind: 'call', body: '', replay: 'none' } })).toBe('kind');
  });

  it("the router's key cannot sign as the platform, nor the platform's as the router", async () => {
    // Signed validly by the router's own key, claiming to be the platform: no platform key has its id.
    const asPlatform = await signed(CALL, {}, 'router');
    expect(await reason({ vector: CALL, header: asPlatform.header, signature: asPlatform.signature })).toBe('kid');
    const asRouter = await signed(ROUTE, {}, 'platform');
    expect(await reason({ header: asRouter.header, signature: asRouter.signature })).toBe('kid');
    // The platform's envelope with its issuer line flipped: the router's list does not hold its kid.
    expect(await reason({ vector: ROUTER_CALL, header: tampered(CALL, 1, 'router'), signature: CALL.signature })).toBe('kid');
  });

  it('refuses an unknown key id, and rotates: two listed keys each verify, a dropped one does not', async () => {
    const other = await generateScopeStoreKeyPair();
    expect(await reason({ keys: await keysOf(other.publicKey) })).toBe('kid');
    expect(await reason({ keys: await keysOf('', '') })).toBe('kid');
    expect(await reason({ keys: await wireVerificationKeys({}) })).toBe('kid');
    const both = await keysOf(`${fixture.keys.router.publicKey},${other.publicKey}`);
    expect((await check({ keys: both })).verdict).toMatchObject({ ok: true });
    const next = await signWireEnvelope(await importWireSigningKey(other.privateKey), ROUTE.input);
    expect(next.claims.kid).toBe(other.kid);
    expect((await check({ keys: both, header: next.header, signature: next.signature })).verdict).toMatchObject({ ok: true });
    // The old key dropped: the new signer verifies, the old one no longer does.
    const dropped = await keysOf(other.publicKey);
    expect((await check({ keys: dropped, header: next.header, signature: next.signature })).verdict).toMatchObject({ ok: true });
    expect(await reason({ keys: dropped })).toBe('kid');
  });

  it('verifies only with keys wireVerificationKeys built, which refuses a list the store would', async () => {
    const other = await generateScopeStoreKeyPair();
    const router = fixture.keys.router.publicKey;
    const built = await keysOf();
    expect(Object.isFrozen(built)).toBe(true);
    // The returned maps are for reading: adding the router's key to the platform's map afterwards does
    // not let the router's key sign as the platform.
    (built.platform as Map<string, string>).set(fixture.keys.router.kid, fixture.keys.router.publicKey);
    const asPlatform = await signed(CALL, {}, 'router');
    expect(await reason({ vector: CALL, header: asPlatform.header, signature: asPlatform.signature, keys: built })).toBe('kid');
    // Any other key set is the deployment's fault, not the caller's: a throw, before any header is read,
    // that no refusal counter hears.
    for (const keys of [{ router: new Map(built.router), platform: new Map(built.platform) }, { ...built }]) {
      const heard: WireRefusalReason[] = [];
      for (const [header, signature] of [[ROUTE.header, ROUTE.signature], [null, null]] as const) {
        await expect(
          verifyWireEnvelope({ headers: headersOf(header, signature), keys, expected: expectationOf(ROUTE), nowSeconds: ROUTE.input.iat, onRefusal: (r) => heard.push(r) }),
        ).rejects.toThrow(/wireVerificationKeys/);
      }
      expect(heard).toEqual([]);
    }
    for (const [config, message] of [
      [{ router, platform: `${other.publicKey},${router}` }, /both issuers/],
      [{ router: alias(router) }, /canonical/],
      [{ router: `${router},${router}` }, /twice/],
      [{ router: `${router},` }, /empty/],
      [{ router: fixture.keys.router.privateKeyPkcs8 }, /32 bytes/],
      [{ router: bytesToBase64Url(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0))) }, /small-order/],
    ] as const) {
      await expect(wireVerificationKeys(config), JSON.stringify(config)).rejects.toThrow(message);
    }
    // The twin: distinct keys per issuer, whitespace around entries, both verify.
    expect((await check({ keys: await wireVerificationKeys({ router: ` ${router} , ${other.publicKey} `, platform: fixture.keys.platform.publicKey }) })).verdict).toMatchObject({ ok: true });
  });

  it('a signing key that is set but unusable is a WireKeyError that names the problem and never carries the key', async () => {
    const der = base64UrlToBytes(fixture.keys.router.privateKeyPkcs8)!;
    for (const [bad, problem] of [
      ['not base64url!', 'encoding'],
      [fixture.keys.router.publicKey, 'not-pkcs8-v1'],
      [bytesToBase64Url(new Uint8Array(48)), 'not-pkcs8-v1'],
      [bytesToBase64Url(Uint8Array.from([...der, 0])), 'not-pkcs8-v1'],
    ] as const) {
      const error = await importWireSigningKey(bad).catch((e: unknown) => e);
      expect(error, bad).toBeInstanceOf(WireKeyError);
      expect((error as WireKeyError).reason).toBe(problem);
      expect((error as Error).message).not.toContain(bad);
      // One judge: the store module refuses the same value for the same reason.
      const store = await scopeStoreSignerPublicKey(bad).catch((e: unknown) => e);
      expect(store).toBeInstanceOf(ScopeStoreKeyError);
      expect((store as ScopeStoreKeyError).reason).toBe(problem);
    }
  });
});

describe('wire envelope: malformed input', () => {
  it('refuses a missing header or signature', async () => {
    for (const [header, signature] of [[null, ROUTE.signature], [ROUTE.header, null], ['', ROUTE.signature], [ROUTE.header, ''], [null, null]] as const) {
      expect(await reason({ header, signature })).toBe('missing');
    }
  });

  it('refuses bytes that are not exactly the encoding, before any key is looked up', async () => {
    const lines = ROUTE.canonical.split('\n');
    const utf8 = (text: string) => [...new TextEncoder().encode(text)];
    // The surface line's one byte replaced by 0xff: decoded leniently it would read as U+FFFD.
    const badField = Uint8Array.from([...utf8(`${lines.slice(0, 7).join('\n')}\n`), 0xff, ...utf8(`\n${lines.slice(8).join('\n')}`)]);
    for (const [label, header] of [
      ['not base64url', 'not base64url!'],
      ['invalid UTF-8', bytesToBase64Url(new Uint8Array([0xff, 0xfe]))],
      ['invalid UTF-8 inside a field', bytesToBase64Url(badField)],
      ['a byte-order mark first', bytesToBase64Url(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(ROUTE.canonical)]))],
      ['a trailing newline', encode(`${ROUTE.canonical}\n`)],
      ['a line short', encode(lines.slice(0, -1).join('\n'))],
      ['a line more', encode([...lines, 'x'].join('\n'))],
      ['a CRLF', encode(ROUTE.canonical.replaceAll('\n', '\r\n'))],
      ['a store envelope', storeVector.header],
    ] as const) {
      expect(await reason({ header, keys: await keysOf('') }), label).toBe('malformed');
    }
  });

  it('refuses a line the encoder cannot emit', async () => {
    const control = 'a\u0007b';
    for (const [vector, index, value] of [
      [ROUTE, 0, 'substrat-wire/2'],
      [ROUTE, 0, '1'],
      [ROUTE, 1, 'Router'],
      [ROUTE, 2, 'routes'],
      [CALL, 2, 'route'], // the platform never asserts a routed request
      [ROUTE, 3, 'short'],
      [ROUTE, 3, alias(fixture.keys.router.kid)], // another spelling of the kid's 8 bytes
      [ROUTE, 4, ''],
      [ROUTE, 4, control],
      [ROUTE, 4, 'x'.repeat(256)],
      [ROUTE, 5, ROUTE.input.tenantId!.toLowerCase()],
      [ROUTE, 5, ''], // half a pair
      [UNSCOPED, 5, OTHER_ULID], // half a pair the other way
      [ROUTE, 7, ''], // a route without its surface
      [ROUTE, 7, control],
      [CALL, 7, 'app'], // a call carries no surface
      [CALL, 8, 'todo'], // the platform names no vertical
      [ROUTE, 9, 'get'],
      [ROUTE, 9, 'A'.repeat(33)],
      [ROUTE, 9, 'GET POST'], // a token holds no space
      [ROUTE, 9, 'GET/1'], // nor a separator
      [ROUTE, 10, 'A'.repeat(64)],
      [ROUTE, 10, ''],
      [ROUTE, 11, CALL.canonical.split('\n')[11]!], // a route binds no body
      [CALL, 11, ''], // a call always does
      [ROUTE, 12, '017'],
      [ROUTE, 12, '-1'],
      [ROUTE, 12, '1e3'],
      [ROUTE, 12, '+17'],
      [ROUTE, 12, '9999999999999999'],
      [ROUTE, 13, ' 1700000060'],
      [ROUTE, 14, 'AAAAAAAAAAAAAAAAAAAAAB'], // an alias spelling of 16 zero bytes
      [ROUTE, 14, 'A'.repeat(23)],
    ] as const) {
      expect(parseWireEnvelope(withLine(vector, index, value)), `line ${index} = ${value}`).toBeUndefined();
      expect(await reason({ vector, header: tampered(vector, index, value) }), `line ${index} = ${value}`).toBe('malformed');
    }
    // The twin: the vector's own vertical line may be empty on a route.
    expect(parseWireEnvelope(withLine(ROUTE, 8, ''))).toMatchObject({ vertical: null });
  });

  it('refuses a signature that is not the one over these bytes', async () => {
    for (const signature of ['not a signature!', ROUTE.signature.slice(0, -2), CALL.signature, `${ROUTE.signature}AA`]) {
      expect(await reason({ signature }), signature).toBe('signature');
    }
  });

  it('admits only the (iss, kind) pairs in its closed table', () => {
    expect(wireEnvelopeShape('router', 'route')).toMatchObject({ scope: 'required', surface: 'required', body: 'absent' });
    expect(wireEnvelopeShape('router', 'call')).toMatchObject({ surface: 'absent', body: 'required' });
    expect(wireEnvelopeShape('platform', 'call')).toMatchObject({ surface: 'absent', vertical: 'absent', body: 'required' });
    // Inherited names at both levels, which a lookup without own-key checks would return.
    for (const [iss, kind] of [['platform', 'route'], ['toString', 'route'], ['router', '__proto__'], ['__proto__', 'call'], ['__proto__', 'toString'], ['constructor', 'name'], ['', '']] as const) {
      expect(wireEnvelopeShape(iss, kind), `${iss}/${kind}`).toBeUndefined();
    }
  });

  it('a store envelope never parses as a wire envelope, and a wire envelope never as a store one', () => {
    expect(parseWireEnvelope(storeVector.canonical)).toBeUndefined();
    for (const vector of fixture.vectors) expect(parseScopeStoreEnvelope(vector.canonical)).toBeUndefined();
  });
});

describe('wire envelope: the encoder', () => {
  it('canonical and parse are inverses, and an absent field is null, never empty', () => {
    for (const vector of fixture.vectors) {
      const claims = parseWireEnvelope(vector.canonical)!;
      expect(canonicalWireEnvelope(claims)).toBe(vector.canonical);
    }
    const claims = parseWireEnvelope(ROUTE.canonical)!;
    const bad = (patch: object) => () => canonicalWireEnvelope({ ...claims, ...patch });
    expect(bad({ vertical: '' })).toThrow(/null/);
    expect(bad({ vertical: 'a\nb' })).toThrow(/newline/);
    expect(bad({ iat: -1 })).toThrow(/time/);
    expect(bad({ exp: 1.5 })).toThrow(/time/);
    expect(bad({ v: 2 })).toThrow(/version/);
    expect(bad({ scopeId: null })).toThrow(/malformed/);
    // Non-ASCII text is carried as UTF-8 and round-trips, a surrogate pair included.
    for (const surface of ['bokföring', 'clef 𝄞']) {
      expect(parseWireEnvelope(canonicalWireEnvelope({ ...claims, surface }))?.surface).toBe(surface);
    }
  });

  it('half a surrogate pair is refused by the parser and so by the encoder: UTF-8 cannot carry it', () => {
    const claims = parseWireEnvelope(ROUTE.canonical)!;
    for (const [field, value] of [
      ['surface', '\ud800'],
      ['surface', 'a\udc00'],
      ['vertical', '\ud834x'],
      ['aud', 'todo\udd1e'],
    ] as const) {
      expect(parseWireEnvelope(withLine(ROUTE, { aud: 4, surface: 7, vertical: 8 }[field], value)), `${field} = ${JSON.stringify(value)}`).toBeUndefined();
      expect(() => canonicalWireEnvelope({ ...claims, [field]: value }), field).toThrow(/malformed/);
    }
  });

  it('the signer refuses what no verifier accepts', async () => {
    const key = await importWireSigningKey(fixture.keys.router.privateKeyPkcs8);
    const route = ROUTE.input;
    const call = ROUTER_CALL.input;
    await expect(signWireEnvelope(key, { ...route, body: '' })).rejects.toThrow(/binds no body/);
    const { body: _body, ...bodiless } = call;
    await expect(signWireEnvelope(key, bodiless)).rejects.toThrow(/binds its body/);
    // As the verifier reads it: null is a body read that failed, never the empty body.
    await expect(signWireEnvelope(key, { ...call, body: null as unknown as string })).rejects.toThrow(/binds its body/);
    await expect(signWireEnvelope(key, { ...call, surface: 'app' })).rejects.toThrow(/malformed/);
    await expect(signWireEnvelope(key, { ...route, surface: null })).rejects.toThrow(/malformed/);
    await expect(signWireEnvelope(key, { ...route, scopeId: null })).rejects.toThrow(/malformed/);
    await expect(signWireEnvelope(key, { ...route, surface: '' })).rejects.toThrow(/null/);
    await expect(signWireEnvelope(key, { ...route, method: 'get' })).rejects.toThrow(/malformed/);
    await expect(signWireEnvelope(key, { ...route, iat: -5, exp: 10 })).rejects.toThrow(/time/);
    await expect(signWireEnvelope(key, { ...route, nonce: 'n' })).rejects.toThrow(/malformed/);
  });

  it('every refusal is the encoder’s own class, which a signer counts as `claims` (RFC §8)', async () => {
    const key = await importWireSigningKey(fixture.keys.router.privateKeyPkcs8);
    const claims = parseWireEnvelope(ROUTE.canonical)!;
    for (const patch of [{ vertical: '' }, { vertical: 'a\nb' }, { iat: -1 }, { v: 2 }, { scopeId: null }]) {
      expect(() => canonicalWireEnvelope({ ...claims, ...patch } as WireClaims), JSON.stringify(patch)).toThrow(WireClaimsError);
    }
    const { body: _body, ...bodiless } = ROUTER_CALL.input;
    for (const input of [{ ...ROUTE.input, body: '' }, bodiless, { ...ROUTE.input, iat: 10, exp: 500 }, { ...ROUTE.input, method: 'get' }]) {
      await expect(signWireEnvelope(key, input)).rejects.toThrow(WireClaimsError);
    }
    expect(new WireClaimsError('x')).toBeInstanceOf(Error);
  });
});

describe('wire envelope: replay', () => {
  it("accepts the same envelope twice inside the window only where the endpoint said so: a route, or a call whose policy is 'none'", async () => {
    expect((await check()).verdict).toMatchObject({ ok: true });
    expect((await check({ now: ROUTE.input.iat + 10 })).verdict).toMatchObject({ ok: true });
    expect((await check({ vector: CALL, expected: { replay: 'none' } })).verdict).toMatchObject({ ok: true });
    expect((await check({ vector: CALL, expected: { replay: 'none' }, now: CALL.input.iat + 10 })).verdict).toMatchObject({ ok: true });
  });

  it('a call whose expectation names no replay policy fails closed, as the deployment\'s fault, before anything is read', async () => {
    for (const replay of [undefined, null, 'window', 'nonce', {}, { claim: true }] as const) {
      const heard: WireRefusalReason[] = [];
      for (const [header, signature] of [[CALL.header, CALL.signature], [null, null]] as const) {
        await expect(
          verifyWireEnvelope({
            headers: headersOf(header, signature),
            keys: await keysOf(),
            expected: { ...expectationOf(CALL), replay } as unknown as WireExpectation,
            nowSeconds: CALL.input.iat,
            onRefusal: (r) => heard.push(r),
          }),
          JSON.stringify(replay),
        ).rejects.toThrow(/replay policy/);
      }
      expect(heard).toEqual([]);
    }
  });

  it('a replay claimed after `until` is refused, even by a cache that has rightly forgotten the nonce', async () => {
    // A cache that keeps its contract: it forgets a nonce once its own clock passes `until`.
    let cacheNow = CALL.input.iat;
    const spent = new Map<string, number>();
    const pruning: WireNonceCache = {
      claim(nonce, until) {
        for (const [n, u] of spent) if (cacheNow > u) spent.delete(n);
        if (cacheNow > until || spent.has(nonce)) return false;
        spent.set(nonce, until);
        return true;
      },
    };
    const until = CALL.input.exp + WIRE_CLOCK_SKEW_SECONDS;
    expect((await check({ vector: CALL, nonces: pruning })).verdict).toMatchObject({ ok: true });
    // The replay arrives inside the window (exp + 28) but its body is slow: claimed at exp + 100.
    cacheNow = CALL.input.exp + 100;
    expect(await reason({ vector: CALL, nonces: pruning, now: CALL.input.exp + 28, claimAt: CALL.input.exp + 100 })).toBe('claim-after-until');
    // The verifier refuses it before asking, so the outcome does not depend on the cache's clock.
    const asked: number[] = [];
    const forgetful: WireNonceCache = { claim: (_n, u) => (asked.push(u), true) };
    // Counted as its own reason, so a slow body is not read as a replay in the metrics.
    expect(await reason({ vector: CALL, nonces: forgetful, now: CALL.input.exp + 28, claimAt: until + 1 })).toBe('claim-after-until');
    expect(asked).toEqual([]);
    // The twin: a claim made at `until` itself is still asked, and accepted once.
    expect((await check({ vector: CALL, nonces: forgetful, now: CALL.input.exp + 28, claimAt: until })).verdict).toMatchObject({ ok: true });
    expect(asked).toEqual([until]);
  });

  it('a claim clock that reads something other than a time is the deployment\'s fault: it throws, never asks the cache, and no reason is heard', async () => {
    const asked: number[] = [];
    const cache: WireNonceCache = { claim: (_n, u) => (asked.push(u), true) };
    for (const reading of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, '1700000000', null, Promise.resolve(CALL.input.iat)]) {
      const heard: WireRefusalReason[] = [];
      await expect(
        verifyWireEnvelope({
          headers: headersOf(CALL.header, CALL.signature),
          keys: await keysOf(),
          expected: { ...expectationOf(CALL), replay: cache, scopeId: CALL.input.scopeId! } as WireExpectation,
          nowSeconds: CALL.input.iat,
          clockSeconds: () => reading as unknown as number,
          onRefusal: (r) => heard.push(r),
        }),
        String(reading),
      ).rejects.toThrow(/clockSeconds read/);
      expect(heard, String(reading)).toEqual([]);
    }
    expect(asked).toEqual([]);
    // The twin: zero, the earliest time, is a reading and asks the cache.
    expect((await check({ vector: CALL, nonces: cache, claimAt: 0 })).verdict).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
  });

  it('a call that keeps nonces takes its claim clock, checked up front, or fails closed as the deployment\'s fault', async () => {
    const { cache, claims } = memoryNonces();
    for (const clockSeconds of [undefined, null, 5, 'now'] as const) {
      const heard: WireRefusalReason[] = [];
      for (const [header, signature] of [[CALL.header, CALL.signature], [null, null]] as const) {
        await expect(
          verifyWireEnvelope({
            headers: headersOf(header, signature),
            keys: await keysOf(),
            expected: { ...expectationOf(CALL), replay: cache, scopeId: CALL.input.scopeId! } as WireExpectation,
            nowSeconds: CALL.input.iat,
            clockSeconds: clockSeconds as unknown as () => number,
            onRefusal: (r) => heard.push(r),
          }),
          String(clockSeconds),
        ).rejects.toThrow(/clockSeconds/);
      }
      expect(heard).toEqual([]);
    }
    expect(claims).toEqual([]);
    // The twin: with 'none', no claim clock is needed.
    const verdict = await verifyWireEnvelope({ headers: headersOf(CALL.header, CALL.signature), keys: await keysOf(), expected: expectationOf(CALL), nowSeconds: CALL.input.iat });
    expect(verdict).toMatchObject({ ok: true });
  });

  it('a call that keeps nonces pins its scope, or fails closed as the deployment\'s fault', async () => {
    const { cache, claims } = memoryNonces();
    // Absent or null alike: an unscoped call with a cache must not reach the claim.
    for (const [vector, scope] of [[CALL, {}], [CALL, { scopeId: null }], [UNSCOPED, { scopeId: null }]] as const) {
      await expect(
        verifyWireEnvelope({ headers: headersOf(vector.header, vector.signature), keys: await keysOf(), expected: { ...expectationOf(vector), replay: cache, ...scope } as unknown as WireExpectation, nowSeconds: vector.input.iat, clockSeconds: () => vector.input.iat }),
        `${vector.name} ${JSON.stringify(scope)}`,
      ).rejects.toThrow(/pins the scope/);
    }
    expect(claims).toEqual([]);
    // An unscoped call cannot keep nonces: it is refused for the scope the endpoint pins.
    expect(await reason({ vector: UNSCOPED, nonces: cache, expected: { scopeId: ROUTE.input.scopeId! } })).toBe('scope');
  });

  it('only a claim of exactly true accepts: 1, "false", "true", undefined, an object and false all refuse', async () => {
    for (const answer of [1, 'false', 'true', undefined, null, {}, false]) {
      const cache = { claim: () => answer } as unknown as WireNonceCache;
      expect(await reason({ vector: CALL, nonces: cache }), JSON.stringify(answer)).toBe('replay');
      const asyncCache = { claim: async () => answer } as unknown as WireNonceCache;
      expect(await reason({ vector: CALL, nonces: asyncCache }), `async ${JSON.stringify(answer)}`).toBe('replay');
    }
    // The twin: true, sync or async, accepts.
    for (const claim of [() => true, async () => true]) {
      expect((await check({ vector: CALL, nonces: { claim } })).verdict).toMatchObject({ ok: true });
    }
  });

  it('with a cache: the first use is accepted, the second refused, and the cache holds it until exp plus the skew', async () => {
    const { cache, claims } = memoryNonces();
    expect((await check({ vector: CALL, nonces: cache })).verdict).toMatchObject({ ok: true });
    expect(await reason({ vector: CALL, nonces: cache, now: CALL.input.iat + 5 })).toBe('replay');
    expect(claims).toEqual([
      [CALL.input.nonce, CALL.input.exp + WIRE_CLOCK_SKEW_SECONDS],
      [CALL.input.nonce, CALL.input.exp + WIRE_CLOCK_SKEW_SECONDS],
    ]);
    // Another envelope from the same signer has its own nonce.
    const fresh = await signed(CALL, { nonce: 'BAAAAAAAAAAAAAAAAAAAAA' });
    expect((await check({ vector: CALL, header: fresh.header, signature: fresh.signature, nonces: cache })).verdict).toMatchObject({ ok: true });
  });

  it('is consulted last: an envelope refused for anything else never spends a nonce', async () => {
    const { cache, claims } = memoryNonces();
    for (const input of [
      { expected: { aud: 'other' } },
      { signature: ROUTE.signature },
      { now: CALL.input.exp + 3600 },
      { expected: { body: 'tampered' } },
      { expected: { scopeId: OTHER_ULID } },
    ] as const) {
      expect(await reason({ vector: CALL, nonces: cache, ...input })).not.toBe('replay');
    }
    expect(claims).toEqual([]);
    expect((await check({ vector: CALL, nonces: cache })).verdict).toMatchObject({ ok: true });
  });

  it('a cache that cannot answer fails the call, and never reads as acceptance', async () => {
    const broken: WireNonceCache = {
      claim: () => {
        throw new Error('storage unavailable');
      },
    };
    await expect(check({ vector: CALL, nonces: broken })).rejects.toThrow(/storage unavailable/);
    const rejecting: WireNonceCache = { claim: () => Promise.reject(new Error('storage unavailable')) };
    await expect(check({ vector: CALL, nonces: rejecting })).rejects.toThrow(/storage unavailable/);
  });
});

describe('wireUploadSettings: what an upload gives a deployment, judged as its verifier loads it (RFC §5, §6)', () => {
  const router = fixture.keys.router.publicKey;
  const platform = fixture.keys.platform.publicKey;

  it('both lists as given, trimmed, the deployment’s own name and `dual`, with each list’s kids', async () => {
    const given = await wireUploadSettings({ routerKeys: ` ${router} `, platformKeys: platform, audience: 'acme-serving' });
    expect(given.settings).toEqual([
      { name: WIRE_ROUTER_KEYS_VAR, text: router },
      { name: WIRE_PLATFORM_KEYS_VAR, text: platform },
      { name: WIRE_AUDIENCE_VAR, text: 'acme-serving' },
      { name: WIRE_STATE_VAR, text: 'dual' },
    ]);
    expect(WIRE_UPLOAD_STATE).toBe('dual');
    expect(given.routerKids).toEqual([fixture.keys.router.kid]);
    expect(given.platformKids).toEqual([fixture.keys.platform.kid]);
    // Exactly what the entry then loads and reads as `dual`.
    const env = Object.fromEntries(given.settings.map((b) => [b.name, b.text]));
    const keys = await wireVerificationKeys({ router: env[WIRE_ROUTER_KEYS_VAR], platform: env[WIRE_PLATFORM_KEYS_VAR] });
    expect([...keys.router.keys()]).toEqual(given.routerKids);
    expect(wireStateOf({ routerKeys: env[WIRE_ROUTER_KEYS_VAR], platformKeys: env[WIRE_PLATFORM_KEYS_VAR], state: env[WIRE_STATE_VAR] })).toBe('dual');
  });

  it('the capability record’s schema names the very version and states this module does', () => {
    const given = { envelope: WIRE_ENVELOPE_VERSION, entrySkipped: null, audience: 'a', routerKids: ['k'], platformKids: ['k'], withheld: null };
    for (const state of WIRE_STATES.filter((s) => s !== 'legacy-only')) expect(wireAuthRecord.safeParse({ ...given, state }).success, state).toBe(true);
    expect(wireAuthRecord.safeParse({ ...given, state: 'off' }).success).toBe(false);
    expect(wireAuthRecord.safeParse({ ...given, state: 'dual', envelope: WIRE_ENVELOPE_VERSION + 1 }).success).toBe(false);
    const none = { envelope: WIRE_ENVELOPE_VERSION, entrySkipped: null, state: 'legacy-only', audience: null, routerKids: [], platformKids: [], withheld: 'unconfigured' };
    expect(wireAuthRecord.safeParse(none).success).toBe(true);
  });

  it('refuses what the verifier would refuse, a missing list, and an audience the encoder would not carry', async () => {
    await expect(wireUploadSettings({ routerKeys: router, platformKeys: `${platform},${router}`, audience: 'a' })).rejects.toThrow(/both issuers/);
    await expect(wireUploadSettings({ routerKeys: router, platformKeys: '', audience: 'a' })).rejects.toThrow(/at least one key/);
    await expect(wireUploadSettings({ routerKeys: '  ', platformKeys: platform, audience: 'a' })).rejects.toThrow(/at least one key/);
    await expect(wireUploadSettings({ routerKeys: `${router},AAAA`, platformKeys: platform, audience: 'a' })).rejects.toThrow();
    await expect(wireUploadSettings({ routerKeys: router, platformKeys: platform, audience: '' })).rejects.toThrow(/audience/);
    await expect(wireUploadSettings({ routerKeys: router, platformKeys: platform, audience: 'a'.repeat(256) })).rejects.toThrow(/audience/);
    await expect(wireUploadSettings({ routerKeys: router, platformKeys: platform, audience: 'a\nb' })).rejects.toThrow(/audience/);
    // Its twin: the longest name the encoder carries is given.
    await expect(wireUploadSettings({ routerKeys: router, platformKeys: platform, audience: 'a'.repeat(255) })).resolves.toBeDefined();
  });
});

describe('wireStateOf: a deployment’s state from what its upload carries (RFC §5, Q3)', () => {
  const lists = { routerKeys: fixture.keys.router.publicKey, platformKeys: fixture.keys.platform.publicKey };

  it('no key list at all is legacy-only, whatever the setting says', () => {
    for (const state of [undefined, 'dual', 'signed-only', 'legacy-only', 'bogus']) {
      expect(wireStateOf({ state })).toBe('legacy-only');
      expect(wireStateOf({ routerKeys: '', platformKeys: '  ', state })).toBe('legacy-only');
      expect(wireStateOf({ routerKeys: 7, platformKeys: null, state })).toBe('legacy-only');
    }
  });

  it('with key lists, an explicit legacy-only or signed-only is taken as said', () => {
    expect(wireStateOf({ ...lists, state: 'legacy-only' })).toBe('legacy-only');
    expect(wireStateOf({ ...lists, state: 'signed-only' })).toBe('signed-only');
    expect(wireStateOf({ ...lists, state: 'dual' })).toBe('dual');
  });

  it('with key lists, a missing or unknown state reads as dual, never as signed-only', () => {
    for (const state of [undefined, '', 'Signed-Only', 'signed-only ', 'bogus', 1]) {
      expect(wireStateOf({ ...lists, state })).toBe('dual');
    }
  });

  it('either issuer’s list alone is key lists', () => {
    expect(wireStateOf({ routerKeys: lists.routerKeys })).toBe('dual');
    expect(wireStateOf({ platformKeys: lists.platformKeys })).toBe('dual');
  });

  it('names every state, and the configuration it is read from', () => {
    expect(WIRE_STATES).toEqual(['legacy-only', 'dual', 'signed-only']);
    expect([WIRE_ROUTER_KEYS_VAR, WIRE_PLATFORM_KEYS_VAR, WIRE_AUDIENCE_VAR, WIRE_STATE_VAR]).toEqual([
      'SUBSTRAT_WIRE_ROUTER_KEYS',
      'SUBSTRAT_WIRE_PLATFORM_KEYS',
      'SUBSTRAT_WIRE_AUDIENCE',
      'SUBSTRAT_WIRE_STATE',
    ]);
  });
});

describe('decodeWireEnvelope: what a header names, before anything is verified', () => {
  it('gives the canonical text and the claims of a vector header', () => {
    const decoded = decodeWireEnvelope(ROUTE.header);
    expect(decoded?.canonical).toBe(ROUTE.canonical);
    expect(decoded?.claims).toEqual(parseWireEnvelope(ROUTE.canonical));
  });

  it('is undefined for anything the verifier refuses as malformed', () => {
    const bom = bytesToBase64Url(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(ROUTE.canonical)]));
    for (const header of ['', 'not base64!', bytesToBase64Url(new Uint8Array([0xff, 0xfe])), bom, bytesToBase64Url(new TextEncoder().encode('1\nplatform'))]) {
      expect(decodeWireEnvelope(header)).toBeUndefined();
    }
  });
});

describe('wireEndpoint: which envelope an endpoint accepts', () => {
  it('the internal surface takes calls from the control plane, and a peer invocation from the router too', () => {
    expect(wireEndpoint('/internal/provision')).toEqual({ kind: 'call', issuers: ['platform'] });
    expect(wireEndpoint('/internal')).toEqual({ kind: 'call', issuers: ['platform'] });
    expect(wireEndpoint('/internal/vertical-invoke')).toEqual({ kind: 'call', issuers: ['platform', 'router'] });
  });

  it('every other path is a routed request, the router’s alone', () => {
    for (const path of ['/', '/api/things', '/internals', '/internal-x', '/api/internal/provision', '/api/%69nternal/x', '/docs/internal', '/my-internal/x', '/internalx']) {
      expect(wireEndpoint(path)).toEqual({ kind: 'route', issuers: ['router'] });
    }
  });

  it.each([
    ['an escaped letter', '/%69nternal/provision'],
    ['an escaped letter after the prefix', '/internal/%70rovision'],
    ['an upper-case escape', '/%49nternal/provision'],
    ['an escaped slash', '/internal%2Fprovision'],
    ['a dot segment', '/./internal/provision'],
    ['a parent segment', '/a/../internal/provision'],
    ['escaped dot segments', '/a/%2e%2e/internal/provision'],
    ['a doubled slash before', '//internal/provision'],
    ['a doubled slash after', '/internal//provision'],
    ['a trailing slash', '/internal/'],
    ['upper case', '/INTERNAL/provision'],
    ['mixed case', '/Internal'],
    // decodeURI throws on the whole path, so only the run-by-run fallback sees the escaped letter.
    ['an escaped letter beside an undecodable escape', '/%69nternal/provision/%ff'],
    ['an escaped letter beside an undecodable last segment', '/%69nternal/%ff'],
  ])('a path a router could read as internal is a call: %s (%s)', (_, path) => {
    expect(wireEndpoint(path)).toEqual({ kind: 'call', issuers: ['platform'] });
  });

  it('admits the router only on the exact path a peer invocation is sent to', () => {
    for (const path of ['/internal/vertical-invoke/', '/internal/vertical-invoke/x', '/internal/%76ertical-invoke', '/INTERNAL/vertical-invoke', '//internal/vertical-invoke']) {
      expect(wireEndpoint(path)).toEqual({ kind: 'call', issuers: ['platform'] });
    }
    expect(wireEndpoint('/internal/vertical-invoke')).toEqual({ kind: 'call', issuers: ['platform', 'router'] });
  });

  it('admits the router on the connector call and probe paths, spelled as vertical-connector.ts names them', () => {
    for (const path of [CONNECTOR_CALL_PATH, CONNECTOR_PROBE_PATH]) {
      expect(wireEndpoint(path)).toEqual({ kind: 'call', issuers: ['platform', 'router'] });
      expect(wireEndpoint(`${path}/`)).toEqual({ kind: 'call', issuers: ['platform'] });
    }
  });
});

describe('a call’s body given as a reader', () => {
  const reader = (body: WireBytes | null) => {
    const calls: number[] = [];
    return { calls, read: () => (calls.push(1), Promise.resolve(body)) };
  };
  const bodyOf = (vector: Vector) => vector.input.body as WireBytes;

  it('is read once, at the body check, and verifies as the bytes it returns', async () => {
    const r = reader(bodyOf(CALL));
    expect((await check({ vector: CALL, expected: { body: r.read } })).verdict).toMatchObject({ ok: true });
    expect(r.calls).toHaveLength(1);
  });

  it('is never read when the envelope is refused before the body', async () => {
    const r = reader(bodyOf(CALL));
    expect(await reason({ vector: CALL, signature: ROUTE.signature, expected: { body: r.read } })).toBe('signature');
    expect(await reason({ vector: CALL, expected: { body: r.read, aud: 'other' } })).toBe('audience');
    expect(await reason({ vector: CALL, now: CALL.input.exp + 3600, expected: { body: r.read } })).toBe('expired');
    expect(await reason({ vector: CALL, expected: { body: r.read, target: '/elsewhere' } })).toBe('target');
    expect(r.calls).toEqual([]);
  });

  it('a read that answers null, or other bytes, is refused for the body', async () => {
    expect(await reason({ vector: CALL, expected: { body: reader(null).read } })).toBe('body');
    expect(await reason({ vector: CALL, expected: { body: reader('tampered').read } })).toBe('body');
  });
});

describe('wireReplayOf: a call’s replay policy, as its endpoint states it', () => {
  it('a safe method keeps no nonce, in any case', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'Head']) expect(wireReplayOf(method, '/internal/provision')).toBe('none');
  });

  it('a call the table lists as changing nothing keeps no nonce', () => {
    for (const path of WIRE_REPLAY_FREE_CALLS) expect(wireReplayOf('POST', path)).toBe('none');
    expect(WIRE_REPLAY_FREE_CALLS).toEqual(['/internal/query', '/internal/redrain-count', '/internal/lifecycle-flow', '/internal/operation-series', '/internal/connector-grants', '/internal/connector-probe']);
  });

  it('every other call keeps nonces: an unlisted one, a new one, another spelling of a listed one', () => {
    for (const path of ['/internal/provision', '/internal/vertical-invoke', '/internal/brand-new-verb', '/internal/%71uery', '/internal/query/', '/INTERNAL/query']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(wireReplayOf(method, path)).toBe('nonce');
    }
  });

  it('a connector probe keeps no nonce; a scoped connector call keeps them', () => {
    expect(wireReplayOf('POST', CONNECTOR_PROBE_PATH)).toBe('none');
    expect(wireReplayOf('POST', CONNECTOR_CALL_PATH)).toBe('nonce');
  });
});

describe('the signers: their flag, their key, and an envelope on a request (RFC §9, step 2)', () => {
  it('wireSigningOn: only `on` turns a signer on; every doubt is off', () => {
    for (const value of ['on', ' on', 'on\n']) expect(wireSigningOn(value), JSON.stringify(value)).toBe(true);
    for (const value of [undefined, null, '', 'off', 'ON', 'On', '1', 'true', 'yes', true, 1]) expect(wireSigningOn(value), JSON.stringify(value)).toBe(false);
  });

  it('wireSigningKeyOf: imported once per value, and replaced when the value changes', async () => {
    const [a, b] = await Promise.all([generateScopeStoreKeyPair(), generateScopeStoreKeyPair()]);
    const first = wireSigningKeyOf(a.privateKey);
    expect(wireSigningKeyOf(a.privateKey)).toBe(first);
    expect((await first).publicKey).toBe(a.publicKey);
    const second = wireSigningKeyOf(b.privateKey);
    expect(second).not.toBe(first);
    expect((await second).kid).toBe((await importWireSigningKey(b.privateKey)).kid);
  });

  it('wireSigningKeyOf: a value that will not import rejects with its reason, never its text', async () => {
    const bad = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const error = await wireSigningKeyOf(bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WireKeyError);
    expect((error as WireKeyError).reason).toBe('not-pkcs8-v1');
    expect(String((error as Error).message)).not.toContain(bad);
    // The same rejection is kept for the same value, rather than imported again.
    expect(wireSigningKeyOf(bad)).toBe(wireSigningKeyOf(bad));
  });

  it('signWireRequest, a route: the envelope beside every header, the body neither bound nor read', async () => {
    const key = await importWireSigningKey(fixture.keys.router.privateKeyPkcs8);
    const request = new Request('https://acme.example/api/things?page=2#frag', { method: 'POST', body: 'upload', headers: { cookie: 'a=1', 'x-substrat-router': 'legacy' } });
    const signed = await signWireRequest(key, request, { iss: 'router', kind: 'route', aud: 'acme', tenantId: ROUTE.input.tenantId!, scopeId: ROUTE.input.scopeId!, surface: 'app' });
    expect(signed.headers.get('cookie')).toBe('a=1');
    expect(signed.headers.get('x-substrat-router')).toBe('legacy');
    expect(await signed.text()).toBe('upload');
    const claims = decodeWireEnvelope(signed.headers.get(WIRE_ENVELOPE_HEADER)!)!.claims;
    expect(claims).toMatchObject({ iss: 'router', kind: 'route', aud: 'acme', method: 'POST', targetDigest: await wireDigest('/api/things?page=2'), bodyDigest: null });
    const verdict = await verifyWireEnvelope({
      headers: signed.headers,
      keys: await keysOf(),
      expected: { iss: 'router', kind: 'route', aud: 'acme', ...wireRequestBinding(signed) },
      nowSeconds: claims.iat,
    });
    expect(verdict.ok).toBe(true);
  });

  it('signWireRequest, a call: the exact body bound and handed on; an absent body is the empty one', async () => {
    const key = await importWireSigningKey(fixture.keys.platform.privateKeyPkcs8);
    const body = JSON.stringify({ note: 'é'.repeat(5) });
    const post = await signWireRequest(key, new Request('https://vertical/internal/query', { method: 'POST', body }), { iss: 'platform', kind: 'call', aud: 'acme' });
    const bytes = await post.arrayBuffer();
    expect(new TextDecoder().decode(bytes)).toBe(body);
    const claims = decodeWireEnvelope(post.headers.get(WIRE_ENVELOPE_HEADER)!)!.claims;
    expect(claims.bodyDigest).toBe(await wireDigest(body));
    const verify = async (request: Request, received: WireBytes) =>
      verifyWireEnvelope({
        headers: request.headers,
        keys: await keysOf(),
        expected: { iss: 'platform', kind: 'call', aud: 'acme', ...wireRequestBinding(request), body: received, replay: 'none' },
        nowSeconds: claims.iat,
      } as never);
    expect((await verify(post, bytes)).ok).toBe(true);
    const get = await signWireRequest(key, new Request('https://vertical/internal/system-grants?scopeId=x'), { iss: 'platform', kind: 'call', aud: 'acme' });
    expect(get.body).toBeNull();
    expect(decodeWireEnvelope(get.headers.get(WIRE_ENVELOPE_HEADER)!)!.claims.bodyDigest).toBe(await wireDigest(''));
  });

  it('signWireRequest replaces an envelope already on the request, and each call is a fresh nonce', async () => {
    const key = await importWireSigningKey(fixture.keys.platform.privateKeyPkcs8);
    const make = () => new Request('https://vertical/internal/query', { method: 'POST', body: '{}', headers: { [WIRE_ENVELOPE_HEADER]: 'stale', [WIRE_SIGNATURE_HEADER]: 'stale' } });
    const [a, b] = await Promise.all([make(), make()].map((r) => signWireRequest(key, r, { iss: 'platform', kind: 'call', aud: 'acme' })));
    expect(a!.headers.get(WIRE_ENVELOPE_HEADER)).not.toBe('stale');
    expect(decodeWireEnvelope(a!.headers.get(WIRE_ENVELOPE_HEADER)!)!.claims.nonce).not.toBe(decodeWireEnvelope(b!.headers.get(WIRE_ENVELOPE_HEADER)!)!.claims.nonce);
  });

  it('signWireRequest refuses claims no verifier would accept, and a pair the table does not admit', async () => {
    const key = await importWireSigningKey(fixture.keys.platform.privateKeyPkcs8);
    const request = () => new Request('https://vertical/internal/query', { method: 'POST', body: '{}' });
    await expect(signWireRequest(key, request(), { iss: 'platform', kind: 'call', aud: '' })).rejects.toThrow();
    await expect(signWireRequest(key, request(), { iss: 'platform', kind: 'route', aud: 'acme' })).rejects.toThrow();
    await expect(signWireRequest(key, request(), { iss: 'platform', kind: 'call', aud: 'acme', tenantId: ROUTE.input.tenantId! })).rejects.toThrow();
    // Its twin: the same request with admissible claims is signed.
    await expect(signWireRequest(key, request(), { iss: 'platform', kind: 'call', aud: 'acme', tenantId: ROUTE.input.tenantId!, scopeId: ROUTE.input.scopeId! })).resolves.toBeInstanceOf(Request);
  });
});

describe('wireSignerOf: one signer decision for the router and the control plane (RFC §5, §8)', () => {
  const call = () => new Request('https://vertical/internal/provision', { method: 'POST', body: '{"a":1}' });
  const CALL_CLAIMS = { iss: 'platform', kind: 'call', aud: 'acme' } as const;

  it('is null while the flag is off, whatever the key', () => {
    for (const sign of [undefined, '', 'off', 'ON']) expect(wireSignerOf({ sign, key: fixture.keys.platform.privateKeyPkcs8 })).toBeNull();
    expect(wireSignerOf({ sign: 'on', key: fixture.keys.platform.privateKeyPkcs8 })).toBeTypeOf('function');
  });

  it('with no key, hands the very request back unread, failed as unset', async () => {
    const request = call();
    const result = await wireSignerOf({ sign: 'on' })!(request, CALL_CLAIMS);
    expect(result).toEqual({ request, outcome: 'failed', reason: 'unset' });
    expect(request.bodyUsed).toBe(false);
  });

  it('with a key that will not import, hands the very request back unread, with the key form’s reason', async () => {
    const request = call();
    const result = await wireSignerOf({ sign: 'on', key: 'AAAA' })!(request, CALL_CLAIMS);
    expect(result).toEqual({ request, outcome: 'failed', reason: 'not-pkcs8-v1' });
    expect(request.bodyUsed).toBe(false);
  });

  it('signs, adding the pair `named` reads off the bytes it read once', async () => {
    const seen: string[] = [];
    const named = (_: Request, body: ArrayBuffer | undefined) => (seen.push(new TextDecoder().decode(body)), { tenantId: ROUTE.input.tenantId!, scopeId: ROUTE.input.scopeId! });
    const result = await wireSignerOf({ sign: 'on', key: fixture.keys.platform.privateKeyPkcs8 })!(call(), CALL_CLAIMS, named);
    expect(result.outcome).toBe('signed');
    expect(seen).toEqual(['{"a":1}']);
    expect(decodeWireEnvelope(result.request.headers.get(WIRE_ENVELOPE_HEADER)!)!.claims).toMatchObject({ tenantId: ROUTE.input.tenantId, bodyDigest: await wireDigest('{"a":1}') });
    expect(await result.request.text()).toBe('{"a":1}');
  });

  it('claims the encoder refuses, after the body was read: the request comes back whole, failed as claims', async () => {
    const result = await wireSignerOf({ sign: 'on', key: fixture.keys.platform.privateKeyPkcs8 })!(call(), { ...CALL_CLAIMS, aud: '' });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'claims' });
    expect(result.request.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
    expect(await result.request.text()).toBe('{"a":1}');
  });

  it('any other throw after the body was read is `error`, never `claims`: the request still comes back whole', async () => {
    const named = () => {
      throw new TypeError('not a claims refusal');
    };
    const result = await wireSignerOf({ sign: 'on', key: fixture.keys.platform.privateKeyPkcs8 })!(call(), CALL_CLAIMS, named);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'error' });
    expect(result.request.headers.has(WIRE_ENVELOPE_HEADER)).toBe(false);
    expect(await result.request.text()).toBe('{"a":1}');
  });

  it('a body that cannot be read fails the signing, not the request: handed back, failed as error', async () => {
    const broken = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new Error('gone')) });
    const request = new Request('https://vertical/internal/provision', { method: 'POST', body: broken, duplex: 'half' } as RequestInit);
    const result = await wireSignerOf({ sign: 'on', key: fixture.keys.platform.privateKeyPkcs8 })!(request, CALL_CLAIMS);
    expect(result).toEqual({ request, outcome: 'failed', reason: 'error' });
  });
});

describe('WIRE_UNSIGNED_HEADERS: the router headers listed as carrying no authority (RFC §5)', () => {
  const ID = '01JZ0000000000000000CVG001';

  it('names exactly the field-coverage sample on a route and the parent request id on a call, spelled as their readers spell them', () => {
    expect(WIRE_UNSIGNED_HEADERS).toEqual({ [FIELD_COVERAGE_HEADER]: 'route', [PARENT_REQUEST_ID_HEADER]: 'call' });
  });

  it('hands on a listed header only on its own kind, and only as one ULID', () => {
    const headers = new Headers({ [FIELD_COVERAGE_HEADER]: ID, [PARENT_REQUEST_ID_HEADER]: ID, 'x-substrat-extra': ID });
    expect(wireUnsignedHeadersOf('route', headers)).toEqual([[FIELD_COVERAGE_HEADER, ID]]);
    expect(wireUnsignedHeadersOf('call', headers)).toEqual([[PARENT_REQUEST_ID_HEADER, ID]]);
    for (const value of ['', ID.toLowerCase(), `${ID} ${ID}`, `${ID},${ID}`, ID.slice(1), `${ID}0`, 'IIIIIIIIIIIIIIIIIIIIIIIIII']) {
      expect(wireUnsignedHeadersOf('route', new Headers({ [FIELD_COVERAGE_HEADER]: value })), JSON.stringify(value)).toEqual([]);
    }
    const twice = new Headers();
    twice.append(PARENT_REQUEST_ID_HEADER, ID);
    twice.append(PARENT_REQUEST_ID_HEADER, ID);
    expect(wireUnsignedHeadersOf('call', twice)).toEqual([]);
  });
});
