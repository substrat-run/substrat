/**
 * The signed envelope the router and the control plane are to put on a call to a vertical
 * (RFC wire-signing, K-58 proposed). **Primitives only**: nothing in the repo signs or
 * verifies one yet, and the shared-secret checks in `wire-auth.ts` and vertical-host's
 * `readRoutedNode` are unchanged.
 *
 * Ed25519 over a canonical encoding, the scheme the scope-store envelope already uses (K-52),
 * with its conventions reused rather than restated: the key id, the raw public key lists, the
 * strict PKCS8 form, the small-order and canonical-spelling refusals and base64url all come
 * from `scope-store-envelope.ts`, so a key one module accepts the other accepts too. A vertical
 * would hold only public keys, a list per issuer, so a key can rotate without a moment where no
 * key verifies.
 *
 * The encoding is fifteen lines joined by `\n`, with no trailing newline, so a verifier in
 * another language can rebuild it (`test/vectors/wire-envelope.json` is the shared vector):
 *
 * ```
 * substrat-wire/1
 * router|platform                  iss: which signer, so which key list
 * route|call                       kind: a routed request, or a call to an internal endpoint
 * <kid>                            as the store's: base64url of SHA-256's first 8 bytes
 * <aud>                            the target deployment (the dispatch script name), opaque
 * <tenant id>                      a ULID, or empty on a call that names no scope
 * <scope id>                       a ULID, empty exactly when the tenant is
 * <surface>                        a route's surface; empty on a call
 * <vertical>                       the vertical slug, or empty
 * <METHOD>                         upper-case
 * <sha256 hex of the target>       the request's pathname + search, as UTF-8
 * <sha256 hex of the body>         a call's exact body bytes; empty on a route
 * <iat, unix seconds>
 * <exp, unix seconds>
 * <nonce, base64url of 16 bytes>
 * ```
 *
 * Which fields a (iss, kind) pair carries is a closed table, {@link wireEnvelopeShape}. The
 * first line names the protocol, so no message signed under another protocol (a store
 * envelope's first line is `1`) parses as one of these, whatever key signed it.
 *
 * Every refusal of a caller is the same value, {@link WIRE_REFUSED}: a caller cannot tell a wrong
 * audience from a bad signature, and neither can whoever it answers. The reason goes to
 * `onRefusal`, for metrics only. A fault of the deployment's own throws instead: a key set it
 * built some other way, a call expectation with no replay policy (or a cache with no pinned
 * scope), and a nonce cache that cannot answer.
 *
 * Imports nothing but its sibling subpath `scope-store-envelope.ts`, which imports nothing, so
 * an entry bundle that imports this subpath pulls in no schema and no zod.
 */
import {
  base64UrlToBytes,
  bytesToBase64Url,
  parseScopeStorePublicKeys,
  ScopeStoreKeyError,
  scopeStoreKeyId,
  scopeStoreSignerPublicKey,
  verifyScopeStoreEnvelope,
  type ScopeStoreKeyProblem,
} from './scope-store-envelope.js';

export const WIRE_ENVELOPE_VERSION = 1;
/** The first line of every wire envelope: the protocol and its version. */
export const WIRE_ENVELOPE_TAG = `substrat-wire/${WIRE_ENVELOPE_VERSION}` as const;
/** The request header carrying base64url of the canonical bytes. */
export const WIRE_ENVELOPE_HEADER = 'x-substrat-wire-envelope';
/** The request header carrying the base64url signature. */
export const WIRE_SIGNATURE_HEADER = 'x-substrat-wire-signature';
/** What a signer gives an envelope when it is not told: `exp = iat + 60`. */
export const WIRE_ENVELOPE_LIFETIME_SECONDS = 60;
/** The longest `exp - iat` a verifier accepts, and a signer mints. */
export const WIRE_ENVELOPE_MAX_LIFETIME_SECONDS = 120;
/** How far a verifier's clock may be from the signer's, on either side of `[iat, exp]`. */
export const WIRE_CLOCK_SKEW_SECONDS = 30;

