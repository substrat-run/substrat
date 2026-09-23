import { describe, expect, it } from 'vitest';
import { resolveObservabilityWindow, observabilityBucketMinutes } from '../src/observability-window.js';
describe('absolute telemetry windows', () => {
  const now = Date.parse('2026-09-23T10:00:00Z');
  it('resolves hours compatibly and canonicalizes offsets', () => {
    expect(resolveObservabilityWindow({ hours: 1 }, now)).toEqual({
      since: '2026-09-23T09:00:00.000Z',
      until: '2026-09-23T10:00:00.000Z',
    });
    const w = resolveObservabilityWindow(
      { hours: 72, since: '2026-09-01T10:00:00+02:00', until: '2026-09-01T11:00:00+02:00' },
      now,
    );
    expect(w.since).toBe('2026-09-01T08:00:00.000Z');
    expect(observabilityBucketMinutes(w)).toBe(15);
  });
  it('refuses partial, reversed, invalid and oversized absolute windows', () => {
    for (const input of [
      { hours: 24, since: '2026-09-01T00:00:00Z' },
      { hours: 24, since: 'bad', until: 'bad' },
      { hours: 24, since: '2026-09-01T00:00:00Z', until: '2026-09-05T00:00:00Z' },
      { hours: 24, since: '2026-09-01T00:00:00Z', until: '2026-08-01T00:00:00Z' },
    ])
      expect(() => resolveObservabilityWindow(input, now)).toThrow();
  });
});
