/**
 * Contract suites for a store kind's releases, rollouts and holds (D-63, #2300).
 *
 * `storeKindReleaseContractSuite` runs on both adapters: a stored release is insert-only, a
 * rollback returns to the immediately previous good release (recorded, never derived from an
 * ordering), a hold excludes what it must, and a rollout whose holder stopped reads as
 * `diverged` to the next one.
 *
 * `storeKindHoldExpiryContractSuite` is the transition the wall clock cannot show without
 * waiting: a hold lapses when the HOST's clock passes it. It is mounted on the pure host, which
 * takes a clock. The Durable Object host reads `Date.now()` inside the control-plane object and
 * no option reaches it (#956), the same parity gap `grantExpiryContractSuite` writes down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId } from '@substrat-run/contracts';
import { ulid, type ManualClock, type ScopeHost } from '@substrat-run/kernel';
import { expectRefusal } from './scope-host-suite.js';

export interface StoreKindReleaseFixture {
  host: ScopeHost;
  cleanup(): Promise<void>;
}

export interface StoreKindHoldExpiryFixture extends StoreKindReleaseFixture {
  /** The clock the host was built on; the suite moves it. */
  clock: ManualClock;
}

const sha = (c: string) => c.repeat(64);
const commit = (c: string) => c.repeat(40);
/** A kind id of its own per test, so tests sharing one directory never meet. */
const freshKind = () => `k${ulid().toLowerCase().slice(-10)}`;

