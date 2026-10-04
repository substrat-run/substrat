import { describe, expect, it } from 'vitest';
import { businessChange } from '../src/lib/pulse-rows';

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
