import { describe, expect, it } from 'vitest';
import type { BusinessVolumeRow } from '../src/lib/api';
import { businessChange, businessLabel, isBusinessOutcome } from '../src/lib/pulse-rows';

describe('Pulse business change (#1750)', () => {
  it('reads as a percentage against yesterday, `new` from nothing, and nothing from nothing', () => {
    expect(businessChange(6, 4)).toEqual({ text: '+50%', tone: 'up' });
    expect(businessChange(2, 4)).toEqual({ text: '−50%', tone: 'down' });
    expect(businessChange(4, 4)).toEqual({ text: '±0%', tone: 'flat' });
    expect(businessChange(0, 4)).toEqual({ text: '−100%', tone: 'down' });
    expect(businessChange(3, 0)).toEqual({ text: 'new', tone: 'up' });
    expect(businessChange(0, 0)).toBeNull();
  });
});

describe('Pulse business outcomes (#1750)', () => {
  const row = (state: string, terminal: boolean, fromInitial: boolean): BusinessVolumeRow =>
    ({ scopeId: 's', entityType: 'support-ticket', state, terminal, fromInitial, operations: [], today: 0, yesterday: 0, buckets: [] });
  it('an outcome opens or ends a record; anything else is a move, named as its edge', () => {
    expect([row('closed', true, false), row('in_progress', false, true), row('on_hold', false, false)].filter(isBusinessOutcome).map((r) => r.state))
      .toEqual(['closed', 'in_progress']);
    expect(businessLabel(row('closed', true, false))).toBe('support ticket closed');
    expect(businessLabel(row('in_progress', false, true))).toBe('support ticket in progress');
    expect(businessLabel(row('on_hold', false, false))).toBe('support ticket → on hold');
  });
});
