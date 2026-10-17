import { describe, expect, it } from 'vitest';
import { ControlPlaneError, type RebindReviewResult } from '@substrat-run/control-plane-api/browser';
import type { ScopeId, TenantId } from '@substrat-run/contracts';
import { moveScopes, readMoveReviews, reviewsToShow, type MovePlane, type MoveScope } from '../src/lib/rebind';

/**
 * #2347: the console's Move reads what each crossing would apply before it asks, and every rebind
 * carries its own scope's binding. A refusal that is the review's (a version moved since it was
 * shown, or none was sent) is told apart from any other, so the dialog reads it again.
 */
const T = 'T1' as TenantId;
const scope = (id: string): MoveScope => ({ id: id as ScopeId, tenantId: T, slug: id.toLowerCase() });
const result = (digest: string, digestsMatch = false): RebindReviewResult => ({
  base: { vertical: 'acme/old', versionId: 'V1' },
  target: { vertical: 'acme/new', versionId: 'V2' },
  digestsMatch,
  migrations: null,
  review: { base: 'V1', digest },
});
const problem = (reason: string) =>
  new ControlPlaneError(412, 'refused', undefined, {
    body: JSON.stringify({ type: 'about:blank', status: 412, code: 'precondition_failed', detail: 'refused', reason }),
  });

function plane(answers: Record<string, RebindReviewResult>, refuse: Record<string, Error> = {}) {
  const sent: Array<{ id: string; opts: unknown }> = [];
  const p: MovePlane = {
    rebindReview: async (_t, s) => answers[s]!,
    rebindScopeVertical: async (_t, s, _v, opts) => {
      sent.push({ id: s, opts });
      if (refuse[s]) throw refuse[s];
      return {};
    },
  };
  return { p, sent };
}

describe('the console Move binds each scope to the review it showed (#2347)', () => {
  it('reads every scope’s review and groups the ones to ask about by the diff they show', async () => {
    const { p } = plane({ A: result('d1'), B: result('d1'), C: result('d2'), D: result('d3', true) });
    const reviews = await readMoveReviews(p, ['A', 'B', 'C', 'D'].map(scope), 'acme/new');
    expect(reviewsToShow(reviews).map((g) => [g.review.review.digest, g.scopes.map((s) => s.id)])).toEqual([
      ['d1', ['A', 'B']],
      ['d2', ['C']],
    ]);
  });

  it('sends each binding, the acknowledgement only where one was asked, and stops at the first refusal', async () => {
    const { p, sent } = plane({ A: result('d1'), B: result('d1'), C: result('d1') }, { B: new ControlPlaneError(409, 'no') });
    const reviews = await readMoveReviews(p, ['A', 'B', 'C'].map(scope), 'acme/new');
    const run = await moveScopes(p, reviews, 'acme/new', true);
    expect(sent).toEqual([
      { id: 'A', opts: { ackMigrations: true, acknowledge: { review: { base: 'V1', digest: 'd1' } } } },
      { id: 'B', opts: { ackMigrations: true, acknowledge: { review: { base: 'V1', digest: 'd1' } } } },
    ]);
    expect(run).toEqual({ moved: ['A'], refusal: 'b: no', reviewMoved: false });
    // Nothing to acknowledge: the binding still rides, the acknowledgement does not.
    const same = plane({ A: result('d9', true) });
    await moveScopes(same.p, await readMoveReviews(same.p, [scope('A')], 'acme/new'), 'acme/new', true);
    expect(same.sent).toEqual([{ id: 'A', opts: { acknowledge: { review: { base: 'V1', digest: 'd9' } } } }]);
  });

  it('tells a review refusal apart from any other, by its reason', async () => {
    for (const [reason, moved] of [['rebind_review_stale', true], ['rebind_review_unbound', true], ['promote_review_stale', false]] as const) {
      const { p } = plane({ A: result('d1') }, { A: problem(reason) });
      const run = await moveScopes(p, await readMoveReviews(p, [scope('A')], 'acme/new'), 'acme/new', true);
      expect([reason, run.reviewMoved]).toEqual([reason, moved]);
    }
  });
});
