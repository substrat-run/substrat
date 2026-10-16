/**
 * The promote review's binding (#2333), shared by both adapters and the control plane's
 * migrations read.
 *
 * A promote review is computed from the version being promoted over the channel's CURRENT
 * version. The acknowledgement a person gives after reading it used to be a bare flag, so a
 * concurrent promote between showing the review and acknowledging it changed the base, and the
 * person acknowledged a diff that was no longer the one applied. The review now hands out a
 * binding — the base it was computed against, and a digest of the stored rows it was computed
 * from — and the promote refuses unless both still hold.
 *
 * The digest is the server's, over the server's stored rows, on both ends: the migrations read
 * computes it beside the diff it shows, and the promote recomputes it. What a client sends is
 * only compared with it, never read as the diff (the same rule the push digests keep: nothing
 * re-derives a review from a client's digest).
 */
import {
  PROMOTE_REVIEW_REASONS,
  reviewLine,
  substratError,
  errorCodeOf,
  type PromotionAcknowledgement,
  type PromotionReviewBinding,
} from '@substrat-run/contracts';

// Declared locally so the kernel needs no platform type packages (§5.8), as `capability.ts` does.
declare const crypto: { subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> } };
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

/** One side of a review, as the directory stores it. */
export interface ReviewedVersion {
  id: string;
  permissionDigest: string;
  migrationDigest: string;
  /** The stored migrations, in host order, with what each declares. Null = the version carries none. */
  migrations:
    | readonly {
        moduleId: string;
        version: string;
        sql: string;
        moves?: Readonly<Record<string, string>>;
        discards?: Readonly<Record<string, string>>;
      }[]
    | null;
}

/** A declaration record as sorted pairs, so key order never moves the digest. */
const pairs = (r: Readonly<Record<string, string>> | undefined): [string, string][] =>
  Object.entries(r ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Exactly what a review shows, and nothing else: each side's id, its two pushed digests (the
 * gate's own comparison) and its stored migrations with their declared moves and discards. A
 * version's admission, origin, label or deployment are left out, so changing them never turns a
 * current review stale.
 */
const sideOf = (v: ReviewedVersion | null) =>
  v === null
    ? null
    : [
        v.id,
        v.permissionDigest,
        v.migrationDigest,
        v.migrations === null
          ? null
          : v.migrations.map((m) => [m.moduleId, m.version, m.sql, pairs(m.moves), pairs(m.discards)]),
      ];

/** The digest of a review of `incoming` over `base` (null: nothing serves). Lowercase hex SHA-256. */
export async function promoteReviewDigest(base: ReviewedVersion | null, incoming: ReviewedVersion): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(['promote-review/1', sideOf(base), sideOf(incoming)]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The first CLI release whose `substrat promote` sends the binding. */
export const PROMOTE_REVIEW_CLI = '@substrat-run/cli 0.45.0';

/** Whether a throw is one of the refusals below, and which. */
export function promoteReviewRefusalOf(err: unknown): 'stale' | 'unbound' | null {
  if (errorCodeOf(err) !== 'precondition_failed') return null;
  const reason = (err as { extensions?: { reason?: unknown } }).extensions?.reason;
  return reason === PROMOTE_REVIEW_REASONS.stale ? 'stale' : reason === PROMOTE_REVIEW_REASONS.unbound ? 'unbound' : null;
}

/**
 * The promote gate's binding check. `baseId` is what the channel points at now (null: nothing).
 * `read` loads both sides' stored rows, and is only called when a binding was sent.
 *
 * - A binding is always checked, whatever it acknowledges: the base it names must be the
 *   channel's, and the digest must be the one the stored rows give now.
 * - Without one, a `migrationChange` the gate is about to consume is refused: that is the
 *   acknowledgement that lets a migration — and any data loss it declares — reach live data.
 *   A permission-only acknowledgement without one is still honoured (an older client's).
 *
 * The refusals carry neither the current base's digest nor anything to retry with: a client
 * that wants to proceed reads the review again, and reading is what shows its person the diff
 * that would now apply.
 */
export async function assertPromoteReviewCurrent(opts: {
  ack: PromotionAcknowledgement;
  channel: string;
  baseId: string | null;
  /** The migration digest moved, so the gate consumes `migrationChange`. */
  migrationsChange: boolean;
  read: () => Promise<{ base: ReviewedVersion | null; incoming: ReviewedVersion }>;
}): Promise<void> {
  const review: PromotionReviewBinding | undefined = opts.ack.review;
  if (review === undefined) {
    if (opts.migrationsChange && opts.ack.migrationChange) {
      throw substratError(
        'precondition_failed',
        `acknowledging a migration change needs the review it answers: send acknowledge.review (the base and ` +
          `digest the migrations read returned beside the diff that was shown). From the command line, upgrade ` +
          `to ${PROMOTE_REVIEW_CLI} or later and run 'substrat promote' without --ack-migrations: it prints the ` +
          `migrations and the --review token to acknowledge them with`,
        { reason: PROMOTE_REVIEW_REASONS.unbound },
      );
    }
    return;
  }
  if (review.base !== opts.baseId) {
    throw substratError(
      'precondition_failed',
      // The ids are a publisher's text (#2322): every control, format and bidi character made visible.
      `the promote review is stale: it was read against ${review.base === null ? 'no serving version' : `version ${reviewLine(review.base)}`}, ` +
        `and ${opts.channel} now points at ${opts.baseId === null ? 'none' : `version ${reviewLine(opts.baseId)}`}. ` +
        'Read the review again and acknowledge what it shows now',
      { reason: PROMOTE_REVIEW_REASONS.stale },
    );
  }
  const { base, incoming } = await opts.read();
  if ((await promoteReviewDigest(base, incoming)) !== review.digest) {
    throw substratError(
      'precondition_failed',
      'the promote review is stale: the stored versions it was computed from no longer give the digest it was ' +
        'acknowledged with. Read the review again and acknowledge what it shows now',
      { reason: PROMOTE_REVIEW_REASONS.stale },
    );
  }
}
