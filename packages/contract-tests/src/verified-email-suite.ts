/**
 * Contract suite for `ctx.verifiedEmail` (K-61): who may hand an operation an address.
 *
 * The rule is that leaving it out fails closed, so most of this suite is doors that must
 * answer null. A door here reads what the operation sees through a real scope, on both
 * adapters: the DO builds its context inside workerd, across an RPC the address has to
 * survive, and the SQLite host builds it in process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type ModuleId } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { addressMod } from './modules.js';

export function verifiedEmailContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`ctx.verifiedEmail (K-61): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const anna = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const address = 'Anna@Example.com';

    const seenThrough = async (stub: ScopeStub): Promise<string | null> =>
      (await stub.invoke<{ verifiedEmail: string | null }>('address/who')).verifiedEmail;

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(addressMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'address-tenant', name: 'Address Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'address');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'address-vertical' });
      await host.admin.activateScope(staff, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('hands the operation the address the door passed, in the issuer’s spelling', async () => {
      expect(await seenThrough(await host.getScope(anna, t1, s1, { verifiedEmail: address }))).toBe(address);
    });

    it.each([
      ['a door that says nothing', async () => host.getScope(anna, t1, s1)],
      ['a door that says null', async () => host.getScope(anna, t1, s1, { verifiedEmail: null })],
      ['the system door', async () => host.getSystemScope(addressMod.manifest.id as ModuleId, t1, s1)],
      [
        'acting as the person (K-42)',
        async () => {
          const session = await host.admin.beginImpersonation(staff, {
            tenantId: t1,
            scopeId: s1,
            principal: anna,
            reason: 'ticket #4182',
          });
          return host.getImpersonatedScope(session.id, t1, s1);
        },
      ],
    ])('answers null through %s', async (_door, open) => {
      expect(await seenThrough(await open())).toBeNull();
    });

    it('stays with the stub, so one person’s address does not reach another’s call', async () => {
      const hers = await host.getScope(anna, t1, s1, { verifiedEmail: address });
      const theirs = await host.getScope(principalId.parse(ulid()), t1, s1);
      expect(await seenThrough(theirs)).toBeNull();
      expect(await seenThrough(hers)).toBe(address);
    });

    it('is null in a consumer, which acts for nobody', async () => {
      const stub = await host.getScope(anna, t1, s1, { verifiedEmail: address });
      await stub.invoke('address/act');
      await expect.poll(() => stub.invoke<(string | null)[]>('address/consumer-saw')).toEqual([null]);
    });
  });
}
