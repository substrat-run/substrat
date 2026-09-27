/**
 * `GET /api/live`: a vertical's change feed as a WebSocket (#938), mounted once, here.
 *
 * ticket0 was the first vertical to open one, and wrote this route in its own
 * `harness/live.ts`. Three of the four things the route decides are the same for every
 * vertical, and the Origin rule is not visible from the kernel contract at all, so the next
 * vertical would have had to rediscover it (#1859). They live here now.
 *
 * Mount it on both hosts. The difference between them is one the kernel already states:
 * the hosted scope host has `liveReads`, the pure one declares it `never`. On a dev server
 * this route answers `501`, and a client keeps the poll it always had.
 *
 * What the route decides, in the order of cost:
 *
 * 1. **It is a WebSocket handshake.** Anything else is `426` with
 *    `x-substrat-live: not-an-upgrade`. This comes first because the Origin check below
 *    lets a request with no `Origin` through, and that is only safe for a handshake: a
 *    browser's WebSocket API always sends `Origin`, while a cross-site top-level GET
 *    carrying a `SameSite=Lax` cookie need not. Without this gate such a GET would run
 *    the vertical's session resolution.
 * 2. **The page asking is the vertical's own.** A browser sends cookies on a WebSocket
 *    handshake, and a WebSocket is not bound by CORS, so the route checks `Origin`
 *    itself. A session cookie that is `SameSite=Lax` does not help: a sibling subdomain
 *    of the platform's own domain is the same site, so Lax alone does not keep a page on
 *    another tenant's hostname from opening this socket as whoever is signed in here.
 *    A WebSocket handshake with no `Origin` did not come from a browser page (the
 *    browser's WebSocket API always sends one), and a bearer client carries its own
 *    credential rather than an ambient one, so it falls through.
 * 3. **This host can carry a push at all.** Asked rather than assumed, as the contract
 *    documents (`ScopeHost.liveReads`). No surface is `501` with
 *    `x-substrat-live: poll`, the same header the hosted adapter sets on its own
 *    refusals, so a client reads one answer whichever end refused.
 * 4. **Who is asking.** The vertical's own login, as a callback, because only the
 *    vertical knows how its session resolves. Nobody means `401`, never a subscription as
 *    some default principal.
 *
 * The Upgrade and Origin checks run before the other two, so a refused request causes no
 * auth side effect: the host is not asked and the subscriber callback is never called.
 *
 * What it does NOT decide is what a subscriber is told, and it could not if it wanted
 * to: the `101` goes back to the browser, and the frames come straight from the scope,
 * filtered per subscriber against the module's declared `liveTargets`. Subscribing
 * grants nothing.
 */
import type { Context, Env, Hono } from 'hono';
import {
  isUpgradeRequest,
  LIVE_MODE_HEADER,
  type LiveReadSurface,
  type LiveRefusal,
} from '@substrat-run/kernel';

/** Where `mountLiveReads` mounts the route unless told otherwise. */
export const LIVE_PATH = '/api/live';

/** Who is subscribing, and to which scope — what `LiveReadSurface.subscribe` takes besides the request. */
export type LiveSubscriber = Omit<Parameters<LiveReadSurface['subscribe']>[0], 'request'>;

/** Typed over the app's own Hono `Env`, so `c.env` in either callback is the vertical's bindings. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface LiveRouteOptions<E extends Env = any> {
  /** The host's live-read surface, or undefined where it has none (the pure host). */
  live: (c: Context<E>) => LiveReadSurface<Request, Response> | undefined;
  /**
   * The signed-in caller and the scope they are in, or null for nobody. Only called for
   * a WebSocket handshake that passed the Origin check, on a host that has live reads.
   */
  subscriber: (c: Context<E>) => Promise<LiveSubscriber | null>;
  /** The route's path. Defaults to `LIVE_PATH` (`/api/live`). */
  path?: string;
}

/**
 * Whether a handshake's `Origin` is the page this vertical serves.
 *
 * Exact match against the request's own origin: scheme, host and port. The SPA and
 * `/api` are one origin on both hosts (a demo's dev proxy keeps the Host header, #1388).
 * An opaque origin (`Origin: null`) is refused. A missing `Origin` falls through, because
 * a browser always sends one on a WebSocket handshake.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  return origin === null || origin === new URL(req.url).origin;
}

/**
 * Mount the live-read route: the Upgrade gate, the Origin gate, the `501` on a host with
 * no live reads, then the subscription as whoever `subscriber` says is asking.
 */
export function mountLiveReads<E extends Env>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<E, any, any>,
  options: LiveRouteOptions<E>,
): void {
  app.get(options.path ?? LIVE_PATH, async (c) => {
    if (!isUpgradeRequest(c.req.raw)) {
      return c.json({ error: 'live reads are a WebSocket surface' }, 426, {
        [LIVE_MODE_HEADER]: 'not-an-upgrade' satisfies LiveRefusal,
      });
    }
    if (!sameOrigin(c.req.raw)) {
      return c.json({ error: 'live reads are only offered to this app’s own pages' }, 403);
    }
    const live = options.live(c);
    if (!live) {
      return c.json(
        { error: 'live reads are not available on this host; poll instead' },
        501,
        { [LIVE_MODE_HEADER]: 'poll' satisfies LiveRefusal },
      );
    }
    const who = await options.subscriber(c);
    if (!who) return c.json({ error: 'unauthorized' }, 401);
    return live.subscribe({ ...who, request: c.req.raw });
  });
}
