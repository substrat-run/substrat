import { describe, expect, it } from 'vitest';
import { PROMOTE_REVIEW_REASONS, substratError } from '@substrat-run/contracts';
import {
  assertPromoteReviewCurrent,
  promoteReviewDigest,
  promoteReviewRefusalOf,
  type ReviewedVersion,
} from '../src/promote-review.js';

/**
 * #2333: what the promote review's binding digests. It must move with everything the review
 * shows — the base, each pushed digest, every migration's SQL and each declared move and discard —
 * and must NOT move with what the review does not show, or a current review reads stale.
 */
const migration: { moduleId: string; version: string; sql: string; moves: Record<string, string>; discards: Record<string, string> } = { moduleId: 'm', version: '0002', sql: 'ALTER TABLE t DROP COLUMN c;', moves: { 't.a': 't.b' }, discards: { 't.c': 'no longer read' } };
const base: ReviewedVersion = { id: 'v1', permissionDigest: 'p1', migrationDigest: 'g1', migrations: [] };
const incoming: ReviewedVersion = { id: 'v2', permissionDigest: 'p2', migrationDigest: 'g2', migrations: [migration] };
const at = (patch: Partial<typeof migration>): ReviewedVersion => ({ ...incoming, migrations: [{ ...migration, ...patch }] });

describe('promoteReviewDigest (#2333)', () => {
  it('is lowercase hex SHA-256, and the same rows give the same digest', async () => {
    const d = await promoteReviewDigest(base, incoming);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(await promoteReviewDigest({ ...base }, { ...incoming, migrations: [{ ...migration }] })).toBe(d);
  });

  it('moves with every displayed declaration, the SQL, the ids and the pushed digests', async () => {
    const d = await promoteReviewDigest(base, incoming);
    const variants: [string, ReviewedVersion | null, ReviewedVersion][] = [
      ['a discard reason', base, at({ discards: { 't.c': 'no longer read.' } })],
      ['a discard target', base, at({ discards: { 't.d': 'no longer read' } })],
      ['a discard added', base, at({ discards: { 't.c': 'no longer read', 't.e': 'also' } })],
      ['a move source', base, at({ moves: { 't.x': 't.b' } })],
      ['a move target', base, at({ moves: { 't.a': 't.x' } })],
      ['the SQL', base, at({ sql: 'ALTER TABLE t DROP COLUMN d;' })],
      ['the migration version', base, at({ version: '0003' })],
      ['the module', base, at({ moduleId: 'n' })],
      ['the base id', { ...base, id: 'v0' }, incoming],
      ['the base permission digest', { ...base, permissionDigest: 'pX' }, incoming],
      ['the base migration digest', { ...base, migrationDigest: 'gX' }, incoming],
      ['the base migrations', { ...base, migrations: [migration] }, incoming],
      ['no base', null, incoming],
      ['the incoming permission digest', base, { ...incoming, permissionDigest: 'pX' }],
      ['the incoming migrations unavailable', base, { ...incoming, migrations: null }],
      ['no migrations at all', base, { ...incoming, migrations: [] }],
    ];
    for (const [what, b, i] of variants) {
      expect({ what, same: (await promoteReviewDigest(b, i)) === d }).toEqual({ what, same: false });
    }
  });

  it('does not move with what the review does not show: key order, or the version record’s other fields', async () => {
    const d = await promoteReviewDigest(base, incoming);
    const reordered = at({ moves: { 't.a': 't.b' }, discards: { 't.c': 'no longer read' } });
    expect(await promoteReviewDigest(base, reordered)).toBe(d);
    const withMetadata = (v: ReviewedVersion, n: number) =>
      ({ ...v, version: `label-${n}`, admission: n ? 'admitted' : 'pending', admissionNote: `note ${n}`, deploymentRef: `ref-${n}`, origin: { source: 'cli' }, createdAt: `2026-10-1${n}` }) as ReviewedVersion;
    expect(await promoteReviewDigest(withMetadata(base, 1), withMetadata(incoming, 2))).toBe(d);
  });
});

describe('assertPromoteReviewCurrent (#2333)', () => {
  const read = async () => ({ base, incoming });
  const run = (ack: Parameters<typeof assertPromoteReviewCurrent>[0]['ack'], baseId: string | null = 'v1', migrationsChange = true) =>
    assertPromoteReviewCurrent({ ack, channel: 'prod', baseId, migrationsChange, read }).then(
      () => 'passed',
      (e: unknown) => promoteReviewRefusalOf(e) ?? e,
    );

  it('passes a binding that still holds, and refuses one whose base or digest moved', async () => {
    const digest = await promoteReviewDigest(base, incoming);
    expect(await run({ migrationChange: true, review: { base: 'v1', digest } })).toBe('passed');
    expect(await run({ migrationChange: true, review: { base: 'v0', digest } })).toBe('stale');
    expect(await run({ migrationChange: true, review: { base: null, digest } })).toBe('stale');
    expect(await run({ review: { base: 'v1', digest } }, null)).toBe('stale');
    expect(await run({ migrationChange: true, review: { base: 'v1', digest: '0'.repeat(64) } })).toBe('stale');
  });

  it('refuses a consumed migration acknowledgement without a binding, and nothing else', async () => {
    expect(await run({ migrationChange: true })).toBe('unbound');
    expect(await run({ migrationChange: true }, 'v1', false)).toBe('passed');
    expect(await run({ permissionChange: true })).toBe('passed');
    expect(await run({})).toBe('passed');
  });

  it('names the two bases on one line, a publisher\u2019s control characters made visible', async () => {
    const digest = await promoteReviewDigest(base, incoming);
    const err = await assertPromoteReviewCurrent({
      ack: { review: { base: 'v1\n+ forged\u202e', digest } }, channel: 'prod', baseId: 'v2\u001b[31m', migrationsChange: false, read: async () => ({ base, incoming }),
    }).then(() => null, (e: Error) => e);
    expect(err?.message).not.toMatch(/[\n\u001b\u202e]/);
    expect(err?.message).toContain('<U+202E>');
  });

  it('reads nothing when no binding was sent', async () => {
    let reads = 0;
    await assertPromoteReviewCurrent({ ack: { permissionChange: true }, channel: 'prod', baseId: 'v1', migrationsChange: false, read: async () => (reads++, { base, incoming }) });
    expect(reads).toBe(0);
  });

  it('recognises its own refusals by reason, not by message', () => {
    expect(promoteReviewRefusalOf(substratError('precondition_failed', 'x', { reason: PROMOTE_REVIEW_REASONS.stale }))).toBe('stale');
    expect(promoteReviewRefusalOf(substratError('precondition_failed', 'x', { reason: PROMOTE_REVIEW_REASONS.unbound }))).toBe('unbound');
    expect(promoteReviewRefusalOf(substratError('precondition_failed', 'the promote review is stale'))).toBeNull();
    expect(promoteReviewRefusalOf(substratError('conflict', 'x', { reason: PROMOTE_REVIEW_REASONS.stale }))).toBeNull();
  });
});
