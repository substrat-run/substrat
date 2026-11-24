/**
 * Contract suite for the delegated call's ceiling (#3161): a person acting through another app,
 * with `getScope(…, { delegation: { actor, scope } })`, may do what they hold AND what was
 * delegated. Alice holds A and B; every case below is about which of them the call may use, and
 * `heldPermissions` (#3360) reads the same answer back without a call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { errorCodeOf, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import {
  CEILING_A,
  CEILING_B,
  CEILING_ECHOED,
  CEILING_ENTITY,
  CEILING_NOTED,
  CEILING_NOTE_ENTITY,
  CEILING_PEER,
  CEILING_ROLE,
  delegationCeilingMod,
} from './delegation-ceiling-module.js';

const ACTOR = 'client-todo';

export function delegationCeilingContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`delegated call ceiling (#3161): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());
    let direct: ScopeStub;
    let delegatedA: ScopeStub;

    const codeOf = (call: Promise<unknown>): Promise<string | undefined> =>
      call.then(
        () => 'answered',
        (e: unknown) => errorCodeOf(e),
      );
    const rows = async () => ((await direct.invoke('ceiling/rows')) as { rows: number }).rows;
    const as = (scope: string[], actor = ACTOR) => host.getScope(alice, t, s, { delegation: { actor, scope } });
    /** One call under an idempotency key: what it answered, and whether that was a replay. */
    const keyed = async (stub: ScopeStub, operation: string, idempotencyKey: string) => {
      let replayed = false;
      const result = await stub.invoke(operation, undefined, { idempotencyKey, onIdempotentReplay: () => { replayed = true; } });
      return { result, replayed };
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(delegationCeilingMod);
      await host.admin.createTenant(staff, { id: t, slug: 'ceiling-tenant', name: 'Ceiling Tenant' });
      await host.admin.grantEntitlement(staff, t, 'delegation-ceiling');
      await host.admin.defineRole(staff, t, { key: CEILING_ROLE, permissions: [CEILING_A, CEILING_B], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: CEILING_ROLE, node: { tenantId: t, scopeId: null } });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'ceiling-vertical' });
      await host.admin.activateScope(staff, t, s);
      direct = await host.getScope(alice, t, s);
      delegatedA = await host.getScope(alice, t, s, { delegation: { actor: ACTOR, scope: [CEILING_A] } });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('with no delegation the person uses everything they hold', async () => {
      expect(await direct.invoke('ceiling/a')).toEqual({ ok: true });
      expect(await direct.invoke('ceiling/b')).toEqual({ ok: true });
      expect(await direct.invoke('ceiling/granted-b')).toEqual({ kind: 'all' });
      expect(await direct.invoke('ceiling/can-assign')).toEqual({ covered: true, missing: [] });
    });

    it('a delegated key passes, and a held key outside the scope is refused', async () => {
      expect(await delegatedA.invoke('ceiling/a')).toEqual({ ok: true });
      expect(await codeOf(delegatedA.invoke('ceiling/b'))).toBe('permission_denied');
    });

    it('a second check inside the operation is capped too, and the refusal rolls the write back', async () => {
      const before = await rows();
      expect(await codeOf(delegatedA.invoke('ceiling/a-then-b'))).toBe('permission_denied');
      expect(await rows()).toBe(before);
    });

    it('the grant-scoped read behind a filtered list finds nothing for a key outside the scope', async () => {
      expect(await delegatedA.invoke('ceiling/granted-b')).toEqual({ kind: 'ids', ids: [] });
    });

    it('a role carrying a key outside the scope is not the call\'s to hand on', async () => {
      expect(await delegatedA.invoke('ceiling/can-assign')).toEqual({ covered: false, missing: [CEILING_B] });
    });

    it('a delegated call is never answered from the person\'s own recording', async () => {
      const key = ulid();
      expect(await keyed(direct, 'ceiling/b', key)).toEqual({ result: { ok: true }, replayed: false });
      expect(await codeOf(delegatedA.invoke('ceiling/b', undefined, { idempotencyKey: key }))).toBe('permission_denied');
    });

    it('a recording made under one delegation is out of reach of another scope or another actor', async () => {
      const wide = await as([CEILING_A, CEILING_B]);
      const wider = ulid();
      expect(await keyed(wide, 'ceiling/b', wider)).toEqual({ result: { ok: true }, replayed: false });
      expect(await codeOf(delegatedA.invoke('ceiling/b', undefined, { idempotencyKey: wider }))).toBe('permission_denied');
      const narrower = ulid();
      expect((await keyed(delegatedA, 'ceiling/mark', narrower)).replayed).toBe(false);
      expect((await keyed(wide, 'ceiling/mark', narrower)).replayed).toBe(false);
      expect((await keyed(await as([CEILING_A], 'client-other'), 'ceiling/mark', narrower)).replayed).toBe(false);
    });

    it('the same actor retrying under the same scope is answered from its recording', async () => {
      const key = ulid();
      const first = await keyed(await as([CEILING_A, CEILING_B]), 'ceiling/mark', key);
      expect(await keyed(await as([CEILING_B, CEILING_A]), 'ceiling/mark', key)).toEqual({ result: first.result, replayed: true });
    });

    describe('the record a delegated call leaves (#3176)', () => {
      /** Each event about one note: its type and the delegation its history entry reports. */
      const recorded = async (id: string) =>
        (await host.admin.entityHistory(staff, t, s, { entityType: CEILING_NOTE_ENTITY, entityId: id })).entries.map(
          (e) => [e.type, e.delegation],
        );
      /** The denial one call left, found by the invocation id it carried. */
      const deniedIn = async (invocationId: string) =>
        (await host.admin.listDenials(staff, t, s, { operation: 'ceiling/b' })).filter((d) => d.invocationId === invocationId);

      it('names the app on every event the call emits, a sub-transaction\'s included, and on none its consumer emits', async () => {
        const id = ulid();
        await delegatedA.invoke('ceiling/note', { id });
        expect(await recorded(id)).toEqual([
          [CEILING_NOTED, { actor: ACTOR }],
          [CEILING_NOTED, { actor: ACTOR }],
          [CEILING_ECHOED, null],
          [CEILING_ECHOED, null],
        ]);
      });

      it('names the app on the denial a refused delegated check writes', async () => {
        const invocationId = ulid();
        expect(await codeOf(delegatedA.invoke('ceiling/b', undefined, { invocationId }))).toBe('permission_denied');
        expect((await deniedIn(invocationId)).map((d) => [d.permission, d.delegation])).toEqual([[CEILING_B, { actor: ACTOR }]]);
      });

      it('records null for a person acting directly, on an event and on a denial', async () => {
        const id = ulid();
        await direct.invoke('ceiling/note', { id });
        expect((await recorded(id)).filter(([type]) => type === CEILING_NOTED)).toEqual([
          [CEILING_NOTED, null],
          [CEILING_NOTED, null],
        ]);
        const invocationId = ulid();
        const stranger = await host.getScope(principalId.parse(ulid()), t, s);
        expect(await codeOf(stranger.invoke('ceiling/b', undefined, { invocationId }))).toBe('permission_denied');
        expect((await deniedIn(invocationId)).map((d) => d.delegation)).toEqual([null]);
      });
    });

    it('heldPermissions lists what the person could pass a check for, under the same ceiling (#3360)', async () => {
      const held = (stub: ScopeStub) => stub.heldPermissions!();
      expect(await held(direct)).toEqual([CEILING_A, CEILING_B]);
      expect(await held(delegatedA)).toEqual([CEILING_A]);
      expect(await held(await as([]))).toEqual([]);
      // A key held on one entity only counts: a check on that entity passes.
      const narrow = principalId.parse(ulid());
      await host.admin.grant(staff, {
        principalId: narrow,
        permission: CEILING_B,
        node: { tenantId: t, scopeId: s },
        entity: { entityType: CEILING_ENTITY, entityId: ulid() },
        grantedBy: alice,
      });
      expect(await held(await host.getScope(narrow, t, s))).toEqual([CEILING_B]);
      expect(await held(await host.getScope(principalId.parse(ulid()), t, s))).toEqual([]);
    });

    it('an empty scope admits nothing', async () => {
      const none = await host.getScope(alice, t, s, { delegation: { actor: ACTOR, scope: [] } });
      expect(await codeOf(none.invoke('ceiling/a'))).toBe('permission_denied');
    });

    describe('arriving through a peer (`via`)', () => {
      // A scope of its own with no vertical, so the peer switch is moved here on both adapters.
      const p = scopeId.parse(ulid());
      const via = (vertical: string = CEILING_PEER, tenantSlug?: string) => ({ vertical, scope: scopeId.parse(ulid()), ...(tenantSlug ? { tenantSlug } : {}) });
      const through = (vertical?: string, tenantSlug?: string) =>
        host.getScope(alice, t, p, { delegation: { actor: ACTOR, scope: [CEILING_A], via: via(vertical, tenantSlug) } });
      const peerSwitch = { vertical: CEILING_PEER, node: { tenantId: t, scopeId: p }, reason: 'incident' };

      beforeAll(async () => {
        await host.provisionScope(staff, { tenantId: t, scopeId: p });
        await host.admin.activateScope(staff, t, p);
      });

      it('a declared peer, switched on, lets the call in, still under the ceiling and with no allowlist', async () => {
        const stub = await through();
        expect(await stub.invoke('ceiling/a')).toEqual({ ok: true });
        expect(await codeOf(stub.invoke('ceiling/b'))).toBe('permission_denied');
        // Pushed pinned to this tenant, the same peer (#2252), as at the peer door.
        expect(await (await through(`ceiling-tenant/${CEILING_PEER}`, 'ceiling-tenant')).invoke('ceiling/a')).toEqual({ ok: true });
      });

      it('a vertical this one does not declare as a peer is refused', async () => {
        expect(await codeOf((await through('ceiling-stranger')).invoke('ceiling/a'))).toBe('forbidden');
      });

      it('the peer switched off refuses the call made through it, and nothing else; on again, it passes', async () => {
        const stub = await through();
        await host.admin.revokeFromPeer(staff, peerSwitch);
        try {
          expect(await codeOf(stub.invoke('ceiling/a'))).toBe('forbidden');
          expect(await codeOf((await through()).invoke('ceiling/a'))).toBe('forbidden');
          expect(await (await host.getScope(alice, t, p)).invoke('ceiling/a')).toEqual({ ok: true });
          expect(await (await as([CEILING_A])).invoke('ceiling/a')).toEqual({ ok: true });
        } finally {
          await host.admin.restoreToPeer(staff, { ...peerSwitch, reason: 'resolved' });
        }
        expect(await stub.invoke('ceiling/a')).toEqual({ ok: true });
      });
    });

    it('a malformed delegation is refused at the door, never ignored', async () => {
      for (const delegation of [
        { actor: '', scope: [CEILING_A] },
        { actor: ACTOR, scope: CEILING_A },
        { actor: ACTOR },
        { actor: ACTOR, scope: [CEILING_A], via: { vertical: CEILING_PEER } },
      ]) {
        expect(await codeOf(host.getScope(alice, t, s, { delegation } as never))).toBe('validation_failed');
      }
    });
  });
}
