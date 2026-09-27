/**
 * `GET /api/live`: the desk's change feed as a WebSocket (#938). The inbox and the
 * conversation view hold it open, and a frame tells them to re-read.
 *
 * Mounted by both hosts, because the difference between them is one the kernel already
 * states. The hosted scope host has `liveReads`. The pure one declares it `never`, so
 * on the dev server this answers 501, and the screens keep the poll they always had.
 *
 * What this route decides is small on purpose, and the order is the order of cost:
 *
 * 1. **The page asking is this desk's own.** A browser sends cookies on a WebSocket
 *    handshake, and a WebSocket is not bound by CORS, so this route checks `Origin`
 *    itself. The session cookie is `SameSite=Lax`, and a sibling subdomain of the
 *    platform's own domain is the same site, so Lax alone does not keep a page on
 *    another tenant's hostname from opening this socket as whoever is signed in here.
 *    A request with no `Origin` did not come from a browser page, and a bearer client
 *    carries its own credential rather than an ambient one.
 * 2. **This host can carry a push at all.** Asked rather than assumed, as the contract
 *    documents (`ScopeHost.liveReads`).
 * 3. **Who is asking.** The same login every other `/api` route resolves. Nobody means
 *    401, never a subscription as some default principal.
 *
 * What it does NOT decide is what a subscriber is told, and it could not if it wanted
 * to: the 101 goes back to the browser, and the frames come straight from the scope,
 * filtered per subscriber against the `liveTargets` in `src/manifest.ts`. Subscribing
 * grants nothing. A customer can open this socket and will hear nothing, because every
 * frame is checked against `conversation:read` on its own entity.
 */
import type { Context, Hono } from 'hono';
import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';
import type { LiveReadSurface } from '@substrat-run/kernel';

export const LIVE_PATH = '/api/live';

/**
 * The header a refusal names its reason in, so a client can tell "poll instead" from
 * "your request was wrong". The same name and value the hosted adapter sets on its own
 * refusals (`LIVE_MODE_HEADER` in `@substrat-run/adapter-cloudflare`, which that
 * package does not export), so a client reads one answer whichever end refused.
 */
const LIVE_MODE_HEADER = 'x-substrat-live';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContext = Context<any>;

export interface LiveSubscriber {
  tenantId: TenantId;
  scopeId: ScopeId;
  principal: PrincipalId;
}

export interface LiveRouteOptions {
  /** The host's live-read surface, or undefined where it has none (the pure host). */
  live: (c: AnyContext) => LiveReadSurface<Request, Response> | undefined;
  /** The signed-in caller and the desk they are in, or null for nobody. */
  subscriber: (c: AnyContext) => Promise<LiveSubscriber | null>;
}

/**
 * Whether a handshake's `Origin` is the page this desk serves.
 *
 * Exact match against the request's own origin: the SPA and `/api` are one origin on
 * both hosts (the dev proxy keeps the Host header, #1388). An embedding page is never a
 * subscriber, since the widget has no principal to subscribe as.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  return origin === null || origin === new URL(req.url).origin;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountLiveReads(app: Hono<any, any, any>, options: LiveRouteOptions): void {
  app.get(LIVE_PATH, async (c) => {
    if (!sameOrigin(c.req.raw)) {
      return c.json({ error: 'live reads are only offered to this desk’s own pages' }, 403);
    }
    const live = options.live(c);
    if (!live) {
      return c.json(
        { error: 'live reads are not available on this host; poll instead' },
        501,
        { [LIVE_MODE_HEADER]: 'poll' },
      );
    }
    const who = await options.subscriber(c);
    if (!who) return c.json({ error: 'unauthorized' }, 401);
    return live.subscribe({ ...who, request: c.req.raw });
  });
}
