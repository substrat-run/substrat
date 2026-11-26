/**
 * The provision reconcile's one rule (#1172, #1653, #2184, #2185), shared by the batched pass
 * (`runPlatformSweep`'s reconcile phase), the on-wake reconcile (K-69, rfc/tenant-scale.md §7.5)
 * and the progress count a staff reader sees. Three readers of "is this install behind, and on
 * what" must not drift apart: the count says complete exactly when neither reconcile has anything
 * left to do.
 */
import type { Instant, ReconcileProgressReading, Scope } from '@substrat-run/contracts';
import { isPrimaryScope, runningVersionOf, type ServingPointer } from './scope-identity.js';

/** Why an install is behind: its receipt, or only what its reconcile reports beside the receipt. */
export interface ProvisionReconcileTarget {
  /** The version the install runs, which is what a reconcile runs against and records. */
  target: string;
  /** True when the receipt names another version (or none); false when only retirements or bound shapes are unreported. */
  receiptBehind: boolean;
}

/** The fields of a scope the rule reads. */
export type ReconcileScopeFields = Pick<
  Scope,
  'verticalVersionId' | 'servingRef' | 'provisionedVersionId' | 'retirementsFinishedVersionId' | 'boundShapes'
>;

/**
 * What a reconcile of `scope` would run against, or null when there is nothing to do: the scope
 * runs no version the platform can name, or its receipt, its finished retirements (#2185) and its
 * bound shapes (#2184) all match the version it runs.
 *
 * A null receipt is "unknown", NOT "up to date": a scope provisioned before the platform recorded
 * it has no evidence either way, and it costs one reconcile, once.
 */
export function provisionReconcileTarget(
  scope: ReconcileScopeFields,
  serving: ServingPointer | null | undefined,
): ProvisionReconcileTarget | null {
  const running = runningVersionOf(scope, serving);
  if (!running) return null;
  if (
    scope.provisionedVersionId === running &&
    scope.retirementsFinishedVersionId === running &&
    scope.boundShapes?.versionId === running
  ) {
    return null;
  }
  return { target: running, receiptBehind: scope.provisionedVersionId !== running };
}

/**
 * The progress count for one vertical (K-69): every active scope of it, counted as an install
 * when it is primary and as a copy when it is not, each install against the version it runs and
 * its provision receipt. An idle install is counted where it stands: nothing here wakes a scope,
 * and the count reaches `installs` only once every install has been reconciled, however late the
 * last one wakes.
 */
export function reconcileProgressOf(
  vertical: string,
  servingVersionId: string | null,
  scopes: readonly (ReconcileScopeFields & Pick<Scope, 'kind' | 'forkedFrom' | 'status' | 'vertical'>)[],
  serving: ServingPointer | null | undefined,
  asOf: Instant,
): ReconcileProgressReading {
  const running = new Map<string | null, { installs: number; reconciled: number }>();
  const receipts = new Map<string | null, number>();
  let installs = 0;
  let reconciled = 0;
  let receipt = 0;
  let followUp = 0;
  let unknown = 0;
  let copies = 0;
  for (const s of scopes) {
    if (s.vertical !== vertical || s.status !== 'active') continue;
    if (!isPrimaryScope(s)) {
      copies += 1;
      continue;
    }
    installs += 1;
    const version = runningVersionOf(s, serving);
    const behind = provisionReconcileTarget(s, serving);
    const row = running.get(version) ?? { installs: 0, reconciled: 0 };
    row.installs += 1;
    receipts.set(s.provisionedVersionId, (receipts.get(s.provisionedVersionId) ?? 0) + 1);
    if (version === null) {
      unknown += 1;
    } else if (behind === null) {
      reconciled += 1;
      row.reconciled += 1;
    } else if (behind.receiptBehind) {
      receipt += 1;
    } else {
      followUp += 1;
    }
    running.set(version, row);
  }
  const byCount = <T extends { installs: number; versionId: string | null }>(a: T, b: T) =>
    b.installs - a.installs || String(a.versionId).localeCompare(String(b.versionId));
  return {
    vertical,
    servingVersionId,
    installs,
    reconciled,
    behind: { total: receipt + followUp, receipt, followUp },
    unknown,
    running: [...running].map(([versionId, r]) => ({ versionId, ...r })).sort(byCount),
    receipts: [...receipts].map(([versionId, n]) => ({ versionId, installs: n })).sort(byCount),
    copies,
    complete: receipt + followUp === 0,
    asOf,
  };
}
