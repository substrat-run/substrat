/**
 * The peer door (#1706), against both adapters — one vertical of a tenant calling another's
 * operations through the platform, as `{ vertical, scope }`.
 *
 * Every "this is safe because…" the door claims is a test here, next to its positive twin: the
 * same call as a principal who holds the key, or the same peer on the call it IS allowed, so a
 * refusal cannot pass by refusing everything.
 *
 * - **Declared, or nothing.** The keys a peer holds are exactly the ones the target's manifest
 *   declared (`peers`), seated at provisioning; an undeclared vertical, and an operation off the
 *   allowlist, are refused at the door (`forbidden`, no K-35 row). A receive-only peer
 *   (`operations: []`) holds its key and invokes nothing.
 * - **On the spine as itself.** Every event and every denial names `{ vertical, scope }`.
 * - **Revocation is the next call.** The per-(scope, peer) kill switch refuses a stub obtained
 *   before it, answers `peerCovers` with nothing held, and survives a re-provision.
 * - **Tenant-bound.** The door fails closed on a (tenant, scope) pair that does not match, and
 *   the resolution only ever searches the tenant it is given.
 * - **No person crosses.** The door takes no principal; a peer cannot mint a capability (the verb
 *   that needs a person to vouch for it); its idempotency keys are its own instance's.
 *
 * The caller's LIVENESS (a live primary instance of its vertical) is the platform's gate, not the
 * door's — the local broker's suite (adapter-sqlite) and the router hold it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
  type PrincipalId,
  type ScopeId,
  type TenantId,
  type VerticalCaller,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { expectAnswered, expectSettledUnknown, withEmptyOutcomeError, withRefusedOutcome, type AdminRowFault } from './switch-audit-fault.js';
import { PEER_CALLER, PEER_LISTENER, peerMod } from './modules.js';

const READ = permissionKey.parse('peer:read');
const WRITE = permissionKey.parse('peer:write');
const ADMIN = permissionKey.parse('peer:admin');

interface OutboxRow {
  actor: string;
  authorization: string | null;
  operation: string | null;
  entity_id: string;
}
interface DenialRow {
  actor: string;
  permission: string;
  operation: string | null;
}
interface TupleRow {
  subject: string;
  relation: string;
  object: string;
  revoked_at: string | null;
}

/** The refusal a promise settles with, or `undefined` when it resolved. */
const refusal = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

/**
 * The peer suite's fixture: a host, and (#2030) a way to give a peer a TENANT-level grant. No
 * platform verb writes one yet — peer grants are seated per scope — so each adapter writes the
 * directory's tenant tuple itself, the one the day such a verb lands will write.
 */
export interface PeerFixture extends ScopeHostFixture, AdminRowFault {
  seatTenantGrant(tenantId: TenantId, subject: string, permission: PermissionKey): Promise<void>;
}

