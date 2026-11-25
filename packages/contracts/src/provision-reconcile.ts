import { z } from 'zod';
import { instant } from './ids.js';

/**
 * K-69 (no scheduled walk over tenants), step 5 of rfc/tenant-scale.md: a promote's provision
 * reconcile (#1172, #1653) reaches a scope on its next wake instead of in a batched pass.
 *
 * The scope records the wake itself: the first time a scope object runs its migration pass on a
 * version it has not asked about, it writes ONE intent of this kind into its own platform-intent
 * journal. The platform drains it like any intent (the router's kick after the request that woke
 * it, the drain's backstop), and its handler reconciles the scope against the version it RUNS if
 * the directory's receipt says it is behind, and does nothing if it is not. So the intent is a
 * wake signal and a durable retry, never the decision: what is behind is the directory's answer,
 * read with the same rule the batched pass reads (`provisionReconcileTarget`).
 *
 * Platform-authored: module code cannot raise it (`assertModuleEnqueueableKind`), since it would
 * spend a platform reconcile on the vertical's say-so.
 */
export const PROVISION_RECONCILE_KIND = 'provision-reconcile';

/** What the scope says when it asks: the version identity its script carried on that wake. */
export const provisionReconcilePayload = z.object({
  /** `SUBSTRAT_VERSION_ID` as the scope's host read it. Informational: the handler reconciles against what the directory says the scope runs. */
  wokeOn: z.string().min(1),
});
export type ProvisionReconcilePayload = z.infer<typeof provisionReconcilePayload>;

/** What a settled `provision-reconcile` intent's `result` holds. */
export const provisionReconcileResult = z.discriminatedUnion('outcome', [
  /** The directory's receipt already matched what the scope runs: nothing ran. */
  z.object({ outcome: z.literal('up-to-date'), versionId: z.string().min(1).nullable() }),
  /** The reconcile ran against `versionId` and the receipt was written. */
  z.object({ outcome: z.literal('reconciled'), versionId: z.string().min(1) }),
  /** The vertical implements no reconcile (a 501): nothing ran, no receipt, as the batched pass counts it. */
  z.object({ outcome: z.literal('unsupported'), versionId: z.string().min(1) }),
  /** The control plane's switch is off: the batched pass is the one that reconciles. */
  z.object({ outcome: z.literal('switched-off') }),
  /** The scope is not an active primary install, so nothing reconciles it. */
  z.object({ outcome: z.literal('not-an-install'), reason: z.string().min(1) }),
]);
export type ProvisionReconcileResult = z.infer<typeof provisionReconcileResult>;

const count = z.number().int().nonnegative();

/**
 * How far a vertical's installs have come (K-69, RFC §7.5): every active primary install counted
 * against the version it runs and the version its provision last ran against, idle ones included,
 * since a scope that has not woken since the promote is still counted where it stands.
 * `complete` is `behind.total === 0`: nothing left for a reconcile to do. Staff only.
 */
export const reconcileProgressReading = z.object({
  vertical: z.string().min(1),
  /** What the vertical's stable serving script runs, or null before its first in-place serve. */
  servingVersionId: z.string().min(1).nullable(),
  /** Active primary installs (previews and forks are `copies`, apart). */
  installs: count,
  /** Installs whose receipt, retirements and bound shapes all match the version they run. */
  reconciled: count,
  behind: z.object({
    /** `receipt + followUp`. */
    total: count,
    /** The provision receipt names another version (or none). */
    receipt: count,
    /** The receipt matches, but its retirements or bound shapes were not reported finished. */
    followUp: count,
  }),
  /** Installs whose running version the directory cannot name: nothing to reconcile against. */
  unknown: count,
  /** Installs grouped by the version they run, newest serve first in practice. */
  running: z.array(z.object({ versionId: z.string().min(1).nullable(), installs: count, reconciled: count })),
  /** Installs grouped by their provision receipt; `null` is a scope with no receipt yet. */
  receipts: z.array(z.object({ versionId: z.string().min(1).nullable(), installs: count })),
  /** Previews and forks of the vertical: not installs, never reconciled. */
  copies: count,
  complete: z.boolean(),
  /** When the directory rows behind the count were read (RFC §11: a cross-tenant read says when it was true). */
  asOf: instant,
});
export type ReconcileProgressReading = z.infer<typeof reconcileProgressReading>;
