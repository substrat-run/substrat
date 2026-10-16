/**
 * Contract suites for a store driver's releases, rollouts and holds (D-63, #2300).
 *
 * `storeDriverReleaseContractSuite` runs on both adapters: a stored release is insert-only, a
 * rollback returns to the immediately previous good release (recorded, never derived from an
 * ordering), a hold excludes what it must, and a rollout whose holder stopped reads as
 * `diverged` to the next one.
 *
 * `storeDriverHoldExpiryContractSuite` is the transition the wall clock cannot show without
 * waiting: a hold lapses when the HOST's clock passes it. It is mounted on the pure host, which
 * takes a clock. The Durable Object host reads `Date.now()` inside the control-plane object and
 * no option reaches it (#956), the same parity gap `grantExpiryContractSuite` writes down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId } from '@substrat-run/contracts';
import { ulid, type ManualClock, type ScopeHost } from '@substrat-run/kernel';
import { expectRefusal } from './scope-host-suite.js';

export interface StoreDriverReleaseFixture {
  host: ScopeHost;
  cleanup(): Promise<void>;
}

export interface StoreDriverHoldExpiryFixture extends StoreDriverReleaseFixture {
  /** The clock the host was built on; the suite moves it. */
  clock: ManualClock;
}

const sha = (c: string) => c.repeat(64);
const commit = (c: string) => c.repeat(40);
/** A driver id of its own per test, so tests sharing one directory never meet. */
const freshDriver = () => `k${ulid().toLowerCase().slice(-10)}`;

