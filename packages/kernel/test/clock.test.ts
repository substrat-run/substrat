import { describe, it, expect } from 'vitest';
import { frozenClock, manualClock } from '../src/clock.js';

/**
 * The test clocks route every value through `instant.parse`, so a caller that
 * hands in an offset string gets a UTC-normalised reading rather than one that
 * compares wrong against every other instant in the store (#963).
 */
describe('test clocks normalise what they are given', () => {
  it('frozenClock normalises an offset start', () => {
    expect(frozenClock('2026-08-28T10:00:00+02:00')()).toBe('2026-08-28T08:00:00.000Z');
  });

  it('manualClock normalises its start, its set, and keeps advancing from there', () => {
    const clock = manualClock('2026-08-28T10:00:00+02:00');
    expect(clock.now()).toBe('2026-08-28T08:00:00.000Z');
    expect(clock.advance(60_000)).toBe('2026-08-28T08:01:00.000Z');
    expect(clock.set('2026-08-28T12:00:00+02:00')).toBe('2026-08-28T10:00:00.000Z');
    expect(clock.read()).toBe('2026-08-28T10:00:00.000Z');
  });

  it('takes a Date as readily as a string', () => {
    expect(frozenClock(new Date('2026-08-28T08:00:00Z'))()).toBe('2026-08-28T08:00:00.000Z');
  });
});
