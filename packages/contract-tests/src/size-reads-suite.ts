import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorCodeOf, platformActorId, scopeId as scopeIdSchema, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { scopeNotHeldRefusal, ulid } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * The vertical-side size reads (#1524, #2501), which take a scope id and nothing else, hold the
 * scope before they open its store (#2541): `/internal/database-size` and `/internal/attachment-size`
 * reach them. A scope this deployment does not hold (never provisioned here, or reaped) is refused
 * `conflict` with one sentence on both reads and both adapters, never answered as an empty store
 * reading zero. The admin twins (`scopeDatabaseSize`, `scopeAttachmentBytes`) resolve the scope
 * through the directory and are held by the shared host suite.
 */
export function sizeReadsContractSuite(
  adapterName: string,
  makeFixture: () => Promise<
    ScopeHostFixture & {
      databaseSizeLocal(scopeId: ScopeId): Promise<number>;
      attachmentSizeLocal(scopeId: ScopeId): Promise<number>;
      /**
       * Whether the scope's store holds nothing: no file on disk, or a Durable Object holding no row
       * of state. An adapter that must construct an object to ask is allowed an empty one.
       */
      storeHoldsNothing(tenantId: TenantId, scopeId: ScopeId): Promise<boolean>;
    }
  >,
): void {
  describe(`vertical-side size reads refuse a scope the deployment does not hold (#2541): ${adapterName}`, () => {
    let fixture: Awaited<ReturnType<typeof makeFixture>>;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      await fixture.host.admin.createTenant(staff, { id: t, slug: `size-reads-${t.slice(-8).toLowerCase()}`, name: 'Size reads' });
    });
    afterAll(async () => fixture?.cleanup());

    const newScope = async (): Promise<ScopeId> => {
      const s = scopeIdSchema.parse(ulid());
      await fixture.host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'size-reads' });
      await fixture.host.admin.activateScope(staff, t, s);
      return s;
    };
    const reap = async (s: ScopeId): Promise<void> => {
      await fixture.host.admin.archiveScope(staff, t, s);
      await fixture.host.admin.reapScope(staff, t, s, { force: true });
    };
    const refusal = (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: unknown) => ({ code: errorCodeOf(e), message: (e as Error).message }),
      );
    const refusedAs = (s: ScopeId) => ({ code: 'conflict', message: scopeNotHeldRefusal(s) });

    it('reads a held scope: a database with bytes, and attachments that sum to nothing yet', async () => {
      const s = await newScope();
      expect(await fixture.databaseSizeLocal(s)).toBeGreaterThan(0);
      expect(await fixture.attachmentSizeLocal(s)).toBe(0);
    });

    it('refuses a reaped scope on both reads, in the same words, and leaves nothing stored for it', async () => {
      const s = await newScope();
      await reap(s);
      const database = await refusal(fixture.databaseSizeLocal(s));
      expect(database).toEqual(refusedAs(s));
      expect(await refusal(fixture.attachmentSizeLocal(s))).toEqual(database);
      // Asked again, it is still refused: the first refusal did not make the scope held.
      expect(await refusal(fixture.databaseSizeLocal(s))).toEqual(database);
      expect(await fixture.storeHoldsNothing(t, s)).toBe(true);
    });

    it('refuses an id nothing provisioned here, on both reads', async () => {
      const s = scopeIdSchema.parse(ulid());
      expect(await refusal(fixture.databaseSizeLocal(s))).toEqual(refusedAs(s));
      expect(await refusal(fixture.attachmentSizeLocal(s))).toEqual(refusedAs(s));
      expect(await fixture.storeHoldsNothing(t, s)).toBe(true);
    });

    it('a scope listed as due and reaped before it is read is refused, while the held one beside it reads', async () => {
      const [gone, kept] = [await newScope(), await newScope()];
      // The sweep lists its due scopes first…
      const due = (await fixture.host.admin.listScopes(staff, { tenantId: t, status: 'active' })).map((x) => x.id);
      expect(due).toEqual(expect.arrayContaining([gone, kept]));
      // …a reap lands between the listing and the read…
      await reap(gone);
      // …and the read of each listed scope meets the world as it is now.
      const read = async (s: ScopeId) => refusal(fixture.databaseSizeLocal(s).then(() => fixture.attachmentSizeLocal(s)));
      expect(await read(gone)).toEqual(refusedAs(gone));
      expect(await read(kept)).toBeUndefined();
      expect(await fixture.storeHoldsNothing(t, gone)).toBe(true);
    });
  });
}
