/**
 * The generic `/api/invoke` route goes through the platform's one door (#2073).
 *
 * A page's `rowCursors` are each row's own cursor: an in-process answer for a walk that stops
 * partway through a page. A handler that filtered its entries after the read would leave them
 * naming the rows it dropped, so they never leave in a response — and a caller cannot ask for
 * them. This route is hand-written, not derived, so it is held to that here.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ScopeStub } from '@substrat-run/kernel';
import { mountApi } from '../src/routes.js';

function harness(result: unknown) {
  const got: { input?: unknown } = {};
  const app = new Hono();
  mountApi(app, async () => ({ invoke: async (_op: string, input: unknown) => ((got.input = input), result) }) as unknown as ScopeStub);
  const call = (input: unknown) =>
    app.request('/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'shop/anything', input }),
    });
  return { call, got };
}

describe('/api/invoke — the one hand-written route (#2073)', () => {
  it("never answers with a page's rowCursors, at the top or nested", async () => {
    const page = { entries: [{ id: 'a' }], nextCursor: 'a', rowCursors: ['a', 'HIDDEN'] };
    for (const result of [page, { nested: page, again: page }]) {
      const text = await (await harness(result).call({})).text();
      expect(text).toContain('"a"');
      expect(text).not.toContain('HIDDEN');
    }
  });

  it('keeps a rowCursors field on something that is not a page', async () => {
    const res = await harness({ id: 'a', rowCursors: ['kept'] }).call({});
    expect(await res.json()).toEqual({ id: 'a', rowCursors: ['kept'] });
  });

  it('a caller cannot ask for rowCursors: the operation never sees the flag', async () => {
    const { call, got } = harness(null);
    await call({ q: 'x', rowCursors: true });
    expect(got.input).toEqual({ q: 'x' });
  });
});
