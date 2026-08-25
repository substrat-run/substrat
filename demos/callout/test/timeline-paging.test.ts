/**
 * A work order past its twentieth event still shows its whole history (#800).
 *
 * Driven over **real HTTP**, because the truncation this guards against exists
 * only there. The operation is paged and honest about it — `readTimeline` answers
 * `{ entries, nextCursor }` and the contract suite proves the walk — but the route
 * is hand-mounted, so the page projection (#829) is written by hand: body is the
 * entries, the continuation rides in a `Link` header. A scenario test invokes the
 * operation and never the route, so nothing above this file would notice if that
 * header were dropped, or if the browser client read the body and ignored it.
 *
 * And the failure is quiet in the way that matters: `LIST_PAGE_DEFAULT` is 20, the
 * strip renders, and the only symptom is a history that stops. An order accrues an
 * event per mutation, so twenty is a working week, not a pathological case.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { LIST_PAGE_DEFAULT, PAGE_LINK_HEADER, type TimelineEntry } from '@substrat-run/contracts';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildDemoHost, seedDemo, type DemoWorld } from '../src/index.js';
import { mountApi } from '../src/routes.js';

describe('an order timeline longer than one page, over HTTP (#800)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: DemoWorld;
  let app: Hono;
  let orderId: string;

  const as = (principal: string) => ({ 'x-principal': principal });

  const post = (path: string, principal: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { ...as(principal), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'callout-timeline-paging-'));
    host = buildDemoHost(dir);
    w = await seedDemo(host, dir);
    app = new Hono();
    mountApi(app, async (c) => {
      const principal = c.req.header('x-principal');
      if (!principal) throw new Error('no principal');
      return await host.getScope(principal as DemoWorld['anna'], w.t1, w.s1);
    });

    // One order, then enough reported time to run past a page boundary. Every
    // report emits an event on the ORDER, which is the entity the strip walks.
    const created = await post('/api/workorders', w.anna, {
      facilityId: w.forskolanId,
      kind: 'repair',
      title: 'Lång historik',
    });
    expect(created.status).toBe(200);
    orderId = ((await created.json()) as { id: string }).id;

    expect((await post(`/api/workorders/${orderId}/assign`, w.anna, { technician: w.harald })).status).toBe(200);
    expect((await post(`/api/workorders/${orderId}/start`, w.harald, {})).status).toBe(200);
    for (let i = 0; i < LIST_PAGE_DEFAULT; i += 1) {
      const res = await post(`/api/workorders/${orderId}/time`, w.harald, {
        hours: '1.00',
        note: `pass ${i + 1}`,
      });
      expect(res.status).toBe(200);
    }
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers one page and names the next in a Link header', async () => {
    const res = await app.request(`/api/workorders/${orderId}/timeline`, { headers: as(w.anna) });
    expect(res.status).toBe(200);
    const entries = (await res.json()) as TimelineEntry[];

    // The page is full and there is more — which is exactly the state a client
    // reading only the body cannot distinguish from a finished list.
    expect(entries).toHaveLength(LIST_PAGE_DEFAULT);
    const link = res.headers.get(PAGE_LINK_HEADER);
    expect(link).toMatch(/rel="next"/);
  });

  it('hands back every event once when the Link is walked to the end', async () => {
    const ids: string[] = [];
    const types: string[] = [];
    let next: string | null = `/api/workorders/${orderId}/timeline`;
    let pages = 0;

    while (next !== null) {
      const res: Response = await app.request(next, { headers: as(w.anna) });
      expect(res.status).toBe(200);
      for (const entry of (await res.json()) as TimelineEntry[]) {
        ids.push(entry.id);
        types.push(entry.type);
      }
      pages += 1;
      const header = res.headers.get(PAGE_LINK_HEADER);
      const match = header === null ? null : /<([^>]+)>\s*;\s*rel="next"/.exec(header);
      // The link is absolute against the API's own origin; `app.request` takes
      // the path, which is what a same-origin browser sends anyway.
      next = match === null ? null : new URL(match[1] as string).pathname + new URL(match[1] as string).search;
    }

    // More than one page was actually walked, or this asserts nothing.
    expect(pages).toBeGreaterThan(1);
    // Creation, assignment, start, and one per reported hour — every one of them,
    // with no row duplicated across a boundary and none skipped at one. The
    // skipping is the bug an `occurred_at` cursor has: `ctx.now()` is stable for
    // an invocation, so a boundary landing inside a burst loses its remainder.
    expect(ids).toHaveLength(LIST_PAGE_DEFAULT + 3);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids]).toEqual([...ids].sort());
    expect(types[0]).toBe('workorder.created');
    expect(types.filter((t) => t === 'workorder.time-reported')).toHaveLength(LIST_PAGE_DEFAULT);
  });
});
