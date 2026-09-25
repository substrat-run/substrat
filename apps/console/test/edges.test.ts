import { describe, expect, it } from 'vitest';
import type { EdgeHealth, EdgeHealthReport } from '@substrat-run/contracts';
import { ApiError } from '../src/lib/api';
import { edgesCardState } from '../src/lib/edges';

const SCOPE = '01J0000000000000000000SCP0';
const edge = (over: Partial<EdgeHealth> = {}): EdgeHealth =>
  ({
    tenantId: '01J0000000000000000000TNT0',
    consumer: { scopeId: SCOPE, vertical: 'acme/board' },
    producer: { vertical: 'acme/crm', scopeId: '01J0000000000000000000PRD0' },
    state: 'caught-up',
    reason: null,
    watermark: null,
    oldestPending: null,
    lagMs: null,
    unexported: [],
    lastDelivered: null,
    lastProblem: null,
    ...over,
  }) as EdgeHealth;
const report = (edges: EdgeHealth[], over: Partial<EdgeHealthReport> = {}): EdgeHealthReport =>
  ({
    tenantId: '01J0000000000000000000TNT0',
    checkedAt: '2026-09-25T00:00:00.000Z',
    edges,
    unavailable: null,
    history: { available: true, reason: null },
    ...over,
  }) as EdgeHealthReport;

/** The card's own state. Labels, tones, lag and the lever request are contracts' (tested there). */
describe('the console Edges card (#1705 PR 3)', () => {
  it('a tenant whose apps could not be listed is an error, never an empty card', () => {
    expect(edgesCardState(report([], { unavailable: 'could not list' }), null, SCOPE)).toEqual({
      kind: 'error',
      message: 'could not list',
    });
    // The twin: a readable tenant with no edge here is an empty (hidden) card.
    expect(edgesCardState(report([]), null, SCOPE)).toEqual({ kind: 'ready', entries: [] });
  });

  it('a control plane that predates the route is its own state (501), not "no edges"', () => {
    expect(edgesCardState(null, new ApiError(501, 'predates'), SCOPE)).toEqual({ kind: 'predates' });
  });

  it("keeps only this scope's edges, in either direction", () => {
    const into = edge();
    const out = edge({
      consumer: { scopeId: '01J0000000000000000000OTH0' as EdgeHealth['consumer']['scopeId'], vertical: 'acme/x' },
      producer: { vertical: 'acme/board', scopeId: SCOPE as EdgeHealth['producer']['scopeId'] },
    });
    const elsewhere = edge({ consumer: { scopeId: '01J0000000000000000000OTH1' as EdgeHealth['consumer']['scopeId'], vertical: 'acme/y' } });
    expect(edgesCardState(report([into, out, elsewhere]), null, SCOPE)).toEqual({ kind: 'ready', entries: [into, out] });
  });
});
