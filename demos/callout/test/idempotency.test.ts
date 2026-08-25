/**
 * A dispatcher's browser times out, she presses Send again, and there is ONE
 * work order (#116).
 *
 * Driven over **real HTTP**, against the real route table and the real scope
 * host, for the reason the concurrency test beside it gives at length: every
 * other layer of this feature already has a test that would pass with the wire
 * half broken. The contract suite proves the recording is written inside the
 * operation's transaction; `operations-routes.test.ts` proves the mount reads and
 * writes the right headers against a stub. Neither would notice if Callout's own
 * `mountApi` never reached them — and an `Idempotency-Key` the server ignores is
 * indistinguishable from a feature that is switched off, right up until the
 * second work order.
 *
 * The difference from #129, and the reason this is a separate file rather than
 * another case in that one: there is nothing for Callout to declare. Optimistic
 * concurrency is opt-in and `update-facility` had to adopt it; request
 * idempotency is honoured on every write, so what this proves is that a vertical
 * which changed NOTHING gets it — which is a claim only an end-to-end test can
 * make.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildDemoHost, seedDemo, type DemoWorld } from '../src/index.js';
import { mountApi } from '../src/routes.js';

describe('request idempotency over HTTP (#116)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: DemoWorld;
  let app: Hono;

  /** The persona seam the demo already uses: `x-principal` picks who is calling. */
  const as = (principal: string) => ({ 'x-principal': principal });

  /** How many work orders exist right now — the ground truth every case reads. */
  const orderCount = async (): Promise<number> => {
    const res = await app.request('/api/workorders', { headers: as(w.anna) });
    expect(res.status).toBe(200);
    return ((await res.json()) as unknown[]).length;
  };

  const open = (key?: string, title = 'Trasig armatur i trapphuset') =>
    app.request('/api/workorders', {
      method: 'POST',
      headers: {
        ...as(w.anna),
        'content-type': 'application/json',
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      },
      body: JSON.stringify({
        facilityId: w.forskolanId,
        kind: 'repair',
        title,
      }),
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'callout-idempotency-'));
    host = buildDemoHost(dir);
    w = await seedDemo(host, dir);
    app = new Hono();
    mountApi(app, async (c) => {
      const principal = c.req.header('x-principal');
      if (!principal) throw new Error('no principal');
      return await host.getScope(principal as DemoWorld['anna'], w.t1, w.s1);
    });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens two work orders when the retry carries no key', async () => {
    const before = await orderCount();
    expect((await open()).status).toBe(200);
    expect((await open()).status).toBe(200);
    // The bug, reproduced first. Without a key the server has no way to tell a
    // retry from a second job, and answering otherwise would mean guessing.
    expect(await orderCount()).toBe(before + 2);
  });

  it('opens ONE when the retry carries the same key, and says it replayed', async () => {
    const key = `dispatch-${Date.now()}`;
    const before = await orderCount();

    const first = await open(key);
    expect(first.status).toBe(200);
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();
    const created = (await first.json()) as { id: string };

    // The browser never saw the first response; the dispatcher pressed Send again.
    const retry = await open(key);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotency-Replayed')).toBe('true');

    // One order, and the retry received the SAME one — same id, so the client can
    // navigate to it exactly as the first response would have let it.
    expect(await orderCount()).toBe(before + 1);
    expect((await retry.json()) as { id: string }).toEqual(created);
  });

  it('refuses a key reused for a different order with 409', async () => {
    const key = `dispatch-reuse-${Date.now()}`;
    expect((await open(key, 'Byte av dörrautomatik')).status).toBe(200);
    const before = await orderCount();

    const different = await open(key, 'Något helt annat');
    // Not a replay: the dispatcher is opening a different job under a key her
    // client reused. Answering with the first order would send her to the wrong
    // work order believing it is the one she just created.
    expect(different.status).toBe(409);
    expect(await orderCount()).toBe(before);
  });
});
