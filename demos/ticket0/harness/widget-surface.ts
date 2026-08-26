/**
 * The widget's public surface — harness code, and the transport half of the
 * capability design.
 *
 * This is the piece the platform does not have yet. In a hosted deployment it belongs
 * in `vertical-host` behind a `widget` surface, with the router in front; here it is
 * mounted on the demo's own server so the design can be driven in a real browser
 * across a real origin boundary. The three operations it exposes are unchanged.
 *
 * Three things it does that the derived `/api` mount deliberately cannot:
 *
 *  1. **It is unauthenticated.** There is no login and no principal for a visitor.
 *     Every call runs as the desk's own `widget` service account, which holds one key.
 *  2. **It takes `origin` from the HEADER, never the body.** A browser sets `Origin`
 *     and a page cannot forge it, so the desk's embedding allowlist is checked against
 *     something the caller does not control. A body field would be a suggestion.
 *  3. **It picks the desk from that same origin.** One deployment, many desks, and
 *     which one you reach is a fact about which site embedded the widget.
 *
 * What confines a visitor is still the session token, checked inside the operation.
 * Nothing here is doing access control; it is deciding which desk and which origin.
 */
import { cors } from 'hono/cors';
import type { Context, Hono } from 'hono';
import { substratError } from '@substrat-run/contracts';

/** Which desk a given browser origin belongs to, and how to act as its widget service. */
export interface WidgetDesk {
  readonly invoke: <T>(operation: string, input: unknown) => Promise<T>;
}

export type ResolveWidgetDesk = (origin: string) => Promise<WidgetDesk | null>;

export interface WidgetSurfaceOptions {
  readonly resolveDesk: ResolveWidgetDesk;
  readonly allowedOrigins: () => readonly string[];
  /**
   * Called after a customer message lands, so the assistant can answer it.
   *
   * Deliberately NOT awaited by the route: the model call is somebody else's latency
   * and the visitor should not hold a connection open for it. The widget polls, and
   * the answer turns up when it turns up — which is also how it behaves when the
   * answer comes from a human.
   */
  readonly onCustomerMessage?: (m: {
    origin: string;
    conversationId: string;
    messageId: string;
    body: string;
  }) => void;
}

export function mountWidgetSurface(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  options: WidgetSurfaceOptions,
): void {
  const { resolveDesk, allowedOrigins } = options;
  /**
   * The allowlist is consulted per request rather than baked at boot: a desk that
   * removes an origin stops being embeddable there without a redeploy, and the
   * preflight is the first place that has to be true.
   */
  app.use(
    '/widget/*',
    cors({
      origin: (origin) => (allowedOrigins().includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type'],
      maxAge: 600,
    }),
  );

  /**
   * The origin a browser actually sent, and the desk it belongs to — or a refusal.
   *
   * The refusals carry the platform's own taxonomy rather than a class of their own.
   * A bespoke error type would need a bespoke renderer, and this vertical already has
   * one `onError` that every other refusal goes through; two would mean the status a
   * caller sees depends on which handler was registered last, which is exactly the
   * bug this line replaced.
   */
  const deskOf = async (c: Context): Promise<{ desk: WidgetDesk; origin: string }> => {
    const origin = c.req.header('origin');
    if (!origin)
      throw substratError('permission_denied', 'this endpoint is for a browser on an embedded page');
    const desk = await resolveDesk(origin);
    if (!desk) throw substratError('permission_denied', `no desk is embedded on ${origin}`);
    return { desk, origin };
  };

  app.post('/widget/sessions', async (c) => {
    const { desk, origin } = await deskOf(c);
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

  app.post('/widget/sessions/:sessionId/messages', async (c) => {
    const { desk, origin } = await deskOf(c);
    const body = (await c.req.json().catch(() => ({}))) as { token?: string; body?: string };
    const message = await desk.invoke<{ id: string; conversation_id: string; body_text: string }>(
      'ticket0/widget-post',
      { sessionId: c.req.param('sessionId'), token: body.token, body: body.body },
    );
    options.onCustomerMessage?.({
      origin,
      conversationId: message.conversation_id,
      messageId: message.id,
      body: message.body_text,
    });
    return c.json(message);
  });

  app.get('/widget/sessions/:sessionId/messages', async (c) => {
    const { desk } = await deskOf(c);
    const entries = await desk.invoke<{ entries: unknown[] }>('ticket0/widget-thread', {
      sessionId: c.req.param('sessionId'),
      token: c.req.query('token'),
    });
    return c.json(entries);
  });
}
