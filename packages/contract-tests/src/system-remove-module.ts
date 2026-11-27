/**
 * The fixture behind `systemAttachmentRemoveContractSuite` (#3434): a retention case. A
 * signed agreement hangs off an order, uploaded by a person holding `ret:write`, and deleted
 * after its retention period by the module's own system principal holding `ret:purge` — the
 * target's `removePermission`, which admits a remove and nothing else.
 *
 * - `ragreement` — read with `ret:read`, uploaded and removed with `ret:write`, and also removed
 *   with `ret:purge`.
 * - `rnote` — declares no `removePermission`, so a remove is the write key's alone.
 *
 * Inert for every other suite: only the remove suite grants its entitlement, and nothing else
 * reads its rows.
 */
import { moduleManifest, permissionKey } from '@substrat-run/contracts';
import type { ModuleRegistration, OperationHandler } from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

export const RET_READ = permissionKey.parse('ret:read');
export const RET_WRITE = permissionKey.parse('ret:write');
export const RET_PURGE = permissionKey.parse('ret:purge');

export const retentionModManifest = moduleManifest.parse({
  id: '@test/retention',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'ret:read', description: 'read an order and its files' },
    { key: 'ret:write', description: 'attach a file to an order, or remove one' },
    { key: 'ret:purge', description: 'remove a file whose retention period has ended' },
  ],
  events: {
    emits: [
      { type: 'attachment.added', schemaVersion: 1 },
      { type: 'attachment.removed', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [
    { entityType: 'ragreement', readPermission: 'ret:read', writePermission: 'ret:write', removePermission: 'ret:purge' },
    { entityType: 'rnote', readPermission: 'ret:read', writePermission: 'ret:write' },
  ],
  entitlementKey: 'retention',
});

export const retentionMod: ModuleRegistration = {
  manifest: retentionModManifest,
  migrations: [],
  ...testOperations({
    // Every `attachment.removed` this scope holds, with the actor it was written as.
    'ret/removed': ((ctx) =>
      ctx.sql.query(
        `SELECT actor, operation, entity_type, entity_id, payload FROM _substrat_outbox
          WHERE type = 'attachment.removed' ORDER BY id`,
      )) as OperationHandler<never, unknown>,
    'ret/denials': ((ctx) =>
      ctx.sql.query(`SELECT actor, permission, operation FROM _substrat_denials ORDER BY id`)) as OperationHandler<
      never,
      unknown
    >,
  }),
};
