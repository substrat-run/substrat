/**
 * `mountLiveReads` (#1859): the live-read route every vertical mounts, held here once.
 *
 * Two apps. One over the real pure host, because what is held there is that THIS host
 * says no: `SqliteScopeHost` declares `liveReads?: never`, and a stub returning
 * `undefined` would only prove the route reads its option. The other over a surface that
 * answers, so a request that gets past the gate can be seen reaching the subscription.
 * What the hosted surface does with a subscriber is the adapter's workerd suite's to hold.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { LIVE_PATH, mountLiveReads, type LiveSubscriber } from '../src/live.js';

const dir = mkdtempSync(join(tmpdir(), 'vertical-host-live-'));
const host = new SqliteScopeHost({ dir });
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const ORIGIN = 'http://localhost:5277';
const who: LiveSubscriber = {
  tenantId: tenantId.parse(ulid()),
  scopeId: scopeId.parse(ulid()),
  principal: principalId.parse(ulid()),
};
/** Who is asking, observed: a refusal on Origin must be decided before anyone is. */
const subscriber = vi.fn(async (): Promise<LiveSubscriber | null> => who);
/** Whether the host was asked for its surface at all. */
const pureLive = vi.fn(() => host.liveReads);
const pure = new Hono();
mountLiveReads(pure, { live: pureLive, subscriber });

/** A 101 cannot be built in node, so the answering surface's reply stands in for one. */
const subscribed = vi.fn(async () => new Response(null, { status: 204 }));
const answeringLive = vi.fn(() => ({ subscribe: subscribed }));
const answering = new Hono();
mountLiveReads(answering, { live: answeringLive, subscriber });

beforeEach(() => {
  subscriber.mockClear();
  subscribed.mockClear();
  pureLive.mockClear();
  answeringLive.mockClear();
});

const handshake = (headers: Record<string, string>, path = LIVE_PATH) =>
  new Request(`${ORIGIN}${path}`, {
    headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', ...headers },
  });

