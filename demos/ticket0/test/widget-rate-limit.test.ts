/**
 * The widget surface's rate limit (#937).
 *
 * ticket0's widget routes are the one door in this repo that anybody's browser
 * may knock on, and `widget-post` turns into a model call — the single thing in the
 * system that costs money per request, metered to a desk that did not choose to be
 * attacked. #130's per-token limit does not reach it: every visitor shares the desk's
 * one `widget` service account, so the only useful unit is the caller.
 *
 * Driven through the mounted routes rather than against `createLimiter` directly,
 * because what is under test is which key each route counts on — the mistake worth
 * catching is `widget-start` keyed on a token it has not issued yet, or a limiter
 * mounted after the handler it is supposed to guard. The desk behind it is a stub: the
 * refusal happens before anything reaches a scope, which is the point of it.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type LiveReadSurface } from '@substrat-run/kernel';
import { mountWidgetSurface, WIDGET_RATE_LIMITS } from '../harness/widget-surface.js';

const ORIGIN = 'https://embedder.example';

/**
 * A desk that answers every invocation, so nothing but the limiter can refuse.
 *
 * ONE mount answering for several desks, which is what a deployed worker is: the isolate
 * is per script, the installation is per routed hostname. `x-test-desk` stands in for the
 * router's signed assertion — every call takes an optional desk and defaults to one, so a
 * test that is not about desks reads as if there were only ever one.
 */
