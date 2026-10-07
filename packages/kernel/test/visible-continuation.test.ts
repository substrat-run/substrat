import { describe, expect, it, vi } from 'vitest';
import { pageOf, pageVisible, VISIBLE_SCAN_BUDGET } from '@substrat-run/contracts';
import {
  CONTINUATION_POSITION_CAP,
  visibleContinuation,
  type ContinuationKeys,
  type ContinuationPosition,
  type ContinuationStore,
} from '../src/visible-continuation.js';

function memoryStore(): ContinuationStore & { clearKeys(): void; stored(): ContinuationPosition[]; keyWrites(): number } {
  let keys: ContinuationKeys | null = null;
  let writes = 0;
  const positions = new Map<string, ContinuationPosition>();
  return {
    keys: async () => keys,
    setKeys: async (next) => { keys = next; writes += 1; },
    position: async (id, expiry) => positions.get(`${expiry}:${id}`) ?? null,
    setPosition: async (id, position) => {
      positions.set(`${position.expiresAt}:${id}`, position);
      while (positions.size > CONTINUATION_POSITION_CAP) positions.delete(positions.keys().next().value!);
    },
    clearKeys: () => { keys = null; },
    stored: () => [...positions.values()],
    keyWrites: () => writes,
  };
}

const binding = {
  scopeId: 'scope-a', principal: 'principal:ada', operation: 'todo/my-lists',
  list: 'list:my-lists', query: { view: 'archived', filters: { status: ['open', 'held'] }, sort: 'name' },
};

