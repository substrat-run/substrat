/**
 * The OWNER CLAIM redemption a vertical mounts — `POST /api/claim-owner` (#925, #1686).
 *
 * Four demo workers carried this route verbatim: resolve who is signing in, hash the presented
 * token, ask the identity directory to bind, and answer one refusal for every failure. Since
 * #1686 a claim link is a `become` capability, and redeeming one is an exchange in the scope's
 * own Durable Object followed by a bind in the identity directory — two calls in the right order,
 * which is the kind of thing that should be written once. So the route lives here, and a
 * vertical supplies only what is its own: how a request resolves to a scope, its auth provider,
 * its directory and host, and anything it does once the owner is seated.
 *
 * What a redemption checks, in order, each step failing closed:
 *   1. **Somebody is signed in.** Before anything is read, so a signed-out visitor never spends
 *      the link — they sign in and open it again.
 *   2. **The secret is the scope's current link** (`ownerClaimMatches`, by hash). A stale link,
 *      or a `become` capability minted for something else, is refused here WITHOUT taking its use.
 *   3. **The scope exchanges it** — the capability's expiry, revocation and single use are judged
 *      by the scope's directory, atomically, and the exchange is on the spine as
 *      `capability.exercised` with the capability as its actor.
 *   4. **The directory binds** the signed-in subject to the principal the capability became,
 *      only if that capability is still the recorded link and names the pending owner.
 *
 * Every refusal after step 1 is the same 400, so a probe learns nothing about which step said no.
 * A token that is not a capability secret at all gets it too: the hash-only links #925 minted
 * before #1686 are no longer redeemed — every one of them expired `OWNER_CLAIM_TTL_MS` after it
 * was minted, and the release after #1686 has long shipped.
 */

import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z, type CapabilityExchange, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { redeemBecomeLink } from './become-link.js';
import type { IdentityStub } from './identity-do.js';
import type { AuthProvider, AuthSubject } from './provider.js';
import { bodyOf } from './request-body.js';

/** The slice of the identity directory the redemption touches. */
export type OwnerClaimDirectory = Pick<IdentityStub, 'ownerClaimMatches' | 'claimOwnerByCapability'>;

/** What the redemption needs of the scope host: the exchange, asked for a `become` capability only. */
export interface OwnerClaimExchangeHost {
  exchangeCapability(
    tenantId: TenantId,
    scopeId: ScopeId,
    secret: string,
    options?: { mode?: 'act' | 'become' },
  ): Promise<CapabilityExchange | null>;
}

/** The body `POST /api/claim-owner` takes. */
export const claimOwnerBody = z.object({ token: z.string().min(1) });

/** A seated owner, as `onClaimed` is told about it. */
export interface OwnerClaimed<N> {
  node: N;
  principal: string;
  subject: AuthSubject;
}

/** What the vertical supplies. `E` is its worker's bindings; `N` what a request resolves to. */
export interface OwnerClaimRouteDeps<E extends object, N extends { tenantId: TenantId; scopeId: ScopeId }> {
  /** The (tenant, scope) this request addresses — behind the router, from the assertion. */
  nodeFor: (req: Request, env: E) => N | Promise<N>;
  /** The configured `AuthProvider` — who is claiming. Resolved per request, as the vertical does. */
  authProvider: (env: E, req: Request) => Promise<AuthProvider>;
  /** The tenant's identity directory — the owner seat and the sub → principal binding. */
  directory: (env: E, node: N) => OwnerClaimDirectory;
  /** The scope host — where the claim link's capability lives. */
  host: (env: E) => OwnerClaimExchangeHost;
  /**
   * What the vertical calls the thing being claimed, for the signed-out refusal: "sign in
   * before claiming this <noun>". Defaults to `workspace`.
   */
  noun?: string;
  /**
   * Run once the owner is seated, before the answer — a support desk records its first colleague
   * here. A throw is the vertical's error to shape; the seat is already bound by then.
   */
  onClaimed?: (c: Context<{ Bindings: E }>, claimed: OwnerClaimed<N>) => Promise<void>;
}

/** The ONE refusal every invalid, expired, used, revoked or stale link gets. */
const REFUSED = 'this claim link is invalid, expired, or already used';

/**
 * Mount `POST /api/claim-owner` → `{ ok: true, principal }` on a vertical's Hono app. 401 for
 * nobody signed in, 400 for a body that is not `{ token }` (`bodyOf`, as the invite routes) and
 * for every refused link. Errors the route raises itself are `HTTPException`s, so the vertical's
 * own `onError` renders them; what its deps throw is passed through untouched.
 */
export function mountOwnerClaim<E extends object, N extends { tenantId: TenantId; scopeId: ScopeId }>(
  app: Hono<{ Bindings: E }>,
  deps: OwnerClaimRouteDeps<E, N>,
): void {
  app.post('/api/claim-owner', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    const subject = await (await deps.authProvider(c.env, c.req.raw)).resolve(c.req.raw.headers);
    if (!subject) {
      throw new HTTPException(401, { message: `sign in before claiming this ${deps.noun ?? 'workspace'}` });
    }
    const { token } = await bodyOf(c, claimOwnerBody);
    const directory = deps.directory(c.env, node);
    const principal = await redeemBecomeLink(
      {
        matches: (hash) => directory.ownerClaimMatches(node.scopeId, hash),
        exchange: (secret) => deps.host(c.env).exchangeCapability(node.tenantId, node.scopeId, secret, { mode: 'become' }),
        bind: (id, owner) => directory.claimOwnerByCapability(node.scopeId, subject.sub, id, owner),
      },
      token,
    );
    if (!principal) throw new HTTPException(400, { message: REFUSED });
    await deps.onClaimed?.(c, { node, principal, subject });
    return c.json({ ok: true, principal });
  });
}
