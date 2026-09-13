/**
 * The MEMBER INVITE routes a vertical mounts — the post-setup join path (#1150).
 *
 * Three demo workers carried these four routes verbatim: list the open invites, create
 * one, revoke one, and accept one. The copies agreed byte-for-byte on the parts that
 * matter — the token shape, that only its HASH is stored, that the role is granted BEFORE
 * the invite is recorded, the status codes and the messages — and nothing but a diff held
 * them in step. So the routes live here once, and a vertical supplies only what is its own:
 * how a request resolves to a scope, who counts as an admin, which roles a teammate may be
 * invited at, and the host that grants the role.
 *
 * What an invite IS does not change by moving here. Creating one pre-mints a member
 * principal, grants it the chosen role at scope level (a real grant — the principal can
 * act the moment somebody binds to it), and records the invite in the tenant's identity
 * directory keyed by the token's SHA-256; the plaintext token rides only in the returned
 * accept link. Accepting binds the invitee's verified subject to that pre-minted principal,
 * and the directory then resolves them as that member. Revoking removes the invite row;
 * the scope-level grant on a principal nobody was ever bound to is inert.
 *
 * Deliberately NOT here: the dashboard-side members view over an installed vertical's
 * directory — that widens the platform's reach into a vertical's identity and is a
 * separate decision — and the richer invite a support desk runs (contact-bound roles,
 * staff profiles), which is a different flow rather than this one with more fields.
 */

import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, z, type PrincipalId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { IdentityStub } from './identity-do.js';
import { claimToken, invitePath, sha256Hex } from './owner-claim-link.js';
import type { AuthProvider } from './provider.js';

/** The slice of the identity directory the invite routes touch. */
export type InviteDirectory = Pick<IdentityStub, 'listInvites' | 'createInvite' | 'revokeInvite' | 'claimInvite'>;

/** The body `POST /api/invites` takes. */
export const inviteBody = z.object({
  email: z.string().email().optional(),
  /** One of the vertical's roles — validated against `roles` below. */
  roleKey: z.string().min(1),
});

/** The body `POST /api/accept-invite` takes. */
export const acceptInviteBody = z.object({ token: z.string().min(1) });

/**
 * What the vertical supplies. `E` is its worker's bindings; `N` is whatever it resolves a
 * request to — the routes only read `scopeId` off it, and hand the whole node back to
 * `directory`, so a vertical whose node carries more (a tenant, a site) loses nothing.
 */
export interface InviteRouteDeps<E extends object, N extends { scopeId: string }> {
  /** The (tenant, scope) this request addresses — behind the router, from the assertion. */
  nodeFor: (req: Request, env: E) => N | Promise<N>;
  /**
   * Gate the three admin routes: throw 401 for nobody, 403 for a caller who may not manage
   * members. The vertical decides what "admin" means — a role, a permission, a whoami.
   */
  requireAdmin: (c: Context<{ Bindings: E }>) => Promise<unknown>;
  /** The role keys a teammate may be invited at — the vertical's own ROLES. */
  roles: readonly string[];
  /** The tenant's identity directory — the invite rows and the sub → principal binding. */
  directory: (env: E, node: N) => InviteDirectory;
  /** Grant the pre-minted principal its role at scope level — the host's `assignScopeRole`. */
  assignScopeRole: (env: E, scopeId: N['scopeId'], principal: PrincipalId, roleKey: string) => Promise<void>;
  /**
   * Take that grant back — the host's `revokeScopeRole`. The grant and the invite row live
   * in two different Durable Objects, so the create has no transaction across them: when
   * the row cannot be written after the role was granted, this is what puts the scope back
   * where it was, rather than leaving a principal nobody can ever bind to holding a role.
   */
  revokeScopeRole: (env: E, scopeId: N['scopeId'], principal: PrincipalId, roleKey: string) => Promise<unknown>;
  /** The configured `AuthProvider` — who is accepting. Resolved per request, as the vertical does. */
  authProvider: (env: E, req: Request) => Promise<AuthProvider>;
  /**
   * The origin the accept link is built on. Defaults to the request's own. A trailing
   * slash is tolerated — `mintOwnerClaimLink` strips one the same way — so a vertical that
   * hands over a configured `https://host/` does not send invitees to `https://host//`.
   */
  origin?: (req: Request) => string;
}

