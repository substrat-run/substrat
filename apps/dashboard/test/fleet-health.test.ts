import { describe, expect, it } from 'vitest';
import { instant, type OpsFailureEntry, type SweepRunEntry } from '@substrat-run/contracts';
import { deriveFleetHealth } from '../src/fleet-health.js';

const A = 'scope-a';
const B = 'scope-b';
const C = 'scope-c';
const D = 'scope-d';

const sweep = (scopeId: string, over: Partial<SweepRunEntry> = {}): SweepRunEntry =>
  ({ scopeId, kind: 'schedule', outcome: 'ok', at: instant.parse('2026-09-10T10:00:00.000Z'), ...over }) as SweepRunEntry;
const failure = (scopeId: string): OpsFailureEntry => ({ scopeId }) as OpsFailureEntry;

describe('deriveFleetHealth (#1238)', () => {
  it('ranks worst first — the ordering IS the feature', () => {
    const rows = deriveFleetHealth({
      scopeIds: [C, A, B, D],
      failures: [failure(A)],
      sweeps: [
        sweep(A),
        sweep(B, { kind: 'freshness', outcome: 'failed' }),
        sweep(C),
        // D has no sweep rows at all.
      ],
    });
    expect(rows.map((r) => r.scopeId)).toEqual([A, B, D, C]);
    expect(rows.map((r) => r.state)).toEqual(['failing', 'stale', 'silent', 'ok']);
  });

  it('calls an unswept app SILENT, never ok', () => {
    // The distinction the whole initiative turns on: nothing has checked this app,
    // which is not the same as nothing being wrong with it. Rendering silence as
    // success is the failure mode every view here is built to refuse.
    const [row] = deriveFleetHealth({ scopeIds: [A], failures: [], sweeps: [] });
    expect(row!.state).toBe('silent');
    expect(row!.reason).toMatch(/nothing is checking it/);
    expect(row!.lastSweepAt).toBeNull();
  });

  it('a failed sweep is failing even with no ops failures, and says which', () => {
    const [row] = deriveFleetHealth({
      scopeIds: [A],
      failures: [],
      sweeps: [sweep(A, { outcome: 'failed' })],
    });
    expect(row!.state).toBe('failing');
    expect(row!.sweepFailures).toBe(1);
    expect(row!.reason).toBe('1 failed sweep recorded.');
  });

  it('counts both sources in one sentence when both are present', () => {
    const [row] = deriveFleetHealth({
      scopeIds: [A],
      failures: [failure(A), failure(A)],
      sweeps: [sweep(A, { outcome: 'failed' })],
    });
    expect(row!.reason).toBe('2 failures and 1 failed sweep recorded.');
  });

  it('reports the newest sweep instant, whatever order the rows arrive in', () => {
    const [row] = deriveFleetHealth({
      scopeIds: [A],
      failures: [],
      sweeps: [
        sweep(A, { at: instant.parse('2026-09-10T08:00:00.000Z') }),
        sweep(A, { at: instant.parse('2026-09-10T12:00:00.000Z') }),
        sweep(A, { at: instant.parse('2026-09-10T09:00:00.000Z') }),
      ],
    });
    expect(row!.lastSweepAt).toBe('2026-09-10T12:00:00.000Z');
  });

  it('never attributes another app’s signals', () => {
    const rows = deriveFleetHealth({
      scopeIds: [A, B],
      failures: [failure(B)],
      sweeps: [sweep(A), sweep(B)],
    });
    expect(rows.find((r) => r.scopeId === A)!.state).toBe('ok');
    expect(rows.find((r) => r.scopeId === B)!.state).toBe('failing');
  });

  it('reads UNKNOWN, not ok, when the signals could not be read', () => {
    // An unavailable read must not render as a clean bill of health for every app.
    const rows = deriveFleetHealth({ scopeIds: [A, B], failures: [], sweeps: [], available: false });
    expect(rows.every((r) => r.state === 'unknown')).toBe(true);
    expect(rows[0]!.reason).toMatch(/unavailable/);
  });
});
