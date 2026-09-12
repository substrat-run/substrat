import { describe, it, expect } from 'vitest';
import { calendarDate, instant } from '../src/ids.js';

/**
 * `calendarDate` is the other half of the time contract `instant` opens (#117):
 * a day on a wall calendar, with no time and no zone. It is a REAL date check,
 * not a shape check — the hand-rolled regex it replaces in engine-absence
 * accepted `2026-13-45` — and it refuses anything that carries a time or a
 * zone, because a value that does is an instant, and the two must never be
 * coerced.
 */
describe('calendarDate', () => {
  it('accepts a real YYYY-MM-DD day, verbatim', () => {
    expect(calendarDate.parse('2026-02-28')).toBe('2026-02-28');
    expect(calendarDate.parse('2024-02-29')).toBe('2024-02-29'); // leap day
    expect(calendarDate.parse('2026-12-31')).toBe('2026-12-31');
  });

  it('refuses a day that is not on the calendar', () => {
    expect(() => calendarDate.parse('2026-02-30')).toThrow();
    expect(() => calendarDate.parse('2026-13-45')).toThrow(); // the old regex took this
    expect(() => calendarDate.parse('2026-00-10')).toThrow();
    expect(() => calendarDate.parse('2025-02-29')).toThrow(); // not a leap year
  });

  it('refuses an instant — a date is not a moment', () => {
    expect(() => calendarDate.parse('2026-02-28T00:00:00Z')).toThrow();
    expect(() => calendarDate.parse('2026-02-28T00:00:00.000Z')).toThrow();
    expect(() => calendarDate.parse(instant.parse('2026-02-28T09:00:00Z'))).toThrow();
  });

  it('refuses a date that carries a zone or a time', () => {
    expect(() => calendarDate.parse('2026-02-28Z')).toThrow();
    expect(() => calendarDate.parse('2026-02-28+02:00')).toThrow();
    expect(() => calendarDate.parse('2026-02-28 09:00')).toThrow();
  });

  it('refuses every other spelling of a day', () => {
    expect(() => calendarDate.parse('28-02-2026')).toThrow();
    expect(() => calendarDate.parse('2026-2-8')).toThrow();
    expect(() => calendarDate.parse('20260228')).toThrow();
    expect(() => calendarDate.parse('yesterday')).toThrow();
  });

  it('is not what instant accepts, and instant is not what it accepts', () => {
    expect(() => instant.parse('2026-02-28')).toThrow();
    expect(() => calendarDate.parse('2026-02-28T09:00:00+02:00')).toThrow();
  });
});
