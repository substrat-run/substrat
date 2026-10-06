/**
 * Contract suite for comments in a module's migration DDL (#2068, Codex #2084 r5): a commented
 * `CREATE TABLE`, then a later migration dropping its LAST column, must migrate on every adapter
 * — a failed migration closes the scope. And `--` / `/*` inside string literals are data: the
 * row and the column default carry them intact. The fixture is `commentedDdlMod`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { commentedDdlMod } from './migration-comments.js';

export function migrationCommentsContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`comments in migration DDL (#2068): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(commentedDdlMod);
      await host.admin.createTenant(staff, { id: t, slug: `cm-${t.toLowerCase()}`, name: 'Comments' });
      await host.admin.grantEntitlement(staff, t, 'commented-ddl');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'commented-ddl' });
      await host.admin.activateScope(staff, t, s);
    });
    afterAll(async () => {
      await fixture.cleanup();
    });

    it('drops the last column of a table whose DDL was commented, and keeps literals that look like comments', async () => {
      const stub = await host.getScope(principalId.parse(ulid()), t, s);
      const read = await stub.invoke<{ columns: string[]; noteDefault: string; rows: unknown[]; stored: string }>(
        'commented-ddl/read',
        undefined,
      );
      // 0002 ran: the last column is gone, and the scope is open.
      expect(read.columns).toEqual(['id', 'note']);
      // The twin: `--` and `/*` inside strings are data, in the row and in the default alike.
      expect(read.rows).toEqual([{ id: 'r1', note: 'keep -- this; and /* that */ too' }]);
      expect(read.noteDefault).toBe("'-- not a comment; /* nor this */'");
      // The stored DDL carries no comment text — what was executed was the blanked statement.
      expect(read.stored).not.toMatch(/one row per run|free text|came back/);
      expect(read.stored).toContain("'-- not a comment; /* nor this */'");
    });
  });
}
