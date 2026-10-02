import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { composedEngineMod, composerMod } from './modules.js';

const ENGINE = moduleId.parse('@test/composed-engine');
const COMPOSER = moduleId.parse('@test/composer');

/**
 * Contract suite for #1654: a COMPOSED engine's own declared schedule, on a tenant that
 * holds the composing vertical's SKU and not the engine's.
 *
 * The §4.3 rule is "a module loads for a tenant only if the tenant holds its SKU flag".
 * Its one exception is a module's own declared schedule fired through the system door,
 * where the `system:<moduleId>` grant is the switch (#383) — the kernel's
 * `requiredEntitlementFor`. Both adapters must agree on the exception AND on everything
 * around it, so this suite pins the four edges together:
 *
 *   1. the engine's schedule fires without the engine's SKU;
 *   2. a PRINCIPAL invoking the same operation is still refused — even holding the
 *      permission — so the invoke surface does not widen;
 *   3. the engine's system door is refused for an operation it does NOT declare as a
 *      schedule, though its system principal would pass that operation's `ctx.check`;
 *   4. another module's system door is refused for the engine's scheduled operation.
 *
 * `runDueSchedules` is called directly, never a sweep, so registering these modules
 * changes no other suite's fired/skipped counts.
 */
export function scheduleEntitlementContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`composed-engine schedule entitlement (#1654): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    // Holds the engine's permission through a role, so a refusal of this principal can
    // only be the SKU gate — a permission refusal would prove nothing about the surface.
    const user: PrincipalId = principalId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(composedEngineMod);
      host.registerModule(composerMod);
      await host.admin.createTenant(staff, { id: t, slug: 'composer-co', name: 'Composer Co' });
      // A standard install: the vertical's key only. Never the engine's.
      await host.admin.grantEntitlement(staff, t, 'composer');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'composer-vertical' });
      await host.admin.activateScope(staff, t, s);
      await host.admin.defineRole(staff, t, {
        key: 'sweeper',
        permissions: [permissionKey.parse('composed-engine:sweep')],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: user,
        roleKey: 'sweeper',
        node: { tenantId: t, scopeId: null },
      });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    const sweeps = async () => (await host.getScope(user, t, s)).invoke<number>('composer/sweeps');

    it("fires the engine's own schedule on a tenant holding only the vertical's key", async () => {
      const report = await host.runDueSchedules(ENGINE, t, s);
      expect(report.errors).toEqual([]);
      expect(report.fired).toBe(1);
      expect(report.failed).toBe(0);
      expect(await sweeps()).toBe(1);
    });

    it("still refuses the engine's operation to a principal — the invoke surface does not widen", async () => {
      const stub = await host.getScope(user, t, s);
      const err = await stub.invoke('composed-engine/sweep').then(
        () => null,
        (e: Error) => e.message,
      );
      expect(err).toMatch(/operation not entitled: composed-engine\/sweep/);
      expect(err).toMatch(/does not hold 'composed-engine'/);
      expect(await sweeps()).toBe(1);
    });

    it('still gates an operation the engine does not declare as a schedule, through its own system door', async () => {
      // The system principal holds `composed-engine:sweep`, which is all `manual` checks:
      // only the SKU gate stands between this call and a write.
      const sys = await host.getSystemScope(ENGINE, t, s);
      await expect(sys.invoke('composed-engine/manual')).rejects.toThrow(
        /operation not entitled: composed-engine\/manual/,
      );
      expect(await sweeps()).toBe(1);
    });

    it("never lends the exception to another module's system door", async () => {
      const sys = await host.getSystemScope(COMPOSER, t, s);
      await expect(sys.invoke('composed-engine/sweep')).rejects.toThrow(
        /operation not entitled: composed-engine\/sweep/,
      );
      expect(await sweeps()).toBe(1);
    });

    it("opens the principal's door once the tenant holds the engine's own key — the refusal above was the SKU", async () => {
      await host.admin.grantEntitlement(staff, t, 'composed-engine');
      const stub = await host.getScope(user, t, s);
      await stub.invoke('composed-engine/sweep');
      expect(await sweeps()).toBe(2);
      await host.admin.revokeEntitlement(staff, t, 'composed-engine');
      await expect(stub.invoke('composed-engine/sweep')).rejects.toThrow(/not entitled/);
    });
  });
}
