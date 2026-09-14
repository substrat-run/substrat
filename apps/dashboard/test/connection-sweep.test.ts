import { describe, expect, it } from 'vitest';
import { SWEEP_RUN_RETENTION_DAYS } from '@substrat-run/kernel';
import { deriveConnectionSweep, sweepWindowCutoff } from '../src/connection-sweep.js';

const NOW = '2026-09-14T12:00:00.000Z';
const conn = (connectionId: string, provider: string, status = 'active', label = `${provider} (${connectionId})`) => ({
  connectionId,
  provider,
  label,
  status,
});

describe('deriveConnectionSweep (#1234)', () => {
  it('carries the newest run per connection, and whether it failed', () => {
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'scrive')],
      sightings: [
        { connectionId: 'c1', at: '2026-09-01T00:00:00Z', outcome: 'ok' },
        { connectionId: 'c1', at: '2026-09-10T00:00:00Z', outcome: 'failed' },
        { connectionId: 'c1', at: '2026-09-05T00:00:00Z', outcome: 'ok' },
      ],
      now: NOW,
    });
    expect(v.rows[0]!.lastSweptAt).toBe('2026-09-10T00:00:00Z');
    expect(v.rows[0]!.lastOutcomeFailed).toBe(true);
    expect(v.rows[0]!.idle).toBe(false);
    expect(v.rows[0]!.unknown).toBe(false);
  });

  it('calls a usable connection with no retained run IDLE', () => {
    const v = deriveConnectionSweep({ connections: [conn('c1', 'scrive')], sightings: [], now: NOW });
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
      now: NOW,
    });
    expect(v.rows.every((r) => r.idle)).toBe(false);
    expect(v.idleCount).toBe(0);
    // …but their absence of runs is still reported truthfully.
    expect(v.rows.every((r) => r.lastSweptAt === null)).toBe(true);
  });

  it('does not count a `skipped` run as a use', () => {
    // A skip is the sweep saying "bound, but no sweeper registered": nothing went
    // through the connection. Rendering its timestamp as "last used" would tell a
    // builder an integration is working that nothing has ever polled.
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'planima')],
      sightings: [
        { connectionId: 'c1', at: '2026-09-13T00:00:00Z', outcome: 'skipped' },
        { connectionId: 'c1', at: '2026-09-12T00:00:00Z', outcome: 'skipped' },
      ],
      now: NOW,
    });
    expect(v.rows[0]!.lastSweptAt).toBeNull();
    expect(v.rows[0]!.lastOutcomeFailed).toBeNull();
    expect(v.rows[0]!.idle).toBe(true);
  });

  it('applies the window itself, against the clock it is handed', () => {
    // Prune-on-write is bounded by writes: if sweeping stops, a row older than the
    // window stays on disk. The cutoff is the derivation's, not the pruner's.
    const stale = new Date(new Date(NOW).getTime() - (SWEEP_RUN_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    const inside = new Date(new Date(NOW).getTime() - (SWEEP_RUN_RETENTION_DAYS - 1) * 86_400_000).toISOString();
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'scrive'), conn('c2', 'scrive')],
      sightings: [
        { connectionId: 'c1', at: stale, outcome: 'ok' },
        { connectionId: 'c2', at: inside, outcome: 'ok' },
      ],
      now: NOW,
    });
    const byId = new Map(v.rows.map((r) => [r.connectionId, r]));
    expect(byId.get('c1')!.lastSweptAt).toBeNull();
    expect(byId.get('c1')!.idle).toBe(true);
    expect(byId.get('c2')!.lastSweptAt).toBe(inside);
    expect(byId.get('c2')!.idle).toBe(false);
    expect(sweepWindowCutoff(NOW) < inside && sweepWindowCutoff(NOW) > stale).toBe(true);
  });

  it('refuses to call a connection idle when its record could not be read', () => {
    // Absence is evidence only when the read that would have found a row succeeded.
    // A plane predating the route, or a transport failure, is "unknown" — never a
    // finding, never a timestamp.
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'scrive'), conn('c2', 'fortnox')],
      sightings: [],
      now: NOW,
      unread: new Set(['c1']),
    });
    const byId = new Map(v.rows.map((r) => [r.connectionId, r]));
    expect(byId.get('c1')!.unknown).toBe(true);
    expect(byId.get('c1')!.idle).toBe(false);
    expect(byId.get('c1')!.lastSweptAt).toBeNull();
    expect(byId.get('c2')!.unknown).toBe(false);
    expect(byId.get('c2')!.idle).toBe(true);
    expect(v.idleCount).toBe(1);
  });

  it('carries the label, so two connections to one provider stay distinguishable', () => {
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'scrive', 'active', 'Nordljus (prod)'), conn('c2', 'scrive', 'active', 'Nordljus (test)')],
      sightings: [],
      now: NOW,
    });
    expect(v.rows.map((r) => r.label)).toEqual(['Nordljus (prod)', 'Nordljus (test)']);
  });

  it('reports the retained window, read from the pruner rather than written down', () => {
    // "No runs" is bounded by what is kept. A connection swept monthly has no row here
    // either, and calling that unused would send someone to disconnect a working
    // integration — so the copy has to say what the absence is bounded by, and the
    // number has to come from the same constant the pruner uses.
    const v = deriveConnectionSweep({ connections: [], sightings: [], now: NOW });
    expect(v.windowDays).toBe(SWEEP_RUN_RETENTION_DAYS);
  });

  it('sorts idle first, then a failing run, then by provider', () => {
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'zulu'), conn('c2', 'alpha'), conn('c3', 'beta')],
      sightings: [
        { connectionId: 'c2', at: '2026-09-10T00:00:00Z', outcome: 'failed' },
        { connectionId: 'c3', at: '2026-09-10T00:00:00Z', outcome: 'ok' },
      ],
      now: NOW,
    });
    expect(v.rows.map((r) => r.provider)).toEqual(['zulu', 'alpha', 'beta']);
  });

  it('ignores a sighting for a connection this app does not hold', () => {
    // The sweep log is tenant-wide; a run for another vertical's connection is not
    // this app's row to render.
    const v = deriveConnectionSweep({
      connections: [conn('c1', 'scrive')],
      sightings: [{ connectionId: 'other', at: '2026-09-10T00:00:00Z', outcome: 'ok' }],
      now: NOW,
    });
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]!.idle).toBe(true);
  });
});
