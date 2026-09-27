/**
 * `GET /api/live` on the node host, which has no live reads (#938).
 *
 * The dev server mounts the same route the worker mounts, over the same host a scenario
 * runs on. `SqliteScopeHost` declares `liveReads?: never`, so the route must answer 501
 * with the header a client reads as "poll", and every screen goes on polling exactly as
 * it did before the route existed. The hosted half, frames and all, is in
 * `test/workerd/sweeper.test.ts`.
 *
 * Driven against the real host rather than a stub returning `undefined`: what is being
 * held is that THIS host says no, and a stub would only prove the route reads its option.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { LIVE_PATH, mountLiveReads } from '../harness/live.js';
import { buildHost } from '../src/seed.js';

const dir = mkdtempSync(join(tmpdir(), 'ticket0-live-'));
const host = buildHost(dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ORIGIN = 'http://localhost:5277';
/** Who is asking, observed: a refusal on Origin must be decided before anyone is. */
const subscriber = vi.fn(async () => ({
  tenantId: tenantId.parse(ulid()),
  scopeId: scopeId.parse(ulid()),
  principal: principalId.parse(ulid()),
}));
const app = new Hono();
mountLiveReads(app, { live: () => host.liveReads, subscriber });

/**
 * The same route over a surface that answers, so a request that gets past the Origin
 * check can be seen reaching the subscription. Only for the Origin cases: what the
 * hosted surface does with a subscriber is the workerd suite's to hold.
 */
const subscribed = vi.fn(async () => new Response(null, { status: 204 }));
const answering = new Hono();
mountLiveReads(answering, { live: () => ({ subscribe: subscribed }), subscriber });
beforeEach(() => {
  subscriber.mockClear();
  subscribed.mockClear();
});

const handshake = (headers: Record<string, string>) =>
  new Request(`${ORIGIN}${LIVE_PATH}`, {
    headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', ...headers },
  });

describe('the live route on the node host', () => {
  it('answers 501 and says to poll, because this host has no live reads', async () => {
    const res = await app.fetch(handshake({ origin: ORIGIN }));
    expect(res.status).toBe(501);
    expect(res.headers.get('x-substrat-live')).toBe('poll');
  });

  it('refuses another origin before it asks the host anything, or asks who is calling', async () => {
    const res = await app.fetch(handshake({ origin: 'http://localhost:9999' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('x-substrat-live')).toBeNull();
    expect(subscriber).not.toHaveBeenCalled();
  });
});

describe("the live route's Origin check", () => {
  // Each refusal beside the request that differs from it in the Origin alone.
  it.each([
    ['an opaque origin', 'null'],
    ['the same host over another scheme', 'https://localhost:5277'],
    ['the same host on another port', 'http://localhost:5278'],
    ['a sibling subdomain', 'http://desk.localhost:5277'],
  ])('refuses %s', async (_what, origin) => {
    const res = await answering.fetch(handshake({ origin }));
    expect(res.status).toBe(403);
    expect(subscriber).not.toHaveBeenCalled();
    expect(subscribed).not.toHaveBeenCalled();
  });

  it("takes the desk's own origin through to the subscription", async () => {
    const res = await answering.fetch(handshake({ origin: ORIGIN }));
    expect(res.status).toBe(204);
    expect(subscriber).toHaveBeenCalledOnce();
    expect(subscribed).toHaveBeenCalledOnce();
  });

  it('lets a request with no Origin through, since no browser page sent it', async () => {
    const res = await answering.fetch(handshake({}));
    expect(res.status).toBe(204);
    expect(subscribed).toHaveBeenCalledOnce();
  });
});
