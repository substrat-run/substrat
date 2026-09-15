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
});
