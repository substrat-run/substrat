/**
 * Contract suite for optimistic concurrency — `If-Match` and the 412 (#129).
 *
 * What it pins: **the comparison belongs to the HOST, and it happens inside the
 * write's own transaction.** Everything else about this feature is a projection.
 * The header names are a wire detail `vertical-host` owns, the declaration is a
 * model detail `contracts` owns, and neither is what makes a write safe — that is
 * this: a version read and a write committed with nothing able to interleave.
 *
 * Behavioural, for the reason the entity-version suite gives one screen over: an
 * adapter that reads correctly can still be wrong against a real database, and a
 * string comparison on the emitted SQL would call it a pass. So every case here
 * provisions a real scope, commits real writes, and asks a real question.
 *
 * The cases that matter are not the happy path:
 *
 * - **A refused write leaves nothing behind.** The precondition runs before the
 *   guards and before the handler, so a 412 must not be a partial write with an
 *   error attached.
 * - **An `If-Match` on an operation that declares nothing is REFUSED.** Ignoring
 *   it would leave a caller believing its write was serialised when nothing was
 *   compared — the failure this whole mechanism exists to prevent, arrived at
 *   through the mechanism itself.
 * - **A guarded write that emits nothing does not move the tag.** The documented
 *   hole, pinned here so it stays a known property of the spine rather than
 *   something an adapter is tempted to paper over by fabricating a version.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  etagOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  errorCodeOf,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { concurrencyMod } from './modules.js';

const CONC_USE = permissionKey.parse('conc:use');

export function concurrencyContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`optimistic concurrency (If-Match): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    /** Every tag the host reported, newest last — the `ETag` an HTTP layer would set. */
    let tags: (string | null)[] = [];
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    /** The version the host last reported — what a client would be holding. */
    const lastTag = (): string => {
      const version = tags.at(-1);
      if (typeof version !== 'string') throw new Error('no version was reported');
      return version;
    };

    /**
     * The reply channel an HTTP mount supplies, collected rather than overwritten
     * so a case can assert a version was NOT reported as easily as that one was.
     */
    const sink = { onEntityVersion: (version: string | null) => tags.push(version) };
    const update = (thingId: string, label: string, ifMatch?: string) =>
      stub.invoke('conc/update', { thingId, label }, { ...sink, ...(ifMatch === undefined ? {} : { ifMatch }) });
    const read = (thingId: string, ifMatch?: string) =>
      stub.invoke('conc/read', { thingId }, { ...sink, ...(ifMatch === undefined ? {} : { ifMatch }) });

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(concurrencyMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'conc-tenant', name: 'Conc Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'conc');
      await host.admin.defineRole(staff, t1, {
        key: 'conc-admin',
        permissions: [CONC_USE],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: alice,
        roleKey: 'conc-admin',
        node: { tenantId: t1, scopeId: null },
      });
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'conc-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      stub = await host.getScope(alice, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('reports a version for a guarded operation, and none for an unguarded one', async () => {
      tags = [];
      await stub.invoke('conc/unguarded', { thingId: 'u1' }, sink);
      // Nothing declared, nothing read: an operation that opted out must not pay
      // for a spine query on every invocation.
      expect(tags).toEqual([]);

      await read(`t-${ulid()}`);
      expect(tags).toHaveLength(1);
    });

    it('answers a never-written entity with a null version', async () => {
      tags = [];
      await read(`t-${ulid()}`);
      // Absence, not a throw. A read is how a client learns there is nothing to
      // hold a tag for yet, which is what makes the create-vs-update distinction
      // visible to it at all.
      expect(tags).toEqual([null]);
    });

    it('admits a write whose tag is current, and hands back the one it created', async () => {
      const id = `t-${ulid()}`;
      tags = [];
      await update(id, 'first');
      const afterFirst = lastTag();
      expect(afterFirst).not.toBeNull();

      await update(id, 'second', etagOf(afterFirst));
      const afterSecond = lastTag();
      // The tag returned describes the row as THIS write left it — not as the
      // caller found it. A client that echoes what it sent would loop forever on
      // its own stale value.
      expect(afterSecond).not.toBe(afterFirst);
      expect(afterSecond > afterFirst).toBe(true);
    });

    it('refuses a write whose tag has moved, with `precondition_failed`', async () => {
      const id = `t-${ulid()}`;
      await update(id, 'first');
      const stale = etagOf(lastTag());

      // A concurrent writer lands between the read and the write.
      await update(id, 'from the other tab');

      await expect(update(id, 'from the stale tab', stale)).rejects.toSatisfy(
        (err: unknown) => errorCodeOf(err) === 'precondition_failed',
      );
    });

    it('leaves nothing behind when it refuses', async () => {
      const id = `t-${ulid()}`;
      await update(id, 'first');
      const stale = etagOf(lastTag());
      await update(id, 'second');
      const beforeRefusal = lastTag();

      tags = [];
      await expect(update(id, 'never lands', stale)).rejects.toThrow();

      // Two halves of one claim. The row still holds what the winning write left
      // — the refused handler never ran, so it wrote nothing to roll back — and
      // no tag was reported, because a version that did not survive its
      // transaction is not one any client may hold.
      expect(tags).toEqual([]);
      await read(id);
      expect(lastTag()).toBe(beforeRefusal);
    });

    it('refuses `If-Match` against an entity that has no version yet', async () => {
      // Nothing has ever been emitted about this id, so there is no version and
      // nothing the caller could legitimately be holding. Admitting it because
      // "there is nothing to conflict with" would make a tag from a rolled-back
      // write — or from another entity entirely — a free pass.
      await expect(update(`t-${ulid()}`, 'x', etagOf(ulid()))).rejects.toSatisfy(
        (err: unknown) => errorCodeOf(err) === 'precondition_failed',
      );
    });

    it('honours `If-Match: *` as "must already exist"', async () => {
      const id = `t-${ulid()}`;
      // RFC 9110 §13.1.1: `*` means any current representation. For us that is
      // "has a version at all", which makes it the update-only guard — the
      // counterpart to `If-None-Match: *` for create-only.
      await expect(update(id, 'first', '*')).rejects.toSatisfy(
        (err: unknown) => errorCodeOf(err) === 'precondition_failed',
      );
      await update(id, 'first');
      await expect(update(id, 'second', '*')).resolves.toBeDefined();
    });

    it('accepts a tag from a comma-separated list, and never a weak one', async () => {
      const id = `t-${ulid()}`;
      await update(id, 'first');
      const current = lastTag();

      // A list is the client saying "any of these will do" — §13.1.1 permits it,
      // and a client that has followed a redirect legitimately holds two.
      await expect(update(id, 'second', `"${ulid()}", ${etagOf(current)}`)).resolves.toBeDefined();

      // A weak validator means "semantically equivalent", which is a judgement no
      // generic layer is entitled to make about a domain entity. §13.1.1 requires
      // the strong comparison for `If-Match`, so this must refuse.
      await expect(update(id, 'third', `W/${etagOf(lastTag())}`)).rejects.toSatisfy(
        (err: unknown) => errorCodeOf(err) === 'precondition_failed',
      );
    });

    it('refuses `If-Match` on an operation that declares no concurrency', async () => {
      // The whole point of refusing rather than ignoring. A caller sending this
      // believes its write is serialised; a 200 would leave that belief intact
      // while nothing was compared. It is not a `precondition_failed` — the
      // precondition was never evaluated — it is a caller error.
      await expect(
        stub.invoke('conc/unguarded', { thingId: 'u1' }, { ifMatch: etagOf(ulid()) }),
      ).rejects.toThrow(/declares no `concurrency`/);
    });

    it('refuses a guarded operation whose id field the caller omitted', async () => {
      // `conc/keyless` declares `idFrom: 'thingId'` over an optional field. There
      // is no row to read, so there is nothing to compare — and skipping the
      // comparison is indistinguishable from passing it.
      await expect(stub.invoke('conc/keyless', {}, { ifMatch: '*' })).rejects.toThrow(
        /carries no such id/,
      );
    });

    it('answers a permission denial ahead of the precondition', async () => {
      const id = `t-${ulid()}`;
      await update(id, 'first');
      const stale = etagOf(lastTag());
      await update(id, 'moved');

      // `conc/forbidden` checks a key nobody holds. The caller's tag is stale, so
      // BOTH refusals apply — and the one that must win is the permission.
      //
      // The other order makes a guarded operation a version oracle: a principal
      // with no permission on the entity sends `If-Match: *` and learns whether it
      // exists, or sends a tag and learns whether it has changed, all without ever
      // being allowed to read it. The precondition therefore snapshots the version
      // before the handler and compares AFTER it, so the handler's own
      // `assertAllowed` is what answers first.
      //
      // Found by driving Callout's two-dispatcher scenario over real HTTP as a
      // principal who lacked `facility:manage`: it answered 412 where it owed 403.
      await expect(
        stub.invoke('conc/forbidden', { thingId: id }, { ...sink, ifMatch: stale }),
      ).rejects.toSatisfy((err: unknown) => errorCodeOf(err) === 'permission_denied');
    });

    it('does not move the tag for a guarded write that emits nothing', async () => {
      const id = `t-${ulid()}`;
      await update(id, 'first');
      const before = lastTag();

      await stub.invoke('conc/silent', { thingId: id, label: 'quietly changed' }, { ...sink, ifMatch: etagOf(before) });

      // The documented hole, and the reason `assertConcurrencyMovesVersion`
      // exists in the model layer rather than here. The write landed, the version
      // did not move, and the stale tag is still accepted:
      expect(lastTag()).toBe(before);
      await expect(
        stub.invoke('conc/silent', { thingId: id, label: 'again' }, { ...sink, ifMatch: etagOf(before) }),
      ).resolves.toBeDefined();
      // An adapter must NOT try to fix this by inventing a version. The spine
      // records what was announced; a host that fabricated a tag here would be
      // reporting a change no consumer, projection or audit ever saw.
    });

    it('serialises two writers who both hold the same tag', async () => {
      const id = `t-${ulid()}`;
      await update(id, 'first');
      const shared = etagOf(lastTag());

      // The scenario in one assertion: both read, both submit, and exactly one
      // may land. Invokes are serialised per scope, so this pins the OUTCOME —
      // that the second is refused on the version rather than admitted by an
      // ordering accident — rather than pretending to test parallelism.
      const results = await Promise.allSettled([
        update(id, 'writer A', shared),
        update(id, 'writer B', shared),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(errorCodeOf(refused.reason)).toBe('precondition_failed');
    });
  });
}