/**
 * The request body, parsed against the route's schema — or a 400 that names what was
 * wrong. Both failure shapes are turned into an `HTTPException` here so the promise
 * `mountInviteRoutes` makes holds: a body that is not JSON would otherwise surface as the
 * `SyntaxError` `c.req.json()` throws (a 500 under any `onError` that does not know it),
 * and a body that does not fit the schema as a `ZodError` the vertical would have to map
 * itself. The issue list is written into the message rather than a structured body
 * because the vertical's own envelope decides the body shape, and a message is the one
 * thing every envelope carries through.
 */
async function bodyOf<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'the request body must be JSON' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new HTTPException(400, { message: `invalid request body — ${issues}` });
  }
  return parsed.data;
}

/**
 * Mount the four invite routes on a vertical's Hono app:
 *
 *   GET  /api/invites                    → { roles, invites }            (admin)
 *   POST /api/invites                    → 201 { principal, roleKey, email, acceptUrl } (admin)
 *   POST /api/invites/:principal/revoke  → 204                           (admin)
 *   POST /api/accept-invite              → { ok: true, principal }       (any signed-in subject)
 *
 * Every error these routes raise themselves is an `HTTPException` — a body that is not
 * JSON or does not fit its schema included, which `bodyOf` turns into a 400 rather than
 * letting a `SyntaxError` or `ZodError` out — so the vertical's own `onError`, or the
 * envelope `mountPlatformSurface` installs, renders them exactly as it renders its own,
 * and needs no branch for this mount. What the vertical's OWN deps throw (`requireAdmin`,
 * the directory, the host) is passed through untouched: those are its errors to shape.
 */
export function mountInviteRoutes<E extends object, N extends { scopeId: string }>(
  app: Hono<{ Bindings: E }>,
  deps: InviteRouteDeps<E, N>,
): void {
  const originOf = (req: Request): string => (deps.origin?.(req) ?? new URL(req.url).origin).replace(/\/$/, '');

  app.get('/api/invites', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    await deps.requireAdmin(c);
    return c.json({ roles: [...deps.roles], invites: await deps.directory(c.env, node).listInvites(node.scopeId) });
  });

  app.post('/api/invites', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    await deps.requireAdmin(c);
    const { email, roleKey } = await bodyOf(c, inviteBody);
    if (!deps.roles.includes(roleKey)) throw new HTTPException(400, { message: `unknown role '${roleKey}'` });
    const principal = principalId.parse(ulid());
    // A long, URL-safe token; only its hash is stored. Two UUIDs = 256 bits of entropy.
    const token = claimToken();
    // The grant first: an invite row whose principal holds nothing is a link that binds a
    // teammate to no access, whereas a grant with no row is inert — nobody can bind to it.
    await deps.assignScopeRole(c.env, node.scopeId, principal, roleKey);
    try {
      await deps.directory(c.env, node).createInvite(node.scopeId, principal, roleKey, email ?? null, await sha256Hex(token));
    } catch (err) {
      // Two Durable Objects, no transaction between them. Inert is not the same as
      // harmless: every retry of a failing create would mint another principal with a
      // role and no row, so the grant is taken back before the failure is reported. If
      // the revoke fails too, the ORIGINAL failure is what the caller hears — it is the
      // one that explains the request — and the orphan is the state this comment names.
      await deps.revokeScopeRole(c.env, node.scopeId, principal, roleKey).catch(() => undefined);
      throw err;
    }
    return c.json({ principal, roleKey, email: email ?? null, acceptUrl: `${originOf(c.req.raw)}${invitePath(token)}` }, 201);
  });

  app.post('/api/invites/:principal/revoke', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    await deps.requireAdmin(c);
    await deps.directory(c.env, node).revokeInvite(node.scopeId, c.req.param('principal'));
    return c.body(null, 204);
  });

  app.post('/api/accept-invite', async (c) => {
    const node = await deps.nodeFor(c.req.raw, c.env);
    const subject = await (await deps.authProvider(c.env, c.req.raw)).resolve(c.req.raw.headers);
    if (!subject) throw new HTTPException(401, { message: 'sign in before accepting an invite' });
    const { token } = await bodyOf(c, acceptInviteBody);
    const principal = await deps.directory(c.env, node).claimInvite(node.scopeId, subject.sub, await sha256Hex(token));
    if (!principal) throw new HTTPException(400, { message: 'this invite is invalid or already used' });
    return c.json({ ok: true, principal });
  });
}
