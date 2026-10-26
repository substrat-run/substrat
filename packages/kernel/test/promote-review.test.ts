import { describe, expect, it } from 'vitest';
import { errorCodeOf, PROMOTE_REVIEW_REASONS, REBIND_REVIEW_REASONS, substratError } from '@substrat-run/contracts';
import {
  assertPromoteReviewCurrent,
  assertRebindReviewCurrent,
  promoteReviewDigest,
  promoteReviewRefusalOf,
  rebindRaceRefusal,
  rebindReviewDigest,
  rebindReviewRefusalOf,
  servingRaceRefusal,
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
  const run = (ack: Parameters<typeof assertPromoteReviewCurrent>[0]['ack'], baseId: string | null = 'v1', migrationsChange = true, permissionsChange = false) =>
    assertPromoteReviewCurrent({ ack, channel: 'prod', baseId, migrationsChange, permissionsChange, read }).then(
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

  it('refuses consumed acknowledgements without a binding, and accepts a bound permission change', async () => {
    expect(await run({ migrationChange: true })).toBe('unbound');
    expect(await run({ migrationChange: true }, 'v1', false)).toBe('passed');
    expect(await run({ permissionChange: true }, 'v1', false, true)).toBe('unbound');
    expect(await run({ permissionChange: true, review: { base: 'v1', digest: await promoteReviewDigest(base, incoming) } }, 'v1', false, true)).toBe('passed');
    expect(await run({})).toBe('passed');
  });

  it('names the two bases on one line, a publisher\u2019s control characters made visible', async () => {
    const digest = await promoteReviewDigest(base, incoming);
    const err = await assertPromoteReviewCurrent({
      ack: { review: { base: 'v1\n+ forged\u202e', digest } }, channel: 'prod', baseId: 'v2\u001b[31m', migrationsChange: false, permissionsChange: false, read: async () => ({ base, incoming }),
    }).then(() => null, (e: Error) => e);
    expect(err?.message).not.toMatch(/[\n\u001b\u202e]/);
    expect(err?.message).toContain('<U+202E>');
  });

  it('reads nothing when no binding was sent', async () => {
    let reads = 0;
    await assertPromoteReviewCurrent({ ack: { permissionChange: true }, channel: 'prod', baseId: 'v1', migrationsChange: false, permissionsChange: false, read: async () => (reads++, { base, incoming }) });
    expect(reads).toBe(0);
  });

  it('recognises its own refusals by reason, not by message', () => {
    expect(promoteReviewRefusalOf(substratError('precondition_failed', 'x', { reason: PROMOTE_REVIEW_REASONS.stale }))).toBe('stale');
    expect(promoteReviewRefusalOf(substratError('precondition_failed', 'x', { reason: PROMOTE_REVIEW_REASONS.unbound }))).toBe('unbound');
    expect(promoteReviewRefusalOf(substratError('precondition_failed', 'the promote review is stale'))).toBeNull();
    expect(promoteReviewRefusalOf(substratError('conflict', 'x', { reason: PROMOTE_REVIEW_REASONS.stale }))).toBeNull();
  });
});

/**
 * #2347: a rebind's review is the target lineage's serving version over the version the scope is
 * bound to. Its digest moves with everything a promote's does, plus each side's lineage, and never
 * equals a promote's over the same rows: a promote's binding is not a rebind's, nor the reverse.
 */
