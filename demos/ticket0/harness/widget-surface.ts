/**
 * The widget's public surface — ticket0's three routes, and nothing else.
 *
 * The platform half used to live here: unauthenticated mount, hand-rolled async CORS,
 * the preflight, and refusing an unlisted origin before the handler rather than beside
 * it. All four are `mountPublicSurface` in `@substrat-run/vertical-host` now (#936), so
 * this file is down to what is genuinely ticket0's — which desk a request is for, and
 * which `ticket0/widget-*` operation each route invokes — plus what one caller may
 * spend on it (`WIDGET_RATE_LIMITS`, #937), which is demo-sized and demo-local until
 * there is a platform limiter to lift it.
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
import {
  clientContextOf,
  substratError,
  toProblem,
  PROBLEM_CONTENT_TYPE,
  type ClientContext,
} from '@substrat-run/contracts';
import {
  mountPublicSurface,
  type PublicServiceActor,
  type ResolvePublicActor,
} from '@substrat-run/vertical-host';
import { wantsHuman } from './assistant.js';

/**
 * A desk, resolved for one request: how to act as its widget service, where it is
 * embeddable, and which installation it is.
 */
export type WidgetDesk = PublicServiceActor & {
  /**
   * Which installation this is — the unit every rate-limit key is scoped to.
   *
   * It has to be a fact the HOST resolved, never anything the caller sent: the worker
   * takes it from the router's SIGNED assertion of (tenant, scope), and the dev server
   * from the desk the embedding origin picked. One script answers for many desks — a
   * worker isolate serves every tenant the router sends it, and the dev server serves
   * several stand-in sites at once — so without this in the key, two installations
   * sharing an embedding origin would spend one budget, and a desk that allowlists a
   * page could spend a neighbour's `start` allowance on it.
   */
  readonly deskKey: string;
};

/**
 * What one caller may do on this surface in a minute (#937).
 *
 * `mountPublicSurface` deliberately carries no limiter, and #130's per-token limit is
 * the wrong unit here: every visitor to a desk shares its one `widget` service account,
 * so a budget on that key either throttles the whole desk because of one visitor or
 * throttles nobody. The unit on a public surface is the CALLER, and the two callers this
 * surface can name are the session token it issued and the embedding `Origin` the
 * browser sent.
 *
 * So there are two budgets and they key differently:
 *
 *  - **`start` is per origin**, because it is the route that MINTS a token and a token
 *    cannot key its own mint. That key is coarse — every visitor on an embedding page
 *    shares it, so one script can spend the site's whole allowance, which is exactly
 *    the failure origin-keying was rejected for on the other routes. It is accepted
 *    HERE because there is nothing finer to key on before a session exists, and it is
 *    why the budget is sized for a whole site rather than one visitor: a desk that
 *    reaps conversations (concept §9.1) survives 60 abandoned ones a minute, and the
 *    two routes that actually cost money are keyed properly.
 *  - **`write` and `read` are per session token.** `write` is `widget-post` and the
 *    handoff — the calls that turn into a model call and a ledger line, i.e. the ones
 *    that cost the desk money. `read` is the thread poll, and its budget has to clear
 *    `widget.js`'s own pace (1.5s while waiting for an answer, ×N open tabs sharing one
 *    token) by a wide margin or the widget limits itself.
 *
 * A caller with no token has no identity of its own and falls into its origin's bucket
 * rather than an unlimited one.
 *
 * Every key is scoped to the DESK first (`deskKey` above). One script answers for many
 * installations, so an unscoped key would let two desks embedded on the same page spend
 * one budget — and would let a desk that allowlists a page exhaust a neighbour's
 * allowance for it.
 *
 * **Approximate by construction, in two ways, and that is the trade this demo makes.**
 * The window is fixed rather than sliding, so a caller straddling a boundary can spend
 * two budgets in a moment. The state is one `Map` in one isolate, so a worker running
 * several isolates limits per isolate. What it deliberately is NOT is resettable: the
 * map is bounded, but a live counter is never dropped to make room — see `createLimiter`
 * for why that distinction is the whole design. The alternative — a real, shared,
 * per-caller limiter — is platform work (#936, #130), and these constants sit in one
 * exported object so it can lift them when it lands.
 */
export const WIDGET_RATE_LIMITS = {
  /** The window every budget below is spent inside, in milliseconds. */
  windowMs: 60_000,
  /** New sessions one embedding origin may open per window. */
  start: 60,
  /** Messages and handoffs one session may send per window — the calls that cost money. */
  write: 10,
  /** Thread reads one session may make per window. Generous on purpose: see above. */
  read: 180,
  /**
   * How many callers are counted at once. Past this, a caller with no counter of its
   * own shares one — it never takes somebody else's.
   */
  maxKeys: 5_000,
} as const;

interface Budget {
  count: number;
  resetAt: number;
}

