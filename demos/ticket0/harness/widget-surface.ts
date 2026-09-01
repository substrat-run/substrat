/**
 * The widget's public surface — ticket0's three routes, and nothing else.
 *
 * The platform half used to live here: unauthenticated mount, hand-rolled async CORS,
 * the preflight, and refusing an unlisted origin before the handler rather than beside
 * it. All four are `mountPublicSurface` in `@substrat-run/vertical-host` now (#936), so
 * this file is down to what is genuinely ticket0's — which desk a request is for, and
 * which `ticket0/widget-*` operation each route invokes.
 *
 * It still lives under `harness/` because it is not module code: it decides which desk
 * and which origin, and it does no access control. What confines a visitor is the
 * session token, checked inside the operation.
 *
 * Both of this vertical's hosts mount it — the node dev server (`src/server.ts`) and
 * the deployed Cloudflare worker (`src/worker.ts`) — because two copies of a route
 * table is how a preflight starts disagreeing with the operation behind it. What
 * differs between them is only `resolveDesk`: the embedding origin picks the desk on
 * the dev server, the routed hostname does in a hosted install, and neither is ever
 * anything the caller sent.
 */
import type { Context, Hono } from 'hono';
import { clientContextOf, type ClientContext } from '@substrat-run/contracts';
import {
  mountPublicSurface,
  type PublicServiceActor,
  type ResolvePublicActor,
} from '@substrat-run/vertical-host';

/** A desk, resolved for one request: how to act as its widget service, and where it is embeddable. */
export type WidgetDesk = PublicServiceActor;

/**
 * Which desk this request is for. Async on purpose: reading a desk's allowlist is a
 * round-trip to its scope, and the answer is needed before the browser's preflight is
 * answered — see `mountPublicSurface` for why that rules out `hono/cors`.
 */
export type ResolveWidgetDesk = (c: Context, origin: string) => Promise<WidgetDesk | null>;

export interface WidgetSurfaceOptions {
  readonly resolveDesk: ResolveWidgetDesk;
  /**
   * What this host knows about the browser opening a session — handed to
   * `widget-start` as input, since module code has no request to read.
   *
   * The default reads the headers every host has (`User-Agent`, `Accept-Language`)
   * and knows no geo. A host behind an edge that does know overrides it with its
   * adapter's normaliser — the worker passes `cloudflareClientContext` — and the
   * operation sees the same shape either way. That is the whole point of the seam:
   * the vertical never learns which runtime it is on.
   */
  readonly clientOf?: (c: Context) => ClientContext;
  /**
   * Called after a customer message lands, so the assistant can answer it.
   *
   * Deliberately NOT awaited by the route: the model call is somebody else's latency
   * and the visitor should not hold a connection open for it. The widget polls, and
   * the answer turns up when it turns up — which is also how it behaves when the
   * answer comes from a human.
   *
   * The Hono context rides along because the worker has to hand the promise to
   * `executionCtx.waitUntil` — a floating promise in a Workers isolate is cancelled
   * the moment the response is returned, so "not awaited" and "not tracked" are two
   * different things and only one of them works.
   */
  readonly onCustomerMessage?: (
    c: Context,
    m: { origin: string; conversationId: string; messageId: string; body: string },
  ) => void;
}

export function mountWidgetSurface(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  options: WidgetSurfaceOptions,
): void {
  const clientOf = options.clientOf ?? ((c: Context) => clientContextOf(c.req.raw.headers));
  const resolveActor: ResolvePublicActor = (c, { origin }) => options.resolveDesk(c, origin);

  mountPublicSurface(app, {
    // Every widget call runs as the desk's own `widget` service account, which holds
    // exactly one key. The visitor has no principal and needs none (concept §4, §9.1).
    service: 'widget',
    basePath: '/widget',
    resolveActor,
    routes: (route) => {
      route.post('/sessions', async (c, { actor: desk, origin }) => {
        const body = (await c.req.json().catch(() => ({}))) as { identity?: unknown };
        // `origin` comes from the header, and so does `client`: both are facts about the
        // request that the page cannot forge. The body may carry an identity signature —
        // which the operation verifies against the desk's secret — and nothing else.
        return c.json(
          await desk.invoke('ticket0/widget-start', {
            origin,
            client: clientOf(c),
            identity: body.identity ?? null,
          }),
        );
      });

      route.post('/sessions/:sessionId/messages', async (c, { actor: desk, origin }) => {
        const body = (await c.req.json().catch(() => ({}))) as { token?: string; body?: string };
        const message = await desk.invoke<{ id: string; conversation_id: string; body_text: string }>(
          'ticket0/widget-post',
          { sessionId: c.req.param('sessionId'), token: body.token, body: body.body },
        );
        options.onCustomerMessage?.(c, {
          origin,
          conversationId: message.conversation_id,
          messageId: message.id,
          body: message.body_text,
        });
        return c.json(message);
      });

      route.get('/sessions/:sessionId/messages', async (c, { actor: desk }) => {
        const entries = await desk.invoke<{ entries: unknown[] }>('ticket0/widget-thread', {
          sessionId: c.req.param('sessionId'),
          token: c.req.query('token'),
        });
        return c.json(entries);
      });
    },
  });
}