describe('sealed visible continuations (#2074)', () => {
  it('round-trips an arbitrary position without putting it in the token or private record plaintext', async () => {
    const store = memoryStore();
    const codec = visibleContinuation(store, binding, () => 1_000);
    const position = 'hidden-row-id|hidden-sort-value';
    const token = await codec.seal(position);
    expect(token).not.toContain(position);
    expect(JSON.stringify(store.stored())).not.toContain(position);
    expect(await codec.open(token!)).toBe(position);
  });

  it('keeps token length fixed across positions of very different lengths', async () => {
    const codec = visibleContinuation(memoryStore(), binding, () => 1_000);
    const short = await codec.seal('a');
    const long = await codec.seal('secret-sort-value'.repeat(2_000));
    expect(long!.length).toBe(short!.length);
    expect(await codec.open(long!)).toBe('secret-sort-value'.repeat(2_000));
  });

  it('keeps full-page positions stateless and seals them under the same wire grammar', async () => {
    const store = memoryStore();
    const codec = visibleContinuation(store, binding, () => 1_000);
    const short = await codec.seal('visible', false);
    const long = await codec.seal('long-visible-sort'.repeat(1_000), false);
    expect(short).toMatch(/^sc1\./);
    expect(store.stored()).toEqual([]);
    expect(long!.length).toBeGreaterThan(short!.length);
    expect(await codec.open(long!)).toBe('long-visible-sort'.repeat(1_000));
    await expect(visibleContinuation(store, { ...binding, principal: 'principal:bob' }, () => 1_000).open(long!))
      .rejects.toThrow(/restart paging/);
    await expect(visibleContinuation(store, binding, () => 1_000 + 15 * 60_000).open(short!))
      .rejects.toThrow(/restart paging/);
  });

  it('requires restart when the oldest budget-stop locator is evicted', async () => {
    const store = memoryStore();
    const codec = visibleContinuation(store, binding, () => 1_000);
    const first = await codec.seal('first hidden');
    for (let i = 0; i < CONTINUATION_POSITION_CAP; i++) await codec.seal(`hidden ${i}`);
    await expect(codec.open(first!)).rejects.toThrow(/restart paging/);
    expect(store.stored()).toHaveLength(CONTINUATION_POSITION_CAP);
  });

  it('accepts a syntactically valid legacy input, logs it, and seals new output', async () => {
    const used: string[] = [];
    const codec = visibleContinuation(memoryStore(), binding, () => 1_000, () => { used.push('legacy'); });
    const old = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const next = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const page = await pageVisible(
      ({ cursor }) => {
        expect(cursor).toBe(old);
        return { entries: [{ id: next }], rowCursors: [next], nextCursor: next };
      },
      { cursor: old, limit: 1 },
      () => true,
      { continuation: codec },
    );
    expect(used).toEqual(['legacy']);
    expect(page.nextCursor).toMatch(/^sc1\./);
    expect(await codec.open(page.nextCursor!)).toBe(next);
    await expect(codec.open('not a cursor')).rejects.toThrow(/restart paging/);
  });

  it('never returns a hidden plain position after a legacy input reaches the budget', async () => {
    const codec = visibleContinuation(memoryStore(), binding, () => 1_000);
    const old = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const hidden = 'hidden-row-private-sort-value';
    const page = await pageVisible(
      ({ cursor }) => {
        expect(cursor).toBe(old);
        return { entries: [{ id: hidden }], rowCursors: [hidden], nextCursor: hidden };
      },
      { cursor: old, limit: 1 }, () => false,
      { scanBudget: 1, continuation: codec },
    );
    expect(page).toEqual({ entries: [], nextCursor: expect.stringMatching(/^sc1\./) });
    expect(page.nextCursor).not.toContain(hidden);
    expect(await codec.open(page.nextCursor!)).toBe(hidden);
  });

  it('refuses tampering and replay under another caller, scope, list, sort, filter or grant constraint', async () => {
    const store = memoryStore();
    const codec = visibleContinuation(store, binding, () => 1_000);
    const token = await codec.seal('hidden-row');
    const changes = [
      { principal: 'principal:bob' },
      { scopeId: 'scope-b' },
      { list: 'list:other' },
      { query: { ...binding.query, sort: 'created_at' } },
      { query: { ...binding.query, filters: { status: ['closed'] } } },
      { query: { ...binding.query, grantConstraint: 'grant-b' } },
      { query: { ...binding.query, grantConstraint: new Set(['grant-b']) } },
    ];
    for (const change of changes) {
      await expect(visibleContinuation(store, { ...binding, ...change }, () => 1_000).open(token!))
        .rejects.toThrow(/restart paging/);
    }
    const payloadAt = token!.lastIndexOf('.') + 1;
    const changed = token![payloadAt] === 'A' ? 'B' : 'A';
    await expect(codec.open(token!.slice(0, payloadAt) + changed + token!.slice(payloadAt + 1)))
      .rejects.toThrow(/restart paging/);
  });

  it('treats reordered and repeated IN filter values as the same walk', async () => {
    const store = memoryStore();
    const codec = visibleContinuation(store, binding, () => 1_000);
    const token = await codec.seal('position', false);
    const reordered = { ...binding, query: { ...binding.query, filters: { status: ['held', 'open', 'open'] } } };
    expect(await visibleContinuation(store, reordered, () => 1_000).open(token!)).toBe('position');
  });

  it('does not write or fail a read-only sparse page at its budget stop', async () => {
    const store = memoryStore();
    const readonly = visibleContinuation(store, binding, () => 1_000, undefined, false);
    const page = await pageVisible(
      () => ({ entries: [{ id: 'hidden' }], rowCursors: ['hidden'], nextCursor: 'hidden' }),
      { limit: 1 }, () => false,
      { scanBudget: 1, continuation: readonly },
    );
    expect(page).toEqual({ entries: [], nextCursor: null });
    expect(store.stored()).toEqual([]);
    expect(await store.keys()).toBeNull();
  });

  it('keeps the full scan budget for a read-only walk with a visible row after 1,500 refusals', async () => {
    const randomness = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((bytes) => {
      bytes.fill(0);
      return bytes;
    });
    try {
      const store = memoryStore();
      const readonly = visibleContinuation(store, binding, () => 1_000, undefined, false);
      const rows = Array.from({ length: 1_600 }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}` }));
      const page = await pageVisible(
        ({ limit, cursor, rowCursors }) => pageOf(
          rows.filter((row) => cursor === undefined || row.id > cursor).slice(0, limit),
          limit,
          (row) => row.id,
          rowCursors,
        ),
        { limit: 1 },
        (row) => row.id === 'r1500',
        { continuation: readonly },
      );
      expect(page.entries).toEqual([{ id: 'r1500' }]);
      expect(page.nextCursor).toBe('r1500');
      expect(readonly.writable).toBe(false);
      expect(VISIBLE_SCAN_BUDGET).toBeGreaterThan(1_500);
      expect(store.stored()).toEqual([]);
      expect(store.keyWrites()).toBe(0);
      expect(randomness).not.toHaveBeenCalled();
    } finally {
      randomness.mockRestore();
    }
  });

  it('uses a visible plain cursor on a read-only full page without a key, then seals with a key', async () => {
    const store = memoryStore();
    const readonly = visibleContinuation(store, binding, () => 1_000, undefined, false);
    const fetch = () => ({ entries: [{ id: 'visible' }], rowCursors: ['visible'], nextCursor: 'visible' });
    const plain = await pageVisible(fetch, { limit: 1 }, () => true, { continuation: readonly });
    expect(plain.nextCursor).toBe('visible');
    expect(store.keyWrites()).toBe(0);
    const writable = visibleContinuation(store, binding, () => 1_000);
    expect((await pageVisible(fetch, { limit: 1 }, () => true, { continuation: writable })).nextCursor)
      .toMatch(/^sc1\./);
    expect(store.keyWrites()).toBe(1);
    expect((await pageVisible(fetch, { limit: 1 }, () => true, { continuation: readonly })).nextCursor)
      .toMatch(/^sc1\./);
    expect(store.keyWrites()).toBe(1);
  });

  it('expires, rotates while the prior key has live tokens, and invalidates on restore', async () => {
    const store = memoryStore();
    let at = 0;
    const codec = visibleContinuation(store, binding, () => at);
    const expired = await codec.seal('early');
    at = 24 * 60 * 60_000 - 5 * 60_000;
    const prior = await codec.seal('prior');
    at = 24 * 60 * 60_000 + 60_000;
    const current = await codec.seal('current');
    expect(store.keyWrites()).toBe(2);
    expect(await codec.open(prior!)).toBe('prior');
    expect(await codec.open(current!)).toBe('current');
    await expect(codec.open(expired!)).rejects.toThrow(/restart paging/);
    store.clearKeys();
    await expect(codec.open(current!)).rejects.toThrow(/restart paging/);
  });
});
