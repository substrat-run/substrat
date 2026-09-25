import type { ExportBreak, PermissionRegistry } from '@substrat-run/contracts';

/**
 * The installed apps a promotion would break (#1705 PR 3), as the plane lists them to this
 * tenant: its own apps by name, any other tenant's only as a count.
 */
export interface ExportBreaks {
  affected: ExportBreak[];
  otherTenants?: number;
}

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
  /**
   * #1705 PR 3: whom this promotion breaks, or null when nothing would (a first promotion, or no
   * installed app imports what it drops). Read BEFORE the promote so the dialog asks up front.
   */
  exportBreaks: ExportBreaks | null;
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
  /** #1705 PR 3: the plane's impact read for promoting `versionId`. Throws when it did not answer. */
  exportBreaks(versionId: string): Promise<ExportBreaks>;
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
      exportBreaks: null,
    };
  }
  const [servingRegistry, incomingRegistry, breaks] = await Promise.all([
    reader.registry(servingId),
    servingId === incomingVersionId ? undefined : reader.registry(incomingVersionId),
    servingId === incomingVersionId ? undefined : reader.exportBreaks(incomingVersionId),
  ]);
  return {
    serving: { versionId: servingId },
    incoming: { versionId: incomingVersionId },
    servingRegistry,
    // Promoting the version prod already serves changes nothing; one read answers both.
    incomingRegistry: incomingRegistry === undefined ? servingRegistry : incomingRegistry,
    exportBreaks: breaks && (breaks.affected.length > 0 || (breaks.otherTenants ?? 0) > 0) ? breaks : null,
  };
}
