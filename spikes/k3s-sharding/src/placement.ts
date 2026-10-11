/**
 * Scope → shard placement (question 1 of #1638).
 *
 * Rendezvous (highest-random-weight) hashing over the StatefulSet's **stable pod names**
 * (`todo-0`, `todo-1`, …). It is a pure function of the scope id and the member list, so
 * the router needs no placement table and no coordination to agree with another router
 * replica: two routers with the same member list compute the same answer.
 *
 * The ordered list, not just the winner, is the useful output: `candidates(scope)[0]` is the
 * scope's home and the rest is the failover order, which every router also agrees on.
 *
 * Placement only says where a scope SHOULD be. Where it IS, and who may write it, is the
 * lease's answer (`lease-client.ts`): a router that sends a request to the wrong shard gets
 * a `421` naming the holder, so a stale or divergent placement costs a hop, never a write.
 *
 * Adding a member moves only the scopes whose new top weight is the new member — on
 * average 1/(N+1) of them (question 4), which `test/placement.test.ts` measures.
 */

/** FNV-1a 64-bit over UTF-8. Deterministic across processes and platforms; not cryptographic. */
function fnv1a64(input: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  // A final avalanche (splitmix64's), so members whose names differ in one trailing digit do
  // not produce correlated weights for the same scope.
  h ^= h >> 30n;
  h = (h * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
  h ^= h >> 27n;
  h = (h * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
  h ^= h >> 31n;
  return h;
}

/** Members ordered by their weight for `scopeId`, highest first: the home, then the failover order. */
export function candidates(scopeId: string, members: readonly string[]): string[] {
  if (members.length === 0) throw new Error('placement over no members');
  return [...members]
    .map((m) => ({ m, w: fnv1a64(`${m}\u0000${scopeId}`) }))
    .sort((a, b) => (a.w === b.w ? (a.m < b.m ? -1 : 1) : a.w > b.w ? -1 : 1))
    .map((x) => x.m);
}

/** The scope's home shard. */
export function home(scopeId: string, members: readonly string[]): string {
  return candidates(scopeId, members)[0]!;
}

/** The StatefulSet's pod names for `replicas` replicas of `name`. */
export function statefulSetMembers(name: string, replicas: number): string[] {
  return Array.from({ length: replicas }, (_, i) => `${name}-${i}`);
}