export type WireIssuer = 'router' | 'platform';
export type WireKind = 'route' | 'call';

/** Whether a field is carried: always, possibly (empty when not), or never (always empty). */
export type WireFieldPresence = 'required' | 'optional' | 'absent';

export interface WireEnvelopeShape {
  /** The tenant and scope, as a pair: both ULIDs or both empty. */
  readonly scope: WireFieldPresence;
  readonly surface: WireFieldPresence;
  readonly vertical: WireFieldPresence;
  readonly body: WireFieldPresence;
}

/**
 * The (iss, kind) pairs version 1 admits and what each carries. Closed: a pair not here is
 * refused, so the control plane can never assert a routed request, and a route never claims
 * to bind a body it does not.
 */
const SHAPES: Readonly<Record<string, Readonly<Record<string, WireEnvelopeShape>>>> = {
  router: {
    // An end user's request the router resolved: always a tenant, a scope and a surface. The
    // body is a stream the router does not buffer, so a route binds none.
    route: { scope: 'required', surface: 'required', vertical: 'optional', body: 'absent' },
    // An internal call the router makes itself, such as a peer invocation.
    call: { scope: 'optional', surface: 'absent', vertical: 'optional', body: 'required' },
  },
  platform: {
    call: { scope: 'optional', surface: 'absent', vertical: 'absent', body: 'required' },
  },
};

/** What an (iss, kind) pair carries, or undefined when version 1 does not admit the pair. */
export function wireEnvelopeShape(iss: string, kind: string): WireEnvelopeShape | undefined {
  const byKind = Object.hasOwn(SHAPES, iss) ? SHAPES[iss] : undefined;
  return byKind && Object.hasOwn(byKind, kind) ? byKind[kind] : undefined;
}

/** One envelope's fields. An absent field is `null`, never an empty string. */
export interface WireClaims {
  readonly v: 1;
  readonly iss: WireIssuer;
  readonly kind: WireKind;
  readonly kid: string;
  readonly aud: string;
  readonly tenantId: string | null;
  readonly scopeId: string | null;
  readonly surface: string | null;
  readonly vertical: string | null;
  readonly method: string;
  readonly targetDigest: string;
  readonly bodyDigest: string | null;
  readonly iat: number;
  readonly exp: number;
  readonly nonce: string;
}

