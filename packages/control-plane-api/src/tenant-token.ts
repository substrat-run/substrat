import { tenantId as tenantIdSchema, type PlatformActorId, type TenantId } from '@substrat-run/contracts';
import { SERVICE_TOKEN_HEADER, type TenantServiceAuth } from './auth.js';
import { hasTokenPrefix, openToken, signToken } from './token-codec.js';

/**
 * Tenant tokens — the dashboard's tenant-scoped service credential (#977).
 *
 * The dashboard reached the shared control plane over the platform `SERVICE_TOKEN`,
 * which authenticates as `{ kind: 'staff' }` and has FLEET-WIDE reach. Its narrowing to
 * one tenant was a constructor argument in the dashboard's own worker
 * (`TenantNarrowedControlPlane`) plus a caller-asserted `x-substrat-tenant` header the
 * plane read only for slug resolution. So the narrowing was the dashboard's promise
 * about itself, not a property of the credential: one wrong tenant id at any of its
 * ~90 call sites reached another customer's data with a staff-level token and nothing
 * server-side to refuse it. That is the vulnerability this closes.
 *
 * A tenant token is the same stateless shape push tokens already establish
 * (`push-token.ts`), with a different claim and a different meaning:
 *
 *   `stt1.<b64url payload>.<b64url HMAC-SHA256 sig>`
 *
 * It authenticates as `{ kind: 'tenant' }` — staff-equivalent CAPABILITY, confined to
 * ONE tenant, which is what a dashboard actually needs. The confinement is enforced by
 * the control plane (`createControlPlaneApi`'s allowlist + pin middleware), so a
 * dashboard bug cannot spend it outside its tenant however it asks.
 *
 * **The claim carries no actor, deliberately.** Who a row is audited as stays the
 * host's decision (`tenantTokenAuth(secret, actor)`, exactly as `serviceTokenAuth`
 * takes it), so a minted token can never name its own audit subject — and the audit
 * row keeps naming what it named before this existed. Making the audit row carry the
 * customer's own `PrincipalId` is the SECOND half of #977 and is deliberately not
 * here: it makes `PlatformActorId` stop being the type of an audit actor, which is
 * kernel-facing and gets its own diff and its own review.
 *
 * **A dedicated secret**, never `pushTokenSecret` and never `PLATFORM_SECRET`. A
 * shared signing key would make a compromised CI push token and a compromised
 * dashboard credential the same incident: whoever holds the key mints either class,
 * and rotating to contain one revokes the other. `PLATFORM_SECRET` is worse still —
 * it is injected into every pushed vertical, so any customer's code could mint a
 * credential for any tenant. Rotating the dedicated secret invalidates every issued
 * tenant token at once (the dashboard re-mints on its next request, so that is a blip
 * rather than an outage) — which is the whole revocation story in v1.
 *
 * Presented in the SAME `x-service-token` header, discriminated by the `stt1.` prefix.
 * A collision is not a risk to reason about: the platform service token is random hex
 * and a push token starts `spt1.`, so no other credential this plane accepts can begin
 * `stt1.`, and the prefix is inside the signed input (`token-codec.ts`) so a push
 * token's payload cannot be replayed as a tenant token even under an equal secret.
 */

const PREFIX = 'stt1';

interface TenantTokenClaim {
  v: 1;
  tenantId: string;
  /** Informational — no expiry in v1, exactly as push tokens have none. */
  iat: number;
}

/**
 * Mint a tenant token.
 *
 * The tenant NEED NOT EXIST in the directory yet, and the claim deliberately carries
 * no slug. Both follow from the same fact: a tenant token narrows WHOSE rows a caller
 * may touch, and a tenant with no rows is narrowed to nothing. What such a credential
 * can do is create the directory row for its own id — `POST /tenants` is body-pinned
 * to the same tenant — which is precisely the sign-up bootstrap dashboard.md §4 names
 * as the one act that cannot be tenant-narrowed, because there is no tenant yet.
 * Requiring the row here would break it: the dashboard's first call for a new team IS
 * `ensureTenant`, and a mint that 404s first makes that unreachable.
 *
 * A slug would also be a staleness hazard rather than a saving: the only thing that
 * reads one is the builder's bare-slug prefixing (#417), and a tenant principal
 * resolves a slug through the `x-substrat-tenant` header the plane already pins.
 */
export async function mintTenantToken(secret: string, identity: { tenantId: TenantId }): Promise<string> {
  const claim: TenantTokenClaim = { v: 1, tenantId: identity.tenantId, iat: Date.now() };
  return signToken(PREFIX, secret, claim);
}

/** Verify a tenant token string → its claim, or null (bad prefix/shape/signature). */
export async function verifyTenantToken(secret: string, token: string): Promise<TenantTokenClaim | null> {
  const opened = await openToken(PREFIX, secret, token);
  if (opened === null) return null;
  try {
    const claim = opened as TenantTokenClaim;
    if (claim.v !== 1) return null;
    // Parse, don't trust: the signature proves WE minted it, the parse proves the
    // fields are still the ones a pin is made of (a format bump fails closed).
    tenantIdSchema.parse(claim.tenantId);
    return claim;
  } catch {
    return null;
  }
}

/**
 * A `TenantServiceAuth` over tenant tokens: reads `x-service-token`, handles only
 * `stt1.…` values (anything else → null, so every other reader is untouched), verifies,
 * and returns the tenant the token is pinned to.
 *
 * `actor` is the audited subject the HOST supplies — the same fixed service actor a
 * platform service token already resolves to. It is NOT read from the token, for the
 * reason the module docblock gives.
 */
export function tenantTokenAuth(secret: string, actor: PlatformActorId): TenantServiceAuth {
  return async (request) => {
    const presented = request.headers.get(SERVICE_TOKEN_HEADER);
    if (!presented || !hasTokenPrefix(PREFIX, presented)) return null;
    const claim = await verifyTenantToken(secret, presented);
    if (!claim) return null;
    return { actor, tenantId: tenantIdSchema.parse(claim.tenantId) };
  };
}
