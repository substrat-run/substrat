/**
 * Contract suite for BIND links (#2817) — how someone who is already a member of a scope comes to
 * hold a record afterwards. A binding invite binds a principal minted fresh for the invite, and a
 * `become` is never minted again for a principal some link already yielded
 * (`target-already-claimed`); a `bind` link instead names one existing member, and binds them
 * when THEIR OWN session presents it. No principal changes hands.
 *
 * What it pins, in one sentence: **a link minted by someone holding a binding shape's key on a
 * free record, for a member, binds exactly that member exactly once — presented by anyone else,
 * by them once they are no member, after the record was bound or the minter lost the key, or
 * through any other exchange, it is refused and left unspent; an unbind of the record or the
 * erasure of the member revokes it.**
 *
 * Reuses `bindingInviteContractSuite`'s fixture module (`bind-module.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  CAPABILITY_BIND_MINTED,
  ENTITY_HOLDER_BOUND,
  dataSubjectId,
  errorCodeOf,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type BoundedBecomeMint,
  type BoundedBindLinkMint,
  type BoundedUnbind,
  type CapabilityRecord,
  type EntityRef,
  type MintedCapability,
  type PrincipalBecomeCapabilityInput,
  type PrincipalBindLinkInput,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { BIND_INVITE, BIND_MEMBER, BIND_READ_OWN, BIND_SHAPE, bindMod } from './bind-module.js';
import type { ScopeHostFixture } from './scope-host-suite.js';

/** The host verbs under test — on each adapter's host class, not on `ScopeHost`. */
export interface BindLinkVerbs {
  mintBindLinkBounded(tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, input: PrincipalBindLinkInput): Promise<BoundedBindLinkMint>;
  mintBecomeCapabilityBounded(tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, input: PrincipalBecomeCapabilityInput): Promise<BoundedBecomeMint>;
  unbindEntityHolderBounded(tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, entity: EntityRef): Promise<BoundedUnbind>;
}

type Row = Record<string, unknown>;