const LINES = 15;
/** The ULID grammar the router asserts and vertical-host's `ROUTED_ID` reads. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/**
 * An HTTP method token (RFC 9110 `tchar`) with its letters upper-cased, as `wireRequestBinding` gives
 * it. At most 32 characters: the longest registered method, UPDATEREDIRECTREF, is 17, and the bound
 * only keeps an unregistered token from making the line unbounded.
 */
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Z-]{1,32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
// At most 15 digits, no sign and no leading zero: the text `String(n)` gives for an integer below 10^15.
const SECONDS = /^(0|[1-9]\d{0,14})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Half a surrogate pair: UTF-8 cannot carry it, so the bytes signed would name another string. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** The longest opaque field (aud, surface, vertical), in UTF-16 code units. */
const MAX_TEXT = 255;

/** An opaque field: every other field's grammar is ASCII, so this is the one place well-formedness is judged. */
const isText = (value: string) => value.length <= MAX_TEXT && !CONTROL.test(value) && !LONE_SURROGATE.test(value);

/**
 * Whether `text` is the canonical base64url of exactly `length` bytes, as the store module judges
 * it: so a kid is 11 characters and a nonce 22, with their unused trailing bits zero.
 */
function isCanonicalBase64Url(text: string, length: number): boolean {
  const bytes = base64UrlToBytes(text);
  return bytes?.length === length && bytesToBase64Url(bytes) === text;
}

/** Whether one line's text is what `presence` allows: empty, or a non-empty value `valid` accepts. */
function admits(presence: WireFieldPresence, value: string, valid: (value: string) => boolean): boolean {
  if (value === '') return presence !== 'required';
  return presence !== 'absent' && valid(value);
}

/** The claims those bytes name, or undefined when they are not exactly what the encoder emits. */
export function parseWireEnvelope(canonical: string): WireClaims | undefined {
  const lines = canonical.split('\n');
  if (lines.length !== LINES) return undefined;
  const [tag, iss, kind, kid, aud, tenantId, scopeId, surface, vertical, method, targetDigest, bodyDigest, iat, exp, nonce] =
    lines as [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];
  if (tag !== WIRE_ENVELOPE_TAG) return undefined;
  const shape = wireEnvelopeShape(iss, kind);
  if (!shape) return undefined;
  if (!isCanonicalBase64Url(kid, 8) || !isCanonicalBase64Url(nonce, 16)) return undefined;
  if (aud === '' || !isText(aud)) return undefined;
  if ((tenantId === '') !== (scopeId === '')) return undefined;
  if (!admits(shape.scope, tenantId, (id) => ULID.test(id)) || !admits(shape.scope, scopeId, (id) => ULID.test(id))) return undefined;
  if (!admits(shape.surface, surface, isText) || !admits(shape.vertical, vertical, isText)) return undefined;
  if (!METHOD.test(method) || !DIGEST.test(targetDigest) || !admits(shape.body, bodyDigest, (d) => DIGEST.test(d))) return undefined;
  if (!SECONDS.test(iat) || !SECONDS.test(exp)) return undefined;
  const orNull = (value: string) => (value === '' ? null : value);
  return {
    v: 1,
    iss: iss as WireIssuer,
    kind: kind as WireKind,
    kid,
    aud,
    tenantId: orNull(tenantId),
    scopeId: orNull(scopeId),
    surface: orNull(surface),
    vertical: orNull(vertical),
    method,
    targetDigest,
    bodyDigest: orNull(bodyDigest),
    iat: Number(iat),
    exp: Number(exp),
    nonce,
  };
}

/** Fifteen lines, no trailing newline. Throws on a field the parser would refuse. */
export function canonicalWireEnvelope(claims: WireClaims): string {
  if (claims.v !== WIRE_ENVELOPE_VERSION) throw new Error(`unknown wire envelope version ${claims.v}`);
  for (const time of [claims.iat, claims.exp]) {
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('a wire envelope time is not a non-negative integer');
  }
  const optional = (value: string | null) => {
    if (value === '') throw new Error('a wire envelope field is empty: an absent field is null');
    return value ?? '';
  };
  const lines = [
    WIRE_ENVELOPE_TAG,
    claims.iss,
    claims.kind,
    claims.kid,
    claims.aud,
    optional(claims.tenantId),
    optional(claims.scopeId),
    optional(claims.surface),
    optional(claims.vertical),
    claims.method,
    claims.targetDigest,
    optional(claims.bodyDigest),
    String(claims.iat),
    String(claims.exp),
    claims.nonce,
  ];
  if (lines.some((line) => line.includes('\n'))) throw new Error('a wire envelope field contains a newline');
  const canonical = lines.join('\n');
  if (!parseWireEnvelope(canonical)) throw new Error('a wire envelope field is malformed');
  return canonical;
}

/** A body or a target, as the bytes a digest is taken over. A string is its UTF-8. */
export type WireBytes = string | ArrayBuffer | ArrayBufferView;

function bytesOf(data: WireBytes): Uint8Array<ArrayBuffer> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  // Web Crypto copies what it is given, so only a shared buffer needs copying here, to type as one.
  return view.buffer instanceof ArrayBuffer ? (view as Uint8Array<ArrayBuffer>) : view.slice();
}

/** SHA-256 of the exact bytes, lowercase hex: for a string, the store's body digest. */
export async function wireDigest(data: WireBytes): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytesOf(data));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * What an envelope binds of a request, read the same way by the signer (from the request it is
 * about to send) and the verifier (from the request it received): the method, upper-cased, and
 * the target, the URL's pathname plus its search as the URL API serializes them. The fragment
 * never travels, and an empty `?` reads as no query on both ends.
 */
