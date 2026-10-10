/**
 * Attachment refusals keep their code (#113).
 *
 * An attachment verb refused by its gate is a `PermissionDenied` where it is raised. On the
 * pure adapter it is thrown in-process and reaches the caller as itself. On Cloudflare it is
 * raised inside the ScopeDO, and a throw across that hop arrives as a bare `Error` carrying
 * only its sentence, so every reader above it had to guess the status from the words. The
 * verbs now answer a refusal as data (`…Reply`), and this suite holds both adapters to the
 * same answer: the code, the `permission` extension and the sentence, for every subject an
 * attachment surface is opened as (a principal, a connection, a module's system principal),
 * with the denial still recorded where it is refused. Each refusal has its allowed twin.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  toProblem,
  type AttachmentRecord,
  type EntityRef,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeAttachments, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { capMod } from './modules.js';

const CAP_READ = permissionKey.parse('cap:read');
const CAP_WRITE = permissionKey.parse('cap:write');

const doc = (id: string): EntityRef => ({ entityType: 'doc', entityId: id });
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

interface DenialRow {
  actor: string;
  permission: string;
  operation: string | null;
}

const refusal = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

/**
 * The refusal as a caller reads it: its code, its declared permission and its sentence —
 * `expectRefusal`'s check, plus the `permission` extension it does not read. A call that
 * resolved fails it the same way, since `errorCodeOf(undefined)` is never a code.
 */
const expectDenied = (err: unknown, permission: string): void => {
  expect(errorCodeOf(err)).toBe('permission_denied');
  expect(toProblem(err)).toMatchObject({
    code: 'permission_denied',
    permission,
    detail: `permission denied: ${permission}`,
  });
};

export function attachmentRefusalContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`attachment refusals keep their code (#113): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid()); // read + write
    const bob: PrincipalId = principalId.parse(ulid()); // read only
    const carol: PrincipalId = principalId.parse(ulid()); // nothing
    const staff = platformActorId.parse(ulid());
    let file: AttachmentRecord;

    const filesOf = (who: PrincipalId): Promise<ScopeAttachments> => host.attachments(who, t1, s1);
    const upload = (surface: ScopeAttachments, name: string) =>
      surface.upload({ entity: doc('d1'), filename: `${name}.txt`, contentType: 'text/plain', visibility: 'internal', body: bytes(name) });
    const denials = async (): Promise<DenialRow[]> =>
      (await host.getScope(alice, t1, s1)).invoke<DenialRow[]>('cap/denials');

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(capMod);
      await host.admin.createTenant(staff, { id: t1, slug: `att-ref-${t1.toLowerCase()}`, name: 'Attachment refusals' });
      await host.admin.grantEntitlement(staff, t1, 'cap');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'cap-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.provisionBlobStore(staff, { tenantId: t1, vertical: 'cap-vertical', binding: 'ATTACHMENTS' });
      await host.admin.defineRole(staff, t1, { key: 'editor', permissions: [CAP_READ, CAP_WRITE], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'reader', permissions: [CAP_READ], source: 'vertical' });
      const node = { tenantId: t1, scopeId: null };
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'editor', node });
      await host.admin.assignRole(staff, { principalId: bob, roleKey: 'reader', node });
      file = await upload(await filesOf(alice), 'd1');
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('a principal without the write key: upload and remove are permission_denied, and recorded', async () => {
      const files = await filesOf(bob);
      expectDenied(await refusal(upload(files, 'nope')), 'cap:write');
      expectDenied(await refusal(files.remove(file.id)), 'cap:write');
      const rows = (await denials()).filter((d) => d.actor.includes(bob));
      expect(rows).toContainEqual(expect.objectContaining({ permission: 'cap:write', operation: 'attachments.upload' }));
      expect(rows).toContainEqual(expect.objectContaining({ permission: 'cap:write', operation: 'attachments.remove' }));
      // The twin: the same key held, the same verbs succeed.
      const mine = await filesOf(alice);
      const extra = await upload(mine, 'extra');
      expect((await mine.remove(extra.id))?.id).toBe(extra.id);
    });

    it('a principal without the read key: list and open are permission_denied, and recorded', async () => {
      const files = await filesOf(carol);
      expectDenied(await refusal(files.list(doc('d1'))), 'cap:read');
      expectDenied(await refusal(files.open(file.id)), 'cap:read');
      const rows = (await denials()).filter((d) => d.actor.includes(carol));
      expect(rows).toContainEqual(expect.objectContaining({ permission: 'cap:read', operation: 'attachments.list' }));
      expect(rows).toContainEqual(expect.objectContaining({ permission: 'cap:read', operation: 'attachments.open' }));
      // The twin: a reader lists and opens the same file.
      const theirs = await filesOf(bob);
      expect((await theirs.list(doc('d1'))).map((r) => r.id)).toContain(file.id);
      expect((await theirs.open(file.id))?.record.id).toBe(file.id);
    });

    it('an unknown id is null, not a refusal', async () => {
      const files = await filesOf(carol);
      expect(await files.open(ulid())).toBeNull();
      expect(await files.remove(ulid())).toBeNull();
    });

    it('a connection never granted the write key: upload is permission_denied', async () => {
      const connId = ulid();
      await host.admin.createConnection(staff, {
        id: connId as never,
        tenantId: t1,
        vertical: 'cap-vertical',
        provider: 'signer',
        label: 'signer',
        secret: { accessToken: 'x' },
      });
      const files = await host.getConnectorAttachments(connId as never, s1);
      expectDenied(await refusal(upload(files, 'sealed')), 'cap:write');
      // The twin: granted the key, the same connection uploads as itself.
      await host.admin.grantToConnection(staff, {
        connectionId: connId,
        permission: CAP_WRITE,
        node: { tenantId: t1, scopeId: s1 },
        grantedBy: staff,
      });
      expect((await upload(files, 'sealed')).createdBy).toBe(connId);
    });

    it('a module’s system principal without the read grant: open is permission_denied', async () => {
      const moduleId = capMod.manifest.id;
      const system = await host.getSystemAttachments(moduleId, t1, s1);
      expectDenied(await refusal(system.open(file.id)), 'cap:read');
      // The twin: granted the read key, the same open answers the file.
      await host.admin.grantToSystem(staff, { moduleId, permission: CAP_READ, node: { tenantId: t1, scopeId: s1 }, grantedBy: staff });
      expect((await system.open(file.id))?.record.id).toBe(file.id);
    });
  });
}
