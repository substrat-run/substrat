/**
 * K-69: the provision reconcile's one rule and the progress count read off it. The batched pass's
 * own behaviour stays pinned by platform-sweep.test.ts; this is what the on-wake handler and the
 * staff count add to it.
 */
import { describe, expect, it } from 'vitest';
import { instant } from '@substrat-run/contracts';
import { provisionReconcileTarget, reconcileProgressOf } from '../src/provision-reconcile.js';

const SERVING = { ref: 'acme-live', versionId: 'v4' };
const AS_OF = instant.parse('2026-11-25T08:00:00.000Z');
type Row = Parameters<typeof reconcileProgressOf>[2][number];
const install = (over: Partial<Row> = {}): Row => ({
  vertical: 'acme',
  status: 'active',
  kind: 'primary',
  forkedFrom: null,
  verticalVersionId: 'v1',
  servingRef: 'acme-live',
  provisionedVersionId: 'v4',
  retirementsFinishedVersionId: 'v4',
  boundShapes: { versionId: 'v4', types: [] },
  ...over,
});

describe('provisionReconcileTarget (K-69)', () => {
  it('targets the version the scope runs, not its pointer, and says whether the receipt or only its follow-up is behind', () => {
    // Idle since v1 through three promotes: its pointer is still v1, it runs v4.
    const idle = install({ provisionedVersionId: 'v1', retirementsFinishedVersionId: 'v1', boundShapes: { versionId: 'v1', types: [] } });
    expect(provisionReconcileTarget(idle, SERVING)).toEqual({ target: 'v4', receiptBehind: true });
    expect(provisionReconcileTarget(install({ provisionedVersionId: null }), SERVING)).toEqual({ target: 'v4', receiptBehind: true });
    expect(provisionReconcileTarget(install({ retirementsFinishedVersionId: null }), SERVING)).toEqual({ target: 'v4', receiptBehind: false });
    expect(provisionReconcileTarget(install({ boundShapes: null }), SERVING)).toEqual({ target: 'v4', receiptBehind: false });
    expect(provisionReconcileTarget(install(), SERVING)).toBeNull();
    // Off the serving script it runs its bound version; with none, there is nothing to target.
    expect(provisionReconcileTarget(install({ servingRef: null }), SERVING)).toEqual({ target: 'v1', receiptBehind: true });
    expect(provisionReconcileTarget(install({ servingRef: null, verticalVersionId: null }), SERVING)).toBeNull();
  });
});

describe('reconcileProgressOf (K-69)', () => {
  it('counts every active install where it stands, idle ones included, copies and other verticals apart', () => {
    const reading = reconcileProgressOf(
      'acme',
      'v4',
      [
        install(),
        install(),
        install({ provisionedVersionId: 'v1' }),
        install({ provisionedVersionId: null }),
        install({ retirementsFinishedVersionId: 'v3' }),
        install({ servingRef: null, verticalVersionId: null, provisionedVersionId: null }),
        install({ kind: 'preview', forkedFrom: null }),
        install({ forkedFrom: 'S1' as never }),
        install({ status: 'archived', provisionedVersionId: null }),
        install({ vertical: 'other', provisionedVersionId: null }),
      ],
      SERVING,
      AS_OF,
    );
    expect(reading).toEqual({
      vertical: 'acme',
      servingVersionId: 'v4',
      installs: 6,
      reconciled: 2,
      behind: { total: 3, receipt: 2, followUp: 1 },
      unknown: 1,
      running: [
        { versionId: 'v4', installs: 5, reconciled: 2 },
        { versionId: null, installs: 1, reconciled: 0 },
      ],
      receipts: [
        { versionId: 'v4', installs: 3 },
        { versionId: null, installs: 2 },
        { versionId: 'v1', installs: 1 },
      ],
      copies: 2,
      complete: false,
      asOf: AS_OF,
    });
    // Complete once nothing is left for a reconcile, an install with no nameable version included.
    expect(reconcileProgressOf('acme', 'v4', [install(), install({ servingRef: null, verticalVersionId: null })], SERVING, AS_OF).complete).toBe(true);
  });
});
