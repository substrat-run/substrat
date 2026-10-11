/**
 * Placement (#1638 Q1) and what resharding moves (Q4), as numbers rather than claims.
 */
import { describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { candidates, home, statefulSetMembers } from '../src/placement.js';

const scopes = Array.from({ length: 6000 }, () => ulid());

describe('rendezvous placement over StatefulSet pod names', () => {
  it('is a pure function: any router with the member list agrees, whatever order it lists them in', () => {
    const members = statefulSetMembers('todo', 4);
    const reversed = [...members].reverse();
    for (const s of scopes.slice(0, 500)) {
      expect(candidates(s, reversed)).toEqual(candidates(s, members));
    }
  });

  it('orders every member, home first — the failover order is the same everywhere too', () => {
    const members = statefulSetMembers('todo', 3);
    for (const s of scopes.slice(0, 100)) {
      const order = candidates(s, members);
      expect([...order].sort()).toEqual([...members].sort());
      expect(order[0]).toBe(home(s, members));
    }
  });

  it('spreads scopes evenly', () => {
    const members = statefulSetMembers('todo', 4);
    const counts = new Map<string, number>();
    for (const s of scopes) counts.set(home(s, members), (counts.get(home(s, members)) ?? 0) + 1);
    for (const m of members) {
      // 1500 expected each; ±10 % is far outside what 6000 uniform draws produce by chance.
      expect(counts.get(m)).toBeGreaterThan(1350);
      expect(counts.get(m)).toBeLessThan(1650);
    }
  });

  it.each([1, 2, 3, 7])('scaling %i → %i+1 moves about 1/(N+1) of the scopes, every one of them to the new pod', (n) => {
    const before = statefulSetMembers('todo', n);
    const after = statefulSetMembers('todo', n + 1);
    const added = after[n]!;
    let moved = 0;
    for (const s of scopes) {
      const was = home(s, before);
      const now = home(s, after);
      if (was !== now) {
        moved++;
        expect(now).toBe(added);
      }
    }
    const fraction = moved / scopes.length;
    expect(fraction).toBeGreaterThan(0.8 / (n + 1));
    expect(fraction).toBeLessThan(1.2 / (n + 1));
  });

  it('scaling down moves only the removed pod’s scopes', () => {
    const before = statefulSetMembers('todo', 4);
    const after = statefulSetMembers('todo', 3);
    for (const s of scopes) {
      const was = home(s, before);
      if (was !== 'todo-3') expect(home(s, after)).toBe(was);
    }
  });
});
