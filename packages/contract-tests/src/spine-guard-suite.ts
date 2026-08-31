/**
 * Contract suite for the spine guard on `ctx.sql` (#954).
 *
 * What it pins is one sentence: **module code cannot write a `_substrat_*` table
 * through the connection the kernel hands it, and can still read one.**
 *
 * Before this existed the rule was a source scan — CLAUDE.md plus
 * `tools/boundary-lint.mjs` — and boundary-lint does not run on the hosted push
 * path, so a vertical that never passed through this repo's CI reached production
 * with `INSERT INTO _substrat_tuples …` (a forged grant) fully available to it.
 *
 * It belongs in the contract suites rather than in one adapter's tests because
 * the guard is only worth anything if BOTH module-facing connections carry it: a
 * vertical is developed against the pure host and deployed onto the DO, so a
 * refusal that exists in only one of them is a rule that changes meaning at
 * deploy time. The guard itself lives in the kernel (`guardSpine`); each adapter
 * proves it wrapped the connection module code actually holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { errorCodeOf, platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { testMod } from './modules.js';

interface TupleRow {
  subject: string;
  relation: string;
  object: string;
}

export function spineGuardContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`spine guard (ctx.sql): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(testMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'spine-tenant', name: 'Spine Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'testmod');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'spine-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      stub = await host.getScope(alice, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    // -- the refusals --------------------------------------------------------

    const refused: [string, string][] = [
      ['a forged tuple (INSERT)', 'testmod/forge-tuple'],
      ['a rewritten event (UPDATE)', 'testmod/forge-outbox'],
      ['a dropped migration journal (DROP)', 'testmod/forge-drop-journal'],
      ['a quoted identifier (DELETE FROM "_substrat_tuples")', 'testmod/forge-quoted'],
      ['a write dressed as a read (INSERT … RETURNING via ctx.sql.query)', 'testmod/forge-returning'],
    ];

    for (const [what, operation] of refused) {
      it(`refuses ${what}`, async () => {
        await expect(stub.invoke(operation)).rejects.toThrow(/cannot write the platform spine/);
      });
    }

    it('refuses as a `forbidden`, so a transport answers 403 rather than 500', async () => {
      const err = await stub.invoke('testmod/forge-tuple').then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(errorCodeOf(err)).toBe('forbidden');
    });

    it('left no forged tuple behind — the whole operation rolled back', async () => {
      const tuples = await stub.invoke<TupleRow[]>('testmod/read-tuples');
      expect(tuples.some((t) => t.subject === 'principal:forged')).toBe(false);
    });

    /**
     * The one that proves the refusal is a THROW and not a silent skip: the
     * operation writes a legitimate row before it forges, so a guard that merely
     * dropped the offending statement would leave the item committed.
     */
    it('takes the operation down with it — the legitimate row before the forge is gone', async () => {
      await expect(stub.invoke('testmod/forge-after-write', { id: 'forge-1' })).rejects.toThrow();
      const items = await stub.invoke<{ id: string }[]>('testmod/read-items');
      expect(items.map((i) => i.id)).not.toContain('forge-1');
    });

    // -- what stays open -----------------------------------------------------

    it('still reads the migration journal', async () => {
      const rows = await stub.invoke<{ module_id: string }[]>('testmod/read-journal');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('still reads the tuple store', async () => {
      await expect(stub.invoke<TupleRow[]>('testmod/read-tuples')).resolves.toBeInstanceOf(Array);
    });

    /**
     * The projection CLAUDE.md blesses — a spine READ feeding a domain write. Only
     * the write's TARGET is judged, so this must keep working; a guard that refused
     * it would be a rule against timelines rather than against forging.
     */
    it('still projects a spine table into a module table', async () => {
      await expect(stub.invoke('testmod/project-journal')).resolves.toBeUndefined();
      const notes = await stub.invoke<{ id: string; body: string }[]>('testmod/read-notes');
      expect(notes.length).toBeGreaterThan(0);
    });
  });
}
