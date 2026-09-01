/**
 * A PUBLIC surface — one anybody's browser may call, on a page the vertical never
 * served — authored once, here, instead of once per vertical that needs one.
 *
 * The platform's other two mounts both assume a caller. `mountPlatformSurface` is
 * gated by the platform secret; `mountOperations` resolves a stub from whatever the
 * vertical authenticated. A support widget in a chat bubble has neither: the visitor
 * has no principal and never gets one (ticket0 concept §4, §9.1). What confines them
 * is a session token checked inside the operation, and what decides which page may
 * talk at all is the installation's own embedding allowlist.
 *
 * ticket0 carried this whole half in its own `harness/` because the host had no notion
 * of a surface without a principal and no CORS anywhere (#936, #918). Three properties
 * are what made it platform work rather than demo code:
 *
 *  1. **It runs as a declared SERVICE principal, and only that.** No header, cookie or
 *     body field on a public request selects an actor — the vertical names one service
 *     when it mounts, and every call on the surface is invoked as whatever
 *     `resolveActor` answers for it. A public surface that could be talked into a
 *     different principal is not public, it is unauthenticated privilege.
 *  2. **CORS is answered in MIDDLEWARE, from an async resolver, per request.** Not
 *     `hono/cors`: its `origin` callback is synchronous, so an allowlist that lives in
 *     a scope has to be cached at boot, and the cached copy disagreed with the live one
 *     the moment an admin edited it (#922). Reading it per request is the point —
 *     removing an origin stops the embed without a redeploy, and the PREFLIGHT is the
 *     first place that has to be true.
 *  3. **The refusal happens BEFORE the handler.** Withholding
 *     `access-control-allow-origin` stops a browser READING a response; it does nothing
 *     to stop the write behind it. A page holding a leaked session token could
 *     otherwise still post from an origin the installation never listed — blind, but
 *     landed. So an unlisted origin never reaches a route.
 *
 * The `Origin` HEADER is what is checked, never a body field: a browser sets it and a
 * page cannot forge it, so it is a fact about the request rather than a suggestion.
 *
 * Rate limiting on the same surface is #937 and deliberately not here.
 */
import type { Context, Hono } from 'hono';
import { substratError } from '@substrat-run/contracts';

/**
 * The service account this surface runs as, resolved for one request, together with
 * the origins the installation behind it may be embedded on.
 *
 * Both halves come from the same resolve, because both are facts about the same
 * installation and reading them apart is how a preflight starts disagreeing with the
 * operation behind it.
 */
export interface PublicServiceActor {
  /** Invoke an operation as the declared service principal. */
  readonly invoke: <T>(operation: string, input: unknown) => Promise<T>;
  /**
   * The origins this installation may be embedded on — the INSTALLATION's own list,
   * read live through the service, which is the same list its operations refuse out
   * of. A host may union its own routing facts into it (a dev server does, for the
   * stand-in sites it serves); the installation's list is the authorization fact.
   */
  readonly allowedOrigins: readonly string[];
}

/**
 * Which installation — and therefore which service account and which allowlist — a
 * public request is for.
 *
 * Async on purpose: the answer is a round trip to a scope, and it is needed before the
 * browser's preflight can be answered. That is the whole reason this surface hand-rolls
 * CORS (§2 above).
 *
 * Returning `null` means "nothing here answers for that origin" and is refused as a
 * denial, not a crash — an un-provisioned instance and an unlisted page look the same
 * to a visitor on purpose.
 */
export type ResolvePublicActor = (
  c: Context,
  request: { readonly origin: string; readonly service: string },
) => Promise<PublicServiceActor | null>;

/** What a public route is handed, in place of the caller it does not have. */
export interface PublicRouteContext {
  /** The service principal every call on this surface runs as. */
  readonly actor: PublicServiceActor;
  /** The embedding origin, off the header, already checked against the allowlist. */
  readonly origin: string;
  /** The service name the vertical declared at mount. */
  readonly service: string;
}

export type PublicRouteHandler = (
  c: Context,
  route: PublicRouteContext,
) => Response | Promise<Response>;

/**
 * The route table a public surface registers into. Paths are relative to `basePath`,
 * so a route cannot accidentally be declared outside the middleware that guards it —
 * which is the failure mode a bare `app.post('/widget/…')` beside the mount has.
 */
export interface PublicRouter {
  get(path: string, handler: PublicRouteHandler): void;
  post(path: string, handler: PublicRouteHandler): void;
  put(path: string, handler: PublicRouteHandler): void;
  patch(path: string, handler: PublicRouteHandler): void;
  delete(path: string, handler: PublicRouteHandler): void;
}

