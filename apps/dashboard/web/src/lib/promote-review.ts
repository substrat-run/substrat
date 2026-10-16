import { promoteReviewReasonIn, type MigrationDiff, type PromotionReviewBinding } from '@substrat-run/contracts';
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
  /** What the incoming version's migrations add on top of the serving one's. Null = no SQL to
   *  show, which `planMigration` asks about whenever there is something to compare. */
  migrations: MigrationDiff | null;
  /** #1705 PR 3: whom the promotion breaks (this tenant's apps by name, others as a count). */
  exportBreaks?: ExportBreakListing | null;
  /**
   * #2333: what an acknowledgement of THIS review is bound to — read in the same answer as
   * `migrations`, so it names exactly the diff shown. Sent with the promote, which the registry
   * refuses once prod has moved. Absent or null: nothing serves, or an older worker.
   */
  review?: PromotionReviewBinding | null;
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

/** What a promote sends: the acknowledgements given, and the review they answer (#2333). */
export type SentAcks = Acks & { review?: PromotionReviewBinding };

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
 * The migration half (#1677). It reaches the dialog two ways, and the difference is who is
 * asking:
 *
 * - From the review, when the incoming version's migrations add to or edit the serving
 *   version's, or when its manifest carries no SQL at all (pushed by an older CLI, or over
 *   the size a manifest carries), so nothing can say whether they changed. `enforced: false`:
 *   the dialog asks before anything is sent. The registry's gate refuses the same change on
 *   its own (#1949), except between versions pushed by a CLI older than 0.38.0, whose digest
 *   covered only the Durable-Object classes, so this acknowledgement is the dialog's own. It is still
 *   required: showing SQL a person may skip — or not showing it — is how a schema change
 *   slips through.
 * - From the gate's own refusal on the migration digest. `enforced: true`, with the digest
 *   pair. `sql` is the review's diff when it has one, and null when the incoming version's
 *   manifest carries no SQL — "not available", and the acknowledgement is still required.
 */
export interface MigrationSection {
  digests: string | null;
  sql: MigrationDiff | null;
  enforced: boolean;
}

/**
 * The migration section a review yields before anything is sent. Null only when the review
 * SHOWS no change — a diff with nothing in it — or has nothing to compare (a first promotion,
 * or promoting what already serves). A version whose manifest carries no SQL is not "no
 * change": it is "SQL not available", and it is asked about, because a version pushed by a CLI
 * older than 0.38.0 moves no digest on a SQL-only change, and this would otherwise promote one
 * with no prompt at all.
 */
export function planMigration(review: PromoteReviewWire): MigrationSection | null {
  if (review.serving === null || review.serving.versionId === review.incoming.versionId) return null;
  const sql = review.migrations;
  if (sql === null) return { digests: null, sql: null, enforced: false };
  return sql.total > 0 ? { digests: null, sql, enforced: false } : null;
}

/** What the dialog is asked to put in front of a person. */
export interface Checkpoint {
  permission: PermissionSection | null;
  migration: MigrationSection | null;
  /** #1705 PR 3. Optional so a checkpoint built before it existed reads as "nothing breaks". */
  exportBreak?: ExportBreakSection | null;
  /** Kinds already acknowledged in this promote — shown as such, not asked for again. */
  acknowledged: Acks;
  /**
   * #2333: prod moved since the review this promote began with, so this checkpoint is a new
   * review and every earlier tick was dropped. The dialog says so.
   */
  reviewMoved?: true;
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

/** A refusal the registry's gate made, read out of its message (and, for a review, its reason). */
export type Refusal =
  | { kind: 'permission' | 'migration'; digests: string | null }
  | { kind: 'export-break'; summary: string }
  /** #2333: the review the acknowledgements were bound to is not the one prod would apply now. */
  | { kind: 'review-moved' };

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
export function classifyRefusal(message: string, reason?: unknown): Refusal | 'unrecognised' | null {
  // #2333: read off the problem's `reason`, never its sentence.
  if (promoteReviewReasonIn({ reason }) !== undefined) return { kind: 'review-moved' };
  const at = message.indexOf(EXPORT_BREAK);
  if (at >= 0) return { kind: 'export-break', summary: message.slice(at) };
  if (!message.includes(NEEDS_ACK)) return null;
  const digests = /\(([^()]*→[^()]*)\)/.exec(message)?.[1]?.trim() ?? null;
  if (message.includes('changes the permission surface')) return { kind: 'permission', digests };
  if (message.includes('changes migrations')) return { kind: 'migration', digests };
  return 'unrecognised';
}

/** The kinds of change a checkpoint can ask about, each true or false. */
export interface PerKind {
  permission: boolean;
  migration: boolean;
  exportBreak: boolean;
}

/** Whether a checkpoint asks for something no one has acknowledged yet. */
export function outstanding(c: Checkpoint): PerKind {
  return {
    permission: c.permission !== null && c.acknowledged.permissionChange !== true,
    migration: c.migration !== null && c.acknowledged.migrationChange !== true,
    exportBreak: (c.exportBreak ?? null) !== null && c.acknowledged.exportBreak !== true,
  };
}

const NONE_TICKED: PerKind = { permission: false, migration: false, exportBreak: false };

/**
 * Whether a promote may go ahead: every kind still outstanding has its box ticked. The ONE
 * place the kinds are joined, read by the dialog's Promote button and by the flow's own
 * check after an answer, so a kind added later cannot be required by one and not the other.
 */
export function readyToPromote(left: PerKind, ticked: PerKind = NONE_TICKED): boolean {
  return (!left.permission || ticked.permission) && (!left.migration || ticked.migration) && (!left.exportBreak || ticked.exportBreak);
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
  promote(acknowledge: SentAcks | undefined): Promise<void>;
  /** The dialog. Resolves the boxes the person ticked, or `null` if they backed out. */
  ask(checkpoint: Checkpoint): Promise<Acks | null>;
}

export type PromoteOutcome = 'promoted' | 'cancelled';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The problem `reason` a failed call carried: `ApiError.reason`, or a platform error's own extension. */
const reasonOf = (e: unknown): unknown => {
  const err = e as { reason?: unknown; extensions?: { reason?: unknown } } | null;
  return err?.reason ?? err?.extensions?.reason;
};

/**
 * Promote through the checkpoint.
 *
 * 1. Read the review. If that fails the promote does not happen: the review is the only
 *    thing that can say "no permission change", and a read that did not answer says nothing.
 * 2. A permission section, migrations the review shows, or apps it breaks → ask, and stop unless each
 *    was acknowledged.
 * 3. Promote with exactly the acknowledgements that were given (none, when none — the
 *    promote of an unchanged surface is the request it always was).
 * 4. If the gate refuses for a kind that was not shown (a migration digest that moved with no
 *    SQL to show; the permission digest can differ where no diff could be drawn), show that
 *    kind in the same dialog and ask again. A refusal for a kind already acknowledged is not
 *    retried — the state moved under the person, and they are told.
 * 5. #2333: every promote carries the review's binding. If prod moved since the review was read
 *    (the registry refuses the binding, or a first promote's review meets a digest refusal),
 *    the review is read again and the new one asked from scratch: no tick given against the old
 *    review is carried over, because it acknowledged a diff that is no longer the one applied.
 */
export async function promoteWithCheckpoint(deps: PromoteDeps): Promise<PromoteOutcome> {
  let review = await deps.review();
  const planOf = (r: PromoteReviewWire): Checkpoint => ({
    permission: planPermission(r),
    migration: planMigration(r),
    exportBreak: planExportBreak(r),
    acknowledged: {},
  });

  let checkpoint: Checkpoint = planOf(review);
  const asks = (c: Checkpoint) => c.permission !== null || c.migration !== null || (c.exportBreak ?? null) !== null;

  // A section is acknowledged only when the dialog shows it and the person ticks it; the
  // rest of the function never sets a flag any other way.
  const confirm = async (): Promise<boolean> => {
    const answer = await deps.ask(checkpoint);
    if (answer === null) return false;
    checkpoint = { ...checkpoint, acknowledged: honour(checkpoint, answer) };
    return readyToPromote(outstanding(checkpoint));
  };

  if (asks(checkpoint) && !(await confirm())) {
    return 'cancelled';
  }

  // Three kinds exist, so a fourth refusal is not a next step but a loop; and prod moving under
  // the review a third time is reported rather than chased. A move starts a new review, so it
  // does not count as one of the kinds' rounds.
  let moves = 0;
  for (let round = 0; round < 4; ) {
    const sent: SentAcks = { ...checkpoint.acknowledged, ...(review.review ? { review: review.review } : {}) };
    try {
      await deps.promote(sent.permissionChange || sent.migrationChange || sent.exportBreak || sent.review ? sent : undefined);
      return 'promoted';
    } catch (e) {
      const refusal = classifyRefusal(messageOf(e), reasonOf(e));
      if (refusal === null || refusal === 'unrecognised') throw e;
      // A first promote's review had nothing to diff; a digest refusal means something serves now.
      const moved = refusal.kind === 'review-moved' || (review.serving === null && refusal.kind !== 'export-break');
      if (moved) {
        if (++moves > 2) throw new Error('Prod kept changing while this promotion was reviewed — reload and try again.');
        review = await deps.review();
        checkpoint = { ...planOf(review), reviewMoved: true };
        if (asks(checkpoint) && !(await confirm())) return 'cancelled';
        continue;
      }
      if (refusal.kind === 'export-break') {
        if (sent.exportBreak === true) throw e;
        checkpoint = { ...checkpoint, exportBreak: { kind: 'server-reported', summary: refusal.summary } };
      } else {
        const flag = refusal.kind === 'permission' ? 'permissionChange' : 'migrationChange';
        if (sent[flag] === true) throw e;
        checkpoint =
          refusal.kind === 'permission'
            ? { ...checkpoint, permission: { kind: 'server-reported', digests: refusal.digests } }
            : { ...checkpoint, migration: { digests: refusal.digests, sql: review.migrations, enforced: true } };
      }
      if (!(await confirm())) return 'cancelled';
      round++;
    }
  }
  throw new Error('The registry kept refusing the promotion — reload and try again.');
}
