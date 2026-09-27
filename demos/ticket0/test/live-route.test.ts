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
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { LIVE_PATH, mountLiveReads, type LiveSubscriber } from '../harness/live.js';
import { buildHost } from '../src/seed.js';

const dir = mkdtempSync(join(tmpdir(), 'ticket0-live-'));
const host = buildHost(dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ORIGIN = 'http://localhost:5277';
const signedIn: LiveSubscriber = {
  tenantId: tenantId.parse(ulid()),
  scopeId: scopeId.parse(ulid()),
  principal: principalId.parse(ulid()),
};

function app(who: LiveSubscriber | null) {
  const a = new Hono();
  mountLiveReads(a, { live: () => host.liveReads, subscriber: async () => who });
  return a;
}

const handshake = (headers: Record<string, string>) =>
  new Request(`${ORIGIN}${LIVE_PATH}`, {
    headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', ...headers },
  });

describe('the live route on the node host', () => {
  it('answers 501 and says to poll, because this host has no live reads', async () => {
    const res = await app(signedIn).fetch(handshake({ origin: ORIGIN }));
    expect(res.status).toBe(501);
    expect(res.headers.get('x-substrat-live')).toBe('poll');
  });

  it('refuses another origin before it asks the host anything', async () => {
    const res = await app(signedIn).fetch(handshake({ origin: 'http://localhost:9999' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('x-substrat-live')).toBeNull();
  });
});
