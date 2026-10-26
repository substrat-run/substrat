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
  REBIND_REVIEW_REASONS,
  reviewLine,
  substratError,
  errorCodeOf,
  type PromotionAcknowledgement,
  type PromotionReviewBinding,
  type VerticalServingState,
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

/** Lowercase hex SHA-256 of a value's JSON. */
async function digestOf(value: unknown): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The digest of a review of `incoming` over `base` (null: nothing serves). Lowercase hex SHA-256. */
export async function promoteReviewDigest(base: ReviewedVersion | null, incoming: ReviewedVersion): Promise<string> {
  return digestOf(['promote-review/1', sideOf(base), sideOf(incoming)]);
}

/**
 * The digest of a rebind review (#2347): the target lineage's serving version over the version
 * the scope is bound to (null: bound to none). Each side names its lineage too, since the two are
 * different verticals. Its own tag, so a promote's binding is never accepted as a rebind's, nor
 * the reverse: the two answer different questions over what can be the same two rows.
 */
export async function rebindReviewDigest(
  base: { vertical: string; version: ReviewedVersion } | null,
  target: { vertical: string; version: ReviewedVersion },
): Promise<string> {
  return digestOf([
    'rebind-review/1',
    base === null ? null : [base.vertical, sideOf(base.version)],
    [target.vertical, sideOf(target.version)],
  ]);
}

/**
 * Where the unbound refusal sends a person, by what the release does rather than its number: the
 * number is the release tooling's to assign, and a version named here before it is cut can name
 * one that does not carry `--review`.
 */
const PROMOTE_REVIEW_DOCS = 'https://substrat.net/guide/deploying#acknowledgement-answers-one-review';

/**
 * The refusal for a promote that lost a race (#2333): the channel moved to another version after
 * this promote's gates and review binding were judged against it. Its acknowledgements answered a
 * diff that is no longer the one it would apply, so it is refused as stale whether bound or not.
 */
export function promoteRaceRefusal(channel: string): Error {
  return substratError(
    'precondition_failed',
    `the promote review is stale: ${reviewLine(channel)} moved to another version while this promote was being ` +
      'judged. Read the review again and acknowledge what it shows now',
    { reason: PROMOTE_REVIEW_REASONS.stale },
  );
}

/**
 * The refusal for a serve that lost a race (#2528): what the vertical's serving script runs moved
 * after this serve's gate was judged against it. Nothing was written; read the serving state again
 * and retry. `precondition_failed`, as a lost promote is.
 */
export function servingRaceRefusal(vertical: string): Error {
  return substratError(
    'precondition_failed',
    `the serving version of ${reviewLine(vertical)} moved while this serve was being judged. ` +
      'Read the serving state again and retry',
  );
}

/**
 * The refusal for a listed vertical's prod taking an auto-admitted version: listing refuses it, and
 * so does a promote once the vertical is listed (#2565). Only its author has read that version.
 */
export function autoAdmittedProdRefusal(vertical: string, versionId: string): Error {
  return substratError(
    'conflict',
    `vertical '${vertical}' prod version ${versionId} is auto-admitted (private self-serve) — ` +
      'a staff admit must vouch for it before it can be prod of a listed vertical',
  );
}

/** The refusal for a promote that may move only an unlisted vertical's prod (`unlistedOnly`, #2565). */
export function listedPromoteRefusal(): Error {
  return substratError('forbidden', 'promotion to prod is staff-only for a listed vertical');
}

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
          `to a CLI release whose 'substrat promote' supports --review, and run it without --ack-migrations: it ` +
          `prints the migrations and the --review token to acknowledge them with (${PROMOTE_REVIEW_DOCS})`,
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

/** Where the unbound rebind refusal sends a person; by what the release does, as `PROMOTE_REVIEW_DOCS`. */
const REBIND_REVIEW_DOCS = 'https://substrat.net/guide/deploying#a-rebind-answers-one-review';

const rebindStale = (why: string): Error =>
  substratError('precondition_failed', `the rebind review is stale: ${why}. Read the review again and acknowledge what it shows now`, {
    reason: REBIND_REVIEW_REASONS.stale,
  });

/**
 * The refusal for a rebind that lost a race (#2347): the scope's bound version, or the target's
 * serving version, moved after the rebind's gate and review binding were judged against them, so
 * its acknowledgement answered a diff that is no longer the one it would apply.
 */
export function rebindRaceRefusal(target: string): Error {
  return rebindStale(
    `the scope's bound version or what ${reviewLine(target)} serves moved while this rebind was being judged`,
  );
}

/** Whether a throw is one of the rebind review refusals, and which. */
export function rebindReviewRefusalOf(err: unknown): 'stale' | 'unbound' | null {
  if (errorCodeOf(err) !== 'precondition_failed') return null;
  const reason = (err as { extensions?: { reason?: unknown } }).extensions?.reason;
  return reason === REBIND_REVIEW_REASONS.stale ? 'stale' : reason === REBIND_REVIEW_REASONS.unbound ? 'unbound' : null;
}

