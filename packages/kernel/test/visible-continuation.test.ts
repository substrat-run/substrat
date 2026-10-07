import { describe, expect, it } from 'vitest';
import {
  visibleContinuation,
  type ContinuationKeys,
  type ContinuationPosition,
  type ContinuationStore,
} from '../src/visible-continuation.js';

function memoryStore(): ContinuationStore & { clearKeys(): void; stored(): ContinuationPosition[] } {
  let keys: ContinuationKeys | null = null;
  const positions = new Map<string, ContinuationPosition>();
  return {
    keys: async () => keys,
    setKeys: async (next) => { keys = next; },
    position: async (id, expiry) => positions.get(`${expiry}:${id}`) ?? null,
    setPosition: async (id, position) => { positions.set(`${position.expiresAt}:${id}`, position); },
    clearKeys: () => { keys = null; },
    stored: () => [...positions.values()],
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
    expect(await codec.open(token)).toBe(position);
  });

  it('keeps token length fixed across positions of very different lengths', async () => {
    const codec = visibleContinuation(memoryStore(), binding, () => 1_000);
    const short = await codec.seal('a');
    const long = await codec.seal('secret-sort-value'.repeat(2_000));
    expect(long.length).toBe(short.length);
    expect(await codec.open(long)).toBe('secret-sort-value'.repeat(2_000));
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
    ];
    for (const change of changes) {
      await expect(visibleContinuation(store, { ...binding, ...change }, () => 1_000).open(token))
        .rejects.toThrow(/restart paging/);
    }
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    await expect(codec.open(token.slice(0, -1) + last)).rejects.toThrow(/restart paging/);
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
    expect(await codec.open(prior)).toBe('prior');
    expect(await codec.open(current)).toBe('current');
    await expect(codec.open(expired)).rejects.toThrow(/restart paging/);
    store.clearKeys();
    await expect(codec.open(current)).rejects.toThrow(/restart paging/);
  });
});