export function storeDriverReleaseContractSuite(adapterName: string, makeFixture: () => Promise<StoreDriverReleaseFixture>): void {
  describe(`store-driver releases (D-63, #2300): ${adapterName}`, () => {
    let fixture: StoreDriverReleaseFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
    });
    afterAll(async () => fixture.cleanup());

    /** Store `shas` and roll each out to good, in order, as one holder. */
    const rollOut = async (driver: string, holder: string, ...shas: string[]) => {
      expect(await host.admin.holdStoreDriver(staff, { driver, holder, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const rows = [];
      for (const s of shas) {
        await host.admin.recordStoreDriverRelease(staff, { driver, sha256: s, sourceCommit: commit('c') });
        const row = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: s, action: 'rollout', holder });
        rows.push(await host.admin.finishStoreDriverRollout(staff, { driver, seq: row.seq, holder, state: 'good', detail: null }));
      }
      return rows;
    };

    it('stores a release once, keeps who uploaded it, and refuses the same bytes from another commit', async () => {
      const driver = freshDriver();
      const first = await host.admin.recordStoreDriverRelease(staff, { driver, sha256: sha('a'), sourceCommit: commit('1') });
      expect(first).toMatchObject({ driver, sha256: sha('a'), sourceCommit: commit('1'), uploadedBy: staff });
      const other = platformActorId.parse(ulid());
      // The same release again is the row as it stands: the uploader is not rewritten.
      expect(await host.admin.recordStoreDriverRelease(other, { driver, sha256: sha('a'), sourceCommit: commit('1') })).toEqual(first);
      await expectRefusal(host.admin.recordStoreDriverRelease(staff, { driver, sha256: sha('a'), sourceCommit: commit('2') }), 'conflict');
      expect(await host.admin.getStoreDriverRelease(staff, driver, sha('a'))).toEqual(first);
      expect(await host.admin.getStoreDriverRelease(staff, driver, sha('b'))).toBeUndefined();
      // The audit names the driver and the sha256 in the row, not in the vertical column.
      const rows = (await host.admin.auditLog(staff, { action: 'uploadStoreDriverRelease' })).filter(
        (r) => (r.after as { driver?: string } | null)?.driver === driver,
      );
      // Once: the second, identical upload wrote nothing.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: staff, vertical: null, after: { sha256: sha('a'), sourceCommit: commit('1') } });
    });

    it('rolls back to the immediately previous good release, then the one before it', async () => {
      const driver = freshDriver();
      const holder = ulid();
      await rollOut(driver, holder, sha('1'), sha('2'), sha('3'));
      expect((await host.admin.storeDriverState(staff, driver)).current).toMatchObject({ sha256: sha('3'), previousGoodSha256: sha('2') });

      // A rollback to anything but the previous good release is refused.
      await expectRefusal(host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder }), 'conflict');
      const back = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('2'), action: 'rollback', holder });
      expect(back).toMatchObject({ fromSha256: sha('3'), previousGoodSha256: sha('1'), state: 'rolling' });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: back.seq, holder, state: 'good', detail: null });
      expect((await host.admin.storeDriverState(staff, driver)).current).toMatchObject({ sha256: sha('2'), previousGoodSha256: sha('1') });

      const again = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: again.seq, holder, state: 'good', detail: null });
      const state = await host.admin.storeDriverState(staff, driver);
      expect(state.current).toMatchObject({ sha256: sha('1'), previousGoodSha256: null });
      // Nowhere further back: refused, not a guess.
      await expectRefusal(host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder }), 'conflict');
      expect(state.rollouts.map((r) => [r.action, r.sha256.slice(0, 1), r.state])).toEqual([
        ['rollout', '1', 'good'],
        ['rollout', '2', 'good'],
        ['rollout', '3', 'good'],
        ['rollback', '2', 'good'],
        ['rollback', '1', 'good'],
      ]);
    });

    it('rolls back after a diverged rollout onto the current release, never past it', async () => {
      const driver = freshDriver();
      const holder = ulid();
      await rollOut(driver, holder, sha('1'), sha('2'));
      await host.admin.recordStoreDriverRelease(staff, { driver, sha256: sha('3'), sourceCommit: commit('c') });
      const bad = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('3'), action: 'rollout', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: bad.seq, holder, state: 'diverged', detail: 'vb on 2, va on 3' });
      // The fleet may be mixed: undoing the bad rollout is converging back on 2.
      expect(await host.admin.storeDriverState(staff, driver)).toMatchObject({
        current: { sha256: sha('2'), previousGoodSha256: sha('1') },
        rollbackTarget: sha('2'),
      });
      await expectRefusal(host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder }), 'conflict');
      const back = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('2'), action: 'rollback', holder });
      // The diverged attempt did not change what 2's previous good release is.
      expect(back).toMatchObject({ fromSha256: sha('2'), previousGoodSha256: sha('1') });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: back.seq, holder, state: 'good', detail: null });
      expect(await host.admin.storeDriverState(staff, driver)).toMatchObject({ current: { sha256: sha('2') }, rollbackTarget: sha('1') });
      // A failed rollout returned every script, so a rollback after it goes back as usual.
      const failed = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('3'), action: 'rollout', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: failed.seq, holder, state: 'failed', detail: null });
      expect((await host.admin.storeDriverState(staff, driver)).rollbackTarget).toBe(sha('1'));
    });

    it('continues a paused rollback onto its target, and undoes a paused rollout onto the current release', async () => {
      const driver = freshDriver();
      const holder = ulid();
      await rollOut(driver, holder, sha('1'), sha('2'));
      const first = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: first.seq, holder, state: 'paused', detail: '2 of 5' });
      // Part way back to 1: the rollback continues to 1, it does not turn around onto 2.
      expect((await host.admin.storeDriverState(staff, driver)).rollbackTarget).toBe(sha('1'));
      await expectRefusal(host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('2'), action: 'rollback', holder }), 'conflict');
      const next = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder });
      expect(next).toMatchObject({ fromSha256: sha('2'), previousGoodSha256: null });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: next.seq, holder, state: 'good', detail: null });
      expect(await host.admin.storeDriverState(staff, driver)).toMatchObject({ current: { sha256: sha('1') }, rollbackTarget: null });
      // A rollback that ended diverged (a failure part way) continues to its target too.
      await host.admin.recordStoreDriverRelease(staff, { driver, sha256: sha('3'), sourceCommit: commit('c') });
      const three = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('3'), action: 'rollout', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: three.seq, holder, state: 'good', detail: null });
      const broken = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: broken.seq, holder, state: 'diverged', detail: 'vb failed' });
      expect((await host.admin.storeDriverState(staff, driver)).rollbackTarget).toBe(sha('1'));
      const again = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: again.seq, holder, state: 'good', detail: null });
      expect((await host.admin.storeDriverState(staff, driver)).current?.sha256).toBe(sha('1'));
      // A rollout that paused part way is undone onto the release the fleet was on.
      const paused = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('2'), action: 'rollout', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: paused.seq, holder, state: 'paused', detail: null });
      expect((await host.admin.storeDriverState(staff, driver)).rollbackTarget).toBe(sha('1'));
    });

    it('lets no rollout begin while a rollback is unfinished, and a failed attempt does not turn the rollback around', async () => {
      const driver = freshDriver();
      const holder = ulid();
      await rollOut(driver, holder, sha('1'), sha('2'));
      await host.admin.recordStoreDriverRelease(staff, { driver, sha256: sha('3'), sourceCommit: commit('c') });
      const paused = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: paused.seq, holder, state: 'paused', detail: null });
      expect(await host.admin.storeDriverState(staff, driver)).toMatchObject({ rollbackTarget: sha('1'), unfinishedRollback: sha('1') });
      // No rollout, of a new release or of the current one, until the rollback is done.
      for (const s of ['3', '2', '1']) {
        await expectRefusal(host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha(s), action: 'rollout', holder }), 'conflict');
      }
      // A rollback post that fails (its moves returned) changes nothing about where the rollback goes.
      const failed = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: failed.seq, holder, state: 'failed', detail: 'vc failed' });
      expect(await host.admin.storeDriverState(staff, driver)).toMatchObject({ rollbackTarget: sha('1'), unfinishedRollback: sha('1') });
      await expectRefusal(host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('3'), action: 'rollout', holder }), 'conflict');
      // Diverged part way (an upload failed, or the request lost its hold): still unfinished, still
      // continued by a rollback, and still blocking every rollout.
      const diverged = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: diverged.seq, holder, state: 'diverged', detail: null });
      expect((await host.admin.storeDriverState(staff, driver)).rollbackTarget).toBe(sha('1'));
      await expectRefusal(host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('3'), action: 'rollout', holder }), 'conflict');
      const done = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: done.seq, holder, state: 'good', detail: null });
      expect(await host.admin.storeDriverState(staff, driver)).toMatchObject({ current: { sha256: sha('1') }, unfinishedRollback: null });
      // Finished: a rollout may begin again.
      const next = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('3'), action: 'rollout', holder });
      // It diverges. Undoing it is a rollback onto the current release, 1; if that diverges too (a
      // script on 3 refuses to go below its schema), going forward stays open: it is the way out.
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: next.seq, holder, state: 'diverged', detail: null });
      expect((await host.admin.storeDriverState(staff, driver)).rollbackTarget).toBe(sha('1'));
      const onto = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollback', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: onto.seq, holder, state: 'diverged', detail: 'below its schema' });
      expect(await host.admin.storeDriverState(staff, driver)).toMatchObject({ unfinishedRollback: sha('1'), current: { sha256: sha('1') } });
      const forward = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('3'), action: 'rollout', holder });
      expect(forward.state).toBe('rolling');
    });

    it('renews only a hold still held, and only for a rollout still rolling', async () => {
      const driver = freshDriver();
      const [a, b] = [ulid(), ulid()];
      await host.admin.recordStoreDriverRelease(staff, { driver, sha256: sha('1'), sourceCommit: commit('c') });
      // Nothing held: a renewal is not an acquisition.
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: a, mode: 'exclusive', ttlMs: 60_000, renew: true })).toBe(false);
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: a, mode: 'shared', ttlMs: 60_000, renew: true })).toBe(false);
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: a, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const row = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollout', holder: a });
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: a, mode: 'exclusive', ttlMs: 60_000, renew: true, rolloutSeq: row.seq })).toBe(true);
      // A gives the driver up; B takes it and ends A's rollout by beginning its own.
      await host.admin.releaseStoreDriverHold(staff, { driver, holder: a });
      expect((await host.admin.storeDriverState(staff, driver)).rollouts.at(-1)?.state).toBe('diverged');
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: b, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const next = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollout', holder: b });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: next.seq, holder: b, state: 'good', detail: null });
      await host.admin.releaseStoreDriverHold(staff, { driver, holder: b });
      // A asks again: its row ended, and it holds nothing, so it gets nothing back.
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: a, mode: 'exclusive', ttlMs: 60_000, renew: true, rolloutSeq: row.seq })).toBe(false);
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: a, mode: 'exclusive', ttlMs: 60_000, renew: true })).toBe(false);
      // Even holding the driver again, a renewal names a rollout that is over.
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: a, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: a, mode: 'exclusive', ttlMs: 60_000, renew: true, rolloutSeq: row.seq })).toBe(false);
      await host.admin.releaseStoreDriverHold(staff, { driver, holder: a });
    });

    it('leaves the current release where it was when a rollout fails, and a resume keeps the rollback target', async () => {
      const driver = freshDriver();
      const holder = ulid();
      await rollOut(driver, holder, sha('1'), sha('2'));
      await host.admin.recordStoreDriverRelease(staff, { driver, sha256: sha('3'), sourceCommit: commit('c') });
      const failed = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('3'), action: 'rollout', holder });
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: failed.seq, holder, state: 'failed', detail: 'canary refused' });
      expect((await host.admin.storeDriverState(staff, driver)).current).toMatchObject({ sha256: sha('2'), previousGoodSha256: sha('1') });
      // Rolling the current release out again converges it, and a rollback from it still goes to 1.
      const resume = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('2'), action: 'rollout', holder });
      expect(resume.previousGoodSha256).toBe(sha('1'));
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: resume.seq, holder, state: 'good', detail: null });
      expect((await host.admin.storeDriverState(staff, driver)).current).toMatchObject({ sha256: sha('2'), previousGoodSha256: sha('1') });
      // A finished rollout cannot be finished again, and an unstored release cannot begin.
      await expectRefusal(host.admin.finishStoreDriverRollout(staff, { driver, seq: resume.seq, holder, state: 'good', detail: null }), 'conflict');
      await expectRefusal(host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('9'), action: 'rollout', holder }), 'not_found');
    });

    it('excludes a shared hold during an exclusive one, and an exclusive one while any hold lives', async () => {
      const driver = freshDriver();
      const [push, rollout, push2] = [ulid(), ulid(), ulid()];
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: push, mode: 'shared', ttlMs: 60_000 })).toBe(true);
      // Two pushes share a driver; a rollout waits for both.
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: push2, mode: 'shared', ttlMs: 60_000 })).toBe(true);
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(false);
      await host.admin.releaseStoreDriverHold(staff, { driver, holder: push });
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(false);
      await host.admin.releaseStoreDriverHold(staff, { driver, holder: push2 });
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      // During the rollout, no push holds the driver, and no second rollout either.
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: push, mode: 'shared', ttlMs: 60_000 })).toBe(false);
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: ulid(), mode: 'exclusive', ttlMs: 60_000 })).toBe(false);
      // The holder renews in its own mode, and may not switch mode.
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      await expectRefusal(host.admin.holdStoreDriver(staff, { driver, holder: rollout, mode: 'shared', ttlMs: 60_000 }), 'conflict');
      // Another driver is not held.
      expect(await host.admin.holdStoreDriver(staff, { driver: freshDriver(), holder: push, mode: 'shared', ttlMs: 60_000 })).toBe(true);
      await host.admin.releaseStoreDriverHold(staff, { driver, holder: rollout });
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: push, mode: 'shared', ttlMs: 60_000 })).toBe(true);
    });

    it('refuses a rollout write by anyone not holding the driver exclusively, and a stopped rollout reads as diverged', async () => {
      const driver = freshDriver();
      const [a, b] = [ulid(), ulid()];
      await host.admin.recordStoreDriverRelease(staff, { driver, sha256: sha('1'), sourceCommit: commit('c') });
      // No hold: no rollout.
      await expectRefusal(host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollout', holder: a }), 'conflict');
      // A shared hold is not enough either.
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: a, mode: 'shared', ttlMs: 60_000 })).toBe(true);
      await expectRefusal(host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollout', holder: a }), 'conflict');
      await host.admin.releaseStoreDriverHold(staff, { driver, holder: a });

      expect(await host.admin.holdStoreDriver(staff, { driver, holder: a, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const stopped = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollout', holder: a });
      // A stops holding the driver mid-rollout (here released; a crash lets the lease lapse instead).
      await host.admin.releaseStoreDriverHold(staff, { driver, holder: a });
      await expectRefusal(host.admin.finishStoreDriverRollout(staff, { driver, seq: stopped.seq, holder: a, state: 'good', detail: null }), 'conflict');
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: b, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const next = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollout', holder: b });
      const state = await host.admin.storeDriverState(staff, driver);
      expect(state.rollouts.find((r) => r.seq === stopped.seq)?.state).toBe('diverged');
      expect(state.current).toBeNull();
      await host.admin.finishStoreDriverRollout(staff, { driver, seq: next.seq, holder: b, state: 'good', detail: null });
      expect((await host.admin.storeDriverState(staff, driver)).current?.sha256).toBe(sha('1'));
    });

    it('names every vertical any version of which declared the driver, with its bindings', async () => {
      const driver = freshDriver();
      const slugA = `ska-${ulid().toLowerCase().slice(-8)}`;
      const slugB = `skb-${ulid().toLowerCase().slice(-8)}`;
      const publish = async (slug: string, scopeStores: { binding: string; driver: string }[]) => {
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
      await publish(slugA, [{ binding: 'GRAPH', driver }]);
      // B's later version drops the store: a scope still running the older one keeps its script.
      await publish(slugB, [{ binding: 'G', driver }, { binding: 'OTHER', driver: freshDriver() }]);
      await publish(slugB, []);
      const declared = await host.admin.storeDriverDeclarations(staff, driver);
      expect(declared.verticals).toEqual([
        { vertical: slugA, stores: [{ binding: 'GRAPH', driver }] },
        { vertical: slugB, stores: [{ binding: 'G', driver }] },
      ]);
      expect(declared.unreadable).not.toContain(slugA);
      expect((await host.admin.storeDriverDeclarations(staff, freshDriver())).verticals).toEqual([]);

      // A version that cannot say what it declares names its vertical as unreadable: it may hold
      // the driver, and a rollout that skipped it would not know.
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
      const after = await host.admin.storeDriverDeclarations(staff, driver);
      expect(after.unreadable).toContain(slugC);
      expect(after.verticals).toEqual(declared.verticals);
    });

    it('leases a fleet rebuild to one holder, keeps its cursor and failures, and starts over at a new fingerprint (#2309)', async () => {
      const driver = freshDriver();
      const [a, b] = [ulid(), ulid()];
      expect(await host.admin.storeDriverRebuild(staff, driver)).toBeUndefined();
      const first = await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: a, ttlMs: 60_000 });
      expect(first).toMatchObject({ driver, fingerprint: 'f1', cursor: null, failures: [], state: 'running', finishedAt: null });
      // While A's lease lives, B gets nothing, and cannot write.
      expect(await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: b, ttlMs: 60_000 })).toBeNull();
      const failed = [{ vertical: 'acme', detail: 'upload failed (500)' }];
      await expectRefusal(
        host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: b, cursor: 'acme', failures: [], done: false, ttlMs: 60_000 }),
        'conflict',
      );
      // A records progress; a write towards another fingerprint is refused, and so is `done` with a failure left.
      const moved = await host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: a, cursor: 'acme', failures: failed, done: false, ttlMs: 60_000 });
      expect(moved).toMatchObject({ cursor: 'acme', failures: failed, state: 'running' });
      await expectRefusal(
        host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f2', holder: a, cursor: 'zz', failures: [], done: false, ttlMs: 60_000 }),
        'conflict',
      );
      await expectRefusal(
        host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: a, cursor: 'acme', failures: failed, done: true, ttlMs: 60_000 }),
        'validation_failed',
      );
      // A releases its lease: B takes it, and the walk resumes where A stopped.
      await host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: a, cursor: 'acme', failures: failed, done: false, ttlMs: 60_000, release: true });
      const resumed = await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: b, ttlMs: 60_000 });
      expect(resumed).toMatchObject({ cursor: 'acme', failures: failed, startedAt: first!.startedAt });
      // The lapsed holder writes nothing once B holds it.
      await expectRefusal(
        host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: a, cursor: 'zz', failures: [], done: true, ttlMs: 60_000 }),
        'conflict',
      );
      const done = await host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: b, cursor: 'zz', failures: [], done: true, ttlMs: 60_000, release: true });
      expect(done).toMatchObject({ state: 'done', cursor: 'zz', failures: [] });
      expect(done.finishedAt).not.toBeNull();
      // The same fingerprint again keeps it done; a new one starts over, whatever was walked.
      expect(await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: a, ttlMs: 60_000 })).toMatchObject({ state: 'done', cursor: 'zz' });
      await host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f1', holder: a, cursor: 'zz', failures: [], done: true, ttlMs: 60_000, release: true });
      const restarted = await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f2', holder: a, ttlMs: 60_000 });
      expect(restarted).toMatchObject({ fingerprint: 'f2', cursor: null, failures: [], state: 'running', finishedAt: null });
      expect(await host.admin.storeDriverRebuild(staff, driver)).toEqual(restarted);
      // A restart starts a done rebuild over at the same fingerprint, and leaves a running one where it is.
      await host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f2', holder: a, cursor: 'q', failures: [], done: true, ttlMs: 60_000, release: true });
      expect(await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f2', holder: b, ttlMs: 60_000, restart: true })).toMatchObject({ cursor: null, state: 'running', finishedAt: null });
      await host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f2', holder: b, cursor: 'm', failures: [], done: false, ttlMs: 60_000, release: true });
      expect(await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f2', holder: a, ttlMs: 60_000, restart: true })).toMatchObject({ cursor: 'm', state: 'running' });
      // Another driver's rebuild is its own row.
      expect(await host.admin.storeDriverRebuild(staff, freshDriver())).toBeUndefined();
      await expectRefusal(host.admin.claimStoreDriverRebuild(staff, { driver: freshDriver(), fingerprint: 'f', holder: a, ttlMs: 0 }), 'validation_failed');
    });

    it('audits a staff-run rebuild pass as rebuildStoreDriver (#2309)', async () => {
      const driver = freshDriver();
      await host.admin.recordStoreDriverRebuildRun(staff, { driver, outcome: 'paused', walked: ['acme'], uploaded: [] });
      const rows = (await host.admin.auditLog(staff, { action: 'rebuildStoreDriver' })).filter(
        (r) => (r.after as { driver?: string } | null)?.driver === driver,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: staff, after: { driver, outcome: 'paused', walked: ['acme'], uploaded: [] } });
    });
  });
}