/**
 * The rebind gate's binding check (#2347), `assertPromoteReviewCurrent`'s rule for a scope
 * moving onto another lineage. `baseId` is the version the scope is bound to now (null: none),
 * `target` the lineage it moves onto. `read` loads both sides' stored rows, and is only called
 * when a binding was sent.
 *
 * - A binding is always checked: its base must be the scope's bound version, and its digest the
 *   one the stored rows of both sides give now. The target's serving version is inside the
 *   digest, so a promote on either lineage since the review was read turns it stale.
 * - Without one, an `ackMigrations` the gate is about to consume (the digests differ) is refused.
 *
 * Neither refusal hands back the current digest: the client reads the review again.
 */
export async function assertRebindReviewCurrent(opts: {
  ackMigrations: boolean;
  review: PromotionReviewBinding | undefined;
  target: string;
  baseId: string | null;
  /** The two lineages' migration digests differ (or the scope is bound to none), so the gate consumes `ackMigrations`. */
  migrationsChange: boolean;
  read: () => Promise<{ base: ReviewedVersion | null; baseVertical: string | null; target: ReviewedVersion }>;
}): Promise<void> {
  const review = opts.review;
  if (review === undefined) {
    if (opts.migrationsChange && opts.ackMigrations) {
      throw substratError(
        'precondition_failed',
        `acknowledging the migrations of a rebind needs the review it answers: send acknowledge.review (the base and ` +
          `digest the rebind-review read returned beside the diff that was shown). From the command line, upgrade ` +
          `to a CLI release whose 'substrat scope rebind' supports --review, and run it without --ack-migrations: it ` +
          `prints the migrations and the --review token to acknowledge them with (${REBIND_REVIEW_DOCS})`,
        { reason: REBIND_REVIEW_REASONS.unbound },
      );
    }
    return;
  }
  if (review.base !== opts.baseId) {
    throw rebindStale(
      // The ids are a publisher's text (#2322): every control, format and bidi character made visible.
      `it was read against ${review.base === null ? 'no bound version' : `version ${reviewLine(review.base)}`}, ` +
        `and the scope is now bound to ${opts.baseId === null ? 'none' : `version ${reviewLine(opts.baseId)}`}`,
    );
  }
  const { base, baseVertical, target } = await opts.read();
  const digest = await rebindReviewDigest(
    base && baseVertical !== null ? { vertical: baseVertical, version: base } : null,
    { vertical: opts.target, version: target },
  );
  if (digest !== review.digest) {
    throw rebindStale(
      `the stored versions it was computed from, the target's serving version among them, no longer give the ` +
        'digest it was acknowledged with',
    );
  }
}

/** #2347: what a rebind expects the target lineage's serving script to run when its write lands. */
export interface ExpectedServing {
  vertical: string;
  ref: string;
  versionId: string;
}

/** The serving row a rebind was judged against, as a `verticals` WHERE. Params: `servesNowParams`. */
export const SERVES_NOW_CONDITION = 'slug = ? AND serving_ref IS ? AND serving_version_id IS ?';

/** Appended to a rebind's `UPDATE scopes … WHERE`, so the route and pointer move only onto what was judged. */
export const SERVES_NOW_PREDICATE = `
  AND EXISTS (SELECT 1 FROM verticals WHERE ${SERVES_NOW_CONDITION})`;

export const servesNowParams = (e: ExpectedServing): string[] => [e.vertical, e.ref, e.versionId];

/**
 * #2577: the serving state a serve was computed from: the ref and version its #2178 gate judges, and
 * the class set and migration tag its upload's DO-class delta was diffed against. Nulls and `[]`:
 * nothing served. A field left out is not compared, which is how a caller from before #2577, sending
 * only the ref and version, is still answered.
 */
export interface ServedFrom {
  ref: string | null;
  versionId: string | null;
  doClasses?: string[];
  migrationTag?: string | null;
}

/** The serving columns of a `verticals` row, as both adapters store them. */
export interface ServingColumns {
  serving_ref: string | null;
  serving_version_id: string | null;
  serving_do_classes: string | null;
  serving_migration_tag: string | null;
}

/** A row's serving state, decoded as `verticalServing` decodes it. */
export const servedFromRow = (r: ServingColumns): Required<ServedFrom> => ({
  ref: r.serving_ref ?? null,
  versionId: r.serving_version_id ?? null,
  doClasses: r.serving_do_classes ? (JSON.parse(r.serving_do_classes) as string[]) : [],
  migrationTag: r.serving_migration_tag ?? null,
});

/** A `verticalServing` answer as the state a serve computed from: null is nothing served. */
export const servedFromState = (s: VerticalServingState | null): Required<ServedFrom> =>
  s ?? { ref: null, versionId: null, doClasses: [], migrationTag: null };

/** Whether the row still holds every field of `from` that is given. Read and judged in the unit that writes. */
export function servesAsFrom(r: ServingColumns, from: ServedFrom): boolean {
  const now = servedFromRow(r);
  return now.ref === from.ref && now.versionId === from.versionId &&
    (from.doClasses === undefined || JSON.stringify(now.doClasses) === JSON.stringify(from.doClasses)) &&
    (from.migrationTag === undefined || now.migrationTag === from.migrationTag);
}
