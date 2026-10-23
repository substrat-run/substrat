import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId as scopeIdSchema,
  tenantId,
  type EntityRef,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { connectorTestFetch } from './connector-fixture.js';
import { permMod } from './modules.js';

const PERM_READ = permissionKey.parse('perm:read');
const PERM_USE = permissionKey.parse('perm:use');
const item = (id: string): EntityRef => ({ entityType: 'item', entityId: id });
const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(97);

/**
 * A scope's attachment bytes (#2501), held to their producer: files go in through the attachment
 * surface a vertical's users upload through, and the bytes come back as the co-located read
 * (`HostAdmin.scopeAttachmentBytes`) and as the storage gauge's `attachments` on `/meters`. What is
 * counted is what the scope's attachment rows record: a removed file stops counting.
 */
export function attachmentBytesContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`attachment bytes beside the storage gauge (#2501): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const editor: PrincipalId = principalId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(permMod);
      await host.admin.createTenant(staff, { id: t, slug: `att-bytes-${t.toLowerCase()}`, name: 'Attachment bytes' });
      await host.admin.grantEntitlement(staff, t, 'perm');
      await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });
      await host.admin.defineRole(staff, t, { key: 'editor', permissions: [PERM_READ, PERM_USE], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: t, scopeId: null } });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    const newScope = async (): Promise<ScopeId> => {
      const s = scopeIdSchema.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
      await host.admin.activateScope(staff, t, s);
      return s;
    };
    const upload = async (s: ScopeId, size: number) =>
      (await host.attachments(editor, t, s)).upload({
        entity: item('i'),
        filename: `f-${size}.txt`,
        contentType: 'text/plain',
        visibility: 'internal',
        body: bytes(size),
      });

    it('reads what the uploaded files sum to, and a removed file stops counting', async () => {
      const s = await newScope();
      expect(await host.admin.scopeAttachmentBytes!(staff, t, s)).toBe(0);
      const kept = await upload(s, 5);
      const removed = await upload(s, 11);
      expect([kept.size, removed.size]).toEqual([5, 11]);
      expect(await host.admin.scopeAttachmentBytes!(staff, t, s)).toBe(16);
      await (await host.attachments(editor, t, s)).remove(removed.id);
      expect(await host.admin.scopeAttachmentBytes!(staff, t, s)).toBe(5);
      // K-24: the read wakes a scope, so it is attributable like the database size.
      const reads = await host.admin.accessLog(staff, { method: 'scopeAttachmentBytes' });
      expect(reads.some((r) => r.scopeId === s && r.tenantId === t)).toBe(true);
      // A scope the directory does not hold under the tenant is refused, not read as 0.
      await expect(host.admin.scopeAttachmentBytes!(staff, t, scopeIdSchema.parse(ulid()))).rejects.toThrow();
    });

    it('the storage phase samples them beside the database, and /meters serves them apart from its bytes', async () => {
      const [s1, s2] = [await newScope(), await newScope()];
      await upload(s1, 7);
      await upload(s1, 3);
      await upload(s2, 4);
      const report = await runPlatformSweep(host, {
        actor: staff,
        fetch: connectorTestFetch,
        sweepers: {},
        storageGauge: {
          read: (scope) => host.admin.scopeDatabaseSize(staff, scope.tenantId, scope.id),
          readAttachments: (scope) => host.admin.scopeAttachmentBytes!(staff, scope.tenantId, scope.id),
          batch: 10_000,
        },
      });
      expect(report.errors.filter((e) => e.kind === 'storage')).toEqual([]);
      const storage = (await host.admin.readMeters(staff, { tenantId: t })).perTenant[0]!.storage!;
      // Every scope of the tenant was sampled: these two, and any an earlier case left.
      const scopes = await host.admin.listScopes(staff, { tenantId: t, status: 'active' });
      let expected = 0;
      for (const scope of scopes) expected += await host.admin.scopeAttachmentBytes!(staff, t, scope.id);
      expect(expected).toBeGreaterThanOrEqual(14);
      expect(storage.attachments).toEqual({ bytes: expected, sampled: scopes.length });
      // `bytes` stays the scope databases, and says attachments are not in it.
      expect(storage.basis).toBe('scope-databases');
      expect(storage.excluded).toContain('attachments');
      expect(storage.bytes).toBeGreaterThan(0);
    });
  });
}
