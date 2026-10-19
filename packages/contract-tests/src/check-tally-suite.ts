/**
 * Contract suite for the per-invocation check tally (#2387): an operation that declares a
 * `permission` and returns without calling `ctx.check` is recorded, on both adapters, and refused
 * where a test run asks for it.
 *
 * The record is a `warn` line through the context's own `ctx.log`, so the suite reads the lines
 * the host wrote for one invocation id. Every operation in the fixture completes whatever the
 * caller holds, so each case is about whether the operation ASKED, never about the answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  REFUSE_UNCHECKED_OPERATIONS_KEY,
  UNCHECKED_OPERATION_FINDING,
  UNCHECKED_OPERATION_TEMPLATE,
  ulid,
  type ModuleLogLine,
  type ScopeHost,
  type ScopeStub,
} from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { checkTallyMod, undeclaredTallyMod } from './check-tally-module.js';

const FLAG = Symbol.for(REFUSE_UNCHECKED_OPERATIONS_KEY);
type Flagged = Record<symbol, unknown>;

/** Run `fn` with the refusal flag set to `on`, and put back whatever a preload had set. */
async function withRefusal<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Flagged;
  const before = g[FLAG];
  g[FLAG] = on;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete g[FLAG];
    else g[FLAG] = before;
  }
}

export function checkTallyContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture & { logs: () => ModuleLogLine[] }>,
): void {
  describe(`check tally (#2387): ${adapterName}`, () => {
    let fixture: ScopeHostFixture & { logs: () => ModuleLogLine[] };
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    /** The unchecked-operation lines the host wrote for one invocation. */
    const recorded = (invocationId: string) =>
      fixture
        .logs()
        .filter((l) => l.invocationId === invocationId && l.template === UNCHECKED_OPERATION_TEMPLATE);

    /** Invoke with a fresh invocation id, with the refusal flag off, and return what was recorded. */
    const run = (operation: string, input?: unknown) =>
      withRefusal(false, async () => {
        const invocationId = ulid();
        const result = await stub.invoke(operation, input, { invocationId });
        return { result, lines: recorded(invocationId) };
      });

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(checkTallyMod);
      host.registerModule(undeclaredTallyMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'tally-tenant', name: 'Tally Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'check-tally');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'tally-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      // Alice holds nothing: every check below is refused, and still counts.
      stub = await host.getScope(alice, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('an operation that checks is not recorded — whatever the answer', async () => {
      const { result, lines } = await run('tally/checks');
      expect(result).toEqual({ allowed: false });
      expect(lines).toEqual([]);
    });

    it('an operation that declares a permission and never checks is recorded, with the host’s stamp', async () => {
      const { result, lines } = await run('tally/silent');
      expect(result).toEqual({ written: 1 });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        substrat: 'log',
        level: 'warn',
        message: UNCHECKED_OPERATION_TEMPLATE,
        tenantId: t1,
        scopeId: s1,
        operation: 'tally/silent',
        principalKind: 'principal',
      });
      expect(lines[0]!.fields).toEqual({ finding: UNCHECKED_OPERATION_FINDING });
    });

    it('recording changes nothing: the unchecked write commits', async () => {
      const before = ((await run('tally/count')).result as { written: number }).written;
      await run('tally/silent');
      const after = ((await run('tally/count')).result as { written: number }).written;
      expect(after).toBe(before + 1);
    });

    it('a check made inside a helper counts', async () => {
      expect((await run('tally/via-helper')).lines).toEqual([]);
    });

    it('a refused check the handler caught counts', async () => {
      expect((await run('tally/caught')).lines).toEqual([]);
    });

    it('a check that threw counts', async () => {
      expect((await run('tally/malformed')).lines).toEqual([]);
    });

    it('a check inside ctx.atomic counts', async () => {
      expect((await run('tally/in-atomic')).lines).toEqual([]);
    });

    it('a guard that asks is not the handler asking: the handler behind it is still recorded', async () => {
      const { result, lines } = await run('tally/guarded-silent');
      expect(result).toEqual({ ok: true });
      expect(lines.map((l) => l.operation)).toEqual(['tally/guarded-silent']);
    });

    it('under a run that refuses, a guard that asked does not let the handler behind it through', async () => {
      await withRefusal(true, () =>
        expect(() => stub.invoke('tally/guarded-silent')).rejects.toThrow(/tally\/guarded-silent declares a permission/),
      );
    });

    it('an operation that declares it checks nothing (`narrows.unchecked`) is not recorded', async () => {
      expect((await run('tally/declared-none')).lines).toEqual([]);
    });

    it('a per-row walk over nothing is not recorded', async () => {
      expect((await run('tally/empty-walk')).lines).toEqual([]);
    });

    it('a module that declares no operations promised no key, and is not recorded', async () => {
      expect((await run('tally-undeclared/silent')).lines).toEqual([]);
    });

    it('an operation that fails is not recorded — it did not complete', async () => {
      const invocationId = ulid();
      await withRefusal(false, () =>
        expect(() => stub.invoke('tally/throws', undefined, { invocationId })).rejects.toThrow(/refused before asking/),
      );
      expect(recorded(invocationId)).toEqual([]);
    });

    it('counts per invocation, not per request: a check in one call does not cover the next', async () => {
      const invocationId = ulid();
      await withRefusal(false, async () => {
        await stub.invoke('tally/checks', undefined, { invocationId });
        await stub.invoke('tally/silent', undefined, { invocationId });
        await stub.invoke('tally/checks', undefined, { invocationId });
      });
      expect(recorded(invocationId).map((l) => l.operation)).toEqual(['tally/silent']);
    });

    it('under a run that refuses, the unchecked operation fails and its write rolls back', async () => {
      const before = ((await run('tally/count')).result as { written: number }).written;
      const invocationId = ulid();
      await withRefusal(true, () =>
        expect(() => stub.invoke('tally/silent', undefined, { invocationId })).rejects.toThrow(
          /tally\/silent declares a permission but its handler returned without calling ctx\.check/,
        ),
      );
      // Recorded before it was refused, so the line says why the call failed.
      expect(recorded(invocationId)).toHaveLength(1);
      const after = ((await run('tally/count')).result as { written: number }).written;
      expect(after).toBe(before);
    });

    it('under a run that refuses, everything that asked — or was never held — still completes', async () => {
      await withRefusal(true, async () => {
        for (const op of ['tally/checks', 'tally/via-helper', 'tally/caught', 'tally/malformed', 'tally/in-atomic',
          'tally/declared-none', 'tally/empty-walk', 'tally-undeclared/silent']) {
          expect(await stub.invoke(op)).toBeDefined();
        }
      });
    });
  });
}