describe('rebindReviewDigest and the rebind gate (#2347)', () => {
  const src = { vertical: 'acme/old', version: base };
  const dst = { vertical: 'acme/new', version: incoming };

  it('never equals a promote review of the same two rows, so neither binding passes for the other', async () => {
    const rebind = await rebindReviewDigest(src, dst);
    expect(rebind).toMatch(/^[0-9a-f]{64}$/);
    expect(rebind).not.toBe(await promoteReviewDigest(base, incoming));
    expect(await rebindReviewDigest(null, dst)).not.toBe(await promoteReviewDigest(null, incoming));
  });

  it('moves with either lineage, either side and the shown rows; not with key order', async () => {
    const d = await rebindReviewDigest(src, dst);
    const variants: [string, typeof src | null, typeof dst][] = [
      ['the source lineage', { ...src, vertical: 'acme/other' }, dst],
      ['the target lineage', src, { ...dst, vertical: 'acme/other' }],
      ['the target serving version', src, { ...dst, version: { ...incoming, id: 'v3' } }],
      ['the bound version', { ...src, version: { ...base, id: 'v0' } }, dst],
      ['a discard reason', src, { ...dst, version: at({ discards: { 't.c': 'reworded' } }) }],
      ['bound to none', null, dst],
    ];
    for (const [what, b, t] of variants) {
      expect({ what, same: (await rebindReviewDigest(b, t)) === d }).toEqual({ what, same: false });
    }
    const reordered = { ...dst, version: at({ moves: { 't.a': 't.b' }, discards: { 't.c': 'no longer read' } }) };
    expect(await rebindReviewDigest(src, reordered)).toBe(d);
  });

  const check = async (o: { ackMigrations?: boolean; review?: { base: string | null; digest: string }; baseId?: string | null; migrationsChange?: boolean }) =>
    assertRebindReviewCurrent({
      ackMigrations: o.ackMigrations ?? false,
      review: o.review,
      target: dst.vertical,
      baseId: o.baseId === undefined ? base.id : o.baseId,
      migrationsChange: o.migrationsChange ?? true,
      read: async () => ({ base, baseVertical: src.vertical, target: incoming }),
    }).then(() => 'passed', (e: unknown) => rebindReviewRefusalOf(e) ?? String(e));

  it('passes a current binding and refuses a stale base, a stale digest and a promote binding', async () => {
    const review = { base: base.id, digest: await rebindReviewDigest(src, dst) };
    expect(await check({ ackMigrations: true, review })).toBe('passed');
    expect(await check({ ackMigrations: true, review, baseId: 'v9' })).toBe('stale');
    expect(await check({ ackMigrations: true, review, baseId: null })).toBe('stale');
    expect(await check({ ackMigrations: true, review: { ...review, digest: await rebindReviewDigest(src, { ...dst, version: { ...incoming, id: 'v3' } }) } })).toBe('stale');
    expect(await check({ ackMigrations: true, review: { base: base.id, digest: await promoteReviewDigest(base, incoming) } })).toBe('stale');
    // A binding is checked even where nothing is to be acknowledged.
    expect(await check({ review: { ...review, digest: '0'.repeat(64) }, migrationsChange: false })).toBe('stale');
  });

  it('refuses an unbound migration acknowledgement where the digests differ, and nothing else', async () => {
    expect(await check({ ackMigrations: true })).toBe('unbound');
    expect(await check({ ackMigrations: true, migrationsChange: false })).toBe('passed');
    expect(await check({})).toBe('passed');
    const err = await assertRebindReviewCurrent({
      ackMigrations: true, review: undefined, target: dst.vertical, baseId: base.id, migrationsChange: true,
      read: async () => ({ base, baseVertical: src.vertical, target: incoming }),
    }).then(() => null, (e: Error) => e);
    // It names the fix by what the release does, never a version number, and links the docs.
    expect(err?.message).toContain("a CLI release whose 'substrat scope rebind' supports --review");
    expect(err?.message).toContain('/guide/deploying#a-rebind-answers-one-review');
    expect(err?.message).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it('names a publisher\u2019s ids on one line, and its refusals are told apart from a promote\u2019s by reason', async () => {
    const err = await assertRebindReviewCurrent({
      ackMigrations: true, review: { base: 'v1\n+ forged\u202e', digest: '0'.repeat(64) }, target: dst.vertical, baseId: 'v2', migrationsChange: true,
      read: async () => ({ base, baseVertical: src.vertical, target: incoming }),
    }).then(() => null, (e: Error) => e);
    expect(err?.message).not.toMatch(/[\n\u202e]/);
    expect(rebindReviewRefusalOf(rebindRaceRefusal('acme/new'))).toBe('stale');
    expect(promoteReviewRefusalOf(rebindRaceRefusal('acme/new'))).toBeNull();
    expect(rebindReviewRefusalOf(substratError('precondition_failed', 'x', { reason: PROMOTE_REVIEW_REASONS.stale }))).toBeNull();
    expect(rebindReviewRefusalOf(substratError('precondition_failed', 'x', { reason: REBIND_REVIEW_REASONS.unbound }))).toBe('unbound');
  });

  it('a lost serve is precondition_failed on one line, and not a promote or rebind review refusal (#2528)', () => {
    const err = servingRaceRefusal('acme/new\n+ forged');
    expect(errorCodeOf(err)).toBe('precondition_failed');
    expect(err.message).not.toMatch(/\n/);
    expect(promoteReviewRefusalOf(err)).toBeNull();
    expect(rebindReviewRefusalOf(err)).toBeNull();
  });

  it('reads nothing when no binding was sent', async () => {
    let reads = 0;
    await assertRebindReviewCurrent({
      ackMigrations: false, review: undefined, target: dst.vertical, baseId: base.id, migrationsChange: true,
      read: async () => (reads++, { base, baseVertical: src.vertical, target: incoming }),
    });
    expect(reads).toBe(0);
  });
});
