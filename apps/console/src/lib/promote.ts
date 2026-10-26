import { diffRegistries, unitemisedRegistryChanges } from '@substrat-run/contracts';
import type {
  ExportBreak,
  MigrationDiff,
  PermissionRegistry,
  PromotionAcknowledgement,
  PromotionReviewBinding,
  RegistryDiff,
} from '@substrat-run/contracts';

/**
 * What the promote dialog knows about whom a promotion breaks (#1705 PR 3): the impact read,
 * or why it could not be read, or that it is still loading.
 */
export type ImpactState =
  | { kind: 'loading' }
  | { kind: 'ready'; affected: ExportBreak[]; otherTenants: number }
  | { kind: 'error'; message: string };

/**
 * Whether the export-break acknowledgement is required before Promote is enabled: exactly when
 * the read names an app. An impact that could not be read does not block the button. The
 * registry's own gate still refuses a breaking promote, and its refusal is what the operator
 * then reads.
 */
export function exportBreakAckNeeded(impact: ImpactState): boolean {
  return impact.kind === 'ready' && (impact.affected.length > 0 || impact.otherTenants > 0);
}

/**
 * #2333: the acknowledgement a promote sends — what was ticked, bound to the review it was ticked
 * against when there is one. The dialog waits for a binding whenever a digest changed.
 */
export function boundAcknowledgement(ack: PromotionAcknowledgement, review: ReviewState): PromotionAcknowledgement {
  return review.kind === 'ready' && review.binding ? { ...ack, review: review.binding } : ack;
}

/** Every acknowledgement is ticked, and a changed digest has the review it answers. */
export function promoteAckSatisfied(
  needs: { permission: boolean; migration: boolean; exportBreak: boolean },
  ack: PromotionAcknowledgement,
  review: ReviewState,
): boolean {
  return (
    ((!needs.permission && !needs.migration) || (review.kind === 'ready' && review.binding !== null)) &&
    (!needs.permission || !!ack.permissionChange) &&
    (!needs.migration || !!ack.migrationChange) &&
    (!needs.exportBreak || !!ack.exportBreak)
  );
}

/**
 * What the promote dialog can show of the two diffs the digests only hint at (#1677). Read
 * from the staff API's `/registry` and `/migrations?base=` routes, and stated so an absent
 * answer never reads as an empty one: a `null` registry is a version that declared none
 * (pushed before D-39) — "cannot diff" — and a `null` migrations list is a version that
 * carries no SQL — "not available". Neither is "no change". The acknowledgement is decided
 * by the digests alone (`promoteAckSatisfied`), so it stays required when a diff is unrenderable.
 */
export type PermissionReview =
  // `unitemised`: registry fields the digest hashes but the diff does not list — an empty diff
  // beside a moved digest is not "no change".
  | { kind: 'diff'; diff: RegistryDiff; unitemised: string[] }
  | { kind: 'cannot-diff' };
export type MigrationReview =
  | { kind: 'diff'; diff: MigrationDiff }
  | { kind: 'unavailable' };

export function permissionReviewOf(
  serving: PermissionRegistry | null,
  incoming: PermissionRegistry | null,
): PermissionReview {
  if (!serving || !incoming) return { kind: 'cannot-diff' };
  const diff = diffRegistries(serving, incoming);
  return { kind: 'diff', diff, unitemised: unitemisedRegistryChanges(serving, incoming, diff) };
}

export function migrationReviewOf(migrations: MigrationDiff | null): MigrationReview {
  return migrations ? { kind: 'diff', diff: migrations } : { kind: 'unavailable' };
}

export type ReviewState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      permission: PermissionReview | null;
      migration: MigrationReview | null;
      /**
       * #2333: what the acknowledgements given against this review are bound to — the migrations
       * read's own answer, so it names the diff shown. Null from a plane that hands none out.
       */
      binding: PromotionReviewBinding | null;
    }
  | { kind: 'error'; message: string };

/** The reads a review needs; `Api` satisfies it. Each must throw when the read did not happen. */
export interface ReviewReader {
  versionRegistry(slug: string, versionId: string): Promise<{ registry: PermissionRegistry | null }>;
  versionMigrations(
    slug: string,
    versionId: string,
    base?: string,
  ): Promise<{ migrations: MigrationDiff | null; review?: PromotionReviewBinding }>;
}

/**
 * Reads only the diffs whose digest differs. A failed read is `error`, never an empty diff. The
 * migrations read is made whenever anything is to be acknowledged, since it is what hands out the
 * binding the acknowledgement carries (#2333); its diff is shown only when the migrations changed.
 */
export async function readReview(
  reader: ReviewReader,
  slug: string,
  servingId: string,
  incomingId: string,
  needs: { permission: boolean; migration: boolean },
): Promise<ReviewState> {
  try {
    const [permission, migrations] = await Promise.all([
      needs.permission
        ? Promise.all([reader.versionRegistry(slug, servingId), reader.versionRegistry(slug, incomingId)]).then(
            ([a, b]) => permissionReviewOf(a.registry, b.registry),
          )
        : null,
      needs.permission || needs.migration ? reader.versionMigrations(slug, incomingId, servingId) : null,
    ]);
    return {
      kind: 'ready',
      permission,
      migration: needs.migration && migrations ? migrationReviewOf(migrations.migrations) : null,
      binding: migrations?.review ?? null,
    };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