export function bindLinkContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture & { verbs: BindLinkVerbs }>): void {
  describe(`bind links (#2817): ${adapterName}`, () => {
    let fixture: ScopeHostFixture & { verbs: BindLinkVerbs };
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const p = () => principalId.parse(ulid());
    const clerk = p(); // bind:invite + bind:member scope-wide
    const node = { tenantId: t1, scopeId: s1 };
    const rec = (id: string): EntityRef => ({ entityType: 'brecord', entityId: id });

    const sql = async (q: string, params: string[] = []): Promise<Row[]> =>
      (await host.getScope(clerk, t1, s1)).invoke<Row[]>('bind/sql', { sql: q, params });
    const put = async (q: string, params: (string | null)[] = []) => (await host.getScope(clerk, t1, s1)).invoke('bind/put', { sql: q, params });
    const record = async (): Promise<string> => {
      const id = ulid();
      await put('INSERT INTO bind_records (id, principal, email, fate) VALUES (?, NULL, NULL, NULL)', [id]);
      return id;
    };
    const holderOf = async (id: string) => ((await sql('SELECT principal FROM bind_records WHERE id = ?', [id]))[0] as { principal: string | null }).principal;
    const outbox = async (type: string) =>
      (await sql('SELECT actor, entity_type, entity_id, payload FROM _substrat_outbox WHERE type = ? ORDER BY id', [type])).map((r) => ({
        actor: JSON.parse(String(r.actor)) as unknown,
        entity: { entityType: r.entity_type, entityId: r.entity_id },
        payload: JSON.parse(String(r.payload)) as Record<string, unknown>,
      }));
    const capOf = async (id: string): Promise<CapabilityRecord | undefined> =>
      (await host.admin.listCapabilities(staff, t1, s1, { includeRevoked: true })).entries.find((r) => r.id === id);
    /** What a refusal must not have changed: the directory, the spine, and the records' tuples. */
    const snapshot = async () => ({
      caps: (await host.admin.listCapabilities(staff, t1, s1, { includeRevoked: true, limit: 200 })).entries.map((r) => [r.id, r.uses, r.revokedAt]),
      events: (await sql('SELECT COUNT(*) AS n FROM _substrat_outbox'))[0]!.n,
      tuples: (await sql("SELECT COUNT(*) AS n, COUNT(revoked_at) AS dead FROM _substrat_tuples WHERE object LIKE 'brecord:%'"))[0],
    });
    const member = async (): Promise<PrincipalId> => {
      const who = p();
      await host.admin.assignRole(staff, { principalId: who, roleKey: 'member', node });
      return who;
    };
    const mint = (caller: PrincipalId, principal: PrincipalId, entity: EntityRef) =>
      fixture.verbs.mintBindLinkBounded(t1, s1, caller, { principal, entity, label: 'bind link' });
    const minted = async (caller: PrincipalId, principal: PrincipalId, entity: EntityRef): Promise<MintedCapability> => {
      const out = await mint(caller, principal, entity);
      if (!out.ok) throw new Error(`expected a mint, refused: ${JSON.stringify(out)}`);
      return out.minted;
    };
    const present = (secret: string, presenter: PrincipalId) => host.exchangeCapability(t1, s1, secret, { mode: 'bind', presenter });
    const reads = async (who: PrincipalId, id: string): Promise<boolean> => {
      try {
        await (await host.getScope(who, t1, s1)).invoke('bind/read', { id });
        return true;
      } catch (err) {
        if (errorCodeOf(err) === 'permission_denied') return false;
        throw err;
      }
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(bindMod);
      await host.admin.createTenant(staff, { id: t1, slug: `bindlink-${t1.toLowerCase()}`, name: 'Bind link' });
      await host.admin.grantEntitlement(staff, t1, 'bind');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'bind-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.admin.defineRole(staff, t1, { key: 'clerk', permissions: [BIND_INVITE, BIND_MEMBER], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'member', permissions: [BIND_MEMBER], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: clerk, roleKey: 'clerk', node });
      await host.admin.reconcileEntityGrantShapes(staff, node, [BIND_SHAPE]);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('binds a member who has already claimed a link — whom no binding invite may name — exactly once', async () => {
      // A member who joined by an invite: a `become` for them was exchanged, so it is never minted again.
      const joined = await member();
      const invite = await fixture.verbs.mintBecomeCapabilityBounded(t1, s1, clerk, { principal: joined, maxUses: 1 });
      if (!invite.ok) throw new Error('expected the member invite to mint');
      expect((await host.exchangeCapability(t1, s1, invite.minted.secret, { mode: 'become' }))?.kind).toBe('principal');
      const id = await record();
      expect(await fixture.verbs.mintBecomeCapabilityBounded(t1, s1, clerk, { principal: joined, maxUses: 1, bind: { entity: rec(id) } })).toEqual({
        ok: false,
        refused: 'target-already-claimed',
      });

      const link = await minted(clerk, joined, rec(id));
      expect(await capOf(link.id)).toMatchObject({ mode: 'bind', principal: joined, action: { kind: 'bind', entity: rec(id) }, maxUses: 1, uses: 0 });
      expect((await outbox(CAPABILITY_BIND_MINTED)).filter((e) => e.payload.capabilityId === link.id)).toEqual([
        {
          actor: clerk,
          entity: rec(id),
          payload: { capabilityId: link.id, principal: joined, entity: rec(id), expiresAt: null, label: 'bind link', mintedBy: clerk },
        },
      ]);
      expect(await reads(joined, id)).toBe(false);

      expect(await present(link.secret, joined)).toEqual({ kind: 'principal', capabilityId: link.id, principal: joined, bound: rec(id) });
      expect(await holderOf(id)).toBe(joined);
      expect(await reads(joined, id)).toBe(true);
      expect((await outbox(ENTITY_HOLDER_BOUND)).filter((e) => e.entity.entityId === id)).toEqual([
        {
          actor: { capability: link.id },
          entity: rec(id),
          payload: { entity: rec(id), principal: joined, capabilityId: link.id, mintedBy: clerk, granted: [BIND_READ_OWN] },
        },
      ]);
      // Single use: spent, and the second presentation binds nothing more.
      const before = await snapshot();
      expect(await present(link.secret, joined)).toBeNull();
      expect(await snapshot()).toEqual(before);
    });

    it('is minted only for a member, and only by a holder of the key — refusals write nothing', async () => {
      const id = await record();
      const [keyless, target] = [await member(), await member()];
      const before = await snapshot();
      expect(await mint(clerk, p(), rec(id))).toEqual({ ok: false, refused: 'target-holds-nothing' });
      expect(await mint(keyless, target, rec(id))).toEqual({ ok: false, coverage: { covered: false, missing: [BIND_INVITE] } });
      expect(await snapshot()).toEqual(before);
    });

    it('is refused, unspent, presented by anyone but the member it names — whom it then binds', async () => {
      const id = await record();
      const named = await member();
      const link = await minted(clerk, named, rec(id));
      const others = [clerk, await member()];
      const before = await snapshot();
      for (const other of others) expect(await present(link.secret, other)).toBeNull();
      expect(await snapshot()).toEqual(before);
      expect(await present(link.secret, named)).toMatchObject({ principal: named, bound: rec(id) });
    });

    it('is refused, unspent, once the member it names is no member — and binds them once they are again', async () => {
      const id = await record();
      const named = await member();
      const link = await minted(clerk, named, rec(id));
      await host.admin.unassignRole(staff, { principalId: named, roleKey: 'member', node });
      expect(await present(link.secret, named)).toBeNull();
      expect((await capOf(link.id))?.uses).toBe(0);
      await host.admin.assignRole(staff, { principalId: named, roleKey: 'member', node });
      expect(await present(link.secret, named)).toMatchObject({ principal: named });
    });

    /** A minted link whose exchange `spoil` makes wrong, and `undo` puts right again. */
    const refusedThenAllowed = async (spoil: (id: string, minter: PrincipalId) => Promise<unknown>, undo: (id: string, minter: PrincipalId) => Promise<unknown>) => {
      const id = await record();
      const minter = p();
      await host.admin.assignRole(staff, { principalId: minter, roleKey: 'clerk', node });
      const named = await member();
      const link = await minted(minter, named, rec(id));
      await spoil(id, minter);
      const was = await holderOf(id);
      expect(await present(link.secret, named)).toBeNull();
      expect((await capOf(link.id))?.uses).toBe(0);
      expect(await holderOf(id)).toBe(was);
      await undo(id, minter);
      expect(await present(link.secret, named)).toMatchObject({ principal: named });
    };

    it('is refused, unspent, when its minter has lost the key — and goes through once they hold it again', () =>
      refusedThenAllowed(
        (_, minter) => host.admin.unassignRole(staff, { principalId: minter, roleKey: 'clerk', node }),
        (_, minter) => host.admin.assignRole(staff, { principalId: minter, roleKey: 'clerk', node }),
      ));

    it('is refused, unspent, when the record was bound meanwhile — and goes through once it is free', () =>
      refusedThenAllowed(
        (id) => put('UPDATE bind_records SET principal = ? WHERE id = ?', [p(), id]),
        (id) => put('UPDATE bind_records SET principal = NULL WHERE id = ?', [id]),
      ));

    it('is spent by no other exchange, and spends no other link', async () => {
      const named = await member();
      const link = await minted(clerk, named, rec(await record()));
      for (const options of [undefined, { mode: 'become' as const }, { mode: 'act' as const }]) {
        expect(await host.exchangeCapability(t1, s1, link.secret, options)).toBeNull();
      }
      expect((await capOf(link.id))?.uses).toBe(0);
      // And a `become` link presented as a bind link is refused unspent: it still yields its seat.
      const seat = await member();
      const invite = await fixture.verbs.mintBecomeCapabilityBounded(t1, s1, clerk, { principal: seat, maxUses: 1 });
      if (!invite.ok) throw new Error('expected the member invite to mint');
      expect(await present(invite.minted.secret, seat)).toBeNull();
      expect(await host.exchangeCapability(t1, s1, invite.minted.secret, { mode: 'become' })).toMatchObject({ principal: seat });
    });

    it('is revoked by an unbind of its record, and by the erasure of the member it names', async () => {
      const id = await record();
      const unbound = await minted(clerk, await member(), rec(id));
      expect(await fixture.verbs.unbindEntityHolderBounded(t1, s1, clerk, rec(id))).toEqual({ ok: true, unbound: [], revokedLinks: [unbound.id] });
      expect(await capOf(unbound.id)).toMatchObject({ revokedBy: clerk, uses: 0 });

      const erased = await member();
      const link = await minted(clerk, erased, rec(id));
      await host.admin.shredSubject(staff, t1, s1, dataSubjectId.parse(erased));
      expect(await capOf(link.id)).toMatchObject({ revokedBy: null, uses: 0 });
      expect(await present(link.secret, erased)).toBeNull();
      expect(await holderOf(id)).toBeNull();
    });
  });
}
