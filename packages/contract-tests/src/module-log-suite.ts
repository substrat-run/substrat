/**
 * Contract suite for `ctx.log` (#1746, #1747): what the HOST stamps on a module's log line.
 *
 * The line's worth is that a reader can trust its fields without trusting the module: the
 * tenant and scope it is filed under, the operation, the invocation it joins to, and who
 * the code ran as. So every case here drives a real scope and reads the line the host
 * wrote, on both adapters — the DO builds its context inside workerd, the SQLite host in
 * process, and either could stamp the wrong invocation or let a field through.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ModuleLogLine, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { loggedMod } from './modules.js';

export function moduleLogContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture & { logs: () => ModuleLogLine[] }>,
): void {
  describe(`ctx.log (#1746, #1747): ${adapterName}`, () => {
    let fixture: ScopeHostFixture & { logs: () => ModuleLogLine[] };
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    /** This suite's lines for one call, in the order they were written. */
    const linesFor = (invocationId: string) => fixture.logs().filter((l) => l.invocationId === invocationId);

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(loggedMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'logged-tenant', name: 'Logged Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'logged');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'logged-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      stub = await host.getScope(alice, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('stamps tenant, scope, operation, invocation and who — and keeps the template', async () => {
      const invocationId = ulid();
      const ticketId = `t-${ulid()}`;
      await stub.invoke('logged/act', { ticketId }, { invocationId });
      const [line] = linesFor(invocationId).filter((l) => l.operation === 'logged/act');
      expect(line).toMatchObject({
        substrat: 'log',
        level: 'info',
        template: 'reply to {ticketId} sent',
        message: `reply to ${ticketId} sent`,
        tenantId: t1,
        scopeId: s1,
        operation: 'logged/act',
        invocationId,
        principalKind: 'principal',
      });
      // The caller's `tenantId` and `operation` stayed fields; the stamp is the host's.
      expect(line!.fields).toMatchObject({ ticketId, tenantId: 'forged', operation: 'forged' });
    });

    it("stamps a consumer's line with the same invocation, no operation, and `system`", async () => {
      const invocationId = ulid();
      await stub.invoke('logged/act', { ticketId: `t-${ulid()}` }, { invocationId });
      const consumer = linesFor(invocationId).find((l) => l.template === 'saw {type}');
      expect(consumer).toMatchObject({
        level: 'warn',
        message: 'saw logged.acted',
        operation: null,
        invocationId,
        principalKind: 'system',
        tenantId: t1,
        scopeId: s1,
      });
    });

    it('writes the line of an operation that then rolled back', async () => {
      const invocationId = ulid();
      await expect(stub.invoke('logged/fail', { ticketId: 'x' }, { invocationId })).rejects.toThrow();
      expect(linesFor(invocationId)).toEqual([
        expect.objectContaining({ level: 'error', template: 'could not reach {ticketId}', operation: 'logged/fail' }),
      ]);
    });
  });
}
