/**
 * Contract suite for `ctx.versionOf` — an entity's version (#901).
 *
 * What it pins: **the version was already being written.** No entity table has a
 * version column and none is going to; `_substrat_outbox` has recorded
 * `entity_type` and `entity_id` against a monotonic ULID since it was written,
 * so every mutation that followed the fat-event rule already versioned the thing
 * it touched. This suite is what holds both adapters to that reading.
 *
 * The assertions are behavioural for the reason the search suite gives: an
 * emitter or a query that reads correctly can still be wrong against a real
 * database, and a string comparison would call it a pass. So every case here
 * provisions a real scope, emits real events, and asks a real question.
 *
 * Two of these cases are the interesting ones, and neither is about the happy
 * path:
 *
 * - **A shred must not take the version with it.** The payload goes, the row
 *   stays, and an erased entity can still refuse a stale write. A version that
 *   vanished with the data would fail OPEN at exactly the moment the data was
 *   most sensitive.
 * - **A silent mutation does not move it.** That is the documented hole, pinned
 *   here deliberately so it stays a known property. The fix is a compile-checked
 *   `concurrency` against the operation's declared `emits` (#129) — not a change
 *   to this behaviour.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  dataSubjectId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { contractTestBareOps, testMod } from './modules.js';

const PERM_USE = permissionKey.parse('testmod:use');

export function entityVersionContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`entity version (ctx.versionOf): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    const versionOf = (entityId: string, entityType = 'test-thing') =>
      stub.invoke<string | null>('test/version-of', { entityType, entityId });
    const emitAbout = (entityId: string, subject?: string) =>
      stub.invoke('test/emit-about', { entityId, ...(subject ? { subject } : {}) });

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      for (const [name, handler] of Object.entries(contractTestBareOps)) {
        host.defineOperation(name, handler);
      }
      host.registerModule(testMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'version-tenant', name: 'Version Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'testmod');
      await host.admin.defineRole(staff, t1, {
        key: 'version-admin',
        permissions: [PERM_USE],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: alice,
        roleKey: 'version-admin',
        node: { tenantId: t1, scopeId: null },
      });
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'version-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      stub = await host.getScope(alice, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('is absent for an entity nothing has emitted about', async () => {
      // Absence, not a throw and not an empty string: `MAX(id)` over no rows is
      // NULL, and the caller distinguishes "never touched" from "touched" on the
      // value alone. A precondition against an entity with no history has nothing
      // to compare and must be able to see that.
      expect(await versionOf('never-touched')).toBeNull();
    });

    it('appears on the first event and moves on every one after', async () => {
      const id = `e-${ulid()}`;
      expect(await versionOf(id)).toBeNull();

      await emitAbout(id);
      const first = await versionOf(id);
      expect(first).not.toBeNull();

      await emitAbout(id);
      const second = await versionOf(id);
      expect(second).not.toBe(first);
      // ULIDs are lexicographically ordered, and `ulid()` uses the monotonic
      // factory — so two events in the SAME millisecond still compare in creation
      // order. Without that this assertion would flake rather than fail, which is
      // the worst way for it to be wrong.
      expect(second! > first!).toBe(true);
    });

    it('is stable across reads that change nothing', async () => {
      const id = `e-${ulid()}`;
      await emitAbout(id);
      const a = await versionOf(id);
      const b = await versionOf(id);
      const c = await versionOf(id);
      expect(b).toBe(a);
      expect(c).toBe(a);
    });

    it('is per entity — an event about one does not move another', async () => {
      const left = `e-${ulid()}`;
      const right = `e-${ulid()}`;
      await emitAbout(left);
      await emitAbout(right);
      const leftBefore = await versionOf(left);

      await emitAbout(right);
      // The scope's newest event is now about `right`. If the query were reading
      // the outbox head rather than the entity's own last row, this would move.
      expect(await versionOf(left)).toBe(leftBefore);
      expect(await versionOf(right)).not.toBe(leftBefore);
    });

    it('distinguishes two entities that share an id under different types', async () => {
      const shared = `e-${ulid()}`;
      await emitAbout(shared);
      const asThing = await versionOf(shared, 'test-thing');
      // Nothing has emitted about this id under the OTHER type, so the pair is
      // what identifies the row — not the id alone.
      expect(await versionOf(shared, 'other-thing')).toBeNull();
      expect(asThing).not.toBeNull();
    });

    it('reflects an emit made earlier in the same operation', async () => {
      const id = `e-${ulid()}`;
      const { before, after } = await stub.invoke<{ before: string | null; after: string | null }>(
        'test/emit-then-version',
        { entityId: id },
      );
      // Read-after-write within one operation. This holds because `emit` writes
      // the outbox row inline rather than buffering to commit — the same property
      // the search index depends on, and worth pinning where it can regress.
      expect(before).toBeNull();
      expect(after).not.toBeNull();
    });

    it('survives a shred — the payload goes, the version stays', async () => {
      const id = `e-${ulid()}`;
      const subject = dataSubjectId.parse(ulid());
      await emitAbout(id, subject);
      const before = await versionOf(id);
      expect(before).not.toBeNull();

      const receipt = await host.admin.shredSubject(staff, t1, s1, subject);
      expect(receipt.eventsRedacted).toBe(1);

      // The whole point. An erasure nulls the payload and keeps the envelope, so
      // the version token outlives the data it described. Were it to go null here,
      // a stale write against an erased entity would be admitted rather than
      // refused — failing open at the worst possible moment.
      expect(await versionOf(id)).toBe(before);
    });

    it('does NOT move for a mutation that emits nothing', async () => {
      const id = `e-${ulid()}`;
      await emitAbout(id);
      const before = await versionOf(id);

      await stub.invoke('test/mutate-silently', {});

      // The documented hole, pinned so it stays known. "Every mutation emits a fat
      // event" is enforced by review, not by boundary-lint, and this is what that
      // costs: a version that did not move because nobody announced the change.
      // The answer is a `concurrency` declaration compile-checked against the
      // operation's declared `emits` (#129) — strictly more than a version column
      // with a trigger would have given, which guarantees the column moved but
      // never that the operation said what it did.
      expect(await versionOf(id)).toBe(before);
    });
  });
}
