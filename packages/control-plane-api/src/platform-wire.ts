/**
 * The control plane's wire signer (RFC wire-signing §5, §9 step 2): a `call` envelope, issuer
 * `platform`, on every call the control plane makes to a deployment, beside the legacy header,
 * which stays. Off by default: while the control plane's `sign` flag is off, the `fetch` a client is
 * given is the very one it would have had, and every call goes out exactly as it did before signing
 * existed.
 */
import { ULID_PATTERN } from '@substrat-run/contracts';
import { wireSignerOf, type WireSignResult } from '@substrat-run/contracts/wire-signing';

/** The control plane's own signing settings, as its env holds them. */
export interface PlatformWireSettings {
  /** The `sign` flag: `on`, or off. */
  readonly sign?: string;
  /** The issuer `platform` private key, PKCS8 Ed25519, base64url. */
  readonly key?: string;
  /** Where the signer's count goes, one line per call. `console.log` unless a test injects one. */
  readonly log?: (line: string) => void;
}

/** Bodies that are bytes rather than JSON (a multipart attachment, an octet stream) name no scope. */
const BYTES = /^(multipart\/|application\/octet-stream)/i;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const OPENS = new Set([OPEN_OBJECT, 0x5b]);
const CLOSES = new Set([0x7d, 0x5d]);
const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
/** A ULID's length in bytes: a string value of any other length is not one, and is never decoded. */
const ULID_BYTES = 26;
const NAMED = [
  ['tenantId', new TextEncoder().encode('tenantId')],
  ['scopeId', new TextEncoder().encode('scopeId')],
] as const;

/**
 * The top-level `tenantId` and `scopeId` of a JSON object, read from its UTF-8 bytes in one walk
 * that decodes and parses nothing: it tracks depth, strings and their escapes, compares a top-level
 * key's bytes with the two names, decodes a value only when it is a string of a ULID's length, and
 * stops once both keys are seen. So a call's body, a copy or restore page of several MiB included,
 * is never held a second time as a string or an object graph to name its scope. A key with a value
 * that is not a string reads as `null`.
 *
 * It reads what `JSON.parse` would for every body the control plane sends, which `JSON.stringify`
 * writes: no key twice, and no key's letters escaped. It does not validate the rest of the body, so a
 * malformed one can name a pair a parse would refuse; the control plane writes none.
 *
 * So it assumes a body `JSON.stringify` wrote from an object the platform built: on a key repeated
 * after both are seen the first wins, and a BOM or an escaped key is not read as a parse reads it. A
 * caller that forwards raw bytes from outside the platform must not use it unchanged.
 */
export function topLevelIds(bytes: Uint8Array): { tenantId?: unknown; scopeId?: unknown } {
  const found: { tenantId?: unknown; scopeId?: unknown } = {};
  let i = 0;
  while (i < bytes.length && SPACE.has(bytes[i]!)) i++;
  if (bytes[i] !== OPEN_OBJECT) return found;
  let depth = 0;
  let expectKey = false;
  // The name whose value comes next, at depth 1: one of the two, or '' for any other key.
  let pending: 'tenantId' | 'scopeId' | '' | null = null;
  const settle = (value: unknown) => {
    if (pending) found[pending] = value;
    pending = null;
    return 'tenantId' in found && 'scopeId' in found;
  };
  for (; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === QUOTE) {
      const start = i + 1;
      i = start;
      while (i < bytes.length && bytes[i] !== QUOTE) i += bytes[i] === BACKSLASH ? 2 : 1;
      if (i >= bytes.length) return found;
      // A string below the top level meets neither branch: a key is expected, and a value pending,
      // only at depth 1, and a nested value settles what was pending as it opens.
      if (expectKey) {
        expectKey = false;
        pending = NAMED.find(([, name]) => name.length === i - start && name.every((c, k) => bytes[start + k] === c))?.[0] ?? '';
      } else if (pending !== null) {
        const text = i - start === ULID_BYTES ? new TextDecoder().decode(bytes.subarray(start, i)) : null;
        if (settle(text)) return found;
      }
    } else if (OPENS.has(b)) {
      // Only ever pending at depth 1, so a nested value settles the top-level key it is the value of.
      if (pending !== null && settle(null)) return found;
      depth++;
      if (depth === 1) expectKey = true;
    } else if (CLOSES.has(b)) {
      depth--;
      if (depth === 0) return found;
    } else if (depth === 1) {
      if (b === COMMA) expectKey = true;
      // A number, `true`, `false` or `null`: a value that is not a string.
      else if (b !== COLON && !SPACE.has(b) && pending !== null && settle(null)) return found;
    }
  }
  return found;
}

