/**
 * Contract suite for grant expiry under an injected clock (#956).
 *
 * What it pins is one sentence: **a grant with an `expiresAt` stops granting the
 * moment the HOST's clock passes it — not the wall clock, the host's.**
 *
 * `permissionContractSuite` already proves an ALREADY-expired grant is refused
 * (dave's, dated 2000). What it cannot prove is the transition: a grant that is
 * live now and dead an hour later, because the only way to get there against the
 * wall clock is to wait. The pure host takes a `clock` (#812), and since #1160 its
 * checker judges `expires_at` against that clock rather than `new Date()` — this
 * suite is what holds it there. Without it, a refactor that quietly reverted the
 * checker to the wall clock would pass every other suite: the dead grant of 2000
 * is dead on both clocks.
 *
 * **Mounted, not flagged.** The fixture returns a `ManualClock` the suite moves,
 * so only an adapter that can hand its host a clock can mount it. That is the
 * pure SQLite host today. It is deliberately NOT a capability flag on the shared
 * fixture that skips on the other adapter: a skipped test reads as coverage the
 * adapter does not have.
 *
 * **Why the Cloudflare adapter does not mount it (the parity gap, written down).**
 * The Durable Object host reads the wall clock inside the DO
 * (`packages/adapter-cloudflare/src/scope-do.ts`, the `at` read in `invoke`, and
 * the entitlement / system-grant reads beside it). The DO is constructed by
 * workerd, not by `CloudflareScopeHost`, so an option on the host factory never
 * reaches it — the host only holds a stub. The three ways a clock could get there
 * were each a decision rather than a patch, and none was taken unattended:
 * (a) the host sends the instant with each invocation, which makes `now`
 * caller-supplied — a different trust story; (b) a test-only seam (an env flag
 * or a DO method a test calls), honest but explicitly not the production path;
 * (c) leave the fact untestable there and say so. This suite is (c): the pure
 * host is held to the contract, the DO's checker runs the same SQL predicate
 * (`expires_at IS NULL OR expires_at > ?`) against a `now` it reads itself, and
 * the day the DO can take a clock, mounting this suite is the whole change.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  instant,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type EntityRef,
  type PermissionKey,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ManualClock, type ScopeHost } from '@substrat-run/kernel';
import { permMod } from './modules.js';

const PERM_READ = permissionKey.parse('perm:read');
const PERM_USE = permissionKey.parse('perm:use');

/**
 * What the fixture hands the suite. `clock` is the SAME `ManualClock` whose
 * `read` the host was constructed with — the suite advances it and expects the
 * host to notice. A fixture that built the host on a different clock would pass
 * the "allowed" half and fail every "denied" one, which is the honest failure.
 */
export interface GrantExpiryFixture {
  host: ScopeHost;
  clock: ManualClock;
  cleanup: () => Promise<void>;
}

const START = '2026-03-01T09:00:00.000Z';
const HOUR = 3_600_000;