/**
 * One fixed-window counter per caller, held in this isolate.
 *
 * Returns 0 when the call is within budget, and otherwise the whole seconds until the
 * window resets — which is what the caller is told to wait.
 *
 * **A counter that is still live is never dropped, and that is the whole design of the
 * bound.** The obvious way to cap the map — evict the oldest when it is full — hands the
 * budget back to the one caller it was holding: spend a session's ten messages, mint
 * 5,000 throwaway tokens to push that counter out, and the eleventh message starts a
 * fresh window. So capacity is reclaimed only from counters the clock has already
 * retired, and a caller arriving while every slot is live is charged to a shared
 * overflow bucket — one per (desk, kind) — instead of being given one of its own.
 *
 * That degrades under a key flood: callers the map has no room for share an allowance
 * and are refused sooner than they deserve. It is the right way round. A limiter that is
 * unfair while it is being attacked still bounds what the desk spends; one that can be
 * reset bounds nothing, which is the only property the route that costs money per
 * request is here for.
 */
function createLimiter(now: () => number) {
  /** One counter per caller. Never larger than `maxKeys`, and never evicted while live. */
  const callers = new Map<string, Budget>();
  /** One counter per (desk, kind), reached only while `callers` has no room. Tiny by shape. */
  const overflow = new Map<string, Budget>();

  /** The only way a slot is freed: the clock. */
  const dropExpired = (map: Map<string, Budget>, at: number) => {
    for (const [key, budget] of map) if (budget.resetAt <= at) map.delete(key);
  };

  const charge = (map: Map<string, Budget>, key: string, allowance: number, at: number): number => {
    let budget = map.get(key);
    if (!budget || budget.resetAt <= at) {
      budget = { count: 0, resetAt: at + WIDGET_RATE_LIMITS.windowMs };
      map.set(key, budget);
    }
    budget.count += 1;
    if (budget.count <= allowance) return 0;
    return Math.max(1, Math.ceil((budget.resetAt - at) / 1000));
  };

  return (bucket: string, key: string, allowance: number): number => {
    const at = now();
    // A key already counted keeps its counter, whatever the map's size — the check is
    // about admitting a NEW one.
    const room = () => callers.has(key) || callers.size < WIDGET_RATE_LIMITS.maxKeys;
    if (!room()) {
      // Every counter expires within one window, so this is what frees the map in the
      // ordinary case. When it frees nothing, the caller falls to the shared bucket.
      dropExpired(callers, at);
      dropExpired(overflow, at);
    }
    return room() ? charge(callers, key, allowance, at) : charge(overflow, bucket, allowance, at);
  };
}

/**
 * The refusal — `429`, `Retry-After`, and the same problem document every other refusal
 * on this vertical carries (#113), so `widget.js` reads a status it already knows.
 *
 * RETURNED rather than thrown, unlike the origin gate one layer up. A throw goes through
 * `onError`, which builds a response of its own and drops the headers the context is
 * holding — including the `access-control-allow-origin` the gate set. The browser would
 * then refuse to hand the widget the body, and a limit the client cannot see is a limit
 * it cannot back off from.
 *
 * `Retry-After` is not a CORS-safelisted response header, so it is exposed explicitly.
 * The same number is in the body's `retryAfter` for a client that reads the document
 * instead.
 */
function tooManyRequests(c: Context, retryAfter: number): Response {
  const body = toProblem(
    substratError('rate_limited', 'too many requests from this page — try again shortly', {
      retryAfter,
    }),
    c.req.path,
  );
  return c.body(JSON.stringify(body), 429, {
    'content-type': PROBLEM_CONTENT_TYPE,
    'retry-after': String(retryAfter),
    'access-control-expose-headers': 'retry-after',
  });
}

/**
 * The desk `mountPublicSurface` hands a route, named again.
 *
 * It types what it passes as the contract it declares — `PublicServiceActor` — while
 * `deskKey` is ticket0's own addition to it. The object IS the one this file's
 * `resolveActor` returned from `options.resolveDesk`, so this restores a fact rather
 * than assuming one.
 */
const deskOf = (actor: PublicServiceActor): WidgetDesk => actor as WidgetDesk;

/**
 * Which budget a route spends out of: this desk's, for this kind of call. Also the key
 * of the shared bucket a caller falls into when the limiter has no room for its own.
 */
const bucketOf = (desk: PublicServiceActor, kind: string): string =>
  `${deskOf(desk).deskKey}|${kind}`;

/**
 * Which caller this is inside that bucket. The session token when there is one — it is
 * what the desk issued and what confines the visitor — and the embedding origin when
 * there is not, so a tokenless flood shares one bucket instead of having none.
 */
