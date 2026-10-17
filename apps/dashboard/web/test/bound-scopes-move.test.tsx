import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type BoundScopesView, type Deployment, type MoveReviewRow } from '../src/lib/api';
import { BoundScopes } from '../src/views/BoundScopes';

/**
 * #2347: the Move dialog shows what a move onto another lineage would apply before it asks, and
 * its acknowledgement answers exactly that review. When a version changes before the move lands,
 * the plane refuses it as stale, and the dialog shows the review as it stands now and asks again,
 * with no earlier tick carried over.
 */

const dep = (slug: string, versionId: string): Deployment => ({
  slug, displaySlug: slug.split('/')[1]!, name: slug, source: 'cli', owned: true,
  versions: [{ id: versionId, version: '1.0.0', createdAt: '2026-10-01T00:00:00.000Z' } as Deployment['versions'][number]],
  channels: [{ channel: 'prod', versionId }],
});
const FROM = dep('acme/courses', 'V-FROM');
const TO = dep('acme/coaching', 'V-TO');
const VIEW: BoundScopesView = {
  live: 1, archived: 0,
  scopes: [{ id: 'S1', slug: 'hr', name: 'HR', status: 'active', fork: false, movable: true, verticalVersionId: 'V-FROM', createdAt: '2026-10-01T00:00:00.000Z', hostnames: [] }],
};
const migrations = (sql: string) => ({
  added: [{ moduleId: 'crm', version: '0002', sql, moves: {}, discards: {} }], changed: [], total: 1, truncated: false,
});
const review = (over: Partial<MoveReviewRow> = {}): MoveReviewRow => ({
  scopeId: 'S1', slug: 'hr',
  base: { vertical: 'acme/courses', versionId: 'V-FROM' },
  target: { vertical: 'acme/coaching', versionId: 'V-TO' },
  digestsMatch: false,
  migrations: migrations('ALTER TABLE t ADD COLUMN a TEXT;') as MoveReviewRow['migrations'],
  migrationsWithheld: false,
  review: { base: 'V-FROM', digest: 'a'.repeat(64) },
  ...over,
});

describe('Bound scopes — Move acknowledges the review it shows (#2347)', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(api, 'listBoundScopes').mockResolvedValue(VIEW);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const button = (name: RegExp) => [...container.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''))!;
  // The dialog may render outside the container (a portal), so it is found in the document.
  const dialog = () => document.querySelector('[role="dialog"]')!;
  const tick = (label: RegExp) => [...dialog().querySelectorAll('label')].find((l) => label.test(l.textContent ?? ''));
  const click = async (el: Element) => act(async () => (el as HTMLElement).click());
  const open = async () => {
    await act(async () => root.render(<BoundScopes d={FROM} all={[FROM, TO]} onChanged={() => {}} />));
    await click([...container.querySelectorAll('label')].find((l) => /^HR/.test(l.textContent ?? ''))!);
    await click(button(/^Move… \(1\)$/));
  };
  const moveButton = () => [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Move')!;

  it('reads the review first, shows its migrations, and moves only once they are acknowledged, sending the binding', async () => {
    const read = vi.spyOn(api, 'readMoveReview').mockResolvedValue({ scopes: [review()] });
    const move = vi.spyOn(api, 'moveBoundScopes').mockResolvedValue({ moved: ['S1'], refusal: null });
    await open();
    await click(moveButton());
    expect(read).toHaveBeenCalledWith('acme/courses', { scopeIds: ['S1'], target: 'acme/coaching' });
    expect(move).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('ALTER TABLE t ADD COLUMN a TEXT;');
    expect(moveButton().disabled).toBe(true);
    await click(tick(/I have read the migrations above/)!);
    expect(moveButton().disabled).toBe(false);
    await click(moveButton());
    expect(move).toHaveBeenCalledWith('acme/courses', {
      scopeIds: ['S1'], target: 'acme/coaching', ackMigrations: true, reviews: { S1: { base: 'V-FROM', digest: 'a'.repeat(64) } },
    });
  });

  it('a review that moved is read again and asked again from scratch', async () => {
    const changed = review({ target: { vertical: 'acme/coaching', versionId: 'V-TO2' }, migrations: migrations('DROP TABLE legacy;') as MoveReviewRow['migrations'], review: { base: 'V-FROM', digest: 'b'.repeat(64) } });
    const read = vi.spyOn(api, 'readMoveReview').mockResolvedValueOnce({ scopes: [review()] }).mockResolvedValueOnce({ scopes: [changed] });
    const move = vi.spyOn(api, 'moveBoundScopes')
      .mockResolvedValueOnce({ moved: [], refusal: { scopeId: 'S1', message: 'the rebind review is stale', reason: 'rebind_review_stale' } })
      .mockResolvedValueOnce({ moved: ['S1'], refusal: null });
    await open();
    await click(moveButton());
    await click(tick(/I have read the migrations above/)!);
    await click(moveButton());
    expect(read).toHaveBeenCalledTimes(2);
    expect(dialog().textContent).toContain('A version changed while you were reviewing this move');
    expect(dialog().textContent).toContain('DROP TABLE legacy;');
    // The earlier tick does not carry over.
    expect(moveButton().disabled).toBe(true);
    await click(tick(/I have read the migrations above/)!);
    await click(moveButton());
    expect(move).toHaveBeenLastCalledWith('acme/courses', {
      scopeIds: ['S1'], target: 'acme/coaching', ackMigrations: true, reviews: { S1: { base: 'V-FROM', digest: 'b'.repeat(64) } },
    });
  });

  it('a review whose SQL is withheld says so, and is still acknowledged and bound', async () => {
    vi.spyOn(api, 'readMoveReview').mockResolvedValue({ scopes: [review({ migrations: null, migrationsWithheld: true })] });
    const move = vi.spyOn(api, 'moveBoundScopes').mockResolvedValue({ moved: ['S1'], refusal: null });
    await open();
    await click(moveButton());
    expect(dialog().textContent).toContain('Their SQL is shown only to the team that owns both verticals.');
    expect(dialog().textContent).not.toContain('SQL not available');
    expect(moveButton().disabled).toBe(true);
    await click(tick(/I have read the migrations above/)!);
    await click(moveButton());
    expect(move).toHaveBeenCalledWith('acme/courses', {
      scopeIds: ['S1'], target: 'acme/coaching', ackMigrations: true, reviews: { S1: { base: 'V-FROM', digest: 'a'.repeat(64) } },
    });
  });

  it('where the migrations match, it moves at once, with the binding and no acknowledgement', async () => {
    vi.spyOn(api, 'readMoveReview').mockResolvedValue({ scopes: [review({ digestsMatch: true })] });
    const move = vi.spyOn(api, 'moveBoundScopes').mockResolvedValue({ moved: ['S1'], refusal: null });
    await open();
    await click(moveButton());
    expect(move).toHaveBeenCalledWith('acme/courses', { scopeIds: ['S1'], target: 'acme/coaching', reviews: { S1: { base: 'V-FROM', digest: 'a'.repeat(64) } } });
  });
});
