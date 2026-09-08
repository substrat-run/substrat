/**
 * The signed state of a PLATFORM-MINTED provider consent round (connections.md §3.5.3).
 *
 * §3.5.1 settled how an OAuth connection is authorized: the act originates in-scope, a
 * signed state token carries the proof, and the host-side callback effects the write
 * stamped with the principal from that state. The dashboard's connect link is one
 * instance of it. This is the second: a tenant admin working inside a VERTICAL — a
 * bookkeeping bureau connecting a client company, with no dashboard account and no
 * reason to have one — presses Connect on the vertical's own screen, and the vertical's
 * operation is the permission-checked act.
 *
 * **Why this claim carries no link row.** The dashboard's connect link is minted, mailed,
 * and clicked days later by someone else, so it is a row: single-use, revocable, and dead
 * when the minting admin loses access. A vertical-minted round is clicked in-session by
 * the person who just pressed the button, so the row would be state nobody reads. What
 * replaces it is the expiry — minutes, not a week — and the account leg of the connection
 * key: a replayed round re-consents the SAME company, which the store rotates in place
 * rather than duplicating (#1267). The consent code itself is single-use at the provider.
 *
 * **Why the kernel.** Two workers hold the halves — the control plane mints (it owns the
 * directory the vertical is re-derived from), the dashboard verifies (it owns the one
 * `redirect_uri` registered with the provider) — and a MAC that two deployments must agree
 * on is exactly the thing that must not be written twice. It sits beside `platform-call.ts`
 * for the same reason that does: both answer "did this really come from the platform".
 *
 * Web Crypto only, so this file is testable in Node and runs unchanged in workerd.
 */

/** Thrown when a claim cannot be minted — never when one fails to verify (that is `null`). */
export class ConnectStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectStateError';
  }
}

/**
 * The purpose label, and the `:v1` is the key-derivation version. Signing key is
 * HKDF(PLATFORM_SECRET, info = this), so a token minted here can never verify anywhere
 * else the platform secret is presented — `/internal/provision` and the two relays
 * compare the secret raw, and a MAC family shared with them would let a signature minted
 * for one be replayed as the other wherever the shapes overlap (the same trap #968 fixed
 * inside the dashboard).
 */
export const CONNECT_STATE_PURPOSE = 'substrat-platform:connect-state:v1';

/**
 * What a platform-minted consent round proves. Every field is decided by the control
 * plane from its own directory — never taken from the caller — except `subjectRef`,
 * which is opaque to the platform by design (see below).
 */
export interface ConnectStateClaim {
  /** The tenant the connection lands under. */
  tenantId: string;
  /**
   * The VERTICAL's scope. The callback upserts against this, and the connection store
   * re-derives the vertical from it a second time — so a claim cannot plant a
   * credential on a vertical other than the one that asked for the round.
   */
  scopeId: string;
  /** The vertical slug, as the directory had it at mint. Carried for the log, not for trust. */
  vertical: string;
  /** Provider slug (`fortnox`). */
  provider: string;
  /**
   * The tenant principal whose in-scope `ctx.check` authorized the round — stamped on
   * the connection as `createdBy`, exactly as §3.5.1 requires. Not a dashboard member.
   */
  principal: string;
  /** Where the browser is sent when the round settles; validated against the scope's own hostnames at mint. */
  returnUrl?: string;
  /**
   * The vertical's OWN name for what is being connected — its client row's id. Opaque to
   * the platform, which never parses, stores, or acts on it; it is echoed back on the
   * return so a bureau holding two hundred outstanding rounds can attribute the one that
   * just landed without waiting to match on an organisation number.
   */
  subjectRef?: string;
  /** Epoch ms. */
  exp: number;
}

// Web Crypto and the base64/text globals are present in Node >= 18, Workers and
// browsers alike. Declared locally, exactly as `secret-box.ts` does, so the kernel
// pulls in no platform lib and never a node-only import.
interface CryptoKeyLike {
  readonly type: string;
}
declare const crypto: {
  subtle: {
    importKey(
      format: 'raw',
      keyData: Uint8Array,
      algorithm: string,
      extractable: boolean,
      usages: string[],
    ): Promise<CryptoKeyLike>;
    deriveKey(
      algorithm: { name: 'HKDF'; hash: 'SHA-256'; salt: Uint8Array; info: Uint8Array },
      baseKey: CryptoKeyLike,
      derived: { name: 'HMAC'; hash: 'SHA-256'; length: number },
      extractable: boolean,
      usages: string[],
    ): Promise<CryptoKeyLike>;
    sign(algorithm: 'HMAC', key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
    verify(algorithm: 'HMAC', key: CryptoKeyLike, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new () => { decode(input: Uint8Array): string };
declare const btoa: (input: string) => string;
declare const atob: (input: string) => string;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlToBytes = (s: string): Uint8Array => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** HKDF-SHA-256(ikm = the platform secret, info = the purpose) → an HMAC-SHA-256 key. */
async function stateKey(platformSecret: string): Promise<CryptoKeyLike> {
  const ikm = await crypto.subtle.importKey('raw', enc(platformSecret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc('substrat-platform'), info: enc(CONNECT_STATE_PURPOSE) },
    ikm,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

/**
 * `<base64url(JSON claim)>.<base64url(HMAC)>`.
 *
 * Refuses an unset secret rather than signing with `''` — the same law
 * `assertPlatformCall` states: an unset secret is a failure, not a bypass. A token
 * signed under the empty string would verify for anyone who guessed that it was.
 */
export async function signConnectState(platformSecret: string, claim: ConnectStateClaim): Promise<string> {
  if (!platformSecret) {
    throw new ConnectStateError('cannot mint a connect state: PLATFORM_SECRET is unset on this deployment');
  }
  const body = b64url(enc(JSON.stringify(claim)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await stateKey(platformSecret), enc(body)));
  return `${body}.${b64url(sig)}`;
}

/**
 * The claim if the signature verifies under this deployment's platform secret and `exp`
 * is still ahead of `now`; `null` for everything else — a forgery, a token minted with
 * the raw secret, an expired round, a malformed string. One `null` for every failure on
 * purpose: the caller renders one refusal, and a distinguishable error is an oracle.
 *
 * An unset secret verifies nothing (never throws): a deployment holding no platform
 * secret has no platform-minted rounds to accept.
 */
export async function verifyConnectState(
  platformSecret: string | undefined,
  token: string,
  now: number,
): Promise<ConnectStateClaim | null> {
  if (!platformSecret || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await stateKey(platformSecret), b64urlToBytes(sig), enc(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const claim = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as ConnectStateClaim;
    if (typeof claim.exp !== 'number' || claim.exp <= now) return null;
    // A verified signature proves the platform minted it; it does not prove the shape,
    // and a claim missing one of these would reach the store as `undefined` — which is
    // how a credential lands under the wrong key rather than not at all.
    for (const field of ['tenantId', 'scopeId', 'vertical', 'provider', 'principal'] as const) {
      if (typeof claim[field] !== 'string' || !claim[field]) return null;
    }
    return claim;
  } catch {
    return null;
  }
}
