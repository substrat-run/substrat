import { describe, expect, it } from 'vitest';
import { ABSENT_TTL_MS, readOwnerSeat, type SeatMemoStore } from '../web/src/lib/owner-seat.js';

/**
 * The owner-seat memo (#1345). A vertical that keeps no seat answers 501, and every 501
 * counts as an errored invocation — so the dashboard must stop asking once it knows, and
 * must never keep believing it past a push. The version id is the key that makes both true.
 */

function memoryStore(): SeatMemoStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** The shape the dashboard API rejects with (`ApiError`): a status on an Error. */
class StatusError extends Error {
  constructor(readonly status: number) {
    super(`${status}`);
  }
}

const SEAT = { state: 'claimed' as const };

function asker(answer: () => Promise<typeof SEAT>) {
  const calls: string[] = [];
  return {
    calls,
    ask: (scopeId: string) => {
      calls.push(scopeId);
      return answer();
    },
  };
}

const absent = () => Promise.reject(new StatusError(501));
const present = () => Promise.resolve(SEAT);

describe('readOwnerSeat', () => {
  it('asks once per running version for a seat the code does not keep', async () => {
    const store = memoryStore();
    const a = asker(absent);
    expect(await readOwnerSeat('scope-a', 'v1', a.ask, { store })).toBeNull();
    expect(await readOwnerSeat('scope-a', 'v1', a.ask, { store })).toBeNull();
    expect(await readOwnerSeat('scope-a', 'v1', a.ask, { store })).toBeNull();
    expect(a.calls).toEqual(['scope-a']);
  });

  it('asks again after a push — another version id can never read the old answer', async () => {
    const store = memoryStore();
    await readOwnerSeat('scope-a', 'v1', asker(absent).ask, { store });
    const b = asker(present);
    expect(await readOwnerSeat('scope-a', 'v2', b.ask, { store })).toEqual(SEAT);
    expect(b.calls).toEqual(['scope-a']);
    // The old version's entry is dropped rather than left to accumulate.
    expect(store.data.size).toBe(0);
  });

  it('keeps scopes apart — the test environment is not production', async () => {
    const store = memoryStore();
    await readOwnerSeat('scope-prod', 'v1', asker(absent).ask, { store });
    const b = asker(present);
    expect(await readOwnerSeat('scope-test', 'v1', b.ask, { store })).toEqual(SEAT);
    expect(b.calls).toEqual(['scope-test']);
  });

  it('never remembers without a known running version', async () => {
    const store = memoryStore();
    const a = asker(absent);
    expect(await readOwnerSeat('scope-a', null, a.ask, { store })).toBeNull();
    expect(await readOwnerSeat('scope-a', null, a.ask, { store })).toBeNull();
    expect(a.calls).toHaveLength(2);
    expect(store.data.size).toBe(0);
  });

  it('does not remember a failure that is not a 501, and still rejects with it', async () => {
    const store = memoryStore();
    const a = asker(() => Promise.reject(new StatusError(502)));
    await expect(readOwnerSeat('scope-a', 'v1', a.ask, { store })).rejects.toMatchObject({ status: 502 });
    await expect(readOwnerSeat('scope-a', 'v1', a.ask, { store })).rejects.toMatchObject({ status: 502 });
    expect(a.calls).toHaveLength(2);
    expect(store.data.size).toBe(0);
  });

  it('expires, so a 501 about the scope rather than the code cannot hide a seat for good', async () => {
    const store = memoryStore();
    let t = 1_000;
    const now = () => t;
    await readOwnerSeat('scope-a', 'v1', asker(absent).ask, { store, now });
    const b = asker(present);
    t += ABSENT_TTL_MS - 1;
    expect(await readOwnerSeat('scope-a', 'v1', b.ask, { store, now })).toBeNull();
    t += 1;
    expect(await readOwnerSeat('scope-a', 'v1', b.ask, { store, now })).toEqual(SEAT);
    expect(b.calls).toEqual(['scope-a']);
  });

  it('asks as before when storage is unavailable or holds garbage', async () => {
    const a = asker(absent);
    expect(await readOwnerSeat('scope-a', 'v1', a.ask, { store: null })).toBeNull();
    expect(await readOwnerSeat('scope-a', 'v1', a.ask, { store: null })).toBeNull();
    expect(a.calls).toHaveLength(2);

    const store = memoryStore();
    store.data.set('substrat.dash.owner-seat-absent:scope-a', '{not json');
    const b = asker(present);
    expect(await readOwnerSeat('scope-a', 'v1', b.ask, { store })).toEqual(SEAT);
  });
  it('coalesces reads in flight for one scope and version — the memo is written too late to', async () => {
    // The memo only exists once `ask` has REJECTED. Two reads that start before that
    // both miss it, so "ask once per version" needed the in-flight join as well: this is
    // navigating away and back while the first 501 is still outstanding.
    const store = memoryStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const a = asker(async () => {
      await gate;
      throw new StatusError(501);
    });
    const both = Promise.all([
      readOwnerSeat('scope-join', 'v1', a.ask, { store }),
      readOwnerSeat('scope-join', 'v1', a.ask, { store }),
    ]);
    release!();
    expect(await both).toEqual([null, null]);
    expect(a.calls).toEqual(['scope-join']);
  });

  it('does not join reads for different versions of one scope', async () => {
    const store = memoryStore();
    const a = asker(present);
    const [x, y] = await Promise.all([
      readOwnerSeat('scope-split', 'v1', a.ask, { store }),
      readOwnerSeat('scope-split', 'v2', a.ask, { store }),
    ]);
    expect([x, y]).toEqual([SEAT, SEAT]);
    expect(a.calls).toHaveLength(2);
  });

  it('shares a non-501 rejection with the joined read, and remembers neither', async () => {
    const store = memoryStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const a = asker(async () => {
      await gate;
      throw new StatusError(502);
    });
    const first = readOwnerSeat('scope-boom', 'v1', a.ask, { store });
    const second = readOwnerSeat('scope-boom', 'v1', a.ask, { store });
    release!();
    await expect(first).rejects.toMatchObject({ status: 502 });
    await expect(second).rejects.toMatchObject({ status: 502 });
    expect(a.calls).toEqual(['scope-boom']);
    expect(store.data.size).toBe(0);
    // The window closed, so the next read is a real one rather than a joined corpse.
    const b = asker(present);
    expect(await readOwnerSeat('scope-boom', 'v1', b.ask, { store })).toEqual(SEAT);
  });

  it('refuses a stamp from the future, which a negative age would otherwise keep fresh', async () => {
    // A clock rolled back between the write and the read. `now - at` goes negative, which
    // satisfies the TTL just as a fresh entry does — so the seat would stay hidden until
    // the clock caught up, which is exactly what the TTL exists to prevent.
    const store = memoryStore();
    store.data.set(
      'substrat.dash.owner-seat-absent:scope-a',
      JSON.stringify({ versionId: 'v1', at: 5_000_000 }),
    );
    const a = asker(present);
    expect(await readOwnerSeat('scope-a', 'v1', a.ask, { store, now: () => 1_000 })).toEqual(SEAT);
    expect(a.calls).toEqual(['scope-a']);
  });

  it('refuses a non-finite stamp, which JSON.parse produces from a corrupted entry', async () => {
    // `1e999` is valid JSON and parses to Infinity, which passes a `typeof === 'number'`
    // check and makes the age -Infinity — remembered for ever.
    const store = memoryStore();
    store.data.set('substrat.dash.owner-seat-absent:scope-a', '{"versionId":"v1","at":1e999}');
    const a = asker(present);
    expect(await readOwnerSeat('scope-a', 'v1', a.ask, { store, now: () => 1_000 })).toEqual(SEAT);
    expect(a.calls).toEqual(['scope-a']);
  });
});
