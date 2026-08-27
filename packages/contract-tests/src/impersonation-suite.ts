import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  IMPERSONATION_MAX_TTL_SECONDS,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type Impersonation,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { permMod } from './modules.js';

const PERM_USE = permissionKey.parse('perm:use');
const PERM_READ = permissionKey.parse('perm:read');

const REASON = 'SUP-4711 customer cannot see their own items';

/**
 * Contract suite for impersonation (K-42, #868). Both adapters must:
 *
 * - resolve permissions as the IMPERSONATED principal, not the staff actor and not a
 *   union of the two — a session that sees more than the customer sees is not a support
 *   tool, it is the screenshot problem with extra steps;
 * - hand the handler both actors (`ctx.principal`, `ctx.impersonation`);
 * - stamp BOTH onto every event a write-enabled session emits;
 * - refuse every mutating verb in a read-only session, AND roll the invocation back
 *   anyway, so a handler that skips `ctx.emit` cannot slip a raw write past the refusal;
 * - kill an expired session on the invoke, not merely at the door;
 * - record `impersonate` in the admin log BEFORE the stub exists;
 * - refuse a request with no real reason, and one asking for a window past the ceiling.
 *
 * Runs against the DEFAULT tuple checker: the whole subject is WHOSE authority resolves,
 * and an allow-all checker cannot answer that question at all.
 */