export function grantExpiryContractSuite(
  adapterName: string,
  makeFixture: () => Promise<GrantExpiryFixture>,
): void {
  describe(`grant expiry under an injected clock: ${adapterName}`, () => {
    let fixture: GrantExpiryFixture;
    let host: ScopeHost;
    let clock: ManualClock;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid()); // grantedBy
    const nora: PrincipalId = principalId.parse(ulid()); // node-level, timed
    const eve: PrincipalId = principalId.parse(ulid()); // entity-narrowed, timed
    const staff = platformActorId.parse(ulid());
    const box: EntityRef = { entityType: 'box', entityId: 'b1' };

    const probe = async (who: PrincipalId, permission: PermissionKey, entity?: EntityRef) => {
      const stub = await host.getScope(who, t1, s1);
      const decision = await stub.invoke<{ allowed: boolean }>('perm/probe', { permission, entity });
      return decision.allowed;
    };

    const at = (ms: number) => instant.parse(new Date(Date.parse(START) + ms).toISOString());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      clock = fixture.clock;
      clock.set(START);
      host.registerModule(permMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'expiry-tenant', name: 'Expiry Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'perm');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'expiry-vertical' });
      await host.admin.activateScope(staff, t1, s1);

      // Both shapes a timed grant takes: node-level, and narrowed to one entity.
      await host.admin.grant(staff, {
        principalId: nora,
        permission: PERM_READ,
        node: { tenantId: t1, scopeId: s1 },
        expiresAt: at(HOUR),
        grantedBy: alice,
      });
      await host.admin.grant(staff, {
        principalId: eve,
        permission: PERM_READ,
        node: { tenantId: t1, scopeId: s1 },
        entity: box,
        expiresAt: at(HOUR),
        grantedBy: alice,
      });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('a node-level grant is live before its expiresAt', async () => {
      expect(await probe(nora, PERM_READ)).toBe(true);
    });

    it('an entity-narrowed grant is live before its expiresAt', async () => {
      expect(await probe(eve, PERM_READ, box)).toBe(true);
    });

    /**
     * The transition the wall clock cannot show. Nothing is revoked and nothing is
     * swept: the only thing that changes is what time the host thinks it is.
     */
    it('the node-level grant stops granting once the clock passes expiresAt', async () => {
      clock.set(at(HOUR + 60_000));
      expect(await probe(nora, PERM_READ)).toBe(false);
    });

    it('the entity-narrowed grant stops granting once the clock passes expiresAt', async () => {
      clock.set(at(HOUR + 60_000));
      expect(await probe(eve, PERM_READ, box)).toBe(false);
    });

    /**
     * The boundary is part of the contract, not an adapter detail: the predicate is
     * `expires_at > now`, so at the expiry instant itself the grant is already gone.
     * A `>=` would pass every other test in this suite and silently widen every
     * timed grant on that adapter by one instant — so the suite pins both sides of
     * the line, for both shapes of grant.
     */
    it('is gone at the expiry instant itself, not one past it', async () => {
      clock.set(at(HOUR - 1));
      expect(await probe(nora, PERM_READ)).toBe(true);
      expect(await probe(eve, PERM_READ, box)).toBe(true);
      clock.set(at(HOUR));
      expect(await probe(nora, PERM_READ)).toBe(false);
      expect(await probe(eve, PERM_READ, box)).toBe(false);
    });

    /**
     * Expiry is judged on every check, not cached at grant time — so the same
     * grant reads as live again if the clock is moved back before it. This is
     * what distinguishes "the checker consults the clock" from "the grant was
     * tombstoned when the clock passed it". The case sets up its own expiry first
     * rather than inheriting the clock an earlier case left behind, so it proves
     * the rollback when run alone too.
     */
    it('is judged at check time — the same grant is live again with the clock before expiresAt', async () => {
      clock.set(at(HOUR + 60_000));
      expect(await probe(nora, PERM_READ)).toBe(false);
      expect(await probe(eve, PERM_READ, box)).toBe(false);
      clock.set(at(HOUR - 60_000));
      expect(await probe(nora, PERM_READ)).toBe(true);
      expect(await probe(eve, PERM_READ, box)).toBe(true);
      clock.set(at(HOUR + 60_000));
      expect(await probe(nora, PERM_READ)).toBe(false);
      expect(await probe(eve, PERM_READ, box)).toBe(false);
    });

    /**
     * Expiry is not sticky: a later re-grant of the same (principal, permission,
     * node) carries its own `expiresAt`, and the checker judges that one. How the
     * adapter stores it is its own business — the SQLite host keys tuples on
     * (subject, relation, object) and the re-grant REPLACES the expired row, so
     * there is never a dead row beside a live one there. What the contract holds is
     * only the outcome: the expired grant does not shadow the new one, and the new
     * one dies on its own clock.
     */
    it('a re-grant after expiry grants again, on its own expiresAt', async () => {
      clock.set(at(HOUR + 60_000));
      expect(await probe(nora, PERM_READ)).toBe(false);
      await host.admin.grant(staff, {
        principalId: nora,
        permission: PERM_READ,
        node: { tenantId: t1, scopeId: s1 },
        expiresAt: at(3 * HOUR),
        grantedBy: alice,
      });
      expect(await probe(nora, PERM_READ)).toBe(true);
      clock.set(at(3 * HOUR + 60_000));
      expect(await probe(nora, PERM_READ)).toBe(false);
    });

    /** An untimed grant is unaffected by any clock — the control for the whole suite. */
    it('a grant with no expiresAt is not touched by the clock', async () => {
      await host.admin.grant(staff, {
        principalId: nora,
        permission: PERM_USE,
        node: { tenantId: t1, scopeId: s1 },
        grantedBy: alice,
      });
      clock.set(at(365 * 24 * HOUR));
      expect(await probe(nora, PERM_USE)).toBe(true);
    });
  });
}
