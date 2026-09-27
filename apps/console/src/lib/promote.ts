import { diffRegistries, unitemisedRegistryChanges } from '@substrat-run/contracts';
import type {
  ExportBreak,
  MigrationDiff,
  PermissionRegistry,
  PromotionAcknowledgement,
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

/** Every acknowledgement the dialog shows is satisfied. */
export function promoteAckSatisfied(
  needs: { permission: boolean; migration: boolean; exportBreak: boolean },
  ack: PromotionAcknowledgement,
): boolean {
  return (
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
  | { kind: 'ready'; permission: PermissionReview | null; migration: MigrationReview | null }
  | { kind: 'error'; message: string };

/** The reads a review needs; `Api` satisfies it. Each must throw when the read did not happen. */
export interface ReviewReader {
  versionRegistry(slug: string, versionId: string): Promise<{ registry: PermissionRegistry | null }>;
  versionMigrations(slug: string, versionId: string, base?: string): Promise<{ migrations: MigrationDiff | null }>;
}

/** Reads only the diffs whose digest differs. A failed read is `error`, never an empty diff. */
export async function readReview(
  reader: ReviewReader,
  slug: string,
  servingId: string,
  incomingId: string,
  needs: { permission: boolean; migration: boolean },
): Promise<ReviewState> {
  try {
    const [permission, migration] = await Promise.all([
      needs.permission
        ? Promise.all([reader.versionRegistry(slug, servingId), reader.versionRegistry(slug, incomingId)]).then(
            ([a, b]) => permissionReviewOf(a.registry, b.registry),
          )
        : null,
      needs.migration
        ? reader.versionMigrations(slug, incomingId, servingId).then((r) => migrationReviewOf(r.migrations))
        : null,
    ]);
    return { kind: 'ready', permission, migration };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
