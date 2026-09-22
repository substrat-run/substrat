import { describe, expect, it } from 'vitest';
import type { ConnectorCallsBucket } from '../src/lib/api';
import { ApiError } from '../src/lib/api';
import { connectorCallsFailure, connectorCallsNote, connectorCallsSeries } from '../src/lib/connector-calls';

/** The chart's grid (#1691): zero-filled, shared across providers, coloured to sum. */
const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-22T12:34:00Z');

const bucket = (provider: string, start: string, over: Partial<ConnectorCallsBucket> = {}): ConnectorCallsBucket => ({
  provider,
  start,
  bucketMinutes: 60,
  calls: 10,
  errors: 0,
  ok: 10,
  class4xx: 0,
  class5xx: 0,
  timeouts: 0,
  failed: 0,
  durationP50: 100,
  durationP95: 200,
  ...over,
});

describe('connectorCallsSeries (#1691)', () => {
  it('zero-fills the whole window, ending with the bucket now falls in', () => {
    const [s] = connectorCallsSeries([bucket('scrive', '2026-09-22T10:00:00Z')], 24, NOW);
    expect(s!.cells).toHaveLength(24);
    expect(s!.cells.at(-1)!.start).toBe('2026-09-22T12:00:00.000Z');
    expect(s!.cells[0]!.start).toBe(new Date(Date.parse('2026-09-22T12:00:00Z') - 23 * HOUR).toISOString());
    // The silent hours around the one busy hour are drawn as zeros, not joined over.
    const busy = s!.cells.findIndex((c) => c.calls > 0);
    expect(s!.cells[busy]!.start).toBe('2026-09-22T10:00:00.000Z');
    expect(s!.cells.filter((c) => c.calls === 0)).toHaveLength(23);
  });

  it('colours each bucket so green + yellow + red is its calls — timeouts and throws are red', () => {
    const [s] = connectorCallsSeries(
      [bucket('fortnox', '2026-09-22T11:00:00Z', { calls: 40, ok: 30, class4xx: 4, class5xx: 3, timeouts: 1, failed: 2 })],
      6,
      NOW,
    );
    const cell = s!.cells.find((c) => c.calls > 0)!;
    expect(cell).toMatchObject({ green: 30, yellow: 4, red: 6 });
    expect(cell.green + cell.yellow + cell.red).toBe(cell.calls);
    expect(s!.totals).toEqual({ calls: 40, green: 30, yellow: 4, red: 6 });
  });

  it('lists providers worst first, and one with no calls not at all', () => {
    const series = connectorCallsSeries(
      [
        bucket('scrive', '2026-09-22T11:00:00Z'),
        bucket('fortnox', '2026-09-22T11:00:00Z', { calls: 5, ok: 2, class5xx: 3 }),
        bucket('planima', '2026-09-22T11:00:00Z', { calls: 0, ok: 0 }),
      ],
      24,
      NOW,
    );
    expect(series.map((s) => s.provider)).toEqual(['fortnox', 'scrive']);
  });
});

describe('an unconfigured control plane is said, never drawn as zero (#1691)', () => {
  it('a 501 reads as unconfigured, and the chart says so rather than "no calls"', () => {
    const state = connectorCallsFailure(new ApiError(501, 'connector-call analytics are not configured'));
    expect(state).toBe('unconfigured');
    const note = connectorCallsNote(state, undefined);
    expect(note).toMatch(/not configured/);
    expect(note).not.toMatch(/No connector calls/);
  });

  it('its positive twin: a configured plane with an empty window says "no calls"', () => {
    expect(connectorCallsNote('ready', [])).toBe('No connector calls in this window.');
  });

  it('any other failure is an error, not "unconfigured"', () => {
    expect(connectorCallsFailure(new ApiError(500, 'boom'))).toBe('error');
    expect(connectorCallsFailure(new Error('network'))).toBe('error');
  });
});
