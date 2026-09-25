import { diffRegistries, hasRegistryChange, type RegistryDiff, type RegistryLike } from './registry-diff.js';

/**
 * The decisions behind the promote dialog (#1677), kept out of the component so they are
 * plain functions the worker's test suite can hold to account — the dashboard has no DOM
 * test setup, and the claims below are exactly the kind a click-through cannot check.
 *
 * The registry's gate is unchanged and stays the authority: it compares two digests and
 * refuses a promote that changes the permission or migration surface until each kind is
 * acknowledged. This file is how a person READS what they are acknowledging, and the one
 * rule it is built around is that an acknowledgement is only ever sent for a change that
 * was put in front of them, ticked by them, on its own.
 */

/** What `GET /deployments/:slug/promote-review` answers (mirrors `src/promotion-review.ts`). */
export interface PromoteReviewWire {
  serving: { versionId: string } | null;
  incoming: { versionId: string };
  servingRegistry: RegistryLike | null;
  incomingRegistry: RegistryLike | null;
  /** #1705 PR 3: whom the promotion breaks (this tenant's apps by name, others as a count). */
  exportBreaks?: ExportBreakListing | null;
}

/** The installed apps a promotion breaks, as the plane lists them to this tenant. */
export interface ExportBreakListing {
  affected: { scopeId: string; vertical: string; type: string; schemaVersion: number; incoming: number | null }[];
  otherTenants?: number;
}

/** The acknowledgements a promote may carry. A flag is present only when it is `true`. */
export interface Acks {
  permissionChange?: true;
  migrationChange?: true;
  exportBreak?: true;
}

/**
 * #1705 PR 3: the export-break half. `listing` is the review's (read before promoting); a refusal
 * the review did not foresee carries only the gate's own sentence, which counts and names no one.
 */
export type ExportBreakSection = { kind: 'listing'; listing: ExportBreakListing } | { kind: 'server-reported'; summary: string };

/** Why a permission diff could not be drawn. */
export type Unverifiable = 'serving-has-no-registry' | 'incoming-has-no-registry' | 'neither-has-a-registry';

/**
 * The permission half of the checkpoint. `diff` is the real thing; the other two are the
 * two ways the dialog has to say "this changed and I cannot show you how" — and both still
 * require the acknowledgement, because the gate does.
 */
export type PermissionSection =
  | { kind: 'diff'; diff: RegistryDiff; from: RegistryLike; to: RegistryLike }
  | { kind: 'unverifiable'; why: Unverifiable }
  /** The registry refused on the permission digest though no diff was drawn (or could be). */
  | { kind: 'server-reported'; digests: string | null };

/**
 * The migration half. The SQL is not carried in the manifest yet (#1677 part b), so there
 * is nothing to show but that the set differs — and that is only learned from the registry's
 * own refusal, which names the digest pair.
 */
export interface MigrationSection {
  digests: string | null;
}

/** What the dialog is asked to put in front of a person. */
export interface Checkpoint {
  permission: PermissionSection | null;
  migration: MigrationSection | null;
  /** #1705 PR 3. Optional so a checkpoint built before it existed reads as "nothing breaks". */
  exportBreak?: ExportBreakSection | null;
  /** Kinds already acknowledged in this promote — shown as such, not asked for again. */
  acknowledged: Acks;
}

/** The export-break section a review yields before anything is sent, or null when nothing breaks. */
export function planExportBreak(review: PromoteReviewWire): ExportBreakSection | null {
  const listing = review.exportBreaks ?? null;
  if (listing === null) return null;
  return listing.affected.length > 0 || (listing.otherTenants ?? 0) > 0 ? { kind: 'listing', listing } : null;
}

/**
 * The permission section a review yields before anything is sent, or null when there is
 * nothing to ask about.
 *
 * Null is claimed in two cases only. A first promotion has nothing to diff against, and the
 * gate does not fire on one either. And two registries that DIFF equal: if the digests
 * still differ, the registry refuses and the section reappears as `server-reported` — so
 * "nothing to show" is never the last word on a change the gate can see.
 *
 * A missing registry on either side is NOT "no change". It is a version pushed before the
 * registry was retained (or one that declares no surface): there is nothing to diff with,
 * so the person is told so and asked to acknowledge.
 */
export function planPermission(review: PromoteReviewWire): PermissionSection | null {
  if (review.serving === null) return null;
  const from = review.servingRegistry;
  const to = review.incomingRegistry;
  if (from === null && to === null) return { kind: 'unverifiable', why: 'neither-has-a-registry' };
  if (from === null) return { kind: 'unverifiable', why: 'serving-has-no-registry' };
  if (to === null) return { kind: 'unverifiable', why: 'incoming-has-no-registry' };
  const diff = diffRegistries(from, to);
  return hasRegistryChange(diff) ? { kind: 'diff', diff, from, to } : null;
}

/** A refusal the registry's gate made, read out of its message. */
export type Refusal = { kind: 'permission' | 'migration'; digests: string | null } | { kind: 'export-break'; summary: string };

const NEEDS_ACK = 'acknowledge it explicitly';
/** How the export-break refusal begins (`EXPORT_BREAK_REFUSAL`, #1705 PR 3). */
const EXPORT_BREAK = 'promotion drops or re-versions';