export function storeKindReleaseContractSuite(adapterName: string, makeFixture: () => Promise<StoreKindReleaseFixture>): void {
  describe(`store-kind releases (D-63, #2300): ${adapterName}`, () => {
    let fixture: StoreKindReleaseFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
    });
    afterAll(async () => fixture.cleanup());

    /** Store `shas` and roll each out to good, in order, as one holder. */
    const rollOut = async (kind: string, holder: string, ...shas: string[]) => {
      expect(await host.admin.holdStoreKind(staff, { kind, holder, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const rows = [];
      for (const s of shas) {
        await host.admin.recordStoreKindRelease(staff, { kind, sha256: s, sourceCommit: commit('c') });
        const row = await host.admin.beginStoreKindRollout(staff, { kind, sha256: s, action: 'rollout', holder });
        rows.push(await host.admin.finishStoreKindRollout(staff, { kind, seq: row.seq, holder, state: 'good', detail: null }));
      }
      return rows;
    };

    it('stores a release once, keeps who uploaded it, and refuses the same bytes from another commit', async () => {
      const kind = freshKind();
      const first = await host.admin.recordStoreKindRelease(staff, { kind, sha256: sha('a'), sourceCommit: commit('1') });
      expect(first).toMatchObject({ kind, sha256: sha('a'), sourceCommit: commit('1'), uploadedBy: staff });
      const other = platformActorId.parse(ulid());
      // The same release again is the row as it stands: the uploader is not rewritten.
      expect(await host.admin.recordStoreKindRelease(other, { kind, sha256: sha('a'), sourceCommit: commit('1') })).toEqual(first);
      await expectRefusal(host.admin.recordStoreKindRelease(staff, { kind, sha256: sha('a'), sourceCommit: commit('2') }), 'conflict');
      expect(await host.admin.getStoreKindRelease(staff, kind, sha('a'))).toEqual(first);
      expect(await host.admin.getStoreKindRelease(staff, kind, sha('b'))).toBeUndefined();
      // The audit names the kind and the sha256 in the row, not in the vertical column.
      const rows = (await host.admin.auditLog(staff, { action: 'uploadStoreKindRelease' })).filter(
        (r) => (r.after as { kind?: string } | null)?.kind === kind,
      );
      // Once: the second, identical upload wrote nothing.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: staff, vertical: null, after: { sha256: sha('a'), sourceCommit: commit('1') } });
    });

    it('rolls back to the immediately previous good release, then the one before it', async () => {
      const kind = freshKind();
      const holder = ulid();
      await rollOut(kind, holder, sha('1'), sha('2'), sha('3'));
      expect((await host.admin.storeKindState(staff, kind)).current).toMatchObject({ sha256: sha('3'), previousGoodSha256: sha('2') });

      // A rollback to anything but the previous good release is refused.
      await expectRefusal(host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder }), 'conflict');
      const back = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('2'), action: 'rollback', holder });
      expect(back).toMatchObject({ fromSha256: sha('3'), previousGoodSha256: sha('1'), state: 'rolling' });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: back.seq, holder, state: 'good', detail: null });
      expect((await host.admin.storeKindState(staff, kind)).current).toMatchObject({ sha256: sha('2'), previousGoodSha256: sha('1') });

      const again = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: again.seq, holder, state: 'good', detail: null });
      const state = await host.admin.storeKindState(staff, kind);
      expect(state.current).toMatchObject({ sha256: sha('1'), previousGoodSha256: null });
      // Nowhere further back: refused, not a guess.
      await expectRefusal(host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder }), 'conflict');
      expect(state.rollouts.map((r) => [r.action, r.sha256.slice(0, 1), r.state])).toEqual([
        ['rollout', '1', 'good'],
        ['rollout', '2', 'good'],
        ['rollout', '3', 'good'],
        ['rollback', '2', 'good'],
        ['rollback', '1', 'good'],
      ]);
    });

    it('rolls back after a diverged rollout onto the current release, never past it', async () => {
      const kind = freshKind();
      const holder = ulid();
      await rollOut(kind, holder, sha('1'), sha('2'));
      await host.admin.recordStoreKindRelease(staff, { kind, sha256: sha('3'), sourceCommit: commit('c') });
      const bad = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('3'), action: 'rollout', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: bad.seq, holder, state: 'diverged', detail: 'vb on 2, va on 3' });
      // The fleet may be mixed: undoing the bad rollout is converging back on 2.
      expect(await host.admin.storeKindState(staff, kind)).toMatchObject({
        current: { sha256: sha('2'), previousGoodSha256: sha('1') },
        rollbackTarget: sha('2'),
      });
      await expectRefusal(host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder }), 'conflict');
      const back = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('2'), action: 'rollback', holder });
      // The diverged attempt did not change what 2's previous good release is.
      expect(back).toMatchObject({ fromSha256: sha('2'), previousGoodSha256: sha('1') });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: back.seq, holder, state: 'good', detail: null });
      expect(await host.admin.storeKindState(staff, kind)).toMatchObject({ current: { sha256: sha('2') }, rollbackTarget: sha('1') });
      // A failed rollout returned every script, so a rollback after it goes back as usual.
      const failed = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('3'), action: 'rollout', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: failed.seq, holder, state: 'failed', detail: null });
      expect((await host.admin.storeKindState(staff, kind)).rollbackTarget).toBe(sha('1'));
    });

    it('continues a paused rollback onto its target, and undoes a paused rollout onto the current release', async () => {
      const kind = freshKind();
      const holder = ulid();
      await rollOut(kind, holder, sha('1'), sha('2'));
      const first = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: first.seq, holder, state: 'paused', detail: '2 of 5' });
      // Part way back to 1: the rollback continues to 1, it does not turn around onto 2.
      expect((await host.admin.storeKindState(staff, kind)).rollbackTarget).toBe(sha('1'));
      await expectRefusal(host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('2'), action: 'rollback', holder }), 'conflict');
      const next = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder });
      expect(next).toMatchObject({ fromSha256: sha('2'), previousGoodSha256: null });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: next.seq, holder, state: 'good', detail: null });
      expect(await host.admin.storeKindState(staff, kind)).toMatchObject({ current: { sha256: sha('1') }, rollbackTarget: null });
      // A rollback that ended diverged (a failure part way) continues to its target too.
      await host.admin.recordStoreKindRelease(staff, { kind, sha256: sha('3'), sourceCommit: commit('c') });
      const three = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('3'), action: 'rollout', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: three.seq, holder, state: 'good', detail: null });
      const broken = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: broken.seq, holder, state: 'diverged', detail: 'vb failed' });
      expect((await host.admin.storeKindState(staff, kind)).rollbackTarget).toBe(sha('1'));
      const again = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: again.seq, holder, state: 'good', detail: null });
      expect((await host.admin.storeKindState(staff, kind)).current?.sha256).toBe(sha('1'));
      // A rollout that paused part way is undone onto the release the fleet was on.
      const paused = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('2'), action: 'rollout', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: paused.seq, holder, state: 'paused', detail: null });
      expect((await host.admin.storeKindState(staff, kind)).rollbackTarget).toBe(sha('1'));
    });

    it('lets no rollout begin while a rollback is unfinished, and a failed attempt does not turn the rollback around', async () => {
      const kind = freshKind();
      const holder = ulid();
      await rollOut(kind, holder, sha('1'), sha('2'));
      await host.admin.recordStoreKindRelease(staff, { kind, sha256: sha('3'), sourceCommit: commit('c') });
      const paused = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: paused.seq, holder, state: 'paused', detail: null });
      expect(await host.admin.storeKindState(staff, kind)).toMatchObject({ rollbackTarget: sha('1'), unfinishedRollback: sha('1') });
      // No rollout, of a new release or of the current one, until the rollback is done.
      for (const s of ['3', '2', '1']) {
        await expectRefusal(host.admin.beginStoreKindRollout(staff, { kind, sha256: sha(s), action: 'rollout', holder }), 'conflict');
      }
      // A rollback post that fails (its moves returned) changes nothing about where the rollback goes.
      const failed = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: failed.seq, holder, state: 'failed', detail: 'vc failed' });
      expect(await host.admin.storeKindState(staff, kind)).toMatchObject({ rollbackTarget: sha('1'), unfinishedRollback: sha('1') });
      await expectRefusal(host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('3'), action: 'rollout', holder }), 'conflict');
      // Diverged part way (an upload failed, or the request lost its hold): still unfinished, still
      // continued by a rollback, and still blocking every rollout.
      const diverged = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: diverged.seq, holder, state: 'diverged', detail: null });
      expect((await host.admin.storeKindState(staff, kind)).rollbackTarget).toBe(sha('1'));
      await expectRefusal(host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('3'), action: 'rollout', holder }), 'conflict');
      const done = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: done.seq, holder, state: 'good', detail: null });
      expect(await host.admin.storeKindState(staff, kind)).toMatchObject({ current: { sha256: sha('1') }, unfinishedRollback: null });
      // Finished: a rollout may begin again.
      const next = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('3'), action: 'rollout', holder });
      // It diverges. Undoing it is a rollback onto the current release, 1; if that diverges too (a
      // script on 3 refuses to go below its schema), going forward stays open: it is the way out.
      await host.admin.finishStoreKindRollout(staff, { kind, seq: next.seq, holder, state: 'diverged', detail: null });
      expect((await host.admin.storeKindState(staff, kind)).rollbackTarget).toBe(sha('1'));
      const onto = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: onto.seq, holder, state: 'diverged', detail: 'below its schema' });
      expect(await host.admin.storeKindState(staff, kind)).toMatchObject({ unfinishedRollback: sha('1'), current: { sha256: sha('1') } });
      const forward = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('3'), action: 'rollout', holder });
      expect(forward.state).toBe('rolling');
    });

    it('renews only a hold still held, and only for a rollout still rolling', async () => {
      const kind = freshKind();
      const [a, b] = [ulid(), ulid()];
      await host.admin.recordStoreKindRelease(staff, { kind, sha256: sha('1'), sourceCommit: commit('c') });
      // Nothing held: a renewal is not an acquisition.
      expect(await host.admin.holdStoreKind(staff, { kind, holder: a, mode: 'exclusive', ttlMs: 60_000, renew: true })).toBe(false);
      expect(await host.admin.holdStoreKind(staff, { kind, holder: a, mode: 'shared', ttlMs: 60_000, renew: true })).toBe(false);
      expect(await host.admin.holdStoreKind(staff, { kind, holder: a, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const row = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollout', holder: a });
      expect(await host.admin.holdStoreKind(staff, { kind, holder: a, mode: 'exclusive', ttlMs: 60_000, renew: true, rolloutSeq: row.seq })).toBe(true);
      // A gives the kind up; B takes it and ends A's rollout by beginning its own.
      await host.admin.releaseStoreKindHold(staff, { kind, holder: a });
      expect((await host.admin.storeKindState(staff, kind)).rollouts.at(-1)?.state).toBe('diverged');
      expect(await host.admin.holdStoreKind(staff, { kind, holder: b, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const next = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollout', holder: b });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: next.seq, holder: b, state: 'good', detail: null });
      await host.admin.releaseStoreKindHold(staff, { kind, holder: b });
      // A asks again: its row ended, and it holds nothing, so it gets nothing back.
      expect(await host.admin.holdStoreKind(staff, { kind, holder: a, mode: 'exclusive', ttlMs: 60_000, renew: true, rolloutSeq: row.seq })).toBe(false);
      expect(await host.admin.holdStoreKind(staff, { kind, holder: a, mode: 'exclusive', ttlMs: 60_000, renew: true })).toBe(false);
      // Even holding the kind again, a renewal names a rollout that is over.
      expect(await host.admin.holdStoreKind(staff, { kind, holder: a, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      expect(await host.admin.holdStoreKind(staff, { kind, holder: a, mode: 'exclusive', ttlMs: 60_000, renew: true, rolloutSeq: row.seq })).toBe(false);
      await host.admin.releaseStoreKindHold(staff, { kind, holder: a });
    });

    it('leaves the current release where it was when a rollout fails, and a resume keeps the rollback target', async () => {
      const kind = freshKind();
      const holder = ulid();
      await rollOut(kind, holder, sha('1'), sha('2'));
      await host.admin.recordStoreKindRelease(staff, { kind, sha256: sha('3'), sourceCommit: commit('c') });
      const failed = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('3'), action: 'rollout', holder });
      await host.admin.finishStoreKindRollout(staff, { kind, seq: failed.seq, holder, state: 'failed', detail: 'canary refused' });
      expect((await host.admin.storeKindState(staff, kind)).current).toMatchObject({ sha256: sha('2'), previousGoodSha256: sha('1') });
      // Rolling the current release out again converges it, and a rollback from it still goes to 1.
      const resume = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('2'), action: 'rollout', holder });
      expect(resume.previousGoodSha256).toBe(sha('1'));
      await host.admin.finishStoreKindRollout(staff, { kind, seq: resume.seq, holder, state: 'good', detail: null });
      expect((await host.admin.storeKindState(staff, kind)).current).toMatchObject({ sha256: sha('2'), previousGoodSha256: sha('1') });
      // A finished rollout cannot be finished again, and an unstored release cannot begin.
      await expectRefusal(host.admin.finishStoreKindRollout(staff, { kind, seq: resume.seq, holder, state: 'good', detail: null }), 'conflict');
      await expectRefusal(host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('9'), action: 'rollout', holder }), 'not_found');
    });

    it('excludes a shared hold during an exclusive one, and an exclusive one while any hold lives', async () => {
      const kind = freshKind();
      const [push, rollout, push2] = [ulid(), ulid(), ulid()];
      expect(await host.admin.holdStoreKind(staff, { kind, holder: push, mode: 'shared', ttlMs: 60_000 })).toBe(true);
      // Two pushes share a kind; a rollout waits for both.
      expect(await host.admin.holdStoreKind(staff, { kind, holder: push2, mode: 'shared', ttlMs: 60_000 })).toBe(true);
      expect(await host.admin.holdStoreKind(staff, { kind, holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(false);
      await host.admin.releaseStoreKindHold(staff, { kind, holder: push });
      expect(await host.admin.holdStoreKind(staff, { kind, holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(false);
      await host.admin.releaseStoreKindHold(staff, { kind, holder: push2 });
      expect(await host.admin.holdStoreKind(staff, { kind, holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      // During the rollout, no push holds the kind, and no second rollout either.
      expect(await host.admin.holdStoreKind(staff, { kind, holder: push, mode: 'shared', ttlMs: 60_000 })).toBe(false);
      expect(await host.admin.holdStoreKind(staff, { kind, holder: ulid(), mode: 'exclusive', ttlMs: 60_000 })).toBe(false);
      // The holder renews in its own mode, and may not switch mode.
      expect(await host.admin.holdStoreKind(staff, { kind, holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      await expectRefusal(host.admin.holdStoreKind(staff, { kind, holder: rollout, mode: 'shared', ttlMs: 60_000 }), 'conflict');
      // Another kind is not held.
      expect(await host.admin.holdStoreKind(staff, { kind: freshKind(), holder: push, mode: 'shared', ttlMs: 60_000 })).toBe(true);
      await host.admin.releaseStoreKindHold(staff, { kind, holder: rollout });
      expect(await host.admin.holdStoreKind(staff, { kind, holder: push, mode: 'shared', ttlMs: 60_000 })).toBe(true);
    });

    it('refuses a rollout write by anyone not holding the kind exclusively, and a stopped rollout reads as diverged', async () => {
      const kind = freshKind();
      const [a, b] = [ulid(), ulid()];
      await host.admin.recordStoreKindRelease(staff, { kind, sha256: sha('1'), sourceCommit: commit('c') });
      // No hold: no rollout.
      await expectRefusal(host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollout', holder: a }), 'conflict');
      // A shared hold is not enough either.
      expect(await host.admin.holdStoreKind(staff, { kind, holder: a, mode: 'shared', ttlMs: 60_000 })).toBe(true);
      await expectRefusal(host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollout', holder: a }), 'conflict');
      await host.admin.releaseStoreKindHold(staff, { kind, holder: a });

      expect(await host.admin.holdStoreKind(staff, { kind, holder: a, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const stopped = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollout', holder: a });
      // A stops holding the kind mid-rollout (here released; a crash lets the lease lapse instead).
      await host.admin.releaseStoreKindHold(staff, { kind, holder: a });
      await expectRefusal(host.admin.finishStoreKindRollout(staff, { kind, seq: stopped.seq, holder: a, state: 'good', detail: null }), 'conflict');
      expect(await host.admin.holdStoreKind(staff, { kind, holder: b, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const next = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollout', holder: b });
      const state = await host.admin.storeKindState(staff, kind);
      expect(state.rollouts.find((r) => r.seq === stopped.seq)?.state).toBe('diverged');
      expect(state.current).toBeNull();
      await host.admin.finishStoreKindRollout(staff, { kind, seq: next.seq, holder: b, state: 'good', detail: null });
      expect((await host.admin.storeKindState(staff, kind)).current?.sha256).toBe(sha('1'));
    });

    it('names every vertical any version of which declared the kind, with its bindings', async () => {
      const kind = freshKind();
      const slugA = `ska-${ulid().toLowerCase().slice(-8)}`;
      const slugB = `skb-${ulid().toLowerCase().slice(-8)}`;
      const publish = async (slug: string, scopeStores: { binding: string; kind: string }[]) => {
        const id = ulid();
        await host.admin.publishVersion(staff, {
          id,
          verticalSlug: slug,
          version: `1.0.${id.slice(-6).toLowerCase()}`,
          manifestDigest: `m-${id}`,
          permissionDigest: 'p',
          migrationDigest: 'g',
          deploymentRef: null,
          manifestJson: JSON.stringify({
            version: '1.0.0', entry: 'index.js', compatibilityDate: '2026-07-01',
            registry: { permissions: [], roles: [], entityGrants: [] },
            digests: { manifest: 'm', permission: 'p', migration: 'g' },
            scopeStores,
          }),
        });
      };
      for (const slug of [slugA, slugB]) await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
      await publish(slugA, [{ binding: 'GRAPH', kind }]);
      // B's later version drops the store: a scope still running the older one keeps its script.
      await publish(slugB, [{ binding: 'G', kind }, { binding: 'OTHER', kind: freshKind() }]);
      await publish(slugB, []);
      const declared = await host.admin.storeKindDeclarations(staff, kind);
      expect(declared.verticals).toEqual([
        { vertical: slugA, stores: [{ binding: 'GRAPH', kind }] },
        { vertical: slugB, stores: [{ binding: 'G', kind }] },
      ]);
      expect(declared.unreadable).not.toContain(slugA);
      expect((await host.admin.storeKindDeclarations(staff, freshKind())).verticals).toEqual([]);

      // A version that cannot say what it declares names its vertical as unreadable: it may hold
      // the kind, and a rollout that skipped it would not know.
      const slugC = `skc-${ulid().toLowerCase().slice(-8)}`;
      await host.admin.registerVertical(staff, { slug: slugC, name: slugC, source: 'cli' });
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id,
        verticalSlug: slugC,
        version: `1.0.${id.slice(-6).toLowerCase()}`,
        manifestDigest: `m-${id}`,
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: null,
        manifestJson: '{nope',
      });
      const after = await host.admin.storeKindDeclarations(staff, kind);
      expect(after.unreadable).toContain(slugC);
      expect(after.verticals).toEqual(declared.verticals);
    });
  });
}

export function storeKindHoldExpiryContractSuite(adapterName: string, makeFixture: () => Promise<StoreKindHoldExpiryFixture>): void {
  describe(`store-kind hold expiry (#2300): ${adapterName}`, () => {
    let fixture: StoreKindHoldExpiryFixture;
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
    });
    afterAll(async () => fixture.cleanup());

    it("lapses a hold on the host's clock, and a crashed rollout then reads as diverged", async () => {
      const { host, clock } = fixture;
      const kind = freshKind();
      const [crashed, next, push] = [ulid(), ulid(), ulid()];
      await host.admin.recordStoreKindRelease(staff, { kind, sha256: sha('1'), sourceCommit: commit('c') });
      expect(await host.admin.holdStoreKind(staff, { kind, holder: crashed, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const stopped = await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollout', holder: crashed });
      // The holder never comes back. Just before the lease ends the kind is still held.
      clock.advance(59_999);
      expect(await host.admin.holdStoreKind(staff, { kind, holder: push, mode: 'shared', ttlMs: 1_000 })).toBe(false);
      clock.advance(1);
      // At its end it lapses. Read now, the rollout reads as stopped, though nothing wrote that.
      expect((await host.admin.storeKindState(staff, kind)).rollouts.at(-1)).toMatchObject({ seq: stopped.seq, state: 'diverged' });
      // Its holder cannot renew it back, even with nobody else holding the kind.
      expect(await host.admin.holdStoreKind(staff, { kind, holder: crashed, mode: 'exclusive', ttlMs: 60_000, renew: true, rolloutSeq: stopped.seq })).toBe(false);
      // The crashed holder can write nothing, and a push holds again.
      await expectRefusal(host.admin.finishStoreKindRollout(staff, { kind, seq: stopped.seq, holder: crashed, state: 'good', detail: null }), 'conflict');
      expect(await host.admin.holdStoreKind(staff, { kind, holder: push, mode: 'shared', ttlMs: 1_000 })).toBe(true);
      expect(await host.admin.holdStoreKind(staff, { kind, holder: next, mode: 'exclusive', ttlMs: 60_000 })).toBe(false);
      clock.advance(1_000);
      expect(await host.admin.holdStoreKind(staff, { kind, holder: next, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      await host.admin.beginStoreKindRollout(staff, { kind, sha256: sha('1'), action: 'rollout', holder: next });
      const state = await host.admin.storeKindState(staff, kind);
      expect(state.rollouts.map((r) => r.state)).toEqual(['diverged', 'rolling']);
      // A lifetime that is not positive is no hold.
      await expectRefusal(host.admin.holdStoreKind(staff, { kind: freshKind(), holder: push, mode: 'shared', ttlMs: 0 }), 'validation_failed');
    });
  });
}