export function storeDriverHoldExpiryContractSuite(adapterName: string, makeFixture: () => Promise<StoreDriverHoldExpiryFixture>): void {
  describe(`store-driver hold expiry (#2300): ${adapterName}`, () => {
    let fixture: StoreDriverHoldExpiryFixture;
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
    });
    afterAll(async () => fixture.cleanup());

    it("lapses a hold on the host's clock, and a crashed rollout then reads as diverged", async () => {
      const { host, clock } = fixture;
      const driver = freshDriver();
      const [crashed, next, push] = [ulid(), ulid(), ulid()];
      await host.admin.recordStoreDriverRelease(staff, { driver, sha256: sha('1'), sourceCommit: commit('c') });
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: crashed, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      const stopped = await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollout', holder: crashed });
      // The holder never comes back. Just before the lease ends the driver is still held.
      clock.advance(59_999);
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: push, mode: 'shared', ttlMs: 1_000 })).toBe(false);
      clock.advance(1);
      // At its end it lapses. Read now, the rollout reads as stopped, though nothing wrote that.
      expect((await host.admin.storeDriverState(staff, driver)).rollouts.at(-1)).toMatchObject({ seq: stopped.seq, state: 'diverged' });
      // Its holder cannot renew it back, even with nobody else holding the driver.
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: crashed, mode: 'exclusive', ttlMs: 60_000, renew: true, rolloutSeq: stopped.seq })).toBe(false);
      // The crashed holder can write nothing, and a push holds again.
      await expectRefusal(host.admin.finishStoreDriverRollout(staff, { driver, seq: stopped.seq, holder: crashed, state: 'good', detail: null }), 'conflict');
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: push, mode: 'shared', ttlMs: 1_000 })).toBe(true);
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: next, mode: 'exclusive', ttlMs: 60_000 })).toBe(false);
      clock.advance(1_000);
      expect(await host.admin.holdStoreDriver(staff, { driver, holder: next, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      await host.admin.beginStoreDriverRollout(staff, { driver, sha256: sha('1'), action: 'rollout', holder: next });
      const state = await host.admin.storeDriverState(staff, driver);
      expect(state.rollouts.map((r) => r.state)).toEqual(['diverged', 'rolling']);
      // A lifetime that is not positive is no hold.
      await expectRefusal(host.admin.holdStoreDriver(staff, { driver: freshDriver(), holder: push, mode: 'shared', ttlMs: 0 }), 'validation_failed');
    });

    it("lapses a fleet rebuild's lease on the host's clock: another pass takes it over and the lapsed holder writes nothing (#2309)", async () => {
      const { host, clock } = fixture;
      const driver = freshDriver();
      const [crashed, next] = [ulid(), ulid()];
      await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f', holder: crashed, ttlMs: 60_000 });
      clock.advance(59_999);
      expect(await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f', holder: next, ttlMs: 60_000 })).toBeNull();
      clock.advance(1);
      // Lapsed, and nobody has claimed it: what the holder did is still recorded (and its lease renewed).
      await host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f', holder: crashed, cursor: 'm', failures: [], done: false, ttlMs: 60_000 });
      expect(await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f', holder: next, ttlMs: 60_000 })).toBeNull();
      clock.advance(60_000);
      expect(await host.admin.claimStoreDriverRebuild(staff, { driver, fingerprint: 'f', holder: next, ttlMs: 60_000 })).toMatchObject({ cursor: 'm', state: 'running' });
      await expectRefusal(
        host.admin.advanceStoreDriverRebuild(staff, { driver, fingerprint: 'f', holder: crashed, cursor: 'z', failures: [], done: true, ttlMs: 60_000 }),
        'conflict',
      );
    });
  });
}
