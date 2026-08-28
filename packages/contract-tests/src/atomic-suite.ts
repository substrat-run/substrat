/**
 * Contract suite for `ctx.atomic` — sub-transactions at the engine seam (#770,
 * docs/architecture/sub-transactions.md).
 *
 * What it pins is one sentence: **a caught error inside `ctx.atomic` destroys
 * everything that region wrote and nothing else.** Before this existed, a
 * vertical that did the reasonable thing — catch a `completeWorkOrder` failure,
 * fall back to a manual path — committed the engine's partial writes, which are
 * precisely the ones its invariants were protecting.
 *
 * It is also a PORTABILITY suite, which is why some assertions look
 * over-specified for the two hosts we ship. "Catch an engine error and keep
 * going" currently means three different things across the substrates the
 * project claims: SQLite commits the partial writes, the DO host does the same,
 * and Postgres poisons the transaction outright (`25P02`) so the operation dies
 * at the next statement. `atomic` is what gives it one meaning — and a third
 * adapter (#123) is expected to satisfy every case below, notably
 * `recoverable`, which is the Postgres-shaped one.
 *
 * Because the semantics live in the kernel (`createAtomic`) and a host supplies
 * only `runSub`, this suite is really testing the kernel once per adapter, with
 * each adapter proving that its `runSub` is a real transaction boundary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { atomicMod } from './modules.js';

const PERM_USE = permissionKey.parse('atomic:use');
const PERM_EXTRA = permissionKey.parse('atomic:extra');

interface Row {
  id: string;
  tag: string;
}
interface OutboxRow {
  type: string;
  authorization: string | null;
}

export function atomicContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`sub-transactions (ctx.atomic): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    /**
     * A FRESH scope per test. These assertions are about what a whole operation
     * left behind — rows, outbox, tuples, intents — so a scope carrying another
     * test's writes would make every count ambiguous.
     */
    const freshScope = async () => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t1, scopeId: s, vertical: 'atomic-vertical' });
      await host.admin.activateScope(staff, t1, s);
      return host.getScope(alice, t1, s);
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(atomicMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'atomic-tenant', name: 'Atomic Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'atomic');
      await host.admin.defineRole(staff, t1, {
        key: 'atomic-admin',
        permissions: [PERM_USE, PERM_EXTRA],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: alice,
        roleKey: 'atomic-admin',
        node: { tenantId: t1, scopeId: null },
      });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    // -- the headline case ---------------------------------------------------

    describe('a caught error discards the callee and nothing else', () => {
      let stub: Awaited<ReturnType<typeof freshScope>>;

      beforeAll(async () => {
        stub = await freshScope();
        await stub.invoke('atomic/rollback');
      });

      it('rethrows the ORIGINAL error, unwrapped', async () => {
        const fresh = await freshScope();
        await expect(fresh.invoke<{ caught: string }>('atomic/rollback')).resolves.toEqual({
          caught: 'callee boom: rollback',
        });
      });

      it("discards the callee's rows and keeps the caller's, before and after", async () => {
        const rows = await stub.invoke<Row[]>('atomic/read-rows');
        expect(rows.map((r) => r.id)).toEqual(['after', 'before']);
      });

      it("discards the callee's events", async () => {
        const outbox = await stub.invoke<OutboxRow[]>('atomic/read-outbox');
        expect(outbox.map((e) => e.type)).toEqual(['atomic.acted']);
      });

      it("discards the callee's links", async () => {
        await expect(stub.invoke<unknown[]>('atomic/read-tuples')).resolves.toEqual([]);
      });

      it("discards the callee's platform intents", async () => {
        await expect(stub.invoke<unknown[]>('atomic/read-intents')).resolves.toEqual([]);
      });

      /**
       * The one the storage rollback cannot do by itself (design note §4.1). The
       * K-34 accumulator lives in JavaScript, so without the kernel's mark/restore
       * `atomic:extra` — checked only inside the discarded region — would ride out
       * on the NEXT event, and the audit spine would attribute a permission check
       * to an event whose operation threw that work away. Silent: nothing raises,
       * the event is well-formed, the record is wrong.
       */
      it('does not carry a discarded check into a later event (K-34)', async () => {
        const outbox = await stub.invoke<OutboxRow[]>('atomic/read-outbox');
        const acted = outbox.find((e) => e.type === 'atomic.acted');
        expect(acted?.authorization).not.toBeNull();
        expect(JSON.parse(acted!.authorization!)).toEqual([{ permission: PERM_USE }]);
      });
    });

    // -- the rest of the semantics -------------------------------------------

    it('keeps the writes of a sub-transaction that succeeds, and returns its value', async () => {
      const stub = await freshScope();
      await expect(stub.invoke('atomic/success')).resolves.toBe(42);
      const rows = await stub.invoke<Row[]>('atomic/read-rows');
      expect(rows.map((r) => r.id)).toEqual(['kept']);
    });

    it('leaves a SIBLING sub-transaction untouched when one fails', async () => {
      const stub = await freshScope();
      await stub.invoke('atomic/stacked');
      const rows = await stub.invoke<Row[]>('atomic/read-rows');
      expect(rows.map((r) => r.id)).toEqual(['sibling-ok']);
      await expect(stub.invoke<unknown[]>('atomic/read-intents')).resolves.toEqual([]);
    });

    it('nests — an inner rollback leaves the outer running', async () => {
      const stub = await freshScope();
      await stub.invoke('atomic/nested');
      const rows = await stub.invoke<Row[]>('atomic/read-rows');
      expect(rows.map((r) => r.id)).toEqual(['outer', 'outer-after']);
    });

    /**
     * `atomic` narrows what a CAUGHT error destroys; it never promotes writes past
     * the operation's own commit. Both runtimes agree on this independently, and a
     * host that got it wrong would be silently upgrading a sub-transaction into a
     * committed one.
     */
    it('treats a sub-transaction commit as provisional on the operation', async () => {
      const stub = await freshScope();
      await expect(stub.invoke('atomic/provisional')).rejects.toThrow(/operation boom/);
      await expect(stub.invoke<Row[]>('atomic/read-rows')).resolves.toEqual([]);
    });

    /**
     * The Postgres-shaped case (design note §1). A STORAGE error — a primary-key
     * violation, not a thrown JS error — is caught, and the enclosing transaction
     * must still be usable. This is the assertion that makes `atomic` a general
     * recoverable-region primitive rather than an engine-call special case, and
     * the reason implicit per-call wrapping would not have been enough.
     */
    it('leaves the transaction usable after a caught STORAGE error', async () => {
      const stub = await freshScope();
      await expect(stub.invoke('atomic/recoverable')).resolves.toEqual({ caught: true });
      const rows = await stub.invoke<Row[]>('atomic/read-rows');
      expect(rows.map((r) => r.id)).toEqual(['recovered']);
    });

    /**
     * Interleaving is not nesting. Two atomics started concurrently would share or
     * cross frames and silently discard a sibling's writes, so the kernel refuses
     * rather than corrupting — the failure a `Promise.all` would otherwise buy.
     */
    it('refuses INTERLEAVED sub-transactions instead of crossing frames', async () => {
      const stub = await freshScope();
      await expect(stub.invoke('atomic/interleaved')).rejects.toThrow(/overlapped|nest/i);
    });
  });
}