function mounted(now: () => number, origin = ORIGIN) {
  const app = new Hono();
  const invoked: string[] = [];
  /**
   * The host's live-read surface, stubbed: what it is asked is the assertion (#1853). A node
   * `Response` cannot carry a 101, so a subscription answers 200 here — the route returns
   * whatever `subscribe` hands it, so the status is only a marker that it was reached.
   */
  const subscribed: string[] = [];
  const live = {
    surface: {
      subscribe: async (input: { within?: unknown }) => {
        subscribed.push(String((input.within as { entity?: { entityId?: string } })?.entity?.entityId));
        return new Response('subscribed', { status: 200 });
      },
    } as unknown as LiveReadSurface<Request, Response>,
    subscriber: {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      principal: principalId.parse(ulid()),
    },
  };
  mountWidgetSurface(app, {
    now,
    resolveDesk: async (c) => ({
      invoke: async <T,>(operation: string) => {
        invoked.push(operation);
        return { id: 'm1', conversation_id: 'c1', body_text: 'hello', entries: [] } as unknown as T;
      },
      allowedOrigins: [origin],
      deskKey: c.req.header('x-test-desk') ?? 'desk-1',
      live,
    }),
  });

  const headers = (desk?: string): Record<string, string> => ({
    origin,
    ...(desk ? { 'x-test-desk': desk } : {}),
  });

  const post = async (path: string, body: unknown, desk?: string): Promise<Response> =>
    app.request(path, {
      method: 'POST',
      headers: { ...headers(desk), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    invoked,
    subscribed,
    /** The widget opening its live feed: a WebSocket handshake on the session's token. */
    watch: async (token: string, desk?: string): Promise<Response> =>
      app.request(`/widget/sessions/s1/live?token=${encodeURIComponent(token)}`, {
        headers: { ...headers(desk), upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13' },
      }),
    start: (desk?: string) => post('/widget/sessions', {}, desk),
    say: (token: string, desk?: string) =>
      post('/widget/sessions/s1/messages', { token, body: 'hi' }, desk),
    handoff: (token: string) => post('/widget/sessions/s1/handoff', { token }),
    read: async (token: string, desk?: string): Promise<Response> =>
      app.request(`/widget/sessions/s1/messages?token=${encodeURIComponent(token)}`, {
        headers: headers(desk),
      }),
  };
}

/**
 * More distinct callers than the limiter counts at once — the shape of an attack on the
 * BOOKKEEPING rather than on the desk. Cheapest route on purpose: minting keys is the
 * point, and the read route needs no body.
 */
async function floodWithNewCallers(surface: { read: (token: string) => Promise<Response> }) {
  for (let i = 0; i < WIDGET_RATE_LIMITS.maxKeys + 1; i += 1) await surface.read(`flood-${i}`);
}

/** Spend a whole budget, and assert the desk was willing all the way through it. */
async function spendAll(call: () => Promise<Response>, budget: number) {
  for (let i = 0; i < budget; i += 1) {
    const res = await call();
    expect(res.status, `call ${i + 1} of ${budget} was refused`).toBe(200);
  }
}

describe('the widget surface limits one caller, not the whole desk', () => {
  it('refuses a flood of new sessions from one embedding origin', async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(surface.start, WIDGET_RATE_LIMITS.start);

    const refused = await surface.start();
    expect(refused.status).toBe(429);
    // The problem document every other refusal on this vertical wears (#113), and the
    // header a client that does not read bodies backs off from.
    expect(refused.headers.get('content-type')).toContain('application/problem+json');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await refused.json()) as { status: number; code: string; retryAfter: number };
    expect(body.status).toBe(429);
    expect(body.code).toBe('rate_limited');
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('answers the 429 so the embedding page can read it — CORS, and the header exposed', async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(surface.start, WIDGET_RATE_LIMITS.start);

    const refused = await surface.start();
    // Withholding this would make the limit invisible to `widget.js`, which is the one
    // caller that has to see it in order to back off.
    expect(refused.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(refused.headers.get('access-control-expose-headers')).toContain('retry-after');
  });

  it('counts a message against the session that sent it, and lets another one through', async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(() => surface.say('token-a'), WIDGET_RATE_LIMITS.write);

    expect((await surface.say('token-a')).status).toBe(429);
    // The whole reason the key is the token: one abusive visitor must not close the
    // desk for everybody else on the same page.
    expect((await surface.say('token-b')).status).toBe(200);
  });

  it('spends the handoff out of the same budget as a message', async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(() => surface.say('token-a'), WIDGET_RATE_LIMITS.write);
    expect((await surface.handoff('token-a')).status).toBe(429);
  });

  it('limits the thread poll too, well above the pace the widget actually polls at', async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(() => surface.read('token-a'), WIDGET_RATE_LIMITS.read);
    expect((await surface.read('token-a')).status).toBe(429);

    // widget.js polls at 1.5s while it is waiting for an answer. A budget that a single
    // well-behaved widget could exhaust would be a bug, not a limit.
    expect(WIDGET_RATE_LIMITS.read).toBeGreaterThan((WIDGET_RATE_LIMITS.windowMs / 1500) * 2);
  });

  it('refuses before the desk is asked anything', async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(() => surface.say('token-a'), WIDGET_RATE_LIMITS.write);
    const spent = surface.invoked.length;

    expect((await surface.say('token-a')).status).toBe(429);
    // Not one more round trip to the scope, and certainly not one more model call.
    expect(surface.invoked.length).toBe(spent);
  });

  it('gives the budget back when the window turns', async () => {
    let at = 1_000_000;
    const surface = mounted(() => at);
    await spendAll(() => surface.say('token-a'), WIDGET_RATE_LIMITS.write);
    expect((await surface.say('token-a')).status).toBe(429);

    at += WIDGET_RATE_LIMITS.windowMs;
    expect((await surface.say('token-a')).status).toBe(200);
  });

  it('does not let one desk spend another desk\'s allowance', async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(() => surface.start('desk-a'), WIDGET_RATE_LIMITS.start);
    expect((await surface.start('desk-a')).status).toBe(429);

    // The same embedding origin, a different installation. One script answers for every
    // desk the router sends it, so a key that did not name the desk would have closed
    // this widget because somebody else's was flooded — and would have let a desk that
    // allowlists a page spend the neighbour it shares that page with.
    expect((await surface.start('desk-b')).status).toBe(200);
  });

  it('does not hand a spent budget back to a caller that floods it with new keys', async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(() => surface.say('token-a'), WIDGET_RATE_LIMITS.write);
    expect((await surface.say('token-a')).status).toBe(429);

    // Evicting the oldest counter to bound the map is the obvious implementation, and it
    // is exactly how a caller buys its own budget back: the counter holding `token-a` at
    // its limit is the first one out. A live counter is never dropped, so this changes
    // nothing about what `token-a` has already spent.
    await floodWithNewCallers(surface);

    expect((await surface.say('token-a')).status).toBe(429);
  });

  it('counts a caller it has no room for in a shared bucket rather than not at all', async () => {
    const surface = mounted(() => 1_000_000);
    await floodWithNewCallers(surface);

    // No slot left to give these, and refusing to count them would be the other way to
    // lose the limit. They share one allowance instead — unfair while the flood lasts,
    // which is the trade: what the desk spends is still bounded.
    await spendAll(() => surface.say(`fresh-${Math.random()}`), WIDGET_RATE_LIMITS.write);
    expect((await surface.say('fresh-last')).status).toBe(429);
  });

  it('does not let a caller without a token escape into an unlimited bucket', async () => {
    const surface = mounted(() => 1_000_000);
    // Every one of these is refused by the operation behind it — but they must still
    // cost something, or dropping the token is how you get an unmetered door.
    await spendAll(() => surface.say(''), WIDGET_RATE_LIMITS.write);
    expect((await surface.say('')).status).toBe(429);
  });

  /**
   * #1853: opening the live feed is a read. A reconnect loop must not be cheaper than the
   * poll it replaces, so the handshake spends the same per-token allowance as the thread
   * read — and is refused before the token is checked or anything is subscribed.
   */
  it('spends a live handshake out of the same per-token read allowance as the thread poll', async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(() => surface.read('token-a'), WIDGET_RATE_LIMITS.read - 1);

    // The last read in the window goes to the socket…
    expect((await surface.watch('token-a')).status).toBe(200);
    expect(surface.subscribed).toEqual(['s1']);

    // …so the next handshake is refused, and so is the next poll: one budget, two doors.
    const refused = await surface.watch('token-a');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await surface.read('token-a')).status).toBe(429);
  });

  it('refuses an over-budget handshake before the token is proven or anything is subscribed', async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(() => surface.read('token-a'), WIDGET_RATE_LIMITS.read);
    surface.invoked.length = 0;

    expect((await surface.watch('token-a')).status).toBe(429);
    expect(surface.invoked).toEqual([]);
    expect(surface.subscribed).toEqual([]);
  });

  it("leaves another session's live allowance alone", async () => {
    const surface = mounted(() => 1_000_000);
    await spendAll(() => surface.watch('token-a'), WIDGET_RATE_LIMITS.read);
    expect((await surface.watch('token-a')).status).toBe(429);

    expect((await surface.watch('token-b')).status).toBe(200);
    expect(surface.subscribed).toHaveLength(WIDGET_RATE_LIMITS.read + 1);
  });
});
