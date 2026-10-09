/**
 * Contract suite for a PRINCIPAL's `become` capability (#1686) — the host verbs a member invite
 * runs: `mintBecomeCapabilityBounded` and `revokeBecomeCapability`.
 *
 * What it pins, in one sentence: **a principal mints a `become` capability for someone only when
 * it already holds everything that someone holds there — node-level and entity-narrowed alike —
 * and the capability then yields exactly that principal, once, in that scope only, until it is
 * revoked; the mint is on the spine as `capability.become-minted` with the minter as actor.**
 *
 * Every refusal is paired with the allow beside it, so a bound that refused everything cannot
 * pass, and every refusal is checked to have written nothing:
 *
 * 1. **The node-level bound.** A reader mints for a reader and is refused for a writer, naming
 *    the key it lacks; the owner mints for the writer.
 * 2. **The narrowed bound.** A target's entity-narrowed grant must be one the minter can
 *    exercise on that entity: a minter holding the key on the entity's ancestor passes, one
 *    holding nothing or holding it on a sibling is refused. And narrowing never launders: a
 *    minter holding the key only on one entity is refused for a target holding it scope-wide.
 * 3. **The record and the spine.** The capability names the minter, the principal, one use
 *    and no expiry; the event names the minter as actor and the capability as its entity.
 * 4. **The exchange.** It yields the principal once; a share-link (`act`) exchange of it is
 *    refused without spending the use; another scope never knows the secret.
 * 5. **The revoke.** Revoking it refuses the exchange and records the revoker. It revokes only
 *    a principal-minted `become` — never an `act` share, never the platform's own `become`.
 * 6. **Tenant isolation.** Another tenant's name for the scope is refused, writing nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  CAPABILITY_BECOME_MINTED,
  CAPABILITY_SECRET_PREFIX,
  capabilityBecomeMintedPayload,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type BoundedBecomeMint,
  type CapabilityId,
  type CapabilityRecord,
  type EntityRef,
  type Instant,
  type MintedCapability,
  type PrincipalBecomeCapabilityInput,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { capMod } from './modules.js';

/** The two host verbs under test — on each adapter's host class, not on `ScopeHost`. */
export interface BecomeMintVerbs {
  mintBecomeCapabilityBounded(
    tenantId: TenantId,
    scopeId: ScopeId,
    caller: PrincipalId,
    input: PrincipalBecomeCapabilityInput,
  ): Promise<BoundedBecomeMint>;
  revokeBecomeCapability(tenantId: TenantId, scopeId: ScopeId, capabilityId: CapabilityId, by: PrincipalId): Promise<boolean>;
}

const READ = permissionKey.parse('cap:read');
const WRITE = permissionKey.parse('cap:write');
const ADMIN = permissionKey.parse('cap:admin');
const folder = (id: string): EntityRef => ({ entityType: 'folder', entityId: id });
const doc = (id: string): EntityRef => ({ entityType: 'doc', entityId: id });

interface OutboxRow {
  type: string;
  actor: string;
  operation: string | null;
  entity_type: string;
  entity_id: string;
  payload: string | null;
}

