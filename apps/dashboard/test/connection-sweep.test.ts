import { describe, expect, it } from 'vitest';
import { SWEEP_RUN_RETENTION_DAYS } from '@substrat-run/kernel';
import { deriveConnectionSweep } from '../src/connection-sweep.js';

const conn = (connectionId: string, provider: string, status = 'active') => ({ connectionId, provider, status });

describe('deriveConnectionSweep (#1234)', () => {
  it('carries the newest run per connection, and whether it failed', () => {
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'scrive')],
      sightings: [
        { connectionId: 'c1', at: '2026-09-01T00:00:00Z', outcome: 'ok' },
        { connectionId: 'c1', at: '2026-09-10T00:00:00Z', outcome: 'failed' },
        { connectionId: 'c1', at: '2026-09-05T00:00:00Z', outcome: 'ok' },
      ],
    });
    expect(v.rows[0]!.lastSweptAt).toBe('2026-09-10T00:00:00Z');
    expect(v.rows[0]!.lastOutcomeFailed).toBe(true);
    expect(v.rows[0]!.idle).toBe(false);
  });

  it('calls a usable connection with no retained run IDLE', () => {
    const v = deriveConnectionSweep({ connections: [conn('c1', 'scrive')], sightings: [] });
    expect(v.rows[0]!.idle).toBe(true);
    expect(v.idleCount).toBe(1);
    // No run means nothing to judge — NOT a passing outcome.
    expect(v.rows[0]!.lastOutcomeFailed).toBeNull();
    expect(v.rows[0]!.lastSweptAt).toBeNull();
  });

  it('does NOT call a lapsed connection idle as well', () => {
    // Two findings for one fact, pointing at the wrong fix: the story is the lapse, and
    // "it has not been used lately" follows from it rather than adding anything.
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'scrive', 'expired'), conn('c2', 'fortnox', 'revoked')],
      sightings: [],
    });
    expect(v.rows.every((r) => r.idle)).toBe(false);
    expect(v.idleCount).toBe(0);
    // …but their absence of runs is still reported truthfully.
    expect(v.rows.every((r) => r.lastSweptAt === null)).toBe(true);
  });

  it('reports the retained window, read from the pruner rather than written down', () => {
    // "No runs" is bounded by what is kept. A connection swept monthly has no row here
    // either, and calling that unused would send someone to disconnect a working
    // integration — so the copy has to say what the absence is bounded by, and the
    // number has to come from the same constant the pruner uses.
    const v = deriveConnectionSweep({ connections: [], sightings: [] });
    expect(v.windowDays).toBe(SWEEP_RUN_RETENTION_DAYS);
  });

  it('sorts idle first, then a failing run, then by provider', () => {
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'zulu'), conn('c2', 'alpha'), conn('c3', 'beta')],
      sightings: [
        { connectionId: 'c2', at: '2026-09-10T00:00:00Z', outcome: 'failed' },
        { connectionId: 'c3', at: '2026-09-10T00:00:00Z', outcome: 'ok' },
      ],
    });
    expect(v.rows.map((r) => r.provider)).toEqual(['zulu', 'alpha', 'beta']);
  });

  it('ignores a sighting for a connection this app does not hold', () => {
    // The sweep log is tenant-wide; a run for another vertical's connection is not
    // this app's row to render.
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'scrive')],
      sightings: [{ connectionId: 'other', at: '2026-09-10T00:00:00Z', outcome: 'ok' }],
    });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]!.idle).toBe(true);
  });
});
