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
 * The bounded prune lives here too: it needs a thousand sessions to expire at once.
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
import {
  CAPABILITY_SESSION_PRUNE_BATCH,
  ulid,
  type ManualClock,
  type ScopeHost,
} from '@substrat-run/kernel';
import { capMod } from './modules.js';

const CAP_READ = permissionKey.parse('cap:read');
// #1686: the folder's attachment write key, so the owner can put a file there to download.
const CAP_ADMIN = permissionKey.parse('cap:admin');
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
      await host.admin.defineRole(staff, t1, {
        key: 'owner',
        permissions: [CAP_READ, CAP_ADMIN],
        source: 'vertical',
      });
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

    it('a download (#1686) works until the capability expires and not after — nor past the session TTL', async () => {
      await host.provisionBlobStore(staff, { tenantId: t1, vertical: 'cap-vertical', binding: 'ATTACHMENTS' });
      const file = await (await host.attachments(alice, t1, s1)).upload({
        entity: folder('F'),
        filename: 'f.txt',
        contentType: 'text/plain',
        visibility: 'internal',
        body: new TextEncoder().encode('f'),
      });
      const filesOf = (token: string) => {
        if (!host.getCapabilityAttachments) throw new Error('host has no getCapabilityAttachments');
        return host.getCapabilityAttachments(token, t1, s1);
      };

      // The capability's own expiry.
      const short = await share({ entity: folder('F'), permissions: [CAP_READ], expiresAt: at(HOUR) });
      const shortFiles = await filesOf((await session(short.secret)).token);
      clock.advance(HOUR - MINUTE);
      expect((await shortFiles.open(file.id))?.record.id).toBe(file.id);
      clock.advance(2 * MINUTE);
      expect(errorCodeOf(await refusal(shortFiles.open(file.id)))).toBe('unauthenticated');

      // The session's TTL, on a capability that never expires.
      const open = await share({ entity: folder('F'), permissions: [CAP_READ] });
      const openFiles = await filesOf((await session(open.secret)).token);
      clock.advance(CAPABILITY_SESSION_TTL_MS - MINUTE);
      expect((await openFiles.open(file.id))?.record.id).toBe(file.id);
      clock.advance(2 * MINUTE);
      expect(errorCodeOf(await refusal(openFiles.open(file.id)))).toBe('unauthenticated');
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

    it('an exchange prunes at most one batch of expired sessions, and later exchanges drain the rest', async () => {
      // A scope of its own, so no other test's sessions are in the count.
      const s2 = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t1, scopeId: s2, vertical: 'cap-vertical' });
      await host.admin.activateScope(staff, t1, s2);
      const stub = await host.getScope(alice, t1, s2);
      const count = () => stub.invoke<number>('cap/session-count');
      const minted = await stub.invoke<MintedCapability>('cap/share', {
        entity: folder('F'),
        permissions: [CAP_READ],
      });
      const exchange = () => host.exchangeCapability(t1, s2, minted.secret);

      for (let i = 0; i < 1000; i++) await exchange();
      expect(await count()).toBe(1000);
      clock.advance(CAPABILITY_SESSION_TTL_MS + MINUTE); // every one of them is now expired

      await exchange();
      // One batch gone, one live session added — not the thousand an unbounded prune takes.
      expect(await count()).toBe(1000 - CAPABILITY_SESSION_PRUNE_BATCH + 1);

      const exchangesToDrain = 1000 / CAPABILITY_SESSION_PRUNE_BATCH;
      for (let i = 1; i < exchangesToDrain; i++) await exchange();
      // Drained: only the live sessions those exchanges handed out remain.
      expect(await count()).toBe(exchangesToDrain);
      await exchange();
      expect(await count()).toBe(exchangesToDrain + 1);
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
