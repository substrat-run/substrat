import { rebindReviewReasonIn, type PromotionReviewBinding, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { RebindReviewResult } from '@substrat-run/control-plane-api/browser';

/**
 * The console's Move (the #389 update-rebind) acknowledges the review it shows (#2347): what each
 * scope's crossing onto the target lineage would apply, read before the dialog asks, with the
 * binding its acknowledgement carries. The decisions live here so they are plain functions a
 * test holds to account; `VerticalDetail` only draws them.
 */

/** A scope the Move acts on, as the view knows it. */
export interface MoveScope {
  id: ScopeId;
  tenantId: TenantId;
  slug: string;
}

/** One scope's review. */
export interface ScopeMoveReview {
  scope: MoveScope;
  result: RebindReviewResult;
}

/** The reads and the write a Move makes; `Api` satisfies it. */
export interface MovePlane {
  rebindReview(t: TenantId, s: ScopeId, vertical: string): Promise<RebindReviewResult>;
  rebindScopeVertical(
    t: TenantId,
    s: ScopeId,
    vertical: string,
    opts?: { ackMigrations?: boolean; acknowledge?: { review?: PromotionReviewBinding } },
  ): Promise<unknown>;
}

/** Every scope's review, in order. A failed read throws: a Move never proceeds on a review it could not show. */
export async function readMoveReviews(plane: MovePlane, scopes: readonly MoveScope[], target: string): Promise<ScopeMoveReview[]> {
  const reviews: ScopeMoveReview[] = [];
  for (const scope of scopes) reviews.push({ scope, result: await plane.rebindReview(scope.tenantId, scope.id, target) });
  return reviews;
}

/**
 * The reviews the dialog must show before it may be acknowledged: each scope whose lineages'
 * migrations differ, grouped by the review it answers — one digest is one diff.
 */
export function reviewsToShow(reviews: readonly ScopeMoveReview[]): { review: RebindReviewResult; scopes: MoveScope[] }[] {
  const groups = new Map<string, { review: RebindReviewResult; scopes: MoveScope[] }>();
  for (const r of reviews) {
    if (r.result.digestsMatch) continue;
    const group = groups.get(r.result.review.digest);
    if (group) group.scopes.push(r.scope);
    else groups.set(r.result.review.digest, { review: r.result, scopes: [r.scope] });
  }
  return [...groups.values()];
}

/** What a Move run did: the scopes that moved, and what stopped it. */
export interface MoveRun {
  moved: ScopeId[];
  /** The plane's own sentence, prefixed with the scope it refused; null when every scope moved. */
  refusal: string | null;
  /** The refusal was the review's: a version moved since it was shown, or none was sent. Read it again and ask again. */
  reviewMoved: boolean;
}

/**
 * Rebind each scope in order, each with its own binding (always sent, since the plane checks a
 * binding it is given) and the acknowledgement when one was given. Stops at the first refusal, so
 * the operator reads it and re-runs the rest rather than half-acknowledging.
 */
export async function moveScopes(
  plane: MovePlane,
  reviews: readonly ScopeMoveReview[],
  target: string,
  ack: boolean,
): Promise<MoveRun> {
  const moved: ScopeId[] = [];
  const asked = reviewsToShow(reviews).length > 0;
  for (const { scope, result } of reviews) {
    try {
      await plane.rebindScopeVertical(scope.tenantId, scope.id, target, {
        ...(asked && ack ? { ackMigrations: true } : {}),
        acknowledge: { review: result.review },
      });
      moved.push(scope.id);
    } catch (e) {
      const reviewMoved = rebindReviewReasonIn((e as { body?: unknown }).body) !== undefined;
      return { moved, refusal: `${scope.slug}: ${(e as Error).message}`, reviewMoved };
    }
  }
  return { moved, refusal: null, reviewMoved: false };
}