export function becomeMintContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture & { verbs: BecomeMintVerbs }>,
): void {
  describe(`a principal's become capability (#1686): ${adapterName}`, () => {
    let fixture: ScopeHostFixture & { verbs: BecomeMintVerbs };
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const t2 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid()); // same tenant, a second scope
    const staff = platformActorId.parse(ulid());
    const p = () => principalId.parse(ulid());
    const owner = p(); // owner at s1: read + write + admin
    const reader = p(); // reader at s1
    const nobody = p(); // holds nothing
    const folderReader = p(); // cap:read on folder F only (d1 lies beneath it)
    const siblingReader = p(); // cap:read on doc d2 only
    const writerTarget = p(); // writer at s1
    const readerTarget = p(); // reader at s1
    const narrowTarget = p(); // cap:read on doc d1 only

    const node = (scope: ScopeId = s1) => ({ tenantId: t1, scopeId: scope });
    const mint = (caller: PrincipalId, principal: PrincipalId, scope: ScopeId = s1, tenant: TenantId = t1) =>
      fixture.verbs.mintBecomeCapabilityBounded(tenant, scope, caller, { principal, maxUses: 1, label: 'member invite' });
    const minted = async (caller: PrincipalId, principal: PrincipalId): Promise<MintedCapability> => {
      const out = await mint(caller, principal);
      if (!out.ok) throw new Error(`expected a mint, refused: ${out.coverage.missing.join(', ')}`);
      return out.minted;
    };
    const records = async (scope: ScopeId = s1): Promise<CapabilityRecord[]> =>
      (await host.admin.listCapabilities(staff, t1, scope, { includeRevoked: true })).entries;
    const outbox = async (): Promise<OutboxRow[]> => (await host.getScope(owner, t1, s1)).invoke<OutboxRow[]>('cap/outbox');
    /** What a refusal must not have changed: the capability directory and the spine. */
    const snapshot = async () => ({ caps: (await records()).length, events: (await outbox()).length });

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(capMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'become-tenant', name: 'Become Tenant' });
      await host.admin.createTenant(staff, { id: t2, slug: 'become-other', name: 'Become Other' });
      for (const t of [t1, t2]) await host.admin.grantEntitlement(staff, t, 'cap');
      for (const s of [s1, s2]) {
        await host.provisionScope(staff, { tenantId: t1, scopeId: s, vertical: 'cap-vertical' });
        await host.admin.activateScope(staff, t1, s);
      }
      await host.admin.defineRole(staff, t1, { key: 'owner', permissions: [READ, WRITE, ADMIN], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'writer', permissions: [READ, WRITE], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'reader', permissions: [READ], source: 'vertical' });
      const assign = (principalId: PrincipalId, roleKey: string) => host.admin.assignRole(staff, { principalId, roleKey, node: node() });
      await assign(owner, 'owner');
      await assign(reader, 'reader');
      await assign(writerTarget, 'writer');
      await assign(readerTarget, 'reader');
      // The tree in s1:  F ─┬─ d1
      //                     └─ d2
      const stub = await host.getScope(owner, t1, s1);
      await stub.invoke('cap/link', { child: doc('d1'), parent: folder('F') });
      await stub.invoke('cap/link', { child: doc('d2'), parent: folder('F') });
      const narrow = (principal: PrincipalId, entity: EntityRef) =>
        host.admin.grant(staff, { principalId: principal, permission: READ, node: node(), entity, grantedBy: owner });
      await narrow(folderReader, folder('F'));
      await narrow(siblingReader, doc('d2'));
      await narrow(narrowTarget, doc('d1'));
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    describe('the node-level bound', () => {
      it('a reader mints for a reader…', async () => {
        const out = await mint(reader, readerTarget);
        expect(out.ok).toBe(true);
      });

      it('…and is refused for a writer, naming what it lacks — nothing recorded, nothing on the spine', async () => {
        const before = await snapshot();
        expect(await mint(reader, writerTarget)).toEqual({ ok: false, coverage: { covered: false, missing: [WRITE] } });
        expect(await snapshot()).toEqual(before);
      });

      it('the owner, who holds all of it, mints for the writer', async () => {
        expect((await mint(owner, writerTarget)).ok).toBe(true);
      });

      it('a principal holding nothing is refused for anyone who holds something', async () => {
        const before = await snapshot();
        const out = await mint(nobody, readerTarget);
        expect(out).toEqual({ ok: false, coverage: { covered: false, missing: [READ] } });
        expect(await snapshot()).toEqual(before);
      });
    });

    describe('the narrowed bound', () => {
      it('a minter holding the key on the entity\'s ancestor passes for a target holding it on the entity', async () => {
        expect((await mint(folderReader, narrowTarget)).ok).toBe(true);
      });

      it('a minter holding it on a sibling is refused — and so is one holding nothing', async () => {
        const before = await snapshot();
        expect(await mint(siblingReader, narrowTarget)).toEqual({ ok: false, coverage: { covered: false, missing: [READ] } });
        expect(await mint(nobody, narrowTarget)).toEqual({ ok: false, coverage: { covered: false, missing: [READ] } });
        expect(await snapshot()).toEqual(before);
      });

      it('narrowing never launders: a key held on one entity does not cover a target holding it scope-wide', async () => {
        const before = await snapshot();
        expect(await mint(folderReader, readerTarget)).toEqual({ ok: false, coverage: { covered: false, missing: [READ] } });
        expect(await snapshot()).toEqual(before);
      });

      it('the scope-wide holder covers the narrowed target too', async () => {
        expect((await mint(reader, narrowTarget)).ok).toBe(true);
      });
    });

    describe('the record and the spine', () => {
      let cap: MintedCapability;
      beforeAll(async () => {
        cap = await minted(owner, readerTarget);
      });

      it('hands back a prefixed secret, once, with no expiry', () => {
        expect(cap.secret.startsWith(CAPABILITY_SECRET_PREFIX)).toBe(true);
        expect(cap.expiresAt).toBeNull();
      });

      it('records the minter, the principal, one use and no expiry — and never the secret', async () => {
        const record = (await records()).find((r) => r.id === cap.id);
        expect(record).toMatchObject({
          mode: 'become',
          principal: readerTarget,
          mintedBy: owner,
          label: 'member invite',
          expiresAt: null,
          maxUses: 1,
          uses: 0,
          revokedAt: null,
        });
        expect(JSON.stringify(record)).not.toContain(cap.secret);
      });

      it('is on the spine as capability.become-minted, the minter its actor and the capability its entity', async () => {
        const rows = (await outbox()).filter((r) => r.type === CAPABILITY_BECOME_MINTED && r.entity_id === cap.id);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row).toMatchObject({ actor: JSON.stringify(owner), operation: 'capabilities.mint-become', entity_type: 'capability' });
        expect(capabilityBecomeMintedPayload.parse(JSON.parse(row!.payload!))).toEqual({
          capabilityId: cap.id,
          principal: readerTarget,
          expiresAt: null,
          maxUses: 1,
          label: 'member invite',
          mintedBy: owner,
        });
        expect(row!.payload).not.toContain(cap.secret);
      });

      it('refuses an expiry in the past, writing nothing', async () => {
        const before = await snapshot();
        await expect(
          fixture.verbs.mintBecomeCapabilityBounded(t1, s1, owner, {
            principal: readerTarget,
            maxUses: 1,
            expiresAt: new Date(Date.now() - 60_000).toISOString() as Instant,
          }),
        ).rejects.toThrow(/not in the future/);
        expect(await snapshot()).toEqual(before);
      });
    });

    describe('the exchange', () => {
      it('yields the principal once; the second exchange is refused', async () => {
        const cap = await minted(owner, readerTarget);
        expect(await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' })).toEqual({
          kind: 'principal',
          capabilityId: cap.id,
          principal: readerTarget,
        });
        expect(await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' })).toBeNull();
      });

      it('a share-link exchange of it is refused without spending the use', async () => {
        const cap = await minted(owner, readerTarget);
        expect(await host.exchangeCapability(t1, s1, cap.secret, { mode: 'act' })).toBeNull();
        expect((await records()).find((r) => r.id === cap.id)?.uses).toBe(0);
        expect((await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' }))?.kind).toBe('principal');
      });

      it('another scope of the same tenant never knows the secret', async () => {
        const cap = await minted(owner, readerTarget);
        expect(await host.exchangeCapability(t1, s2, cap.secret, { mode: 'become' })).toBeNull();
        expect((await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' }))?.kind).toBe('principal');
      });
    });

    describe('the revoke', () => {
      it('refuses the exchange after it, records the revoker, and is idempotent', async () => {
        const cap = await minted(owner, readerTarget);
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, cap.id, owner)).toBe(true);
        expect(await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' })).toBeNull();
        expect((await records()).find((r) => r.id === cap.id)).toMatchObject({ revokedBy: owner, uses: 0 });
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, cap.id, owner)).toBe(false);
      });

      it('…its live twin still exchanges', async () => {
        const cap = await minted(owner, readerTarget);
        expect((await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' }))?.kind).toBe('principal');
      });

      it('never revokes an act share, which keeps working', async () => {
        const share = await (await host.getScope(owner, t1, s1)).invoke<MintedCapability>('cap/share', {
          entity: folder('F'),
          permissions: [READ],
        });
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, share.id, owner)).toBe(false);
        expect((await host.exchangeCapability(t1, s1, share.secret, { mode: 'act' }))?.kind).toBe('session');
      });

      it('never revokes the platform\'s own become (a claim link), which keeps working', async () => {
        const platform = await host.admin.mintCapability(staff, t1, s1, {
          principal: readerTarget,
          maxUses: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString() as Instant,
        });
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, platform.id, owner)).toBe(false);
        expect((await host.exchangeCapability(t1, s1, platform.secret, { mode: 'become' }))?.kind).toBe('principal');
      });

      it('another scope cannot revoke it', async () => {
        const cap = await minted(owner, readerTarget);
        expect(await fixture.verbs.revokeBecomeCapability(t1, s2, cap.id, owner)).toBe(false);
        expect((await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' }))?.kind).toBe('principal');
      });
    });

    describe('tenant isolation', () => {
      it('another tenant\'s name for the scope is refused, writing nothing', async () => {
        const before = await snapshot();
        await expect(mint(owner, readerTarget, s1, t2)).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      });
    });
  });
}