const callerKey = (bucket: string, token: unknown, origin: string): string =>
  typeof token === 'string' && token !== '' ? `${bucket}|t:${token}` : `${bucket}|o:${origin}`;

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
  /**
   * The clock the rate limiter's windows are measured against. Host code, so this is
   * the wall clock by default — module code's `ctx.now()` is not in scope here and a
   * limiter that follows an operation's frozen instant would never let a window turn.
   *
   * A test passes its own so it can watch a window expire without waiting a minute.
   */
  readonly now?: () => number;
}

export function mountWidgetSurface(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  options: WidgetSurfaceOptions,
): void {
  const clientOf = options.clientOf ?? ((c: Context) => clientContextOf(c.req.raw.headers));
  const resolveActor: ResolvePublicActor = (c, { origin }) => options.resolveDesk(c, origin);
  // One limiter per mount, so two surfaces in one process (a test, a dev server serving
  // two stand-in sites) do not spend each other's budgets.
  const spend = createLimiter(options.now ?? (() => Date.now()));

  mountPublicSurface(app, {
    // Every widget call runs as the desk's own `widget` service account, which holds
    // exactly one key. The visitor has no principal and needs none (concept §4, §9.1).
    service: 'widget',
    basePath: '/widget',
    resolveActor,
    routes: (route) => {
      route.post('/sessions', async (c, { actor: desk, origin }) => {
        // Per origin, not per token: this is the route that mints the token. And per
        // desk, because one script answers for many of them.
        const bucket = bucketOf(desk, 'start');
        const wait = spend(bucket, `${bucket}|o:${origin}`, WIDGET_RATE_LIMITS.start);
        if (wait) return tooManyRequests(c, wait);
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
        // The one call on this surface that costs the desk money, so it is counted
        // before anything reaches a scope, let alone a model.
        const bucket = bucketOf(desk, 'write');
        const wait = spend(bucket, callerKey(bucket, body.token, origin), WIDGET_RATE_LIMITS.write);
        if (wait) return tooManyRequests(c, wait);
        const sessionId = c.req.param('sessionId');
        const message = await desk.invoke<{ id: string; conversation_id: string; body_text: string }>(
          'ticket0/widget-post',
          { sessionId, token: body.token, body: body.body },
        );
        /**
         * A message that asks for a person is not a question, and must not reach a
         * model. The widget's button says so through the route below; this is for a
         * visitor who TYPED it, which the button cannot know about.
         *
         * The decision is here rather than in `answerConversation` because of who is
         * allowed to speak: the handoff's acknowledgement is the DESK confirming
         * receipt, written by the widget service, and a desk that keeps a human in
         * the loop refuses the assistant a public word — correctly, and it must not
         * take this sentence down with it.
         *
         * If the escalation itself fails, the assistant answers after all. A poor
         * answer beats the silence of a message that nothing was ever going to pick
         * up, and the visitor can always press the button.
         */
        if (wantsHuman(message.body_text)) {
          try {
            await desk.invoke('ticket0/request-human', { sessionId, token: body.token });
            return c.json(message);
          } catch {
            /* fall through to the assistant */
          }
        }
        options.onCustomerMessage?.(c, {
          origin,
          conversationId: message.conversation_id,
          messageId: message.id,
          body: message.body_text,
        });
        return c.json(message);
      });

      /**
       * "Talk to a human", as a click rather than a sentence about one.
       *
       * The button used to post its own prose through the route above and hope
       * something downstream recognised it. Nothing did: the intent was in the click
       * and the pipeline turned it back into a guess. One call now posts what the
       * visitor said, acknowledges it, and tells the desk — in one transaction, so
       * the request cannot be recorded without being announced.
       */
      route.post('/sessions/:sessionId/handoff', async (c, { actor: desk, origin }) => {
        const body = (await c.req.json().catch(() => ({}))) as { token?: string; body?: string };
        // The same budget as a message, and deliberately: it is the same visitor writing
        // to the same conversation, and pressing the button is a way of posting.
        const bucket = bucketOf(desk, 'write');
        const wait = spend(bucket, callerKey(bucket, body.token, origin), WIDGET_RATE_LIMITS.write);
        if (wait) return tooManyRequests(c, wait);
        return c.json(
          await desk.invoke('ticket0/request-human', {
            sessionId: c.req.param('sessionId'),
            token: body.token,
            ...(body.body ? { body: body.body } : {}),
          }),
        );
      });

      route.get('/sessions/:sessionId/messages', async (c, { actor: desk, origin }) => {
        const token = c.req.query('token');
        const bucket = bucketOf(desk, 'read');
        const wait = spend(bucket, callerKey(bucket, token, origin), WIDGET_RATE_LIMITS.read);
        if (wait) return tooManyRequests(c, wait);
        const entries = await desk.invoke<{ entries: unknown[] }>('ticket0/widget-thread', {
          sessionId: c.req.param('sessionId'),
          token,
        });
        return c.json(entries);
      });
    },
  });
}
