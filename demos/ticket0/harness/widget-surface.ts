/**
 * The widget's public surface — the transport half of the capability design, and the
 * one implementation BOTH hosts mount: the node dev server (`src/server.ts`) and the
 * deployed Cloudflare worker (`src/worker.ts`).
 *
 * It lives under `harness/` because it is not module code — it decides which desk and
 * which origin, and it does no access control. In a hosted deployment this belongs in
 * `vertical-host` behind a declared `widget` surface, with the router in front; until
 * that exists, both of this vertical's hosts import it from here rather than keeping a
 * copy each, because two copies of a CORS decision is how a preflight starts
 * disagreeing with the operation behind it.
 *
 * Three things it does that the derived `/api` mount deliberately cannot:
 *
 *  1. **It is unauthenticated.** There is no login and no principal for a visitor.
 *     Every call runs as the desk's own `widget` service account, which holds one key.
 *  2. **It takes `origin` from the HEADER, never the body.** A browser sets `Origin`
 *     and a page cannot forge it, so the desk's embedding allowlist is checked against
 *     something the caller does not control. A body field would be a suggestion.
 *  3. **It picks the desk from the request.** Which desk you reach is a fact about the
 *     deployment — the embedding origin on the dev server, the routed hostname in a
 *     hosted install — and never about what the caller asked for.
 *
 * What confines a visitor is still the session token, checked inside the operation.
 * Nothing here is doing access control; it is deciding which desk and which origin.
 */
import type { Context, Hono } from 'hono';
import { substratError } from '@substrat-run/contracts';

/** A desk, resolved for one request: how to act as its widget service, and where it is embeddable. */
export interface WidgetDesk {
  readonly invoke: <T>(operation: string, input: unknown) => Promise<T>;
  /**
   * The origins this desk may be embedded on — the DESK's own list, read through
   * `ticket0/widget-origins`, which is the same array `widget-start` refuses out of.
   * A host may union its own routing facts into it (the dev server does, for the
   * stand-in sites it serves), but the desk's list is the authorization fact.
   */
  readonly allowedOrigins: readonly string[];
}

/**
 * Which desk this request is for. Async on purpose: reading a desk's allowlist is a
 * round-trip to its scope, and the answer is needed before the browser's preflight is
 * answered — which is why this surface hand-rolls CORS instead of using `hono/cors`,
 * whose `origin` callback is synchronous and would force a cached copy of a list that
 * `configure-desk` can change at any moment.
 */
export type ResolveWidgetDesk = (c: Context, origin: string) => Promise<WidgetDesk | null>;

export interface WidgetSurfaceOptions {
  readonly resolveDesk: ResolveWidgetDesk;
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

/** Where the resolved desk is stashed, so CORS and the handler resolve it once per request. */
const DESK = 'ticket0:widget-desk';

export function mountWidgetSurface(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  options: WidgetSurfaceOptions,
): void {
  const { resolveDesk } = options;

  /**
   * CORS, and the allowlist is consulted per request rather than baked at boot: a desk
   * that removes an origin stops being embeddable there without a redeploy, and the
   * preflight is the first place that has to be true.
   *
   * A page whose origin the desk has not listed gets no `access-control-allow-origin`
   * header, so the browser refuses the response — the request may still have reached
   * the operation, which refuses it again on its own terms. Two refusals for one
   * unlisted origin is the point: neither is load-bearing alone.
   */
  app.use('/widget/*', async (c: Context, next: () => Promise<void>) => {
    const origin = c.req.header('origin');
    const desk = origin ? await resolveDesk(c, origin) : null;
    const allowed = !!origin && !!desk && desk.allowedOrigins.includes(origin);
    if (desk) c.set(DESK, desk);

    if (allowed) {
      c.header('access-control-allow-origin', origin!);
      c.header('vary', 'origin');
    }
    if (c.req.method === 'OPTIONS') {
      // Answered here rather than by a route, because a preflight names a method that
      // does not exist yet as far as the router is concerned.
      if (!allowed) return c.body(null, 403);
      c.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      c.header('access-control-allow-headers', 'content-type');
      c.header('access-control-max-age', '600');
      return c.body(null, 204);
    }
    await next();
  });

  /**
   * The desk this request resolved to — or a refusal.
   *
   * The refusals carry the platform's own taxonomy rather than a class of their own.
   * A bespoke error type would need a bespoke renderer, and this vertical already has
   * one `onError` that every other refusal goes through; two would mean the status a
   * caller sees depends on which handler was registered last, which is exactly the
   * bug this line replaced.
   */
  const deskOf = (c: Context): { desk: WidgetDesk; origin: string } => {
    const origin = c.req.header('origin');
    if (!origin)
      throw substratError('permission_denied', 'this endpoint is for a browser on an embedded page');
    const desk = c.get(DESK) as WidgetDesk | undefined;
    if (!desk) throw substratError('permission_denied', `no desk is embedded on ${origin}`);
    return { desk, origin };
  };

  app.post('/widget/sessions', async (c: Context) => {
    const { desk, origin } = deskOf(c);
    const body = (await c.req.json().catch(() => ({}))) as { identity?: unknown };
    // `origin` comes from the header. The body may carry an identity signature — which
    // the operation verifies against the desk's secret — and nothing else.
    return c.json(
      await desk.invoke('ticket0/widget-start', {
        origin,
        identity: body.identity ?? null,
      }),
    );
  });

  app.post('/widget/sessions/:sessionId/messages', async (c: Context) => {
    const { desk, origin } = deskOf(c);
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

  app.get('/widget/sessions/:sessionId/messages', async (c: Context) => {
    const { desk } = deskOf(c);
    const entries = await desk.invoke<{ entries: unknown[] }>('ticket0/widget-thread', {
      sessionId: c.req.param('sessionId'),
      token: c.req.query('token'),
    });
    return c.json(entries);
  });
}
