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
} from '../src/scope-store-envelope.js';
import {
  canonicalWireEnvelope,
  importWireSigningKey,
  parseWireEnvelope,
  signWireEnvelope,
  verifyWireEnvelope,
  WIRE_CLOCK_SKEW_SECONDS,
  WIRE_ENVELOPE_HEADER,
  WIRE_ENVELOPE_LIFETIME_SECONDS,
  WIRE_ENVELOPE_MAX_LIFETIME_SECONDS,
  WIRE_REFUSAL_REASONS,
  WIRE_REFUSED,
  WIRE_SIGNATURE_HEADER,
  wireDigest,
  wireEnvelopeShape,
  WireKeyError,
  wireRequestBinding,
  wireVerificationKeys,
  type WireBytes,
  type WireEnvelopeInput,
  type WireExpectation,
  type WireIssuer,
  type WireNonceCache,
  type WireRefusalReason,
  type WireVerificationKeys,
} from '../src/wire-signing.js';

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
  return kind === 'call' ? { iss, kind, aud, method, target, body: body! } : { iss, kind, aud, method, target };
}

interface Check {
  readonly vector?: Vector;
  readonly header?: string | null;
  readonly signature?: string | null;
  readonly expected?: Partial<WireExpectation> & { readonly body?: WireBytes };
  readonly now?: number;
  readonly keys?: WireVerificationKeys;
  readonly nonces?: WireNonceCache;
}

/** Verify a vector (or what replaces part of it), collecting the reasons `onRefusal` hears. */
async function check(input: Check = {}) {
  const vector = input.vector ?? ROUTE;
  const reasons: WireRefusalReason[] = [];
  const verdict = await verifyWireEnvelope({
    headers: headersOf(input.header === undefined ? vector.header : input.header, input.signature === undefined ? vector.signature : input.signature),
    keys: input.keys ?? (await keysOf()),
    expected: { ...expectationOf(vector), ...input.expected } as WireExpectation,
    nowSeconds: input.now ?? vector.input.iat,
    ...(input.nonces ? { nonces: input.nonces } : {}),
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
    await check({ nonces: nonces.cache });
    const handBuilt = { router: new Map([[fixture.keys.router.kid, fixture.keys.router.publicKey]]), platform: new Map() };
    const cases: [WireRefusalReason, Check][] = [
      ['missing', { signature: null }],
      ['malformed', { header: 'not base64url!' }],
      ['issuer', { expected: { iss: 'platform' } }],
      ['kind', { vector: ROUTER_CALL, expected: { kind: 'route' } }],
      ['keys', { keys: handBuilt }],
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
      ['replay', { nonces: nonces.cache }],
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
    expect(await reason({ vector: ROUTE, expected: { kind: 'call', body: '' } })).toBe('kind');
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
    expect(await reason({ keys: { router: new Map(built.router), platform: new Map(built.platform) } })).toBe('keys');
    expect(await reason({ keys: { ...built } })).toBe('keys');
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
      [ROUTE, 9, 'A'.repeat(17)],
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
    expect(bad({ surface: '\ud800' })).toThrow(/well-formed/);
    expect(bad({ iat: -1 })).toThrow(/time/);
    expect(bad({ exp: 1.5 })).toThrow(/time/);
    expect(bad({ v: 2 })).toThrow(/version/);
    expect(bad({ scopeId: null })).toThrow(/malformed/);
    // Non-ASCII text is carried as UTF-8 and round-trips.
    const text = canonicalWireEnvelope({ ...claims, surface: 'bokföring' });
    expect(parseWireEnvelope(text)?.surface).toBe('bokföring');
  });

  it('the signer refuses what no verifier accepts', async () => {
    const key = await importWireSigningKey(fixture.keys.router.privateKeyPkcs8);
    const route = ROUTE.input;
    const call = ROUTER_CALL.input;
    await expect(signWireEnvelope(key, { ...route, body: '' })).rejects.toThrow(/binds no body/);
    const { body: _body, ...bodiless } = call;
    await expect(signWireEnvelope(key, bodiless)).rejects.toThrow(/binds its body/);
    await expect(signWireEnvelope(key, { ...call, surface: 'app' })).rejects.toThrow(/malformed/);
    await expect(signWireEnvelope(key, { ...route, surface: null })).rejects.toThrow(/malformed/);
    await expect(signWireEnvelope(key, { ...route, scopeId: null })).rejects.toThrow(/malformed/);
    await expect(signWireEnvelope(key, { ...route, surface: '' })).rejects.toThrow(/null/);
    await expect(signWireEnvelope(key, { ...route, method: 'get' })).rejects.toThrow(/malformed/);
    await expect(signWireEnvelope(key, { ...route, iat: -5, exp: 10 })).rejects.toThrow(/time/);
    await expect(signWireEnvelope(key, { ...route, nonce: 'n' })).rejects.toThrow(/malformed/);
  });
});

describe('wire envelope: replay', () => {
  it('accepts the same envelope twice inside the window when the endpoint keeps no nonces, by design', async () => {
    expect((await check()).verdict).toMatchObject({ ok: true });
    expect((await check({ now: ROUTE.input.iat + 10 })).verdict).toMatchObject({ ok: true });
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