export function peerContractSuite(adapterName: string, makeFixture: () => Promise<PeerFixture>): void {
  describe(`peer door (#1706): ${adapterName}`, () => {
    let fixture: PeerFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const u = tenantId.parse(ulid()); // another tenant
    const s = scopeId.parse(ulid()); // the target instance, in t
    const su = scopeId.parse(ulid()); // an instance in u
    const alice: PrincipalId = principalId.parse(ulid()); // holds every key, tenant-wide
    const callerScope = scopeId.parse(ulid()); // the calling instance (another vertical's scope)
    const secondCaller = scopeId.parse(ulid()); // a second instance of the same calling vertical
    const caller: VerticalCaller = { vertical: PEER_CALLER, scope: callerScope };
    const listener: VerticalCaller = { vertical: PEER_LISTENER, scope: scopeId.parse(ulid()) };
    const reason = 'incident: the caller is misbehaving';

    const asAlice = (scope: ScopeId = s) => host.getScope(alice, t, scope);
    const asPeer = (c: VerticalCaller = caller, scope: ScopeId = s, tenant = t) => host.getVerticalScope(c, tenant, scope);
    const outbox = async () => (await asAlice()).invoke<OutboxRow[]>('peer/outbox');
    const denials = async () => (await asAlice()).invoke<DenialRow[]>('peer/denials');
    const tuples = async () => (await asAlice()).invoke<TupleRow[]>('peer/tuples');
    const covers = (vertical: string, keys = [READ, WRITE, ADMIN]) => host.peerCovers(t, s, vertical, keys);
    const held = async (vertical: string) =>
      (await covers(vertical)).filter((c) => c.held).map((c) => c.permission);
    const off = (vertical = PEER_CALLER) =>
      host.admin.revokeFromPeer(staff, { vertical, node: { tenantId: t, scopeId: s }, reason });
    const on = (vertical = PEER_CALLER) =>
      host.admin.restoreToPeer(staff, { vertical, node: { tenantId: t, scopeId: s }, reason: 'resolved' });

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(peerMod);
      for (const [tenant, scope, slug] of [
        [t, s, 'peer-t'],
        [u, su, 'peer-u'],
      ] as const) {
        await host.admin.createTenant(staff, { id: tenant, slug: `${slug}-${tenant.slice(-8).toLowerCase()}`, name: slug });
        await host.admin.grantEntitlement(staff, tenant, 'peer');
        await host.provisionScope(staff, { tenantId: tenant, scopeId: scope });
        await host.admin.activateScope(staff, tenant, scope);
        await host.admin.defineRole(staff, tenant, {
          key: 'owner',
          permissions: [READ, WRITE, ADMIN],
          source: 'vertical',
        });
      }
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t, scopeId: null } });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    describe('declared, or nothing', () => {
      it('provisioning seats exactly the declared keys, per peer, and nothing for an undeclared one', async () => {
        const live = (await tuples())
          .filter((r) => r.revoked_at === null)
          .map((r) => `${r.subject} ${r.relation} ${r.object}`);
        expect(live.sort()).toEqual(
          [
            `vertical:${PEER_CALLER} granted:peer:read scope:${s}`,
            `vertical:${PEER_CALLER} granted:peer:write scope:${s}`,
            `vertical:${PEER_LISTENER} granted:peer:read scope:${s}`,
          ].sort(),
        );
      });

      it('an allowlisted operation runs as the peer — the event names { vertical, scope }', async () => {
        const peer = await asPeer();
        await expect(peer.invoke('peer/note', { id: 'n-peer', body: 'from the board room' })).resolves.toEqual({
          id: 'n-peer',
        });
        const row = (await outbox()).find((r) => r.entity_id === 'n-peer')!;
        expect(JSON.parse(row.actor)).toEqual({ vertical: PEER_CALLER, scope: callerScope });
        expect(row.operation).toBe('peer/note');
        // K-34: authorized by the declared key, recorded like any other authorization.
        expect(JSON.parse(row.authorization ?? '[]')).toEqual([expect.objectContaining({ permission: WRITE })]);
      });

      it('twin: the same write by a person is recorded as that person', async () => {
        await (await asAlice()).invoke('peer/note', { id: 'n-alice', body: 'from alice' });
        const row = (await outbox()).find((r) => r.entity_id === 'n-alice')!;
        expect(JSON.parse(row.actor)).toBe(alice);
      });

      it('a read through a declared key sees the scope', async () => {
        const notes = await (await asPeer()).invoke<{ id: string }[]>('peer/list');
        expect(notes.map((n) => n.id)).toEqual(expect.arrayContaining(['n-alice', 'n-peer']));
      });

      it('an allowlisted operation checking an UNDECLARED key is a K-35 denial against the peer', async () => {
        const err = await refusal((await asPeer()).invoke('peer/admin'));
        expect(errorCodeOf(err)).toBe('permission_denied');
        const row = (await denials()).find((d) => d.operation === 'peer/admin')!;
        expect(JSON.parse(row.actor)).toEqual({ vertical: PEER_CALLER, scope: callerScope });
        expect(row.permission).toBe(ADMIN);
      });

      it('twin: a person holding that key runs it', async () => {
        await expect((await asAlice()).invoke('peer/admin')).resolves.toEqual({ admin: true });
      });

      it('an operation OFF the allowlist is refused at the door — forbidden, and no K-35 row', async () => {
        const before = (await denials()).length;
        const err = await refusal((await asPeer()).invoke('peer/off-list'));
        expect(errorCodeOf(err)).toBe('forbidden');
        expect((await denials()).length).toBe(before);
      });

      it('twin: a person reaches that operation', async () => {
        await expect((await asAlice()).invoke('peer/off-list')).resolves.toEqual({ reached: true });
      });

      it('a vertical the target never declared is refused at the door, whatever it asks for', async () => {
        const stranger: VerticalCaller = { vertical: 'acme/stranger', scope: callerScope };
        for (const op of ['peer/list', 'peer/note', 'peer/off-list']) {
          expect(errorCodeOf(await refusal((await asPeer(stranger)).invoke(op, { id: 'x', body: 'x' })))).toBe(
            'forbidden',
          );
        }
        expect(await held('acme/stranger')).toEqual([]);
      });

      it('a receive-only peer (`operations: []`) holds its key and invokes nothing', async () => {
        expect(await held(PEER_LISTENER)).toEqual([READ]);
        for (const op of ['peer/list', 'peer/note']) {
          expect(errorCodeOf(await refusal((await asPeer(listener)).invoke(op, { id: 'y', body: 'y' })))).toBe(
            'forbidden',
          );
        }
      });

      it('peerCovers answers the checker’s own view, key by key', async () => {
        expect(await covers(PEER_CALLER)).toEqual([
          { permission: READ, held: true },
          { permission: WRITE, held: true },
          { permission: ADMIN, held: false },
        ]);
      });
    });

    describe('revocation is the next call: the per-(scope, peer) kill switch', () => {
      it('OFF refuses a stub obtained BEFORE it, and every key reads as not held', async () => {
        const early = await asPeer();
        await expect(early.invoke('peer/list')).resolves.toBeDefined();
        const result = await off();
        expect(result).toMatchObject({ vertical: PEER_CALLER, calls: 'off', changed: true });
        expect([...result.permissions].sort()).toEqual([READ, WRITE]);
        expect(errorCodeOf(await refusal(early.invoke('peer/list')))).toBe('forbidden');
        expect(errorCodeOf(await refusal((await asPeer()).invoke('peer/list')))).toBe('forbidden');
        expect(await held(PEER_CALLER)).toEqual([]);
      });

      it('is per peer: the receive-only peer keeps its key', async () => {
        expect(await held(PEER_LISTENER)).toEqual([READ]);
      });

      it('a re-provision does not seat a switched-off peer back', async () => {
        await host.provisionScope(staff, { tenantId: t, scopeId: s });
        expect(await held(PEER_CALLER)).toEqual([]);
        expect(errorCodeOf(await refusal((await asPeer()).invoke('peer/list')))).toBe('forbidden');
      });

      it('a repeat OFF changes nothing and says so', async () => {
        await expect(off()).resolves.toMatchObject({ calls: 'off', changed: false, permissions: [] });
      });

      it('restoreToPeer gives back exactly what OFF took, and the peer calls again', async () => {
        const result = await on();
        expect(result).toMatchObject({ vertical: PEER_CALLER, calls: 'on', changed: true });
        expect([...result.permissions].sort()).toEqual([READ, WRITE]);
        expect(await held(PEER_CALLER)).toEqual([READ, WRITE]);
        await expect((await asPeer()).invoke('peer/list')).resolves.toBeDefined();
      });

      it('a switch for a peer the scope never held writes nothing and says not_found', async () => {
        expect(errorCodeOf(await refusal(off('acme/stranger')))).toBe('not_found');
        expect((await tuples()).some((r) => r.subject === 'vertical:acme/stranger')).toBe(false);
      });
    });

    /**
     * The switch's READ half (#1706) — what a tenant is shown about "which of my other apps
     * may call into here". It must answer from the same predicate the door refuses on, or a
     * tenant reads `on` for a peer whose next call is refused; the ordering below runs the
     * switch and the read against each other rather than asserting the read alone.
     */
    describe('the status read', () => {
      const statusOf = async (vertical: string) =>
        (await host.admin.peerGrantsStatus(staff, { tenantId: t, scopeId: s })).find((p) => p.vertical === vertical);

      it('lists every declared peer as on, with no explanation to give', async () => {
        const all = await host.admin.peerGrantsStatus(staff, { tenantId: t, scopeId: s });
        expect(all).toEqual([
          { vertical: PEER_CALLER, calls: 'on', switchedOff: null },
          { vertical: PEER_LISTENER, calls: 'on', switchedOff: null },
        ]);
      });

      it('a peer the scope holds no row for is absent, not reported', async () => {
        expect(await statusOf('acme/stranger')).toBeUndefined();
      });

      it('OFF shows as off, and names who, when and why — while the peer keeps its row', async () => {
        await off();
        const entry = await statusOf(PEER_CALLER);
        expect(entry).toMatchObject({ vertical: PEER_CALLER, calls: 'off' });
        expect(entry?.switchedOff).toMatchObject({ actor: staff, reason: expect.any(String) });
        expect(entry?.switchedOff?.at).toEqual(expect.any(String));
        // The read and the door agree, which is the whole point of sharing the predicate.
        expect(errorCodeOf(await refusal((await asPeer()).invoke('peer/list')))).toBe('forbidden');
      });

      it('is per peer: the other one is untouched and still explains nothing', async () => {
        expect(await statusOf(PEER_LISTENER)).toEqual({
          vertical: PEER_LISTENER,
          calls: 'on',
          switchedOff: null,
        });
      });

      it('ON clears the explanation with the position — a stale reason is worse than none', async () => {
        await on();
        expect(await statusOf(PEER_CALLER)).toEqual({ vertical: PEER_CALLER, calls: 'on', switchedOff: null });
        await expect((await asPeer()).invoke('peer/list')).resolves.toBeDefined();
      });
    });

    /**
     * #2029: the switch is recorded OUTSIDE the scope, in the directory, as the schedule switch is
     * (#1674) — so a scope whose storage lost the marker (a restore of a dump taken before the
     * switch was pulled) is switched off again by the unit that loads it, not left admitting the
     * peer until an operator notices.
     */
    describe('the record outlives the scope’s storage (#2029)', () => {
      it('a restore of a dump from before the OFF keeps the peer refused, and the re-assert finds it off', async () => {
        const before = await host.admin.exportScope(staff, t, s);
        await off();
        await host.restoreScope(staff, t, s, before);
        expect(await held(PEER_CALLER)).toEqual([]);
        expect(errorCodeOf(await refusal((await asPeer()).invoke('peer/list')))).toBe('forbidden');
        const reasserted = await host.admin.reassertSystemSwitches(staff, { tenantId: t, scopeId: s });
        expect(reasserted).toEqual([{ vertical: PEER_CALLER, held: true, changed: false }]);
        // The other peer was never switched, and the record names nothing for it.
        expect(await held(PEER_LISTENER)).toEqual([READ]);
      });

      it('ON gives it back, and a restore after that leaves the peer admitted', async () => {
        await on();
        expect(await held(PEER_CALLER)).toEqual([READ, WRITE]);
        const before = await host.admin.exportScope(staff, t, s);
        await host.restoreScope(staff, t, s, before);
        await expect((await asPeer()).invoke('peer/list')).resolves.toBeDefined();
        expect(await host.admin.reassertSystemSwitches(staff, { tenantId: t, scopeId: s })).toEqual([]);
      });

      it('twin: a switch for a peer the scope never held records nothing, so nothing is re-asserted', async () => {
        expect(errorCodeOf(await refusal(off('acme/stranger')))).toBe('not_found');
        expect(await host.admin.peerSwitchCarry(staff, { tenantId: t, scopeId: s })).toEqual({ switchedOffPeers: [], tenantHeldPeers: [], fences: {} });
      });
    });

    describe('tenant-bound', () => {
      it('the door fails closed on a scope of another tenant, named under this one', async () => {
        // K-3's pair check — the confinement this whole door rests on, so the test pins the
        // CODE and not merely "something threw" (#1714 review). `not_found` on both adapters:
        // a scope of another tenant reads exactly as one that does not exist.
        for (const refused of [refusal(asPeer(caller, su, t)), refusal(host.peerCovers(t, su, PEER_CALLER, [READ]))]) {
          const err = await refused;
          expect(errorCodeOf(err)).toBe('not_found');
          expect(String((err as Error).message)).toMatch(/unknown scope/);
        }
      });

      it('twin: that scope, under its own tenant, is a door like any other', async () => {
        await expect((await asPeer(caller, su, u)).invoke('peer/list')).resolves.toEqual([]);
      });
    });

    describe('no person crosses', () => {
      it('a peer cannot mint a capability — the verb that needs a person to vouch for it', async () => {
        const err = await refusal((await asPeer()).invoke('peer/share', { id: 'n-peer' }));
        expect(String((err as Error | undefined)?.message)).toMatch(/only a principal may mint/);
      });

      it('twin: the person who holds the key mints one', async () => {
        await expect((await asAlice()).invoke('peer/share', { id: 'n-peer' })).resolves.toMatchObject({
          id: expect.any(String),
        });
      });

      it('every record a peer call left names the peer, never a person', async () => {
        const peerRows = (await outbox()).filter((r) => typeof JSON.parse(r.actor) !== 'string');
        expect(peerRows.length).toBeGreaterThan(0);
        for (const row of peerRows) expect(JSON.parse(row.actor)).toMatchObject({ vertical: PEER_CALLER });
        for (const d of (await denials()).filter((d) => d.operation === 'peer/admin')) {
          expect(JSON.parse(d.actor)).toMatchObject({ vertical: PEER_CALLER });
        }
      });

      it('an idempotency key is the calling INSTANCE’s: a second instance’s same key is not a replay', async () => {
        const first = await asPeer();
        await first.invoke('peer/note', { id: 'idem-1', body: 'one' }, { idempotencyKey: 'k-1' });
        // Same instance, same key, same request → a replay: nothing new is written.
        await first.invoke('peer/note', { id: 'idem-1', body: 'one' }, { idempotencyKey: 'k-1' });
        expect((await outbox()).filter((r) => r.entity_id === 'idem-1')).toHaveLength(1);
        // A SECOND instance of the same vertical choosing the same key is a different caller.
        const second = await asPeer({ vertical: PEER_CALLER, scope: secondCaller });
        await second.invoke('peer/note', { id: 'idem-2', body: 'two' }, { idempotencyKey: 'k-1' });
        const row = (await outbox()).find((r) => r.entity_id === 'idem-2')!;
        expect(JSON.parse(row.actor)).toEqual({ vertical: PEER_CALLER, scope: secondCaller });
      });
    });

    describe('an outcome row the log cannot take (#2089)', () => {
      const where = (action: 'revokeFromPeer' | 'restoreToPeer', operationId: string) => ({ tenantId: t, scopeId: s, action, operationId });

      it("a refusal whose row is refused still answers its own not_found, logs the operation, and the settle closes it unknown", async () => {
        const { settled, unrecorded } = await withRefusedOutcome(fixture, s, 'refused', () => off('acme/stranger'));
        expect(errorCodeOf((settled as PromiseRejectedResult).reason)).toBe('not_found');
        expect(unrecorded).toEqual([
          { flow: 'peer-switch', operationId: expect.any(String), phase: 'refused', auditError: expect.stringMatching(/test fault/) },
        ]);
        await expectSettledUnknown(host, staff, where('revokeFromPeer', unrecorded[0]!.operationId as string), {
          vertical: 'acme/stranger',
          calls: 'off',
        });
      });

      it('a failed directory write keeps its own error when its failed row is refused, and settles unknown', async () => {
        const latestOperation = async () =>
          ((await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: 'revokeFromPeer', order: 'desc', limit: 1 }))[0]!.after as {
            operationId: string;
          }).operationId;
        const liftRecord = await fixture.refuseSwitchRecord(s, 'peer');
        try {
          const { settled, unrecorded } = await withRefusedOutcome(fixture, s, 'failed', () => off(PEER_LISTENER));
          expect(settled.status).toBe('rejected');
          expect(String((settled as PromiseRejectedResult).reason)).toMatch(/peer switch record was refused/);
          expect(unrecorded).toEqual([
            { flow: 'peer-switch', operationId: expect.any(String), phase: 'failed', auditError: expect.stringMatching(/test fault/) },
          ]);
          const operationId = unrecorded[0]!.operationId as string;
          expect(await latestOperation()).toBe(operationId);
          await expectSettledUnknown(host, staff, where('revokeFromPeer', operationId), {
            vertical: PEER_LISTENER,
            calls: 'off',
          });

          // Twin: the same directory error with a writable failed row has an answered intent.
          const twin = await withRefusedOutcome(fixture, s, 'applied', () => off(PEER_LISTENER));
          expect(String((twin.settled as PromiseRejectedResult).reason)).toMatch(/peer switch record was refused/);
          expect(twin.unrecorded).toEqual([]);
          await expectAnswered(host, staff, where('revokeFromPeer', await latestOperation()), 'failed');
        } finally {
          await liftRecord();
        }
      });

      it('an empty outcome-write error still warns after the switch moves', async () => {
        const result = await withEmptyOutcomeError(() => off(PEER_LISTENER));
        expect(result.auditWarning).toBe('the switch completed, but its outcome could not be written to the admin log: ');
        expect(await held(PEER_LISTENER)).toEqual([]);
        await expectSettledUnknown(host, staff, where('revokeFromPeer', result.operationId), { vertical: PEER_LISTENER, calls: 'off' });
        await on(PEER_LISTENER);
      });

      it('a switch that moved but whose applied row is refused answers success with auditWarning, and the settle closes it unknown', async () => {
        const { settled, unrecorded } = await withRefusedOutcome(fixture, s, 'applied', () => off(PEER_LISTENER));
        const result = (settled as PromiseFulfilledResult<Awaited<ReturnType<typeof off>>>).value;
        expect(result).toMatchObject({
          vertical: PEER_LISTENER,
          calls: 'off',
          changed: true,
          auditWarning: expect.stringMatching(/^the switch completed, but its outcome could not be written to the admin log: .*test fault/),
        });
        expect(await held(PEER_LISTENER)).toEqual([]);
        expect(unrecorded).toEqual([
          { flow: 'peer-switch', operationId: result.operationId, phase: 'applied', auditError: expect.stringMatching(/test fault/) },
        ]);
        await expectSettledUnknown(host, staff, where('revokeFromPeer', result.operationId), { vertical: PEER_LISTENER, calls: 'off' });

        // Twin: the restore's applied row lands — no warning, nothing to settle.
        const restored = await on(PEER_LISTENER);
        expect(restored).not.toHaveProperty('auditWarning');
        await expectAnswered(host, staff, where('restoreToPeer', restored.operationId), 'applied');
      });
    });
  });

  /**
   * #2030: a peer whose ONLY authority on a scope is a tenant-level `vertical:` grant. The scope
   * here is provisioned before the host registers the peer's module, so provisioning seated none
   * of its keys — the scope holds no row for it at all — and the tenant grant is what admits it.
   * The switch must still turn it off there: the directory says the tenant holds the grant
   * (`tenantHeld`), and OFF writes the scope's marker with nothing to tombstone.
   */
  describe(`peer door, tenant-level authority only (#2030): ${adapterName}`, () => {
    let fixture: PeerFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const other = scopeId.parse(ulid());
    const caller: VerticalCaller = { vertical: PEER_CALLER, scope: scopeId.parse(ulid()) };
    const node = (scope: ScopeId = s) => ({ tenantId: t, scopeId: scope });
    const asPeer = (scope: ScopeId = s) => host.getVerticalScope(caller, t, scope);
    const heldBy = async (vertical: string, scope: ScopeId = s) =>
      (await host.peerCovers(t, scope, vertical, [READ])).filter((c) => c.held).map((c) => c.permission);

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      await host.admin.createTenant(staff, { id: t, slug: `peer-tw-${t.slice(-8).toLowerCase()}`, name: 'tenant-wide' });
      await host.admin.grantEntitlement(staff, t, 'peer');
      for (const scope of [s, other]) await host.provisionScope(staff, { tenantId: t, scopeId: scope });
      // Registered AFTER the seat, so neither scope holds a row for either peer.
      host.registerModule(peerMod);
      for (const scope of [s, other]) await host.admin.activateScope(staff, t, scope);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('twin first: no row here and no tenant grant — or only ANOTHER peer’s — is not_found, recording nothing', async () => {
      const offCaller = () =>
        refusal(host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node: node(), reason: 'r' }));
      expect(errorCodeOf(await offCaller())).toBe('not_found');
      await fixture.seatTenantGrant(t, `vertical:${PEER_LISTENER}`, READ);
      expect(errorCodeOf(await offCaller())).toBe('not_found');
      expect(await host.admin.peerSwitchCarry(staff, node())).toEqual({ switchedOffPeers: [], tenantHeldPeers: [], fences: {} });
      expect(errorCodeOf(await refusal((await asPeer()).invoke('peer/list')))).toBe('permission_denied');
    });

    it('the tenant grant admits the peer on a scope that holds no row for it', async () => {
      await fixture.seatTenantGrant(t, `vertical:${PEER_CALLER}`, READ);
      await expect((await asPeer()).invoke('peer/list')).resolves.toEqual([]);
      expect(await heldBy(PEER_CALLER)).toEqual([READ]);
    });

    it('OFF holds it there: the marker is written, nothing is tombstoned, and the peer is refused', async () => {
      const result = await host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node: node(), reason: 'incident' });
      expect(result).toMatchObject({ vertical: PEER_CALLER, calls: 'off', changed: true, permissions: [] });
      expect(errorCodeOf(await refusal((await asPeer()).invoke('peer/list')))).toBe('forbidden');
      expect(await heldBy(PEER_CALLER)).toEqual([]);
      expect(await host.admin.peerSwitchCarry(staff, node())).toEqual({
        switchedOffPeers: [PEER_CALLER],
        tenantHeldPeers: [PEER_CALLER],
        fences: { [PEER_CALLER]: expect.any(String) },
      });
    });

    it('is per peer and per scope: another peer, and the same peer on another scope, are still admitted', async () => {
      expect(await heldBy(PEER_LISTENER)).toEqual([READ]);
      await expect((await asPeer(other)).invoke('peer/list')).resolves.toEqual([]);
    });

    it('ON gives the tenant grant back on that scope, and a repeat ON still holds', async () => {
      await expect(
        host.admin.restoreToPeer(staff, { vertical: PEER_CALLER, node: node(), reason: 'resolved' }),
      ).resolves.toMatchObject({ calls: 'on', changed: true, permissions: [] });
      await expect((await asPeer()).invoke('peer/list')).resolves.toEqual([]);
      await expect(
        host.admin.restoreToPeer(staff, { vertical: PEER_CALLER, node: node(), reason: 'again' }),
      ).resolves.toMatchObject({ calls: 'on', changed: false });
    });
  });
}

