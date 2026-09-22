/**
 * Capability expiry under an injected clock (#1672) — the TRANSITION from live to expired,
 * which `capabilityContractSuite` cannot reach without waiting for it.
 *
 * Held to the contract on the pure host only, for the reason `grantExpiryContractSuite`
 * gives: the Durable-Object host takes no clock (`clock?: never`, #956), because the
 * instant that matters is read inside the ScopeDO. What makes the DO's answer the same
 * is that both hosts call ONE predicate — `capabilityLive` / `capabilityExchangeable` in
 * the kernel — for the checker, the session door and the exchange alike; the kernel's
 * evaluator tests pin that predicate against an expired row directly.
 *
 * Three clocks run out here, and each has a positive twin one step before it:
 * the capability's own `expiresAt`, a session's TTL, and a platform `become`'s expiry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  CAPABILITY_SESSION_TTL_MS,
  errorCodeOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type EntityRef,
  type Instant,
  type MintedCapability,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ManualClock, type ScopeHost } from '@substrat-run/kernel';
import { capMod } from './modules.js';

const CAP_READ = permissionKey.parse('cap:read');
const START = '2026-03-01T09:00:00.000Z';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const folder = (id: string): EntityRef => ({ entityType: 'folder', entityId: id });

export interface CapabilityExpiryFixture {
  host: ScopeHost;
  clock: ManualClock;
  cleanup: () => Promise<void>;
}

const refusal = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

export function capabilityExpiryContractSuite(
  adapterName: string,
  makeFixture: () => Promise<CapabilityExpiryFixture>,
): void {
  describe(`capability expiry under an injected clock (#1672): ${adapterName}`, () => {
    let fixture: CapabilityExpiryFixture;
    let host: ScopeHost;
    let clock: ManualClock;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const seat: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const at = (ms: number): Instant => new Date(Date.parse(clock.now()) + ms).toISOString() as Instant;

    const share = async (spec: Record<string, unknown>): Promise<MintedCapability> =>
      (await host.getScope(alice, t1, s1)).invoke<MintedCapability>('cap/share', spec);
    const read = async (token: string) =>
      (await host.getCapabilityScope(token, t1, s1)).invoke('cap/read', { entity: folder('F') });
    const session = async (secret: string): Promise<{ token: string; expiresAt: string }> => {
      const ex = await host.exchangeCapability(t1, s1, secret);
      if (ex?.kind !== 'session') throw new Error(`expected a session, got ${JSON.stringify(ex)}`);
      return { token: ex.sessionToken, expiresAt: ex.expiresAt };
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      clock = fixture.clock;
      clock.set(START);
      host.registerModule(capMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'cap-expiry', name: 'Cap Expiry' });
      await host.admin.grantEntitlement(staff, t1, 'cap');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'cap-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.admin.defineRole(staff, t1, { key: 'owner', permissions: [CAP_READ], source: 'vertical' });
      await host.admin.assignRole(staff, {
        principalId: alice,
        roleKey: 'owner',
        node: { tenantId: t1, scopeId: null },
      });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('a capability acts until its expiry and not a moment after — and cannot be exchanged after it', async () => {
      const minted = await share({ entity: folder('F'), permissions: [CAP_READ], expiresAt: at(HOUR) });
      const { token, expiresAt } = await session(minted.secret);
      // A session never outlives its capability.
      expect(expiresAt).toBe(minted.expiresAt);
      clock.advance(HOUR - MINUTE);
      await expect(read(token)).resolves.toBeTruthy();
      clock.advance(2 * MINUTE);
      expect(errorCodeOf(await refusal(read(token)))).toBe('unauthenticated');
      expect(await host.exchangeCapability(t1, s1, minted.secret)).toBeNull();
    });

    it('a session lives its TTL and no longer; the link itself exchanges again', async () => {
      const minted = await share({ entity: folder('F'), permissions: [CAP_READ] });
      const { token } = await session(minted.secret);
      clock.advance(CAPABILITY_SESSION_TTL_MS - MINUTE);
      await expect(read(token)).resolves.toBeTruthy();
      clock.advance(2 * MINUTE);
      expect(errorCodeOf(await refusal(read(token)))).toBe('unauthenticated');
      const fresh = await session(minted.secret);
      await expect(read(fresh.token)).resolves.toBeTruthy();
    });

    it('a platform `become` exchanges until its expiry, and not after', async () => {
      const early = await host.admin.mintCapability(staff, t1, s1, {
        principal: seat,
        expiresAt: at(10 * MINUTE),
        maxUses: 5,
      });
      const late = await host.admin.mintCapability(staff, t1, s1, {
        principal: seat,
        expiresAt: at(10 * MINUTE),
        maxUses: 5,
      });
      clock.advance(9 * MINUTE);
      expect((await host.exchangeCapability(t1, s1, early.secret))?.kind).toBe('principal');
      clock.advance(2 * MINUTE);
      expect(await host.exchangeCapability(t1, s1, late.secret)).toBeNull();
    });
  });
}