export interface PublicSurfaceOptions {
  /**
   * The service principal this surface runs as, named by the VERTICAL (`widget`, …).
   * It is passed back to `resolveActor` so a vertical with several service accounts
   * resolves the one this surface declared rather than re-deriving it.
   */
  readonly service: string;
  /** Where the surface is mounted — `/widget`, `/public`, … No trailing slash. */
  readonly basePath: string;
  /** Which installation this request is for, and how to act as its service. */
  readonly resolveActor: ResolvePublicActor;
  /**
   * Request headers a browser may send. `content-type` alone by default — a public
   * surface has no `authorization` to allow, and listing one would advertise a door
   * that is not there.
   */
  readonly allowHeaders?: readonly string[];
  /** How long a browser may cache the preflight, in seconds. */
  readonly preflightMaxAge?: number;
  /** Register the vertical's own routes. Called once, at mount. */
  readonly routes: (route: PublicRouter) => void;
}

/** Where the resolved actor is stashed, so the middleware and the handler resolve it once. */
const ACTOR = 'substrat:public-actor';

/**
 * Mount a public route group: the origin gate, the preflight, and the vertical's own
 * routes running as one declared service principal.
 *
 * Returns the table it mounted, so a caller can assert on it — a surface that
 * registered nothing should fail a test loudly rather than 404 in production.
 */
export function mountPublicSurface(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  options: PublicSurfaceOptions,
): { service: string; basePath: string; routes: { method: string; path: string }[] } {
  const { service, basePath, resolveActor } = options;
  if (!basePath.startsWith('/') || basePath.endsWith('/')) {
    throw new Error(`mountPublicSurface: basePath must start with '/' and not end with one (got '${basePath}')`);
  }
  const allowHeaders = (options.allowHeaders ?? ['content-type']).join(', ');
  const maxAge = String(options.preflightMaxAge ?? 600);
  const routes: { method: string; path: string }[] = [];
  // Filled by the `routes` callback below, read at REQUEST time — so the preflight
  // advertises exactly the methods this surface has, rather than a hard-coded guess
  // that goes stale the first time a route is added.
  const methods = new Set<string>(['OPTIONS']);

  /**
   * The door. Registered before the routes, because Hono dispatches in registration
   * order and middleware added after a handler never runs ahead of it.
   *
   * Thrown rather than returned, so the refusal goes through the vertical's one
   * `onError` and comes back in whatever envelope every other refusal on that worker
   * has — readable in a log or a `curl` even though the browser will not show it to
   * the embedding page.
   */
  const gate = async (c: Context, next: () => Promise<void>) => {
    const origin = c.req.header('origin');
    const actor = origin ? await resolveActor(c, { origin, service }) : null;
    const allowed = !!origin && !!actor && actor.allowedOrigins.includes(origin);

    if (c.req.method === 'OPTIONS') {
      // Answered here rather than by a route: a preflight names a method that, as far
      // as the router is concerned, this URL does not have yet. A bare status and no
      // body — no browser reads a preflight's body.
      if (!allowed) return c.body(null, 403);
      c.header('access-control-allow-origin', origin as string);
      c.header('vary', 'origin');
      c.header('access-control-allow-methods', [...methods].join(', '));
      c.header('access-control-allow-headers', allowHeaders);
      c.header('access-control-max-age', maxAge);
      return c.body(null, 204);
    }

    if (!origin)
      throw substratError('permission_denied', 'this endpoint is for a browser on an embedded page');
    if (!actor) throw substratError('permission_denied', `nothing is embedded on ${origin}`);
    if (!allowed) throw substratError('permission_denied', `this is not embedded on ${origin}`);

    c.set(ACTOR, actor);
    c.header('access-control-allow-origin', origin);
    c.header('vary', 'origin');
    await next();
  };

  // `${basePath}/*` covers the base path ITSELF as well as everything under it, so a route
  // the vertical declares at `'/'` is guarded like every other one. Registered once:
  // adding a second `app.use(basePath, …)` for it would run the gate — and therefore
  // `resolveActor`'s round trip to a scope — twice on that one path.
  app.use(`${basePath}/*`, gate);

  /**
   * What the middleware above already decided. The throw is the assertion that the two
   * cannot drift — not a second gate: every request that would not have an actor was
   * refused before it reached a route.
   */
  const contextOf = (c: Context): PublicRouteContext => {
    const origin = c.req.header('origin') ?? '';
    const actor = c.get(ACTOR) as PublicServiceActor | undefined;
    if (!actor) throw substratError('permission_denied', `nothing is embedded on ${origin}`);
    return { actor, origin, service };
  };

  const register =
    (method: 'get' | 'post' | 'put' | 'patch' | 'delete') =>
    (path: string, handler: PublicRouteHandler): void => {
      const full = path === '/' ? basePath : `${basePath}${path}`;
      methods.add(method.toUpperCase());
      routes.push({ method: method.toUpperCase(), path: full });
      app[method](full, (c: Context) => handler(c, contextOf(c)));
    };

  options.routes({
    get: register('get'),
    post: register('post'),
    put: register('put'),
    patch: register('patch'),
    delete: register('delete'),
  });

  return { service, basePath, routes };
}
