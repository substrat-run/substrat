/**
 * The SESSION read a vertical mounts — `GET /api/me`: who is signed in here, or why nobody is.
 *
 * Three deployed workers carried this route, each the same four steps in its own words: resolve
 * the signed-in subject, map it to a principal in the routed scope, tell the identity pool what
 * that established (#1670), and — when it bound nobody — say whether the owner seat is waiting to
 * be claimed (#925). They also each picked their own field names, so two of them answered `key`
 * where the third answered `principal`, and a shared header component could not read all three.
 * The route lives here so the answer has one shape, which `@substrat-run/elements`'
 * `<sub-user-menu>` and `<sub-avatar>` read as they are.
 *
 * A vertical supplies only what is its own: how a request resolves to a caller (a vertical that
 * selects among sites resolves the site itself), its directory, and any fields of its own — a
 * role, a capability map — which go beside the standard ones and never replace them.
 *
 * The answers:
 *   - **200 `{ principal, display, email?, …extra }`** — signed in and bound here. `display` is
 *     the issuer's `name`, else `email`, else `You`; never empty. `email` is the issuer's, sent
 *     only when it sent one, verified or not: this is what the header shows, never an identifier
 *     anything is decided on.
 *   - **200 `{ status: 'needs-setup', firstSignInOpen }`** — nobody bound, and the owner seat is
 *     unclaimed. A 200 because it is not a refusal: the app shows "set this up" instead of a
 *     sign-in, and `firstSignInOpen` says whether a plain sign-in still claims the seat or only a
 *     claim link from the dashboard does — the app must not offer a sign-in that binds nobody.
 *   - **401** — nobody bound, seat claimed (or never provisioned here). An `HTTPException`, so
 *     the vertical's own `onError` renders it, as `mountOwnerClaim`'s refusals are.
 */

import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ScopeId, TenantId } from '@substrat-run/contracts';
import type { IdentityStub } from './identity-do.js';
import type { AuthChoice } from './instance-auth.js';
import { observePlace, placesReporter } from './places.js';
import type { AuthSubject } from './provider.js';

/** The fields every signed-in answer carries. */
export interface SessionAnswer {
  principal: string;
  display: string;
  email?: string;
}

/** The standard answer for a bound subject — for a host that answers `/api/me` without the mount. */
export function sessionAnswer(principal: string, subject: Pick<AuthSubject, 'name' | 'email'>): SessionAnswer {
  return {
    principal,
    display: subject.name || subject.email || 'You',
    ...(subject.email ? { email: subject.email } : {}),
  };
}

/** What a request resolved to, as the vertical resolves it. */
export interface ResolvedCaller<N> {
  /** The (tenant, scope) the principal was resolved in — the one the seat is read from. */
  node: N;
  subject: AuthSubject | null;
  /** The principal `subject` is bound to in `node`, or null. */
  principal: string | null;
  /** The delivered identity choice — where the place report goes. Null sends none. */
  identity: AuthChoice | null;
  /**
   * Whether this resolve is a place the identity pool should hear about. Default true; false for
   * a scope the platform does not register as one (a site picked in-app rather than routed).
   */
  place?: boolean;
}

/** A bound caller, as `extra` is told about it. */
export interface SignedIn<N> {
  node: N;
  principal: string;
  subject: AuthSubject;
}

/** What the vertical supplies. `E` is its worker's bindings; `N` what a request resolves to. */
export interface SessionRouteDeps<E extends object, N extends { tenantId: TenantId; scopeId: ScopeId }> {
  /** Who this request is, in which scope. Resolved once; the route reads nothing else for it. */
  caller: (c: Context<{ Bindings: E }>) => Promise<ResolvedCaller<N>>;
  /** The tenant's identity directory — read only for the owner seat, when nobody is bound. */
  directory: (env: E, node: N) => Pick<IdentityStub, 'ownerSeat'>;
  /** The vertical's own fields, beside the standard ones. A standard field of the same name wins. */
  extra?: (c: Context<{ Bindings: E }>, signedIn: SignedIn<N>) => Promise<Record<string, unknown>>;
}

/** Mount `GET /api/me` on a vertical's Hono app. What its deps throw is passed through untouched. */
export function mountSession<E extends object, N extends { tenantId: TenantId; scopeId: ScopeId }>(
  app: Hono<{ Bindings: E }>,
  deps: SessionRouteDeps<E, N>,
): void {
  app.get('/api/me', async (c) => {
    const { node, subject, principal, identity, place = true } = await deps.caller(c);
    // After the response, and it never throws: one request per login per isolate (#1670). Every
    // screen asks this route first, so this is what catches every way a binding is made — the
    // owner's first sign-in, a claim link, an accepted invite.
    if (subject && place) {
      c.executionCtx.waitUntil(observePlace(placesReporter({ identity }), node.scopeId, subject.sub, principal));
    }
    if (!principal || !subject) {
      const seat = await deps.directory(c.env, node).ownerSeat(node.scopeId);
      if (seat.state === 'unclaimed') {
        return c.json({ status: 'needs-setup' as const, firstSignInOpen: seat.firstSignIn?.open ?? false });
      }
      throw new HTTPException(401, { message: 'unauthorized' });
    }
    const own = deps.extra ? await deps.extra(c, { node, principal, subject }) : {};
    return c.json({ ...own, ...sessionAnswer(principal, subject) });
  });
}
