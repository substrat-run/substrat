import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoundScopesView, Deployment, MoveReviewRow } from '../src/lib/api';
import { BoundScopes } from '../src/views/BoundScopes';

// The team client the dialog reaches through `teamApi(teamId)` (#2170): the calls, not the wire, are
// what these cases are about, and the wire is `deployments-client.test.ts`.
const client = vi.hoisted(() => ({
  listBoundScopes: vi.fn(),
  reviewScopeMove: vi.fn(),
  moveScopes: vi.fn(),
  retireScopes: vi.fn(),
}));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  teamApi: () => client,
}));

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
    for (const fn of Object.values(client)) fn.mockReset();
    client.listBoundScopes.mockResolvedValue(VIEW);
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
    await act(async () => root.render(<BoundScopes teamId="T1" d={FROM} all={[FROM, TO]} expanded onChanged={() => {}} />));
    await click([...container.querySelectorAll('label')].find((l) => /^HR/.test(l.textContent ?? ''))!);
    await click(button(/^Move… \(1\)$/));
  };
  const moveButton = () => [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Move')!;

  it('reads the review first, shows its migrations, and moves only once they are acknowledged, sending the binding', async () => {
    const read = client.reviewScopeMove.mockResolvedValue({ scopes: [review()] });
    const move = client.moveScopes.mockResolvedValue({ moved: ['S1'], refusal: null });
    await open();
    await click(moveButton());
    expect(read).toHaveBeenCalledWith({ slug: 'acme/courses', scopeIds: ['S1'], target: 'acme/coaching' });
    expect(move).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('ALTER TABLE t ADD COLUMN a TEXT;');
    expect(moveButton().disabled).toBe(true);
    await click(tick(/I have read the migrations above/)!);
    expect(moveButton().disabled).toBe(false);
    await click(moveButton());
    expect(move).toHaveBeenCalledWith({ slug: 'acme/courses',
      scopeIds: ['S1'], target: 'acme/coaching', ackMigrations: true, reviews: { S1: { base: 'V-FROM', digest: 'a'.repeat(64) } },
    });
  });

  it('a review that moved is read again and asked again from scratch', async () => {
    const changed = review({ target: { vertical: 'acme/coaching', versionId: 'V-TO2' }, migrations: migrations('DROP TABLE legacy;') as MoveReviewRow['migrations'], review: { base: 'V-FROM', digest: 'b'.repeat(64) } });
    const read = client.reviewScopeMove.mockResolvedValueOnce({ scopes: [review()] }).mockResolvedValueOnce({ scopes: [changed] });
    const move = client.moveScopes
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
    expect(move).toHaveBeenLastCalledWith({ slug: 'acme/courses',
      scopeIds: ['S1'], target: 'acme/coaching', ackMigrations: true, reviews: { S1: { base: 'V-FROM', digest: 'b'.repeat(64) } },
    });
  });

  it('a review whose SQL is withheld says so, and is still acknowledged and bound', async () => {
    client.reviewScopeMove.mockResolvedValue({ scopes: [review({ migrations: null, migrationsWithheld: true })] });
    const move = client.moveScopes.mockResolvedValue({ moved: ['S1'], refusal: null });
    await open();
    await click(moveButton());
    expect(dialog().textContent).toContain('Their SQL is shown only to the team that owns both verticals.');
    expect(dialog().textContent).not.toContain('SQL not available');
    expect(moveButton().disabled).toBe(true);
    await click(tick(/I have read the migrations above/)!);
    await click(moveButton());
    expect(move).toHaveBeenCalledWith({ slug: 'acme/courses',
      scopeIds: ['S1'], target: 'acme/coaching', ackMigrations: true, reviews: { S1: { base: 'V-FROM', digest: 'a'.repeat(64) } },
    });
  });

  it('a SQL diff the dashboard could not read arrives as null: the dialog still opens and the acknowledgement still gates the move', async () => {
    // A plane newer than the dashboard: the route answers `migrations: null` (not withheld, not matching).
    client.reviewScopeMove.mockResolvedValue({ scopes: [review({ migrations: null, migrationsWithheld: false })] });
    const move = client.moveScopes.mockResolvedValue({ moved: ['S1'], refusal: null });
    await open();
    await click(moveButton());
    expect(dialog().textContent).toContain('SQL not available');
    expect(moveButton().disabled).toBe(true);
    expect(move).not.toHaveBeenCalled();
    await click(tick(/I have read the migrations above/)!);
    expect(moveButton().disabled).toBe(false);
    await click(moveButton());
    expect(move).toHaveBeenCalledWith({
      slug: 'acme/courses', scopeIds: ['S1'], target: 'acme/coaching', ackMigrations: true, reviews: { S1: { base: 'V-FROM', digest: 'a'.repeat(64) } },
    });
  });

  it('where the migrations match, it moves at once, with the binding and no acknowledgement', async () => {
    client.reviewScopeMove.mockResolvedValue({ scopes: [review({ digestsMatch: true })] });
    const move = client.moveScopes.mockResolvedValue({ moved: ['S1'], refusal: null });
    await open();
    await click(moveButton());
    expect(move).toHaveBeenCalledWith({ slug: 'acme/courses', scopeIds: ['S1'], target: 'acme/coaching', reviews: { S1: { base: 'V-FROM', digest: 'a'.repeat(64) } } });
  });
});
