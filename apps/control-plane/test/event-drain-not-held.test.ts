import { describe, expect, it } from 'vitest';
import type { ScopeId, TenantId } from '@substrat-run/contracts';
import { newlyNotHeld } from '../src/event-drain-not-held.js';

const T = 'tenant-a' as TenantId;
const gone = (id: string) => ({ tenantId: T, scopeId: id as ScopeId });

describe('newlyNotHeld (#2544)', () => {
  it('files a scope once while it stays not held, over several ticks', () => {
    const recorded = new Set<string>();
    expect(newlyNotHeld(recorded, [gone('s1')])).toEqual([gone('s1')]);
    expect(newlyNotHeld(recorded, [gone('s1')])).toEqual([]);
    expect(newlyNotHeld(recorded, [gone('s1')])).toEqual([]);
  });

  it('files it again after a pass in which it was held again, and files a second scope alone', () => {
    const recorded = new Set<string>();
    newlyNotHeld(recorded, [gone('s1')]);
    expect(newlyNotHeld(recorded, [gone('s1'), gone('s2')])).toEqual([gone('s2')]);
    expect(newlyNotHeld(recorded, undefined)).toEqual([]);
    expect(newlyNotHeld(recorded, [gone('s1')])).toEqual([gone('s1')]);
  });
});