export function wireRequestBinding(request: { readonly method: string; readonly url: string }): {
  readonly method: string;
  readonly target: string;
} {
  const url = new URL(request.url);
  return { method: request.method.toUpperCase(), target: `${url.pathname}${url.search}` };
}

/** A signing key that is present but cannot be used. Its message never carries the key. */
export class WireKeyError extends Error {
  override readonly name = 'WireKeyError';
  constructor(
    message: string,
    readonly reason: ScopeStoreKeyProblem,
  ) {
    super(message);
  }
}

/** An imported private key and the key id its envelopes name. Import once per isolate. */
export interface WireSigningKey {
  readonly kid: string;
  readonly publicKey: string;
  readonly key: CryptoKey;
}

/**
 * Import a PKCS8 Ed25519 private key (base64url) for signing. The key is judged by the store
 * module's own check (only the 48-byte PKCS8 v1 form, never a small-order point), so the store
 * key tooling's `generate` and `doctor` accept and refuse the same values. Throws
 * {@link WireKeyError} when it is unusable.
 */
export async function importWireSigningKey(pkcs8: string): Promise<WireSigningKey> {
  let signer: { readonly publicKey: string; readonly kid: string };
  try {
    signer = await scopeStoreSignerPublicKey(pkcs8);
  } catch (error) {
    if (error instanceof ScopeStoreKeyError) {
      throw new WireKeyError(`the wire signing key is unusable (${error.reason})`, error.reason);
    }
    throw error;
  }
  // Accepted above, so it decodes. Not extractable: nothing reads it back out of the isolate.
  const key = await crypto.subtle.importKey('pkcs8', bytesOf(base64UrlToBytes(pkcs8)!), { name: 'Ed25519' }, false, ['sign']);
  return Object.freeze({ kid: signer.kid, publicKey: signer.publicKey, key });
}

/** What a signer is told. Absent optional fields are omitted or `null`. */
export interface WireEnvelopeInput {
  readonly iss: WireIssuer;
  readonly kind: WireKind;
  readonly aud: string;
  readonly tenantId?: string | null;
  readonly scopeId?: string | null;
  readonly surface?: string | null;
  readonly vertical?: string | null;
  /** From {@link wireRequestBinding} over the request being sent. */
  readonly method: string;
  readonly target: string;
  /** A call's exact body (an empty one is `''`). A route takes none. */
  readonly body?: WireBytes;
  /** Defaults to now. */
  readonly iat?: number;
  /** Defaults to `iat` + {@link WIRE_ENVELOPE_LIFETIME_SECONDS}. */
  readonly exp?: number;
  /** Defaults to 16 random bytes. */
  readonly nonce?: string;
}

export interface IssuedWireEnvelope {
  readonly claims: WireClaims;
  readonly canonical: string;
  /** {@link WIRE_ENVELOPE_HEADER} carries it: base64url of the canonical UTF-8 bytes. */
  readonly header: string;
  /** {@link WIRE_SIGNATURE_HEADER} carries it. */
  readonly signature: string;
}

