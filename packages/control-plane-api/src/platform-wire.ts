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

/**
 * The tenant and scope a call names itself: its JSON body's top-level `tenantId` and `scopeId`,
 * else its query's, both or neither, each one ULID. The envelope names the pair (RFC §3.1: with the
 * scope, or neither), and a call that changes state spends its nonce in that scope (§4). A call that
 * names only a scope, or nothing, is signed naming neither: where its nonce is spent is follow-on 5's
 * to decide.
 */
export function platformCallScope(request: Request, body: ArrayBuffer | undefined): { tenantId: string; scopeId: string } | null {
  const pair = (tenantId: unknown, scopeId: unknown) =>
    typeof tenantId === 'string' && typeof scopeId === 'string' && ULID_PATTERN.test(tenantId) && ULID_PATTERN.test(scopeId)
      ? { tenantId, scopeId }
      : null;
  if (body !== undefined && body.byteLength > 0 && !BYTES.test(request.headers.get('content-type') ?? '')) {
    try {
      const json: unknown = JSON.parse(new TextDecoder().decode(body));
      if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
        const named = pair(Reflect.get(json, 'tenantId'), Reflect.get(json, 'scopeId'));
        if (named) return named;
      }
    } catch {
      // Not JSON: it names nothing in its body.
    }
  }
  const query = new URL(request.url).searchParams;
  return pair(query.get('tenantId'), query.get('scopeId'));
}

/**
 * A call whose body is sent as it is read (a streamed attachment, #2498): binding it would mean
 * holding all of it, which is what streaming it exists to avoid, so version 1 does not sign it
 * (RFC §3.6, Q5).
 */
const streamed = (init: RequestInit | undefined) => typeof (init?.body as { getReader?: unknown } | null | undefined)?.getReader === 'function';

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
    if (streamed(init)) {
      count('skipped', 'stream');
      return send(input, init);
    }
    const result = await signer(new Request(input, init), { iss: 'platform', kind: 'call', aud }, platformCallScope);
    count(result.outcome, result.outcome === 'failed' ? result.reason : undefined);
    return send(result.request);
  }) as typeof fetch;
}
