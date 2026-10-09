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
 * 7. **The target's holdings reach as the checker's do.** A key the target holds only at the
 *    TENANT node, and an entity-narrowed grant it holds only through an ORG, both count: a
 *    minter short of them is refused, one holding them passes.
 * 8. **A seat already taken.** A target some `become` link has been exchanged into in this
 *    scope (a principal's or the platform's) is refused another link; never-exchanged links,
 *    open or revoked, leave it untaken, and a seat taken in another scope is not taken here.
 * 9. **The link dies when its principal's holdings change.** The mint records a digest of what
 *    the target holds; the exchange recomputes it, and a link whose principal was raised through
 *    (i) a scope-level role, (ii) a tenant-level role, (iii) an org joined, or (iv) a role
 *    redefined is revoked — with no revoker — and refused, its use untaken. Its twin: nothing
 *    changed (another principal raised meanwhile), and the link exchanges.
 * 10. **Nothing to become.** A target holding nothing at the node is refused outright, whoever
 *    mints — the bound is evaluated at mint, and an empty set would cover trivially. Its twin:
 *    the same principal, once it holds a role, is minted for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  CAPABILITY_BECOME_MINTED,
  CAPABILITY_SECRET_PREFIX,
  capabilityBecomeMintedPayload,
  orgId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type BoundedBecomeMint,
  type BoundedBecomeRevoke,
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
  revokeBecomeCapability(tenantId: TenantId, scopeId: ScopeId, capabilityId: CapabilityId, by: PrincipalId): Promise<BoundedBecomeRevoke>;
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
    const folderReader = p(); // member, plus cap:read on folder F only (d1 lies beneath it)
    const siblingReader = p(); // member, plus cap:read on doc d2 only
    const writerTarget = p(); // writer at s1
    const readerTarget = p(); // reader at s1
    const narrowTarget = p(); // member, plus cap:read on doc d1 only
    const emptyTarget = p(); // holds nothing — until the last case grants it reader

    const node = (scope: ScopeId = s1) => ({ tenantId: t1, scopeId: scope });
    const mint = (caller: PrincipalId, principal: PrincipalId, scope: ScopeId = s1, tenant: TenantId = t1) =>
      fixture.verbs.mintBecomeCapabilityBounded(tenant, scope, caller, { principal, maxUses: 1, label: 'member invite' });
    const minted = async (caller: PrincipalId, principal: PrincipalId): Promise<MintedCapability> => {
      const out = await mint(caller, principal);
      if (!out.ok) throw new Error(`expected a mint, refused: ${JSON.stringify(out)}`);
      return out.minted;
    };
    const records = async (scope: ScopeId = s1): Promise<CapabilityRecord[]> =>
      (await host.admin.listCapabilities(staff, t1, scope, { includeRevoked: true })).entries;
    const outbox = async (): Promise<OutboxRow[]> => (await host.getScope(owner, t1, s1)).invoke<OutboxRow[]>('cap/outbox');
    /** What a refusal must not have changed: the capability directory and the spine. */
    const snapshot = async () => ({ caps: (await records()).length, events: (await outbox()).length });
    /** A fresh reader at s1 — a seat for a case that exchanges its link, since a claimed seat refuses another. */
    const seat = async (): Promise<PrincipalId> => {
      const who = p();
      await host.admin.assignRole(staff, { principalId: who, roleKey: 'reader', node: node() });
      return who;
    };

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
      await host.admin.defineRole(staff, t1, { key: 'member', permissions: [ADMIN], source: 'vertical' });
      const assign = (principalId: PrincipalId, roleKey: string) => host.admin.assignRole(staff, { principalId, roleKey, node: node() });
      await assign(owner, 'owner');
      await assign(reader, 'reader');
      await assign(writerTarget, 'writer');
      await assign(readerTarget, 'reader');
      for (const m of [folderReader, siblingReader, narrowTarget]) await assign(m, 'member');
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
        expect(await mint(nobody, narrowTarget)).toEqual({ ok: false, coverage: { covered: false, missing: [ADMIN, READ] } });
        expect(await snapshot()).toEqual(before);
      });

      it('narrowing never launders: a key held on one entity does not cover a target holding it scope-wide', async () => {
        const before = await snapshot();
        expect(await mint(folderReader, readerTarget)).toEqual({ ok: false, coverage: { covered: false, missing: [READ] } });
        expect(await snapshot()).toEqual(before);
      });

      it('the scope-wide holder covers the narrowed target too', async () => {
        expect((await mint(owner, narrowTarget)).ok).toBe(true);
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
        const target = await seat();
        const cap = await minted(owner, target);
        expect(await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' })).toEqual({
          kind: 'principal',
          capabilityId: cap.id,
          principal: target,
        });
        expect(await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' })).toBeNull();
      });

      it('a share-link exchange of it is refused without spending the use', async () => {
        const cap = await minted(owner, await seat());
        expect(await host.exchangeCapability(t1, s1, cap.secret, { mode: 'act' })).toBeNull();
        expect((await records()).find((r) => r.id === cap.id)?.uses).toBe(0);
        expect((await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' }))?.kind).toBe('principal');
      });

      it('another scope of the same tenant never knows the secret', async () => {
        const cap = await minted(owner, await seat());
        expect(await host.exchangeCapability(t1, s2, cap.secret, { mode: 'become' })).toBeNull();
        expect((await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' }))?.kind).toBe('principal');
      });
    });

    describe('the revoke', () => {
      it('refuses the exchange after it, records the revoker, and is idempotent', async () => {
        const cap = await minted(owner, await seat());
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, cap.id, owner)).toEqual({ ok: true, revoked: true });
        expect(await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' })).toBeNull();
        expect((await records()).find((r) => r.id === cap.id)).toMatchObject({ revokedBy: owner, uses: 0 });
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, cap.id, owner)).toEqual({ ok: true, revoked: false });
      });

      it('is bounded in the kernel: a revoker short of what the link\'s principal holds is refused, writing nothing', async () => {
        const cap = await minted(owner, writerTarget);
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, cap.id, reader)).toEqual({
          ok: false,
          coverage: { covered: false, missing: [WRITE] },
        });
        expect((await records()).find((r) => r.id === cap.id)?.revokedAt).toBeNull();
        expect((await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' }))?.kind).toBe('principal');
      });

      it('…while one who holds all of it may revoke a link someone else minted', async () => {
        const cap = await minted(owner, await seat());
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, cap.id, reader)).toEqual({ ok: true, revoked: true });
        expect((await records()).find((r) => r.id === cap.id)).toMatchObject({ revokedBy: reader });
      });

      it('…and the minter may always revoke its own link', async () => {
        const cap = await minted(reader, await seat());
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, cap.id, reader)).toEqual({ ok: true, revoked: true });
      });

      it('…its live twin still exchanges', async () => {
        const cap = await minted(owner, await seat());
        expect((await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' }))?.kind).toBe('principal');
      });

      it('never revokes an act share, which keeps working', async () => {
        const share = await (await host.getScope(owner, t1, s1)).invoke<MintedCapability>('cap/share', {
          entity: folder('F'),
          permissions: [READ],
        });
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, share.id, owner)).toEqual({ ok: true, revoked: false });
        expect((await host.exchangeCapability(t1, s1, share.secret, { mode: 'act' }))?.kind).toBe('session');
      });

      it('never revokes the platform\'s own become (a claim link), which keeps working', async () => {
        const platform = await host.admin.mintCapability(staff, t1, s1, {
          principal: await seat(),
          maxUses: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString() as Instant,
        });
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, platform.id, owner)).toEqual({ ok: true, revoked: false });
        expect((await host.exchangeCapability(t1, s1, platform.secret, { mode: 'become' }))?.kind).toBe('principal');
      });

      it('another scope cannot revoke it', async () => {
        const cap = await minted(owner, await seat());
        expect(await fixture.verbs.revokeBecomeCapability(t1, s2, cap.id, owner)).toEqual({ ok: true, revoked: false });
        expect((await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' }))?.kind).toBe('principal');
      });
    });

    describe('the link dies when its principal\'s holdings change', () => {
      /** The link is refused, revoked by the kernel (no revoker), and its use never taken. */
      const expectDead = async (cap: MintedCapability) => {
        expect(await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' })).toBeNull();
        expect((await records()).find((r) => r.id === cap.id)).toMatchObject({ uses: 0, revokedBy: null, revokedAt: expect.any(String) });
      };

      it('(i) a scope-level role raised', async () => {
        const target = await seat();
        const cap = await minted(owner, target);
        await host.admin.assignRole(staff, { principalId: target, roleKey: 'writer', node: node() });
        await expectDead(cap);
      });

      it('(ii) a tenant-level role raised', async () => {
        const target = await seat();
        const cap = await minted(owner, target);
        await host.admin.assignRole(staff, { principalId: target, roleKey: 'writer', node: { tenantId: t1, scopeId: null } });
        await expectDead(cap);
      });

      it('(iii) an org joined that holds more', async () => {
        const target = await seat();
        const org = orgId.parse(ulid());
        await host.admin.createOrg(staff, { id: org, tenantId: t1, slug: `raise-${ulid().toLowerCase()}`, name: 'Raise Org' });
        await host.admin.grantToOrg(staff, org, WRITE, node());
        const cap = await minted(owner, target);
        await host.admin.addMember(staff, t1, target, org);
        await expectDead(cap);
      });

      it('(iv) a role it holds redefined to carry more', async () => {
        const target = p();
        const key = `widening-${ulid().toLowerCase()}`;
        await host.admin.defineRole(staff, t1, { key, permissions: [READ], source: 'vertical' });
        await host.admin.assignRole(staff, { principalId: target, roleKey: key, node: node() });
        const cap = await minted(owner, target);
        await host.admin.defineRole(staff, t1, { key, permissions: [READ, WRITE], source: 'vertical' });
        await expectDead(cap);
      });

      it('the twin: nothing about its principal changed — another raised meanwhile — and the link exchanges', async () => {
        const target = await seat();
        const bystander = await seat();
        const cap = await minted(owner, target);
        await host.admin.assignRole(staff, { principalId: bystander, roleKey: 'writer', node: node() });
        expect((await host.exchangeCapability(t1, s1, cap.secret, { mode: 'become' }))?.kind).toBe('principal');
        expect((await records()).find((r) => r.id === cap.id)).toMatchObject({ uses: 1, revokedAt: null });
      });
    });

    describe('a seat already taken', () => {
      it('a target some become link has been exchanged into is refused another — nothing recorded, nothing on the spine', async () => {
        const target = await seat();
        const first = await minted(owner, target);
        expect((await host.exchangeCapability(t1, s1, first.secret, { mode: 'become' }))?.kind).toBe('principal');
        const before = await snapshot();
        expect(await mint(owner, target)).toEqual({ ok: false, refused: 'target-already-claimed' });
        expect(await snapshot()).toEqual(before);
      });

      it('…so is one the platform\'s own become was exchanged into (a claimed owner seat)', async () => {
        const target = await seat();
        const platform = await host.admin.mintCapability(staff, t1, s1, {
          principal: target,
          maxUses: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString() as Instant,
        });
        expect((await host.exchangeCapability(t1, s1, platform.secret, { mode: 'become' }))?.kind).toBe('principal');
        expect(await mint(owner, target)).toEqual({ ok: false, refused: 'target-already-claimed' });
      });

      it('the twin: links never exchanged — open, or revoked — leave the seat untaken, and another is minted', async () => {
        const target = await seat();
        await minted(owner, target);
        const revoked = await minted(owner, target);
        expect(await fixture.verbs.revokeBecomeCapability(t1, s1, revoked.id, owner)).toEqual({ ok: true, revoked: true });
        expect((await mint(owner, target)).ok).toBe(true);
      });

      it('a seat taken in another scope of the tenant is not taken here', async () => {
        const target = await seat();
        await host.admin.assignRole(staff, { principalId: target, roleKey: 'reader', node: node(s2) });
        const there = (await fixture.verbs.mintBecomeCapabilityBounded(t1, s2, owner, { principal: target, maxUses: 1 }));
        // owner holds nothing at s2, so the s2 link is the platform's instead.
        expect(there.ok).toBe(false);
        const platform = await host.admin.mintCapability(staff, t1, s2, {
          principal: target,
          maxUses: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString() as Instant,
        });
        expect((await host.exchangeCapability(t1, s2, platform.secret, { mode: 'become' }))?.kind).toBe('principal');
        expect((await mint(owner, target)).ok).toBe(true);
      });
    });

    describe('the target\'s holdings reach as the checker\'s do', () => {
      it('a key held only at the tenant node counts: a scope reader is refused, the owner passes', async () => {
        const tenantTarget = p();
        await host.admin.assignRole(staff, { principalId: tenantTarget, roleKey: 'writer', node: { tenantId: t1, scopeId: null } });
        const before = await snapshot();
        expect(await mint(reader, tenantTarget)).toEqual({ ok: false, coverage: { covered: false, missing: [WRITE] } });
        expect(await snapshot()).toEqual(before);
        expect((await mint(owner, tenantTarget)).ok).toBe(true);
      });

      it('an entity-narrowed grant held only through an org counts: the sibling holder is refused, the ancestor holder passes', async () => {
        const orgTarget = p();
        const org = orgId.parse(ulid());
        await host.admin.createOrg(staff, { id: org, tenantId: t1, slug: `become-${ulid().toLowerCase()}`, name: 'Become Org' });
        await host.admin.addMember(staff, t1, orgTarget, org);
        await host.admin.grantToOrg(staff, org, READ, node(), doc('d1'));
        await host.admin.assignRole(staff, { principalId: orgTarget, roleKey: 'member', node: node() });
        const before = await snapshot();
        expect(await mint(siblingReader, orgTarget)).toEqual({ ok: false, coverage: { covered: false, missing: [READ] } });
        expect(await snapshot()).toEqual(before);
        expect((await mint(folderReader, orgTarget)).ok).toBe(true);
      });
    });

    describe('nothing to become', () => {
      it('a target holding nothing at the node is refused, even by the owner — nothing recorded, nothing on the spine', async () => {
        const before = await snapshot();
        expect(await mint(owner, emptyTarget)).toEqual({ ok: false, refused: 'target-holds-nothing' });
        expect(await mint(nobody, emptyTarget)).toEqual({ ok: false, refused: 'target-holds-nothing' });
        expect(await snapshot()).toEqual(before);
      });

      it('…and so is one holding only an entity-narrowed grant: the node-level set is what must be there', async () => {
        const narrowOnly = p();
        await host.admin.grant(staff, { principalId: narrowOnly, permission: READ, node: node(), entity: doc('d1'), grantedBy: owner });
        expect(await mint(owner, narrowOnly)).toEqual({ ok: false, refused: 'target-holds-nothing' });
      });

      it('the twin: once it holds a role, the same principal is minted for', async () => {
        await host.admin.assignRole(staff, { principalId: emptyTarget, roleKey: 'reader', node: node() });
        expect((await mint(owner, emptyTarget)).ok).toBe(true);
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
