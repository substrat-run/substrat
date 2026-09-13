import { describe, expect, it } from 'vitest';
import type { OpsFailureEntry, SweepRunEntry } from '@substrat-run/contracts';
import { OVERLAY_MARKER_CAP, deriveAppOverlays } from '../src/overlays.js';

/**
 * The overlay rules (#1447 step 3b). Every one of them is about what an instant MEANS —
 * which is why they are tested here rather than read off a rendered chart: a marker in
 * the wrong place, or a stale span that ends where it should continue, is a chart that
 * lies quietly.
 */
describe('deriveAppOverlays', () => {
  const NOW = new Date('2026-09-13T12:00:00.000Z');
  const SCOPE = '01J2Q8Z3V9K4W7X2M5N6P789AB';
  const OTHER = '01J2Q8Z3V9K4W7X2M5N6P789CD';
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

  // The fixtures are written in plain strings and cast once at the seam: `at` and
  // `scopeId` are branded in contracts, and a test that had to mint brands for every row
  // would be testing the brands rather than the rules.
  const sweep = (r: {
    at: string;
    kind?: SweepRunEntry['kind'];
    unit?: string;
    outcome?: SweepRunEntry['outcome'];
    error?: string | null;
    eventType?: string | null;
  }): SweepRunEntry =>
    ({
      id: `01J${r.at}`,
      kind: 'schedule',
      unit: `${SCOPE}:crm/sync`,
      outcome: 'ok',
      tenantId: null,
      scopeId: SCOPE,
      vertical: 'crm',
      version: null,
      operation: null,
      connectionId: null,
      error: null,
      elapsedMs: null,
      eventType: null,
      observedAt: null,
      ...r,
    }) as unknown as SweepRunEntry;

  const freshness = (unit: string, at: string, outcome: 'ok' | 'failed' | 'skipped', eventType: string | null = null) =>
    sweep({ kind: 'freshness', unit, at, outcome, eventType });

  const failure = (f: {
    at: string;
    scopeId?: string;
    operation?: string;
    stage?: string | null;
    code?: string | null;
    message?: string;
  }): OpsFailureEntry =>
    ({
      id: `01J${f.at}`,
      actor: 'dana@acme.example',
      operation: 'POST /api/orders',
      stage: null,
      tenantId: null,
      scopeId: SCOPE,
      vertical: 'crm',
      version: null,
      status: 500,
      origin: 'platform',
      code: null,
      message: 'boom',
      reference: null,
      fingerprint: null,
      ...f,
    }) as unknown as OpsFailureEntry;

  const derive = (input: Partial<Parameters<typeof deriveAppOverlays>[0]>) =>
    deriveAppOverlays({
      migrations: [],
      sweepRuns: [],
      failures: [],
      scopeId: SCOPE,
      hours: 24,
      now: NOW,
      ...input,
    });

  it('draws a migration per applied row in the window, and never one without an instant', () => {
    const { markers } = derive({
      migrations: [
        { moduleId: 'crm', version: '0003-owner-index', appliedAt: hoursAgo(2) },
        // Outside the window — the chart is 24h and this ran last week.
        { moduleId: 'crm', version: '0002-contacts', appliedAt: hoursAgo(200) },
        // Predates the recording of the instant: no instant, no marker.
        { moduleId: 'crm', version: '0001-init', appliedAt: null },
      ],
    });
    expect(markers).toEqual([
      { at: hoursAgo(2), kind: 'migration', label: 'crm 0003-owner-index', detail: null },
    ]);
  });

  it('draws a failed schedule run, and only a failed one', () => {
    const { markers } = derive({
      sweepRuns: [
        sweep({ at: hoursAgo(3), outcome: 'failed', error: 'upstream 502' }),
        sweep({ at: hoursAgo(4), outcome: 'ok' }),
        sweep({ at: hoursAgo(5), outcome: 'skipped' }),
        // A failed CONNECTOR sweep is not this app's schedule.
        sweep({ at: hoursAgo(6), kind: 'connector', outcome: 'failed', unit: 'conn-1' }),
        // Outside the window.
        sweep({ at: hoursAgo(48), outcome: 'failed' }),
      ],
    });
    expect(markers).toEqual([
      { at: hoursAgo(3), kind: 'run-failed', label: `${SCOPE}:crm/sync`, detail: 'upstream 502' },
    ]);
  });

  it('draws a failure for THIS scope only, labelled by operation and stage', () => {
    const { markers } = derive({
      failures: [
        failure({ at: hoursAgo(1), stage: 'upload', code: 'deploy.rejected' }),
        // Same vertical, another installation — the read carries no scope filter, so
        // this is where another tenant's incident is kept off this chart.
        failure({ at: hoursAgo(2), scopeId: OTHER }),
        failure({ at: hoursAgo(60) }),
      ],
    });
    expect(markers).toEqual([
      { at: hoursAgo(1), kind: 'failure', label: 'POST /api/orders · upload', detail: 'deploy.rejected' },
    ]);
  });

  it('falls back to the message for a failure with no code, capped at 120 characters', () => {
    const { markers } = derive({ failures: [failure({ at: hoursAgo(1), message: 'x'.repeat(400) })] });
    expect(markers[0]!.detail).toBe('x'.repeat(120));
  });

  it('orders markers oldest first, across kinds', () => {
    const { markers } = derive({
      migrations: [{ moduleId: 'crm', version: '0003', appliedAt: hoursAgo(4) }],
      sweepRuns: [sweep({ at: hoursAgo(2), outcome: 'failed' })],
      failures: [failure({ at: hoursAgo(6) })],
    });
    expect(markers.map((m) => m.kind)).toEqual(['failure', 'migration', 'run-failed']);
  });

  it('keeps the NEWEST markers at the cap and admits the rest were dropped', () => {
    const many = Array.from({ length: OVERLAY_MARKER_CAP + 5 }, (_, i) =>
      failure({ at: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(), message: `m${i}` }),
    );
    const { markers, truncated } = derive({ failures: many });
    expect(truncated).toBe(true);
    expect(markers).toHaveLength(OVERLAY_MARKER_CAP);
    // `m0` is the newest row; the oldest (`m304`) is the one that went.
    expect(markers[markers.length - 1]!.detail).toBe('m0');
    expect(markers.some((m) => m.detail === `m${OVERLAY_MARKER_CAP + 4}`)).toBe(false);
    expect(derive({ failures: many.slice(0, OVERLAY_MARKER_CAP) }).truncated).toBe(false);
  });

  describe('stale spans', () => {
    const unit = `${SCOPE}:receipt.landed`;

    it('runs from the failed verdict to the ok that ends it', () => {
      const { spans } = derive({
        sweepRuns: [
          freshness(unit, hoursAgo(8), 'failed', 'receipt.landed'),
          freshness(unit, hoursAgo(3), 'ok', 'receipt.landed'),
        ],
      });
      expect(spans).toEqual([
        { from: hoursAgo(8), to: hoursAgo(3), kind: 'stale', label: 'receipt.landed' },
      ]);
    });

    it('runs to now while nothing has said otherwise', () => {
      const { spans } = derive({ sweepRuns: [freshness(unit, hoursAgo(5), 'failed')] });
      // No eventType on the row — the unit is the honest label.
      expect(spans).toEqual([{ from: hoursAgo(5), to: hoursAgo(0), kind: 'stale', label: unit }]);
    });

    it('shades from the window edge when it was already stale before the window', () => {
      const { spans } = derive({
        sweepRuns: [freshness(unit, hoursAgo(70), 'failed'), freshness(unit, hoursAgo(6), 'ok')],
      });
      expect(spans).toEqual([{ from: hoursAgo(24), to: hoursAgo(6), kind: 'stale', label: unit }]);
    });

    it('drops a span that closed before the window began', () => {
      const { spans } = derive({
        sweepRuns: [freshness(unit, hoursAgo(70), 'failed'), freshness(unit, hoursAgo(30), 'ok')],
      });
      expect(spans).toEqual([]);
    });

    it('never opens or closes on a skip — never-seen is not stale', () => {
      expect(derive({ sweepRuns: [freshness(unit, hoursAgo(5), 'skipped')] }).spans).toEqual([]);
      const { spans } = derive({
        sweepRuns: [
          freshness(unit, hoursAgo(8), 'failed'),
          freshness(unit, hoursAgo(5), 'skipped'),
          freshness(unit, hoursAgo(2), 'ok'),
        ],
      });
      expect(spans).toEqual([{ from: hoursAgo(8), to: hoursAgo(2), kind: 'stale', label: unit }]);
    });

    it('keeps two units independent, oldest span first', () => {
      const other = `${SCOPE}:invoice.exported`;
      const { spans } = derive({
        sweepRuns: [
          freshness(unit, hoursAgo(4), 'failed', 'receipt.landed'),
          freshness(other, hoursAgo(9), 'failed', 'invoice.exported'),
          // The ok belongs to `unit` alone and must not close the other one.
          freshness(unit, hoursAgo(1), 'ok', 'receipt.landed'),
        ],
      });
      expect(spans).toEqual([
        { from: hoursAgo(9), to: hoursAgo(0), kind: 'stale', label: 'invoice.exported' },
        { from: hoursAgo(4), to: hoursAgo(1), kind: 'stale', label: 'receipt.landed' },
      ]);
    });

    it('never runs past now, even when a row is stamped in the future', () => {
      // The rows are written by the scope's own sweeper; a clock ahead of the
      // dashboard's must not shade a span into the chart's empty right-hand side.
      const { spans } = derive({
        sweepRuns: [freshness(unit, hoursAgo(4), 'failed'), freshness(unit, hoursAgo(-2), 'ok')],
      });
      expect(spans).toEqual([{ from: hoursAgo(4), to: hoursAgo(0), kind: 'stale', label: unit }]);
    });

    it('keys spans by UNIT, so two units sharing an event type stay apart', () => {
      // The unit is the identity the sweeper writes (`<scopeId>:<eventType>`); the event
      // type is only its label, and two units reading stale at once are two spans.
      const a = `${SCOPE}:receipt.landed`;
      const b = `${OTHER}:receipt.landed`;
      const { spans } = derive({
        sweepRuns: [
          freshness(a, hoursAgo(6), 'failed', 'receipt.landed'),
          freshness(b, hoursAgo(4), 'failed', 'receipt.landed'),
          freshness(a, hoursAgo(2), 'ok', 'receipt.landed'),
        ],
      });
      expect(spans.map((sp) => [sp.from, sp.to])).toEqual([
        [hoursAgo(6), hoursAgo(2)],
        [hoursAgo(4), hoursAgo(0)],
      ]);
    });

    it('a re-open after an ok is its own span', () => {
      const { spans } = derive({
        sweepRuns: [
          freshness(unit, hoursAgo(10), 'failed'),
          freshness(unit, hoursAgo(8), 'ok'),
          freshness(unit, hoursAgo(6), 'failed'),
          freshness(unit, hoursAgo(5), 'ok'),
        ],
      });
      expect(spans.map((s) => [s.from, s.to])).toEqual([
        [hoursAgo(10), hoursAgo(8)],
        [hoursAgo(6), hoursAgo(5)],
      ]);
    });
  });
});
