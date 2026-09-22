import type { PermissionRegistry } from '@substrat-run/contracts';

/**
 * What the promote dialog needs to show a permission diff BEFORE a promote (#1677): the
 * version `prod` serves now (the one the registry's digest gate compares against),
 * the version being promoted, and the declared permission registry of each.
 *
 * `serving: null` is a first promotion — the gate is about change, not existence, so there
 * is nothing to diff. A `null` registry is a version that declared none (pushed before
 * D-39, or no surface): "cannot diff", which the dialog turns into a required
 * acknowledgement rather than into "no change".
 */
export interface PromotionReview {
  serving: { versionId: string } | null;
  incoming: { versionId: string };
  servingRegistry: PermissionRegistry | null;
  incomingRegistry: PermissionRegistry | null;
}

/**
 * The two reads a review is built from. BOTH must throw when the read did not happen:
 * a reader that folds a failure into `null` turns "the plane never answered" into
 * "this version declares no registry", and the caller cannot tell the two apart. The
 * lenient reads elsewhere in the authority seam do exactly that, on purpose, for a tab
 * that would rather render empty; this one is the input to an acknowledgement.
 */
export interface PromotionReviewReader {
  /** The version the `prod` channel points at, or null when no version has been promoted. */
  prodVersionId(): Promise<string | null>;
  registry(versionId: string): Promise<PermissionRegistry | null>;
}

export async function readPromotionReview(
  reader: PromotionReviewReader,
  incomingVersionId: string,
): Promise<PromotionReview> {
  const servingId = await reader.prodVersionId();
  // Nothing serves yet: nothing to diff against, and the gate does not fire either.
  // The incoming registry is not read — a read that cannot change the answer is only a
  // way to fail a first promote.
  if (servingId === null) {
    return {
      serving: null,
      incoming: { versionId: incomingVersionId },
      servingRegistry: null,
      incomingRegistry: null,
    };
  }
  const [servingRegistry, incomingRegistry] = await Promise.all([
    reader.registry(servingId),
    servingId === incomingVersionId ? undefined : reader.registry(incomingVersionId),
  ]);
  return {
    serving: { versionId: servingId },
    incoming: { versionId: incomingVersionId },
    servingRegistry,
    // Promoting the version prod already serves changes nothing; one read answers both.
    incomingRegistry: incomingRegistry === undefined ? servingRegistry : incomingRegistry,
  };
}