describe('the live route on the pure host', () => {
  it('answers 501 and says to poll, because this host has no live reads', async () => {
    const res = await pure.fetch(handshake({ origin: ORIGIN }));
    expect(res.status).toBe(501);
    expect(res.headers.get('x-substrat-live')).toBe('poll');
    // Asking who is calling on a host that cannot subscribe them would be a wasted login.
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('refuses another origin before it asks the host anything, or asks who is calling', async () => {
    const res = await pure.fetch(handshake({ origin: 'http://localhost:9999' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('x-substrat-live')).toBeNull();
    expect(pureLive).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
  });
});

/** A plain request to the route: no `Upgrade`, only what the caller names. */
const plain = (headers: Record<string, string>, method = 'GET') =>
  new Request(`${ORIGIN}${LIVE_PATH}`, { method, headers });

describe("the live route's Upgrade check", () => {
  // Only a WebSocket handshake reaches the Origin gate. A browser's WebSocket API always
  // sends Origin, so letting a missing Origin through is safe there and nowhere else: a
  // cross-site top-level GET carrying a Lax cookie may have none.
  it.each([
    ['no Upgrade and no Origin', plain({})],
    ['no Upgrade from the app\'s own origin', plain({ origin: ORIGIN })],
    ['a HEAD with no Upgrade', plain({}, 'HEAD')],
    ['an Upgrade to something else', plain({ upgrade: 'h2c', connection: 'Upgrade' })],
  ])('answers 426 to %s, before the host or the login is asked', async (_what, req) => {
    const res = await answering.fetch(req);
    expect(res.status).toBe(426);
    expect(res.headers.get('x-substrat-live')).toBe('not-an-upgrade');
    expect(answeringLive).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
    expect(subscribed).not.toHaveBeenCalled();
  });

  it('refuses a plain request on the pure host too, rather than telling it to poll', async () => {
    const res = await pure.fetch(plain({}));
    expect(res.status).toBe(426);
    expect(pureLive).not.toHaveBeenCalled();
  });

  // `Upgrade` is a comma-separated protocol list (RFC 9110 §7.8), compared per token and
  // case-insensitively. Each accepted value beside the near misses that are refused.
  it.each([
    ['websocket', 'websocket'],
    ['a mixed-case token', 'WebSocket'],
    ['a padded token', ' WebSocket '],
    ['websocket after another protocol', 'h2c, websocket'],
    ['websocket before another protocol', 'websocket,h2c'],
  ])('accepts %s', async (_what, upgrade) => {
    const res = await answering.fetch(handshake({ origin: ORIGIN, upgrade }));
    expect(res.status).toBe(204);
    expect(subscribed).toHaveBeenCalledOnce();
  });

  it.each([
    ['another protocol alone', 'h2c'],
    ['a longer token', 'websocketx'],
    ['a versioned token', 'websocket2'],
    ['an empty value', ''],
    ['a list of empty tokens', ', ,'],
  ])('answers 426 to %s', async (_what, upgrade) => {
    const res = await answering.fetch(handshake({ origin: ORIGIN, upgrade }));
    expect(res.status).toBe(426);
    expect(res.headers.get('x-substrat-live')).toBe('not-an-upgrade');
    expect(subscriber).not.toHaveBeenCalled();
    expect(subscribed).not.toHaveBeenCalled();
  });
});

describe("the live route's Origin check", () => {
  // Each refusal beside the request that differs from it in the Origin alone.
  it.each([
    ['an opaque origin', 'null'],
    ['the same host over another scheme', 'https://localhost:5277'],
    ['the same host on another port', 'http://localhost:5278'],
    ['a sibling subdomain', 'http://desk.localhost:5277'],
    ['a trailing slash', `${ORIGIN}/`],
    // Fails closed on case: a browser serializes the origin lowercased, so a mismatch
    // here is not a browser page this app served.
    ['an uppercase scheme', 'HTTP://localhost:5277'],
    ['an uppercase host', 'http://LOCALHOST:5277'],
  ])('refuses %s, before the host or the login is asked', async (_what, origin) => {
    const res = await answering.fetch(handshake({ origin }));
    expect(res.status).toBe(403);
    expect(answeringLive).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
    expect(subscribed).not.toHaveBeenCalled();
  });

  it("takes the app's own origin through to the subscription, as the resolved caller", async () => {
    const res = await answering.fetch(handshake({ origin: ORIGIN }));
    expect(res.status).toBe(204);
    expect(subscriber).toHaveBeenCalledOnce();
    expect(subscribed).toHaveBeenCalledOnce();
    const [input] = subscribed.mock.calls[0] as unknown as [LiveSubscriber & { request: Request }];
    expect(input).toMatchObject(who);
    expect(input.request.headers.get('upgrade')).toBe('websocket');
  });

  it('lets a WebSocket handshake with no Origin through, since no browser page sent it', async () => {
    const res = await answering.fetch(handshake({}));
    expect(res.status).toBe(204);
    expect(subscribed).toHaveBeenCalledOnce();
  });
});

describe('who is asking', () => {
  it('answers 401 for nobody, and never subscribes a default principal', async () => {
    subscriber.mockResolvedValueOnce(null);
    const res = await answering.fetch(handshake({ origin: ORIGIN }));
    expect(res.status).toBe(401);
    expect(subscriber).toHaveBeenCalledOnce();
    expect(subscribed).not.toHaveBeenCalled();
  });
});

describe('the path', () => {
  it('mounts at /api/live unless told otherwise, and only there when told', async () => {
    const elsewhere = new Hono();
    mountLiveReads(elsewhere, { live: answeringLive, subscriber, path: '/feed' });
    expect((await elsewhere.fetch(handshake({ origin: ORIGIN }, '/feed'))).status).toBe(204);
    expect((await elsewhere.fetch(handshake({ origin: ORIGIN }))).status).toBe(404);
    // The Origin gate travels with the route, wherever it is mounted.
    expect((await elsewhere.fetch(handshake({ origin: 'http://localhost:9999' }, '/feed'))).status).toBe(403);
  });
});
