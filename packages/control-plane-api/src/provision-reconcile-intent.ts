/**
 * K-69 (no scheduled walk over tenants), step 5 of rfc/tenant-scale.md §7.5: the platform's half of
 * the on-wake provision reconcile. A scope writes one `provision-reconcile` intent the first time it
 * wakes on a version it has not asked about (`adapter-cloudflare`'s `reconcileOnWake`); the drain
 * that reaches it (the router's kick after the request that woke the scope, or the backstop) runs
 * this handler.
 *
 * The intent is only the wake signal. Whether there is anything to do is read from the directory,
 * with the batched pass's own rule (`provisionReconcileTarget`), so the two cannot disagree: a scope
 * the batched pass already reconciled settles `up-to-date` here and runs nothing, and one this
 * handler reconciled is skipped by the next pass. The reach and the receipt are the batched pass's
 * too (`reconcile` is the control plane's `reconcileOneScope`), so a reconcile runs against the
 * version the scope RUNS (#1653), never against the one its intent named.
 *
 * A throw leaves the intent `pending`: the drain retries it on its next pass and gives up at its
 * attempt ceiling, which files an ops-failure row (#570). The batched pass stays on behind its own
 * switch until the progress count has been watched through several promotes, so a scope whose
 * intent gave up is still reached.
 */
import { isPrimaryScope, provisionReconcileTarget, runningVersionOf, type HostAdmin, type ReconcileOutcome, type ServingPointer } from '@substrat-run/kernel';
import type { PlatformActorId, ProvisionReconcileResult, ScopeId, TenantId } from '@substrat-run/contracts';
import type { PlatformRequestHandler } from './platform-drain.js';

export interface ProvisionReconcileIntentDeps {
  admin: Pick<HostAdmin, 'getScopeRecord' | 'verticalServing' | 'markScopeProvisioned'>;
  actor: PlatformActorId;
  /**
   * Reach the scope's deployment and run its reconcile against `target`, the version it runs. Throws
   * on any refusal, as the batched pass's reach does: a silent return would write a receipt for a
   * reconcile that never ran.
   */
  reconcile: (tenantId: TenantId, scopeId: ScopeId, target: string) => Promise<'unsupported' | ReconcileOutcome>;
  /** The switch (`PROVISION_RECONCILE_ON_WAKE`). Off: settled without reconciling, and the batched pass reconciles. */
  enabled: boolean;
}

/** `PROVISION_RECONCILE_ON_WAKE`: on unless it says `off` (or `0`, `false`). */
export function reconcileOnWakeEnabled(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

export function provisionReconcileHandler(deps: ProvisionReconcileIntentDeps): PlatformRequestHandler {
  const done = (result: ProvisionReconcileResult) => ({ status: 'done' as const, result });
  return async (ctx) => {
    if (!deps.enabled) return done({ outcome: 'switched-off' });
    const rec = await deps.admin.getScopeRecord(deps.actor, ctx.tenantId, ctx.scopeId);
    // The drain already holds an inactive scope's intents and settles a copy's inert (#1713, #2005);
    // said again here, since a reconcile with platform authority is the one place it must not slip.
    if (!rec) return done({ outcome: 'not-an-install', reason: 'the scope has no directory record' });
    if (!rec.vertical) return done({ outcome: 'not-an-install', reason: 'the scope is bound to no vertical' });
    if (rec.status !== 'active') return done({ outcome: 'not-an-install', reason: `the scope is ${rec.status}` });
    if (!isPrimaryScope(rec)) return done({ outcome: 'not-an-install', reason: 'the scope is a preview or a fork' });
    // Only a scope on the stable serving script can run anything but its bound version.
    const state = rec.servingRef ? await deps.admin.verticalServing(deps.actor, rec.vertical) : null;
    const serving: ServingPointer | null = state ? { ref: state.ref, versionId: state.versionId } : null;
    const due = provisionReconcileTarget(rec, serving);
    if (!due) return done({ outcome: 'up-to-date', versionId: runningVersionOf(rec, serving) });
    const outcome = await deps.reconcile(ctx.tenantId, ctx.scopeId, due.target);
    // A 501: nothing ran, so nothing is recorded, as the batched pass counts it. Settled, since asking
    // again on every drain changes nothing; the pass still counts the install `unsupported`.
    if (outcome === 'unsupported') return done({ outcome: 'unsupported', versionId: due.target });
    // The version reconciled against, read before the call, as the pass marks it (#1653).
    await deps.admin.markScopeProvisioned(deps.actor, ctx.tenantId, ctx.scopeId, due.target, outcome);
    return done({ outcome: 'reconciled', versionId: due.target });
  };
}