/**
 * Read the gate's refusal (`promotion changes the permission surface (a → b) — acknowledge
 * it explicitly to promote`, and the migrations twin). `null` is any other failure.
 * `'unrecognised'` is a refusal that asks for an acknowledgement of something this code has
 * no section for: it is surfaced as the error it is rather than guessed at, because the
 * guess is the click-through this file exists to end.
 */
export function classifyRefusal(message: string): Refusal | 'unrecognised' | null {
  const at = message.indexOf(EXPORT_BREAK);
  if (at >= 0) return { kind: 'export-break', summary: message.slice(at) };
  if (!message.includes(NEEDS_ACK)) return null;
  const digests = /\(([^()]*→[^()]*)\)/.exec(message)?.[1]?.trim() ?? null;
  if (message.includes('changes the permission surface')) return { kind: 'permission', digests };
  if (message.includes('changes migrations')) return { kind: 'migration', digests };
  return 'unrecognised';
}

/** Whether a checkpoint asks for something no one has acknowledged yet. */
export function outstanding(c: Checkpoint): { permission: boolean; migration: boolean; exportBreak: boolean } {
  return {
    permission: c.permission !== null && c.acknowledged.permissionChange !== true,
    migration: c.migration !== null && c.acknowledged.migrationChange !== true,
    exportBreak: (c.exportBreak ?? null) !== null && c.acknowledged.exportBreak !== true,
  };
}

/**
 * The acknowledgements a dialog answer amounts to: a kind counts only if the checkpoint
 * SHOWED it, and only if the answer ticked it. An answer that carries a flag for a change
 * that was not shown — a dialog bug, a stale answer, a tampered one — contributes nothing.
 */
export function honour(c: Checkpoint, answer: Acks): Acks {
  const out: Acks = { ...c.acknowledged };
  if (c.permission !== null && answer.permissionChange === true) out.permissionChange = true;
  if (c.migration !== null && answer.migrationChange === true) out.migrationChange = true;
  if ((c.exportBreak ?? null) !== null && answer.exportBreak === true) out.exportBreak = true;
  return out;
}

export interface PromoteDeps {
  /** The permission review; a rejection blocks the promote — see `promoteWithCheckpoint`. */
  review(): Promise<PromoteReviewWire>;
  /** The promote itself, with the acknowledgements to send (`undefined` = none, as before). */
  promote(acknowledge: Acks | undefined): Promise<void>;
  /** The dialog. Resolves the boxes the person ticked, or `null` if they backed out. */
  ask(checkpoint: Checkpoint): Promise<Acks | null>;
}

export type PromoteOutcome = 'promoted' | 'cancelled';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Promote through the checkpoint.
 *
 * 1. Read the review. If that fails the promote does not happen: the review is the only
 *    thing that can say "no permission change", and a read that did not answer says nothing.
 * 2. A permission section to show → ask, and stop unless it was acknowledged.
 * 3. Promote with exactly the acknowledgements that were given (none, when none — the
 *    promote of an unchanged surface is the request it always was).
 * 4. If the gate refuses for a kind that was not shown (the migrations are only ever learned
 *    this way; the permission digest can differ where no diff could be drawn), show that
 *    kind in the same dialog and ask again. A refusal for a kind already acknowledged is not
 *    retried — the state moved under the person, and they are told.
 */
export async function promoteWithCheckpoint(deps: PromoteDeps): Promise<PromoteOutcome> {
  const review = await deps.review();

  let checkpoint: Checkpoint = {
    permission: planPermission(review),
    migration: null,
    exportBreak: planExportBreak(review),
    acknowledged: {},
  };

  // A section is acknowledged only when the dialog shows it and the person ticks it; the
  // rest of the function never sets a flag any other way.
  const confirm = async (): Promise<boolean> => {
    const answer = await deps.ask(checkpoint);
    if (answer === null) return false;
    checkpoint = { ...checkpoint, acknowledged: honour(checkpoint, answer) };
    const left = outstanding(checkpoint);
    return !left.permission && !left.migration && !left.exportBreak;
  };

  if ((checkpoint.permission !== null || checkpoint.exportBreak !== null) && !(await confirm())) return 'cancelled';

  // Three kinds exist, so a fourth refusal is not a next step but a loop.
  for (let round = 0; round < 4; round++) {
    const sent = { ...checkpoint.acknowledged };
    try {
      await deps.promote(sent.permissionChange || sent.migrationChange || sent.exportBreak ? sent : undefined);
      return 'promoted';
    } catch (e) {
      const refusal = classifyRefusal(messageOf(e));
      if (refusal === null || refusal === 'unrecognised') throw e;
      if (refusal.kind === 'export-break') {
        if (sent.exportBreak === true) throw e;
        checkpoint = { ...checkpoint, exportBreak: { kind: 'server-reported', summary: refusal.summary } };
      } else {
        const flag = refusal.kind === 'permission' ? 'permissionChange' : 'migrationChange';
        if (sent[flag] === true) throw e;
        checkpoint =
          refusal.kind === 'permission'
            ? { ...checkpoint, permission: { kind: 'server-reported', digests: refusal.digests } }
            : { ...checkpoint, migration: { digests: refusal.digests } };
      }
      if (!(await confirm())) return 'cancelled';
    }
  }
  throw new Error('The registry kept refusing the promotion — reload and try again.');
}