export function impersonationContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`impersonation contract (K-42, #868): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    /** Holds `perm:use` + `perm:read` — the customer a support engineer acts as. */
    const anna: PrincipalId = principalId.parse(ulid());
    /** Holds `perm:read` only — the narrower principal, for the "whose authority" test. */
    const bo: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    /** A SECOND staff actor, so "who opened it" is a real answer rather than the only one. */
    const otherStaff = platformActorId.parse(ulid());

    const openAs = (
      who: PrincipalId,
      extra: { writes?: boolean; ttlSeconds?: number; actor?: typeof staff } = {},
    ) =>
      host.getImpersonatedScope(
        { actor: extra.actor ?? staff, principal: who, reason: REASON, ...extra },
        t,
        s,
      );

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(permMod);
      await host.admin.createTenant(staff, { id: t, slug: 'imp-tenant', name: 'Imp Tenant' });
      await host.admin.grantEntitlement(staff, t, 'perm');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t, s);

      await host.admin.defineRole(staff, t, {
        key: 'imp-admin',
        permissions: [PERM_USE, PERM_READ],
        source: 'vertical',
      });
      await host.admin.defineRole(staff, t, {
        key: 'imp-reader',
        permissions: [PERM_READ],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: anna,
        roleKey: 'imp-admin',
        node: { tenantId: t, scopeId: null },
      });
      await host.admin.assignRole(staff, {
        principalId: bo,
        roleKey: 'imp-reader',
        node: { tenantId: t, scopeId: null },
      });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('stamps the session kernel-side — the caller chooses neither the window nor readOnly', async () => {
      const scope = await openAs(anna, { ttlSeconds: 600 });
      const session = scope.impersonation;
      expect(session.actor).toBe(staff);
      expect(session.principal).toBe(anna);
      expect(session.reason).toBe(REASON);
      // Read-only unless asked otherwise — the default that makes "our support engineer
      // approved an invoice" unreachable rather than merely unlikely.
      expect(session.readOnly).toBe(true);
      const window = Date.parse(session.expiresAt) - Date.parse(session.startedAt);
      expect(window).toBe(600_000);
    });

    it('hands the handler BOTH actors', async () => {
      const scope = await openAs(anna);
      const seen = (await scope.invoke('perm/whoami')) as {
        principal: string;
        impersonation: Impersonation | null;
      };
      // `ctx.principal` is who the operation acts AS — so a handler needs to do nothing
      // differently to be impersonatable, which is the property the whole design rests on.
      expect(seen.principal).toBe(anna);
      expect(seen.impersonation?.actor).toBe(staff);
      expect(seen.impersonation?.principal).toBe(anna);
      expect(seen.impersonation?.reason).toBe(REASON);
    });

    it('leaves ctx.impersonation null on an ordinary session', async () => {
      const scope = await host.getScope(anna, t, s);
      const seen = (await scope.invoke('perm/whoami')) as { impersonation: Impersonation | null };
      // Null rather than absent-or-undefined: the ordinary case is a value a handler can
      // branch on, not a hole it has to guess about.
      expect(seen.impersonation).toBeNull();
    });

    it('resolves permissions as the IMPERSONATED principal, not the staff actor', async () => {
      // Bo holds `perm:read` and not `perm:use`. A session acting as Bo must be refused
      // `perm:use` — if the staff actor's authority leaked in (or if impersonation were a
      // bypass), this would pass and the session would show more than Bo can see.
      const asBo = await openAs(bo);
      expect(await asBo.invoke('perm/authorized-read', { permission: PERM_READ })).toBe(0);
      await expect(asBo.invoke('perm/authorized-read', { permission: PERM_USE })).rejects.toThrow(
        /permission denied/,
      );
      // …and acting as Anna, who does hold it, the SAME check passes. Same staff actor,
      // same operation, different answer — which is only possible if the impersonated
      // principal is what resolves.
      const asAnna = await openAs(anna);
      expect(await asAnna.invoke('perm/authorized-read', { permission: PERM_USE })).toBe(0);
    });

    it('records `impersonate` in the admin log before handing over the stub', async () => {
      const before = await host.admin.auditLog(staff, { tenantId: t });
      const scope = await openAs(anna, { actor: otherStaff, ttlSeconds: 900 });
      const after = await host.admin.auditLog(staff, { tenantId: t });
      const added = after.filter((e) => !before.some((b) => b.id === e.id));
      const entry = added.find((e) => e.action === 'impersonate');
      expect(entry).toBeDefined();
      expect(entry!.actor).toBe(otherStaff);
      expect(entry!.scopeId).toBe(s);
      // The `after` carries the stamped session verbatim — who acted as whom, why, until
      // when, and whether writes were on. An entry that recorded only "somebody
      // impersonated somebody" would not survive the audit this feature exists for.
      expect(entry!.after).toMatchObject({
        actor: otherStaff,
        principal: anna,
        reason: REASON,
        readOnly: true,
        expiresAt: scope.impersonation.expiresAt,
      });
    });

    // -- read-only, which is the default -------------------------------------

    it('refuses ctx.emit in a read-only session', async () => {
      const scope = await openAs(anna);
      // The operation is innocent — the same handler is correct for a real principal.
      // What is refused is the mutation, and it is refused loudly rather than silently
      // discarded, because "your fix landed" when nothing landed is the worse failure.
      await expect(
        scope.invoke('perm/authorized-emit', { permission: PERM_USE }),
      ).rejects.toThrow(/read-only session/);
    });

    it('refuses ctx.grant in a read-only session', async () => {
      const scope = await openAs(anna);
      await expect(
        scope.invoke('perm/share', {
          principal: bo,
          permission: PERM_READ,
          entity: { entityType: 'item', entityId: 'i-imp' },
        }),
      ).rejects.toThrow(/read-only session/);
    });

    it('rolls back a raw ctx.sql write a read-only session made — the backstop', async () => {
      // `perm/raw-write` breaks D-5 deliberately: it writes and emits nothing, so the
      // refusals above never fire. This is the ONLY thing standing between a
      // non-conforming handler and a customer's table, so it is tested for what it is.
      const scope = await openAs(anna);
      const before = (await scope.invoke('perm/count-items')) as number;
      // The invocation itself SUCCEEDS — the handler ran and returned. What did not
      // happen is the commit.
      expect(await scope.invoke('perm/raw-write', { id: `raw-${ulid()}` })).toEqual({
        wrote: expect.any(String),
      });
      const ordinary = await host.getScope(anna, t, s);
      expect(await ordinary.invoke('perm/count-items')).toBe(before);
    });

    it('lets an ordinary read through untouched', async () => {
      const scope = await openAs(anna);
      // The point of the whole feature: seeing what the customer sees, with no ceremony.
      expect(await scope.invoke('perm/count-items')).toBe(0);
    });

    // -- write-enabled, which is opt-in --------------------------------------

    it('stamps BOTH actors onto an event a write-enabled session emits', async () => {
      const scope = await openAs(anna, { writes: true });
      expect(scope.impersonation.readOnly).toBe(false);
      await scope.invoke('perm/authorized-emit', { permission: PERM_USE });

      const rows = (await scope.invoke('perm/read-impersonation')) as {
        type: string;
        actor: string;
        impersonation: string | null;
      }[];
      const acted = rows.filter((r) => r.type === 'perm.acted');
      expect(acted).toHaveLength(1);
      // `actor` stays the impersonated principal — it is who the operation acted AS…
      expect(JSON.parse(acted[0]!.actor)).toBe(anna);
      // …and the second actor is the staff member who was really at the keyboard. A
      // session swap would have recorded only the first, which is the audit failure.
      const stamped = JSON.parse(acted[0]!.impersonation!) as Impersonation;
      expect(stamped.actor).toBe(staff);
      expect(stamped.principal).toBe(anna);
      expect(stamped.reason).toBe(REASON);
      expect(stamped.readOnly).toBe(false);
    });

    it('leaves the impersonation column null for an ordinary write', async () => {
      const ordinary = await host.getScope(anna, t, s);
      await ordinary.invoke('perm/authorized-emit', { permission: PERM_USE });
      const rows = (await ordinary.invoke('perm/read-impersonation')) as {
        type: string;
        impersonation: string | null;
      }[];
      const acted = rows.filter((r) => r.type === 'perm.acted');
      // Two events now: the write-enabled session's, and this one. Only one is stamped —
      // null here is the ordinary case, not an unrecorded gap.
      expect(acted.filter((r) => r.impersonation === null)).toHaveLength(1);
      expect(acted.filter((r) => r.impersonation !== null)).toHaveLength(1);
    });

    // -- the window ----------------------------------------------------------

    it('kills an expired session on the INVOKE, not merely at the door', async () => {
      // One second, then outlive it. A stub is an ordinary object a console can hold, so
      // a check at mint time would bound nothing — this is the check that does.
      const scope = await openAs(anna, { ttlSeconds: 1 });
      expect(await scope.invoke('perm/count-items')).toBe(0);
      await new Promise((r) => setTimeout(r, 1100));
      await expect(scope.invoke('perm/count-items')).rejects.toThrow(/expired/);
    });

    // -- what the door refuses -----------------------------------------------

    it('refuses a request with no real reason', async () => {
      await expect(
        host.getImpersonatedScope({ actor: staff, principal: anna, reason: 'why' }, t, s),
      ).rejects.toThrow();
    });

    it('refuses a window past the ceiling', async () => {
      await expect(
        openAs(anna, { ttlSeconds: IMPERSONATION_MAX_TTL_SECONDS + 1 }),
      ).rejects.toThrow();
    });

    it('refuses a scope in another tenant, exactly as getScope does', async () => {
      const elsewhere = scopeId.parse(ulid());
      await expect(
        host.getImpersonatedScope({ actor: staff, principal: anna, reason: REASON }, t, elsewhere),
      ).rejects.toThrow();
    });
  });
}