/** Build, digest and sign one envelope. Throws on an input no verifier would accept. */
export async function signWireEnvelope(key: WireSigningKey, input: WireEnvelopeInput): Promise<IssuedWireEnvelope> {
  // A pair the table does not admit fails in the encoder below, as malformed.
  const body = wireEnvelopeShape(input.iss, input.kind)?.body;
  if (body === 'absent' && input.body !== undefined) throw new Error(`a ${input.kind} envelope binds no body`);
  // `== null`, as the verifier reads it: a null body is a read that failed, never the empty body.
  if (body === 'required' && input.body == null) throw new Error(`a ${input.kind} envelope binds its body: pass it, empty or not`);
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  const exp = input.exp ?? iat + WIRE_ENVELOPE_LIFETIME_SECONDS;
  if (!lifetimeAdmitted(iat, exp)) throw new Error('a wire envelope lives for at most the maximum lifetime, and ends after it starts');
  const claims: WireClaims = {
    v: 1,
    iss: input.iss,
    kind: input.kind,
    kid: key.kid,
    aud: input.aud,
    tenantId: input.tenantId ?? null,
    scopeId: input.scopeId ?? null,
    surface: input.surface ?? null,
    vertical: input.vertical ?? null,
    method: input.method,
    targetDigest: await wireDigest(input.target),
    bodyDigest: input.body === undefined ? null : await wireDigest(input.body),
    iat,
    exp,
    nonce: input.nonce ?? bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const canonical = canonicalWireEnvelope(claims);
  const bytes = new TextEncoder().encode(canonical);
  const signature = await crypto.subtle.sign('Ed25519', key.key, bytes);
  return { claims, canonical, header: bytesToBase64Url(bytes), signature: bytesToBase64Url(new Uint8Array(signature)) };
}

function lifetimeAdmitted(iat: number, exp: number): boolean {
  return exp > iat && exp - iat <= WIRE_ENVELOPE_MAX_LIFETIME_SECONDS;
}

/**
 * The public keys a deployment verifies with, per issuer, by key id. Only {@link wireVerificationKeys}
 * makes one, and only the same copy of this module accepts it: the mark is held by the module
 * instance, so a key set built by a second copy of the package (two bundled versions, say) throws
 * on every call. Build the key set and verify in the same bundle.
 */
export interface WireVerificationKeys {
  readonly router: ReadonlyMap<string, string>;
  readonly platform: ReadonlyMap<string, string>;
}

/**
 * The verifier's own copy of each key set it was handed, by the object returned. The returned maps
 * are for reading; a caller that mutates one (`keys.platform.set(…)`) changes nothing the verifier
 * uses, so the both-issuers refusal cannot be undone after the fact.
 */
const PREPARED = new WeakMap<WireVerificationKeys, { readonly router: ReadonlyMap<string, string>; readonly platform: ReadonlyMap<string, string> }>();

/**
 * Each issuer's public keys, from the configured lists: raw Ed25519 keys, base64url, separated
 * by commas, as the store's lists are and refused for the same faults. An unset or blank list is
 * no keys, which verifies nothing. Throws on a key listed for both issuers: whoever holds the
 * router's private key could then sign as the platform.
 */
export async function wireVerificationKeys(config: { readonly router?: string; readonly platform?: string }): Promise<WireVerificationKeys> {
  const listed = (text: string | undefined) => (text?.trim() ? parseScopeStorePublicKeys(text) : []);
  const router = listed(config.router);
  const platform = listed(config.platform);
  if (router.some((key) => platform.includes(key))) throw new Error('a wire public key is listed for both issuers');
  // The list parser refused a key listed twice, and canonical spelling makes equal text equal bytes.
  const byKid = async (keys: readonly string[]) => new Map(await Promise.all(keys.map(async (key) => [await scopeStoreKeyId(key), key] as const)));
  const own = Object.freeze({ router: await byKid(router), platform: await byKid(platform) });
  const keys: WireVerificationKeys = Object.freeze({ router: new Map(own.router), platform: new Map(own.platform) });
  PREPARED.set(keys, own);
  return keys;
}

/**
 * Where a deployment records the nonces of envelopes it accepted, so a replay inside the window
 * is refused. An interface only: the RFC puts the store in the scope's own object, for the calls
 * that change state.
 */
export interface WireNonceCache {
  /**
   * Record `nonce` as spent until `until` (Unix seconds) and answer whether it was unspent. It
   * answers `true` at most once per nonce while recorded, concurrent claims included, and may
   * forget a nonce after `until`, and a claim made after `until` by its own clock answers `false`:
   * that is what makes forgetting safe. The verifier also refuses, without asking, a claim it would
   * make after `until` by its own clock (a slow body). Only `true` itself is acceptance: any other
   * answer refuses. A cache that cannot answer throws, and the verifier never reads a throw as
   * acceptance. The entry bounds each claim in time and treats a timeout as that throw.
   */
  claim(nonce: string, until: number): boolean | Promise<boolean>;
}

/**
 * How a call is held against replay, stated by the endpoint, never defaulted: `'none'` keeps no
 * nonce memory, so a replay inside the window is accepted (a read, an idempotent call); a cache
 * spends each nonce once (a call that changes state). A call expectation without one throws.
 */
export type WireReplayPolicy = 'none' | WireNonceCache;

/** What a deployment expects of an envelope: who signs, for whom, and the request it rides on. */
interface WireExpectationOf<K extends WireKind> {
  readonly iss: WireIssuer;
  readonly kind: K;
  /** This deployment's own name. An empty one matches nothing. */
  readonly aud: string;
  /** From {@link wireRequestBinding} over the request received. */
  readonly method: string;
  readonly target: string;
  /** When given, the envelope must name exactly this tenant. */
  readonly tenantId?: string;
  /** When given, the envelope must name exactly this scope. */
  readonly scopeId?: string;
}

export type WireExpectation =
  | WireExpectationOf<'route'>
  | (WireExpectationOf<'call'> & {
      /** The exact body received, read before any of it is acted on. */
      readonly body: WireBytes;
      /** Required: an endpoint that forgets to say fails closed, rather than accepting replays. */
      readonly replay: WireReplayPolicy;
    });

/** Why an envelope was refused, in the order the verifier checks. For metrics only. */
export const WIRE_REFUSAL_REASONS = [
  'missing',
  'malformed',
  'issuer',
  'kind',
  'kid',
  'signature',
  'audience',
  'lifetime',
  'not-yet-valid',
  'expired',
  'method',
  'target',
  'body',
  'scope',
  'claim-after-until',
  'replay',
] as const;
export type WireRefusalReason = (typeof WIRE_REFUSAL_REASONS)[number];

export interface WireAccepted {
  readonly ok: true;
  readonly claims: WireClaims;
}

/** The one refusal. Every failure returns this same object, so none can be told from another. */
export interface WireRefused {
  readonly ok: false;
}
export const WIRE_REFUSED: WireRefused = Object.freeze({ ok: false });

export type WireVerdict = WireAccepted | WireRefused;

/**
 * Every check a deployment makes on an envelope, in one fixed order: present, well-formed, the
 * expected issuer and kind, a listed key id, the signature, then (all over signed bytes) the
 * audience, the lifetime, the clock, the method, the target, a call's body, any pinned tenant
 * and scope, and last a call's nonce when its policy keeps them, so an envelope that fails anything
 * else never spends a cache entry. A route keeps no nonces. `nowSeconds` is the time the request
 * arrived, not when its body finished reading.
 *
 * Returns {@link WIRE_REFUSED} for every failure of the caller's. `onRefusal` hears the reason; a
 * throw or a rejection from it is ignored. The deployment's own faults throw instead, so no counter
 * files them under a caller, and they are checked before anything else: a key set
 * {@link wireVerificationKeys} did not build, a call expectation whose replay policy is neither
 * `'none'` nor a cache, and a cache with no pinned `scopeId` (a cache lives in one scope's object,
 * so the endpoint pins the scope it claims through). A throw from the cache propagates too.
 */
export async function verifyWireEnvelope(input: {
  readonly headers: { get(name: string): string | null };
  readonly keys: WireVerificationKeys;
  readonly expected: WireExpectation;
  /** When the request arrived: what the envelope's window is judged against. */
  readonly nowSeconds: number;
  /**
   * The time now, read again just before a nonce is claimed, after the body has been read: the same
   * clock `nowSeconds` was read from. Required when the replay policy is a cache (it throws otherwise,
   * before anything is read). A claim that would come after the cache may have forgotten the nonce is
   * refused as `claim-after-until`.
   */
  readonly clockSeconds?: () => number;
  /** Whatever it returns is ignored; a promise it returns is awaited by nobody and its rejection caught. */
  readonly onRefusal?: (reason: WireRefusalReason) => unknown;
}): Promise<WireVerdict> {
  const refuse = (reason: WireRefusalReason): WireRefused => {
    try {
      // Metrics never decide a verdict, and an async counter that rejects must not crash the isolate.
      void Promise.resolve(input.onRefusal?.(reason)).catch(() => {});
    } catch {
      // A synchronous throw, likewise ignored.
    }
    return WIRE_REFUSED;
  };
  const { expected, keys, nowSeconds } = input;
  const own = PREPARED.get(keys);
  if (!own) throw new TypeError('verifyWireEnvelope takes the key set wireVerificationKeys built');
  const replay = expected.kind === 'call' ? expected.replay : 'none';
  if (replay !== 'none' && typeof (replay as Partial<WireNonceCache> | undefined)?.claim !== 'function') {
    throw new TypeError("a call's expectation states its replay policy: 'none' or a nonce cache");
  }
  // `== null`: an untyped `scopeId: null` pins nothing, so it is the same fault as leaving it out.
  if (replay !== 'none' && expected.scopeId == null) {
    throw new TypeError('a call that keeps nonces pins the scope whose object holds them');
  }
  // The claim clock is the deployment's, like `nowSeconds`; a default would mix an injected clock
  // with the wall clock, so a call that keeps nonces must hand it over, and it is checked here.
  if (replay !== 'none' && typeof input.clockSeconds !== 'function') {
    throw new TypeError('a call that keeps nonces takes a clockSeconds function to time its claim');
  }
  const header = input.headers.get(WIRE_ENVELOPE_HEADER);
  const signature = input.headers.get(WIRE_SIGNATURE_HEADER);
  if (!header || !signature) return refuse('missing');
  const bytes = base64UrlToBytes(header);
  if (!bytes) return refuse('malformed');
  let canonical: string;
  try {
    // Fatal and BOM-keeping, so decoding and re-encoding gives back exactly these bytes.
    canonical = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse('malformed');
  }
  const claims = parseWireEnvelope(canonical);
  if (!claims) return refuse('malformed');
  if (claims.iss !== expected.iss) return refuse('issuer');
  if (claims.kind !== expected.kind) return refuse('kind');
  const publicKey = own[claims.iss].get(claims.kid);
  if (!publicKey) return refuse('kid');
  if (!(await verifyScopeStoreEnvelope(publicKey, canonical, signature))) return refuse('signature');
  if (claims.aud !== expected.aud) return refuse('audience');
  if (!lifetimeAdmitted(claims.iat, claims.exp)) return refuse('lifetime');
  // Negated, so a clock that is not a number fails both instead of passing both.
  if (!(nowSeconds >= claims.iat - WIRE_CLOCK_SKEW_SECONDS)) return refuse('not-yet-valid');
  if (!(nowSeconds <= claims.exp + WIRE_CLOCK_SKEW_SECONDS)) return refuse('expired');
  if (claims.method !== expected.method) return refuse('method');
  if (claims.targetDigest !== (await wireDigest(expected.target))) return refuse('target');
  // The type requires a call's body; an untyped caller that leaves it out, or hands over the null of
  // a body read that failed, is refused, never read as an empty body.
  if (expected.kind === 'call' && (expected.body == null || claims.bodyDigest !== (await wireDigest(expected.body)))) {
    return refuse('body');
  }
  if (expected.tenantId !== undefined && claims.tenantId !== expected.tenantId) return refuse('scope');
  if (expected.scopeId !== undefined && claims.scopeId !== expected.scopeId) return refuse('scope');
  if (replay !== 'none') {
    const until = claims.exp + WIRE_CLOCK_SKEW_SECONDS;
    const claimedAt = input.clockSeconds!();
    // A cache may forget the nonce after `until`, so a claim made later could not see a replay. Its
    // own reason, so a slow body is not counted as one.
    if (!(claimedAt <= until)) return refuse('claim-after-until');
    if ((await replay.claim(claims.nonce, until)) !== true) return refuse('replay');
  }
  return { ok: true, claims };
}
