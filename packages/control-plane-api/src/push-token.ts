import { platformActorId, tenantId as tenantIdSchema, type TenantId } from '@substrat-run/contracts';
import { SERVICE_TOKEN_HEADER, type BuilderAuth, type BuilderIdentity } from './auth.js';

/**
 * Tenant-scoped push tokens — the CI credential the builder plane was missing.
 *
 * A builder's OIDC session (builder-auth in the worker) is per-human and short-lived;
 * the platform `SERVICE_TOKEN` is staff-equivalent and must never land in a customer
 * repo. A push token sits between: a long-lived MACHINE credential that authenticates
 * as a **builder principal** for ONE tenant — so it reaches only the builder-allowlisted
 * routes, only that tenant's `<tenantSlug>/…` namespace, and never prod promotion or
 * admission (those checks live in api.ts and apply to every builder alike).
 *
 * Format: `spt1.<b64url payload>.<b64url HMAC-SHA256 sig>` — stateless, verified
 * against a dedicated `pushTokenSecret`. Deliberately NOT the platform secrets:
 * PLATFORM_SECRET is injected into every pushed vertical (a vertical holding the
 * push-token signing key could forge tokens for any tenant), and deriving from
 * SERVICE_TOKEN would tie CI-credential rotation to service-token rotation. Rotating
 * the dedicated secret invalidates every issued push token (customers reconnect) —
 * that is the whole revocation story in v1, so treat it as set-once like the
 * dashboard's SECRET_BOX_KEY and keep it out of routine rotation.
 *
 * The token is presented in the SAME header the CLI already sends its credential in
 * (`x-service-token`, via `SUBSTRAT_SERVICE_TOKEN`), discriminated by the `spt1.`
 * prefix — a random-hex service token can never collide with it, and the CLI and the
 * generated CI workflow need no changes at all.
 */

const PREFIX = 'spt1';

interface PushTokenClaim {
  v: 1;
  tenantId: string;
  tenantSlug: string;
  actor: string;
  iat: number;
}

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

async function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The audited subject for a tenant's CI pushes — deterministic from the tenant, so
 * every push from that tenant's pipelines lands in the admin log under ONE nameable
 * actor (the mirror of builder-auth's `builderActorFor`, which is per-human; CI is
 * per-tenant because the pipeline, not a person, is what authenticated).
 */
export async function pushActorFor(tenantId: TenantId): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', enc.encode(`push-token:${tenantId}`)),
  );
  let s = '';
  for (let i = 0; i < 26; i++) s += CROCKFORD[digest[i]! % 32];
  return platformActorId.parse(s);
}

/** Mint a push token for one tenant. `iat` is informational (no expiry in v1). */
export async function mintPushToken(
  secret: string,
  identity: { actor: string; tenantId: TenantId; tenantSlug: string },
): Promise<string> {
  const claim: PushTokenClaim = {
    v: 1,
    tenantId: identity.tenantId,
    tenantSlug: identity.tenantSlug,
    actor: identity.actor,
    iat: Date.now(),
  };
  const payload = b64url(enc.encode(JSON.stringify(claim)));
  const signingInput = `${PREFIX}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

/** Verify a push token string → its claim, or null (bad prefix/shape/signature). */
export async function verifyPushToken(secret: string, token: string): Promise<PushTokenClaim | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, sig] = parts as [string, string, string];
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      b64urlToBytes(sig),
      enc.encode(`${PREFIX}.${payload}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const claim = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as PushTokenClaim;
    if (claim.v !== 1) return null;
    // Parse, don't trust — the signature proves WE minted it, the parse proves the
    // fields still are what a BuilderIdentity needs (a future format bump fails closed).
    tenantIdSchema.parse(claim.tenantId);
    platformActorId.parse(claim.actor);
    if (typeof claim.tenantSlug !== 'string' || !claim.tenantSlug) return null;
    return claim;
  } catch {
    return null;
  }
}

/**
 * A `BuilderAuth` over push tokens: reads `x-service-token`, handles only `spt1.…`
 * values (anything else → null, falling through to the other readers), verifies, and
 * returns the builder principal the token carries. Compose with the OIDC reader via
 * `firstBuilderAuth`.
 */
export function pushTokenBuilderAuth(secret: string): BuilderAuth {
  return async (request): Promise<BuilderIdentity | null> => {
    const presented = request.headers.get(SERVICE_TOKEN_HEADER);
    if (!presented || !presented.startsWith(`${PREFIX}.`)) return null;
    const claim = await verifyPushToken(secret, presented);
    if (!claim) return null;
    return {
      actor: platformActorId.parse(claim.actor),
      tenantId: tenantIdSchema.parse(claim.tenantId),
      tenantSlug: claim.tenantSlug,
    };
  };
}