/**
 * The tenant and scope a call names itself: its JSON body's top-level `tenantId` and `scopeId`
 * ({@link topLevelIds}), else its query's, both or neither, each one ULID. The envelope names the pair
 * (RFC §3.1: with the scope, or neither), and a call that changes state spends its nonce in that
 * scope (§4). A call that names only a scope, or nothing, is signed naming neither: where its nonce
 * is spent is follow-on 5's to decide.
 */
export function platformCallScope(request: Request, body: ArrayBuffer | undefined): { tenantId: string; scopeId: string } | null {
  const pair = (tenantId: unknown, scopeId: unknown) =>
    typeof tenantId === 'string' && typeof scopeId === 'string' && ULID_PATTERN.test(tenantId) && ULID_PATTERN.test(scopeId)
      ? { tenantId, scopeId }
      : null;
  if (body !== undefined && body.byteLength > 0 && !BYTES.test(request.headers.get('content-type') ?? '')) {
    const named = topLevelIds(new Uint8Array(body));
    const fromBody = pair(named.tenantId, named.scopeId);
    if (fromBody) return fromBody;
  }
  const query = new URL(request.url).searchParams;
  return pair(query.get('tenantId'), query.get('scopeId'));
}

/** A body sent as it is read rather than held. */
const isStream = (body: unknown) =>
  body instanceof ReadableStream || typeof (body as { getReader?: unknown } | null | undefined)?.getReader === 'function';

/**
 * A call whose body is sent as it is read (a streamed attachment, #2498): binding it would mean
 * holding all of it, which is what streaming it exists to avoid, so version 1 does not sign it
 * (RFC §3.6, Q5). Judged on the body the call would send, whatever its call style: `init.body` when
 * it gives one, else (a null `init.body` keeps it, as the Request constructor reads it) the body of a
 * `Request` handed whole, which is a stream whatever it was built from, so it is never read to be
 * bound either. Every client call today passes a URL and an `init`.
 */
function streamed(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (init?.body != null) return isStream(init.body);
  return input instanceof Request && input.body !== null;
}

/**
 * The `fetch` a client for the deployment the dispatch namespace knows as `aud` is given: `send`
 * itself while the flag is off; on, `send` behind the signer, so every call, a retry included, is
 * signed afresh for that deployment (RFC §4). The caller builds it for the same name it makes the
 * dispatch stub from, so the envelope always names the script the call reaches. A signer that cannot
 * sign never fails the call: it goes with its legacy header and its whole body, and the line says
 * why, never a key. A streamed call is not signed and its body is not read: it goes exactly as
 * given, counted `skipped`, which is a decision, not a failure.
 */
export function platformSignedFetch(settings: PlatformWireSettings, aud: string, send: typeof fetch): typeof fetch {
  const signer = wireSignerOf(settings);
  if (!signer) return send;
  const log = settings.log ?? ((line: string) => console.log(line));
  const count = (outcome: WireSignResult['outcome'] | 'skipped', reason?: string) =>
    log(JSON.stringify({ substrat: 'wire-sign', issuer: 'platform', aud, outcome, ...(reason ? { reason } : {}) }));
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (streamed(input, init)) {
      count('skipped', 'stream');
      return send(input, init);
    }
    const result = await signer(new Request(input, init), { iss: 'platform', kind: 'call', aud }, platformCallScope);
    count(result.outcome, result.outcome === 'failed' ? result.reason : undefined);
    return send(result.request);
  }) as typeof fetch;
}
