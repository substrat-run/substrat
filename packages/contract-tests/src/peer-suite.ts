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
  type PrincipalId,
  type ScopeId,
  type VerticalCaller,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
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

export function peerContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`peer door (#1706): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
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

    it('two live instances are ambiguous — refused, never guessed', async () => {
      await scope(t);
      await expect(host.admin.resolveVerticalInstance(t, slug)).resolves.toEqual({
        outcome: 'ambiguous',
        tenantId: t,
        vertical: slug,
        count: 2,
      });
    });
  });
}
