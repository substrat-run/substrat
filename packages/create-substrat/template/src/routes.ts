import type { Context, Hono } from 'hono';
import { mountOperations, problemResponse, type ResolveStub } from '@substrat-run/vertical-host';
import { bikeShopEngineRoutes, bikeShopInvoicingRoutes, bikeShopOperations } from './operations.js';

/**
 * The bike shop's HTTP API — derived from the declared operations, adapter- and
 * auth-agnostic.
 *
 * Both entrypoints mount this: `server.ts` (node, pure-SQLite adapter, OIDC against the
 * local dev issuer) and `worker.ts` (Cloudflare, Durable-Object adapter, the auth seam). Each
 * supplies a `resolveStub` that authenticates the caller its own way and returns a
 * capability `ScopeStub`; every route is a thin wrapper over ONE operation, with no
 * business logic — the rules live in an operation or an engine.
 *
 * Sharing the table is the point. A route added to only one entrypoint is a surface
 * that exists in dev and 404s in production (or the reverse), and nothing catches it
 * until deploy: the scenario tests call operations directly and never boot either host.
 * What each entrypoint still owns is only what is genuinely its own: how it builds a
 * host, how it resolves a caller, and its own auth-shaped routes (`/api/auth/*` and
 * `/api/me` in dev, `/api/me` in the worker) — those answer "who am I on THIS host"
 * and cannot be shared.
 *
 * ## Why there is no table here
 *
 * There was one, and every line of it restated something the operations already
 * declare: the method, the path, which input fields the path carries, and — for a
 * paged read — that the page trio must be forwarded in and the entries handed back
 * as the body with the walk in a `Link` header. Two helpers held that last part
 * together by hand, and every route that invoked a paged operation had to remember
 * to call both. `mountOperations` derives all of it from the `http` each operation
 * declares in `src/operations.ts`: it orders static path segments ahead of their
 * parameter siblings, coerces query values per the declared shape, pins a
 * `z.literal` input the caller must not choose, projects a `Page<T>` onto the wire,
 * and turns the kernel's own refusals into their status. A new operation is on
 * both hosts the moment it declares `http`, and there is no second list to drift.
 */
export type { ResolveStub };

/** Every operation that carries a URL: this vertical's own, and the two engines it composes. */
const ROUTED = {
  ...bikeShopOperations,
  ...bikeShopEngineRoutes,
  ...bikeShopInvoicingRoutes,
};

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  /**
   * One error vocabulary, shared with the platform surface: `problemResponse`
   * (@substrat-run/vertical-host) is built on the same `classifyError` that
   * `mountPlatformSurface` uses, so a permission denial is 403, a missing thing 404, a
   * broken invariant 409, a runtime fault 502 — identically on both hosts. "No opinion"
   * becomes the caller's 400.
   *
   * The body is RFC 9457 `application/problem+json`: a `code` from the closed taxonomy
   * when your throw declared one (`substratError('conflict', …)`), `about:blank` when it
   * did not. `{ error }` rides along for one deprecation window, so a client reading it
   * keeps working while you move to `code`.
   *
   * In `worker.ts` this handler is REPLACED: Hono keeps only the last-registered
   * `onError`, and `mountPlatformSurface` installs its own. That is harmless precisely
   * because both are built on the same vocabulary — same input, same answer. Registering
   * it here is what gives `server.ts`, which mounts no platform surface, the same
   * behaviour.
   */
  app.onError((err, c: Context) => problemResponse(c, err));

  // The one hand-written route, registered BEFORE the derived table so the
  // exception always wins. The kernel checks a permission inside EVERY operation,
  // so a generic route is exactly as safe as one route per operation — and it is
  // what keeps an operation reachable that has no URL of its own: an engine
  // operation this vertical deliberately did not bind (`workorder/complete`, which
  // `shop/complete-repair` wraps) is still callable here, on BOTH hosts.
  app.post('/api/invoke', async (c) => {
    const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
    return c.json((await (await resolveStub(c)).invoke(op, input)) ?? null);
  });

  // Returns what it mounted, in registration order — a test pins the complete
  // method/path set, so a derived table that mounted nothing, moved a path or
  // changed a verb fails loudly rather than passing over an empty app.
  return mountOperations(app, ROUTED, resolveStub);
}
