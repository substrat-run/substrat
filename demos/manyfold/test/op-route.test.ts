/**
 * Manyfold's hand-written `/api/op/*` route goes through the platform's one door (#2073): a
 * page's `rowCursors` never leave in a response, and a caller cannot ask for them.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ScopeStub } from '@substrat-run/kernel';
import { mountApi, OPERATIONS } from '../src/routes.js';

function harness(result: unknown) {
  const got: { input?: unknown } = {};
  const app = new Hono();
  mountApi(app, async () => ({ invoke: async (_op: string, input: unknown) => ((got.input = input), result) }) as unknown as ScopeStub);
  const call = (input: unknown) =>
    app.request(`/api/op/${OPERATIONS[0]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  return { call, got };
}

describe('/api/op/* (#2073)', () => {
  it("never answers with a page's rowCursors, at the top or nested", async () => {
    const page = { entries: [{ id: 'a' }], nextCursor: 'a', rowCursors: ['a', 'HIDDEN'] };
    for (const result of [page, { nested: page, again: page }]) {
      const text = await (await harness(result).call({})).text();
      expect(text).toContain('"a"');
      expect(text).not.toContain('HIDDEN');
    }
  });

  it('keeps a rowCursors field on something that is not a page — an opaque record', async () => {
    const res = await harness({ data: { rowCursors: { any: 'thing' } } }).call({});
    expect(await res.json()).toEqual({ data: { rowCursors: { any: 'thing' } } });
  });

  it('a caller cannot ask for rowCursors: the operation never sees the flag', async () => {
    const { call, got } = harness(null);
    await call({ q: 'x', rowCursors: true });
    expect(got.input).toEqual({ q: 'x' });
  });
});
