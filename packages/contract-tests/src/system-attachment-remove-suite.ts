/**
 * A module's system principal removes an attachment (#3434).
 *
 * A retention schedule that must delete a file after a fixed period had nothing to do it with:
 * the system surface was open-only, a person's surface records the removal as theirs, and
 * module code may not write `_substrat_attachments`. `getSystemAttachments(…).remove` is gated
 * as a person's remove is — the target's write key, or its `removePermission` — checked as
 * `system:<moduleId>`, and the `attachment.removed` it emits is attributed to the module.
 *
 * Both adapters run this suite, so the gate, the attribution, the kill switch and the denial
 * record cannot drift between self-host and production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  toProblem,
  type AttachmentRecord,
  type EntityRef,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid, type ScopeAttachments, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { RET_PURGE, RET_READ, RET_WRITE, retentionMod } from './system-remove-module.js';

const MODULE = retentionMod.manifest.id;
const VERTICAL = 'retention-vertical';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

interface RemovedRow {
  actor: string;
  entity_type: string;
  entity_id: string;
  payload: string;
}
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

const expectDenied = (err: unknown, permission: string): void => {
  expect(errorCodeOf(err)).toBe('permission_denied');
  expect(toProblem(err)).toMatchObject({ code: 'permission_denied', permission });
};

export function systemAttachmentRemoveContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`a module's system principal removes an attachment (#3434): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid()); // read + write: the uploader
    const dave: PrincipalId = principalId.parse(ulid()); // read + purge: removes, never uploads

    /** A scope of its own, so no case reads grants another left behind. */
    const freshScope = async (): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: VERTICAL });
      await host.admin.activateScope(staff, t, s);
      return s;
    };
    const filesOf = (who: PrincipalId, s: ScopeId): Promise<ScopeAttachments> => host.attachments(who, t, s);
    const upload = async (s: ScopeId, entity: EntityRef, name: string, who: PrincipalId = alice): Promise<AttachmentRecord> =>
      (await filesOf(who, s)).upload({ entity, filename: `${name}.pdf`, contentType: 'text/plain', visibility: 'internal', body: bytes(name) });
    const grantSystem = (s: ScopeId, permission: typeof RET_PURGE) =>
      host.admin.grantToSystem(staff, { moduleId: MODULE, permission, node: { tenantId: t, scopeId: s }, grantedBy: staff });
    const read = <T>(s: ScopeId, op: string): Promise<T> => host.getScope(alice, t, s).then((stub) => stub.invoke<T>(op));
    const agreement = (id: string): EntityRef => ({ entityType: 'ragreement', entityId: id });
    const note = (id: string): EntityRef => ({ entityType: 'rnote', entityId: id });

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(retentionMod);
      await host.admin.createTenant(staff, { id: t, slug: `ret-${t.toLowerCase()}`, name: 'Retention' });
      await host.admin.grantEntitlement(staff, t, 'retention');
      await host.provisionBlobStore(staff, { tenantId: t, vertical: VERTICAL, binding: 'ATTACHMENTS' });
      await host.admin.defineRole(staff, t, { key: 'broker', permissions: [RET_READ, RET_WRITE], source: 'vertical' });
      await host.admin.defineRole(staff, t, { key: 'archivist', permissions: [RET_READ, RET_PURGE], source: 'vertical' });
      const node = { tenantId: t, scopeId: null };
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'broker', node });
      await host.admin.assignRole(staff, { principalId: dave, roleKey: 'archivist', node });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('removes with the remove key, attributed to the module; refused and recorded without it', async () => {
      const s = await freshScope();
      const file = await upload(s, agreement('o1'), 'mandate');
      const system = await host.getSystemAttachments(MODULE, t, s);

      // No key: refused, naming the narrowest key that would have admitted it, and recorded.
      expectDenied(await refusal(system.remove(file.id)), 'ret:purge');
      expect(await read<DenialRow[]>(s, 'ret/denials')).toContainEqual(
        expect.objectContaining({ actor: JSON.stringify({ system: MODULE }), permission: 'ret:purge', operation: 'attachments.remove' }),
      );
      expect((await (await filesOf(alice, s)).open(file.id))?.record.id).toBe(file.id);

      // The remove key alone is enough: the module never holds the uploader's key.
      await grantSystem(s, RET_PURGE);
      expect((await system.remove(file.id))?.id).toBe(file.id);
      expect(await (await filesOf(alice, s)).open(file.id)).toBeNull();
      const removed = await read<RemovedRow[]>(s, 'ret/removed');
      expect(removed).toHaveLength(1);
      expect(JSON.parse(removed[0]!.actor)).toEqual({ system: MODULE });
      expect(JSON.parse(removed[0]!.payload)).toMatchObject({ attachment: { id: file.id, createdBy: alice } });
      // Gone is gone: a second remove of the same id is null, as an unknown id is.
      expect(await system.remove(file.id)).toBeNull();
    });

    it('a target with no removePermission is removed with its write key alone', async () => {
      const s = await freshScope();
      const file = await upload(s, note('n1'), 'memo');
      const system = await host.getSystemAttachments(MODULE, t, s);
      await grantSystem(s, RET_PURGE);
      expectDenied(await refusal(system.remove(file.id)), 'ret:write');
      await grantSystem(s, RET_WRITE);
      expect((await system.remove(file.id))?.id).toBe(file.id);
    });

    it('a person holding only the remove key removes a file but cannot upload one', async () => {
      const s = await freshScope();
      const file = await upload(s, agreement('o2'), 'mandate');
      expectDenied(await refusal(upload(s, agreement('o2'), 'forged', dave)), 'ret:write');
      expect((await (await filesOf(dave, s)).remove(file.id))?.id).toBe(file.id);
      // Recorded as theirs: they removed it.
      expect((await read<RemovedRow[]>(s, 'ret/removed'))[0]!.actor).toContain(dave);
    });

    it('the schedule kill switch refuses a system remove until it is restored', async () => {
      const s = await freshScope();
      const file = await upload(s, agreement('o3'), 'mandate');
      await grantSystem(s, RET_PURGE);
      const switchOf = { moduleId: MODULE, node: { tenantId: t, scopeId: s }, reason: 'legal hold' };
      await host.admin.revokeFromSystem(staff, switchOf);
      const system = await host.getSystemAttachments(MODULE, t, s);
      expect(errorCodeOf(await refusal(system.remove(file.id)))).toBe('permission_denied');
      expect((await (await filesOf(alice, s)).open(file.id))?.record.id).toBe(file.id);
      await host.admin.restoreToSystem(staff, switchOf);
      expect((await system.remove(file.id))?.id).toBe(file.id);
    });
  });
}