/**
 * `HostAdmin.resolveVerticalInstance` (#1706) — the directory's half, against both adapters: the
 * kernel's one rule (same tenant, primary, active, exactly one) over each adapter's own directory.
 */
export function verticalResolutionContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`vertical instance resolution (#1706): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const u = tenantId.parse(ulid());
    // A vertical slug no other suite binds a scope to, so the answer is this suite's alone.
    const slug = `acme/resolve-${t.slice(-6).toLowerCase()}`;
    const other = `acme/other-${t.slice(-6).toLowerCase()}`;

    const scope = async (tenant: typeof t, extra: Record<string, unknown> = {}, activate = true) => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical: slug, ...extra });
      if (activate) await host.admin.activateScope(staff, tenant, s);
      return s;
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      for (const tenant of [t, u]) {
        await host.admin.createTenant(staff, {
          id: tenant,
          slug: `resolve-${tenant.slice(-10).toLowerCase()}`,
          name: 'Resolve',
        });
      }
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('not installed: nothing of that vertical in the tenant', async () => {
      await expect(host.admin.resolveVerticalInstance(t, slug)).resolves.toEqual({
        outcome: 'not-installed',
        tenantId: t,
        vertical: slug,
      });
    });

    let primary: ScopeId;
    it('a preview, a fork and a still-provisioning scope are never the instance', async () => {
      await scope(t, { kind: 'preview' });
      const source = await scope(u); // a fork's source, in the OTHER tenant so it does not count here
      await scope(t, { forkedFrom: source, forkedAt: new Date().toISOString() });
      await scope(t, {}, false);
      expect((await host.admin.resolveVerticalInstance(t, slug)).outcome).toBe('not-installed');
    });

    it('twin: one primary, active scope resolves — and only in its own tenant', async () => {
      primary = await scope(t);
      await expect(host.admin.resolveVerticalInstance(t, slug)).resolves.toEqual({
        outcome: 'resolved',
        instance: { tenantId: t, scopeId: primary, vertical: slug },
      });
      // `u` holds the fork source — a primary, active instance of the same vertical — and `t`
      // never sees it, nor `u` the one in `t`.
      const inU = await host.admin.resolveVerticalInstance(u, slug);
      expect(inU.outcome).toBe('resolved');
      if (inU.outcome === 'resolved') expect(inU.instance.tenantId).toBe(u);
    });

    it('another vertical of the same tenant is a different question', async () => {
      expect((await host.admin.resolveVerticalInstance(t, other)).outcome).toBe('not-installed');
    });

    it('a suspended instance is not a callable one', async () => {
      await host.admin.suspendScope(staff, t, primary);
      expect((await host.admin.resolveVerticalInstance(t, slug)).outcome).toBe('not-installed');
      await host.admin.unsuspendScope(staff, t, primary);
      expect((await host.admin.resolveVerticalInstance(t, slug)).outcome).toBe('resolved');
    });

    let secondary: ScopeId;
    it('two live instances are ambiguous — refused, never guessed', async () => {
      secondary = await scope(t);
      await expect(host.admin.resolveVerticalInstance(t, slug)).resolves.toEqual({
        outcome: 'ambiguous',
        tenantId: t,
        vertical: slug,
        count: 2,
      });
    });

    it('a caller chooses one of two targets; stale and foreign choices never redirect', async () => {
      const caller = scopeId.parse(ulid());
      const secondCaller = scopeId.parse(ulid());
      for (const id of [caller, secondCaller]) {
        await host.provisionScope(staff, { tenantId: t, scopeId: id, vertical: other });
        await host.admin.activateScope(staff, t, id);
      }
      const read = () => host.admin.resolvePeerInstance(t, caller, slug);
      expect((await read()).outcome).toBe('ambiguous');
      await expect(host.admin.setPeerBinding(staff, t, caller, slug, primary)).resolves.toMatchObject({ changed: true });
      await expect(read()).resolves.toEqual({ outcome: 'resolved', instance: { tenantId: t, scopeId: primary, vertical: slug } });
      expect((await host.admin.resolvePeerInstance(t, secondCaller, slug)).outcome).toBe('ambiguous');
      await host.admin.suspendScope(staff, t, primary);
      expect((await read()).outcome).toBe('bound-unavailable');
      // A remaining singleton is never silently substituted for an explicit choice.
      expect(await host.admin.resolveVerticalInstance(t, slug)).toEqual({
        outcome: 'resolved', instance: { tenantId: t, scopeId: secondary, vertical: slug },
      });
      await host.admin.unsuspendScope(staff, t, primary);
      expect((await read()).outcome).toBe('resolved');
      await host.admin.archiveScope(staff, t, primary);
      expect((await read()).outcome).toBe('bound-unavailable');
      await host.admin.unarchiveScope(staff, t, primary);
      expect((await read()).outcome).toBe('bound-unavailable');
      await expect(host.admin.setPeerBinding(staff, t, caller, slug, primary)).resolves.toMatchObject({ changed: true });
      expect((await read()).outcome).toBe('resolved');
      const foreign = (await host.admin.resolveVerticalInstance(u, slug));
      if (foreign.outcome !== 'resolved') throw new Error('foreign fixture absent');
      await expect(host.admin.setPeerBinding(staff, t, caller, slug, foreign.instance.scopeId)).rejects.toThrow();
      expect((await read()).outcome).toBe('resolved');
      await host.admin.setPeerBinding(staff, t, caller, slug, null);
      expect((await read()).outcome).toBe('ambiguous');
    });
  });
}
