import { describe, expect, it } from 'vitest';
import { budgetedFetch, SweepBudgetSpent } from '../src/sweep-budget.js';
import type { ConnectorResponse, FetchLike } from '../src/connector-transport.js';

/**
 * #3324: one connection's share of a sweep pass, held on the `fetch` its sweeper is handed. The
 * byte count is taken while a body streams, so a response is never read past the share.
 */

const chunk = (n: number) => new Uint8Array(n).fill(0x61); // 'a'

/** A response streaming `chunks`, recording how many the reader pulled and whether it was cancelled. */
function streamed(chunks: number[], headers: Record<string, string> = {}) {
  const seen = { pulled: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      seen.pulled += 1;
      controller.enqueue(chunk(chunks[i++]!));
    },
    cancel() {
      seen.cancelled = true;
    },
  }, { highWaterMark: 0 }); // pull-only, so `pulled` counts what the reader asked for and nothing queued ahead
  return { res: new Response(body, { headers }) as unknown as ConnectorResponse, seen };
}

const fetchOf = (make: () => ConnectorResponse): FetchLike => async () => make();

describe('budgetedFetch (#3324)', () => {
  it('passes a body within the share through unchanged, read by text() or as a stream', async () => {
    const budget = { maxBytes: 100, maxMs: 60_000, clock: () => 0 };
    const viaText = budgetedFetch(fetchOf(() => streamed([10, 20]).res), budget);
    expect(await (await viaText('https://p.example/a')).text()).toBe('a'.repeat(30));
    const viaStream = budgetedFetch(fetchOf(() => streamed([10, 20]).res), budget);
    const reader = (await viaStream('https://p.example/a')).body!.getReader();
    let total = 0;
    for (let r = await reader.read(); !r.done; r = await reader.read()) total += r.value!.byteLength;
    expect(total).toBe(30);
  });

  it('errors the read at the chunk that crosses the share, and cancels the rest of the body', async () => {
    const { res, seen } = streamed([40, 40, 40, 40]);
    const f = budgetedFetch(fetchOf(() => res), { maxBytes: 100, maxMs: 60_000, clock: () => 0 });
    await expect((await f('https://p.example/big')).text()).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(seen.pulled).toBe(3);
    expect(seen.cancelled).toBe(true);
  });

  it('counts across calls: the share is the connection\'s for the whole pass, not per response', async () => {
    const f = budgetedFetch(fetchOf(() => streamed([60]).res), { maxBytes: 100, maxMs: 60_000, clock: () => 0 });
    await (await f('https://p.example/1')).arrayBuffer();
    await expect((await f('https://p.example/2')).json()).rejects.toBeInstanceOf(SweepBudgetSpent);
    // Spent: the next call is refused before it is made.
    await expect(f('https://p.example/3')).rejects.toBeInstanceOf(SweepBudgetSpent);
  });

  it('refuses a response whose declared length would cross the share before reading a byte of it', async () => {
    const { res, seen } = streamed([500], { 'content-length': '500' });
    const f = budgetedFetch(fetchOf(() => res), { maxBytes: 100, maxMs: 60_000, clock: () => 0 });
    await expect(f('https://p.example/declared')).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(seen.pulled).toBe(0);
  });

  it('reads a body of declared length into one buffer, whole, and hands that buffer out', async () => {
    const f = budgetedFetch(fetchOf(() => streamed([10, 20, 5], { 'content-length': '35' }).res), { maxBytes: 100, maxMs: 60_000, clock: () => 0 });
    const buffer = await (await f('https://p.example/sized')).arrayBuffer();
    expect(buffer.byteLength).toBe(35);
    expect(new Uint8Array(buffer).every((b) => b === 0x61)).toBe(true);
  });

  it('lets go of the provider\'s body when the stream is cancelled before its first read', async () => {
    const { res, seen } = streamed([10]);
    const f = budgetedFetch(fetchOf(() => res), { maxBytes: 100, maxMs: 60_000, clock: () => 0 });
    await (await f('https://p.example/unread')).body!.getReader().cancel('not needed');
    expect(seen).toEqual({ pulled: 0, cancelled: true });
  });

  it('refuses the next call once the share\'s time has passed', async () => {
    let now = 1_000;
    let calls = 0;
    const f = budgetedFetch(async () => { calls += 1; return streamed([1]).res; }, { maxBytes: 100, maxMs: 5_000, clock: () => now });
    await f('https://p.example/early');
    now += 5_000;
    await expect(f('https://p.example/late')).rejects.toThrow(/ran past its/);
    expect(calls).toBe(1);
  });
});
