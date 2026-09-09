/**
 * The widget surface's rate limit (#937).
 *
 * ticket0's three widget routes are the one door in this repo that anybody's browser
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
import { mountWidgetSurface, WIDGET_RATE_LIMITS } from '../harness/widget-surface.js';

const ORIGIN = 'https://embedder.example';

/** A desk that answers every invocation, so nothing but the limiter can refuse. */
function mounted(now: () => number, origin = ORIGIN) {
  const app = new Hono();
  const invoked: string[] = [];
  mountWidgetSurface(app, {
    now,
    resolveDesk: async () => ({
      invoke: async <T,>(operation: string) => {
        invoked.push(operation);
        return { id: 'm1', conversation_id: 'c1', body_text: 'hello', entries: [] } as unknown as T;
      },
      allowedOrigins: [origin],
    }),
  });

  const post = async (path: string, body: unknown): Promise<Response> =>
    app.request(path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    invoked,
    start: () => post('/widget/sessions', {}),
    say: (token: string) => post('/widget/sessions/s1/messages', { token, body: 'hi' }),
    handoff: (token: string) => post('/widget/sessions/s1/handoff', { token }),
    read: async (token: string): Promise<Response> =>
      app.request(`/widget/sessions/s1/messages?token=${encodeURIComponent(token)}`, {
        headers: { origin },
      }),
  };
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

  it('does not let a caller without a token escape into an unlimited bucket', async () => {
    const surface = mounted(() => 1_000_000);
    // Every one of these is refused by the operation behind it — but they must still
    // cost something, or dropping the token is how you get an unmetered door.
    await spendAll(() => surface.say(''), WIDGET_RATE_LIMITS.write);
    expect((await surface.say('')).status).toBe(429);
  });
});
