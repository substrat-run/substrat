/**
 * K-69 (no scheduled walk over tenants), step 5 of rfc/tenant-scale.md §7.5: how far a promote's
 * provision reconcile has reached a vertical's installs, idle ones included.
 *
 * Read on demand from the directory's scope rows (one `listScopes` for the vertical, one serving
 * read), and counted with the rule both reconciles use (`reconcileProgressOf`), so "complete" here
 * means neither the on-wake handler nor the batched pass has anything left to do. Nothing is woken
 * to count it: an idle scope is counted where its receipt stands. Once the directory is split per
 * tenant (step 3, K-68), the same reading is answered from the per-(vertical, version) projection
 * in the cross-tenant index instead of these rows; its shape does not change.
 */
import { reconcileProgressOf, type HostAdmin } from '@substrat-run/kernel';
import { instant, reconcileProgressReading, type PlatformActorId, type ReconcileProgressReading } from '@substrat-run/contracts';

export async function readReconcileProgress(
  admin: Pick<HostAdmin, 'listScopes' | 'verticalServing'>,
  actor: PlatformActorId,
  vertical: string,
  now: () => Date = () => new Date(),
): Promise<ReconcileProgressReading> {
  const asOf = instant.parse(now().toISOString());
  const [scopes, state] = await Promise.all([
    admin.listScopes(actor, { vertical, status: 'active' }),
    admin.verticalServing(actor, vertical),
  ]);
  const serving = state ? { ref: state.ref, versionId: state.versionId } : null;
  return reconcileProgressReading.parse(reconcileProgressOf(vertical, state?.versionId ?? null, scopes, serving, asOf));
}
