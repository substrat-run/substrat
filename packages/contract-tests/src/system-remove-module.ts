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
import { z } from 'zod';
import {
  defineEntities,
  defineOperations,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  operationInputsOf,
  permissionKey,
  purgeSchedulesOf,
} from '@substrat-run/contracts';
import { assertAllowed, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
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

/**
 * The second fixture (#3434 review): a target whose `removePermission` is a PURGE-ONLY key — one
 * the module's system principal holds only for its purge schedule (#119). Such a key is withheld
 * from every system check but the purge sweep's own invoke of the purge operation, so it must not
 * admit a system remove either: holding it is not a licence to delete any file on the target.
 *
 * - `rpbox` — trashable, purged after a week by `rp/purge` under `rp:shred`; files on it are
 *   read (and uploaded) with `rp:read` and removed with `rp:shred`.
 */
export const RETENTION_PURGE_MODULE_ID = '@test/retention-purge';

const rpEntities = defineEntities({
  rpbox: {
    table: 'rp_boxes',
    fields: z.object({ id: z.string() }),
    trash: { permission: 'rp:trash', purgeAfterDays: 7 },
  },
});

const RP_PERMISSIONS = ['rp:read', 'rp:trash', 'rp:shred'] as const;
const rpOk = z.object({ ok: z.boolean() });

const rpOperations = defineOperations(rpEntities, RP_PERMISSIONS)({
  'rp/purge': {
    summary: 'Delete a box for good — the purge horizon runs this',
    permission: { key: 'rp:shred', entity: 'rpbox', idFrom: 'boxId' },
    trashed: 'purges',
    input: z.strictObject({ boxId: z.string() }),
    output: rpOk,
  },
});

type RpHandler = OperationHandler<never, unknown>;
const RP = (key: (typeof RP_PERMISSIONS)[number]) => key as Parameters<Parameters<RpHandler>[0]['check']>[0];

export const retentionPurgeMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: RETENTION_PURGE_MODULE_ID,
    version: '1.0.0',
    kernelContract: '^0.0.1',
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    ...manifestOperations(rpOperations, {
      permissions: {
        'rp:read': 'read a box and its files',
        'rp:trash': 'bin a box',
        'rp:shred': 'delete a box, or a file on it, for good',
      },
      consumes: [],
    }),
    ...manifestEntities(rpEntities, {
      attachmentTargets: [{ entityType: 'rpbox', readPermission: 'rp:read', removePermission: 'rp:shred' }],
    }),
    schedules: purgeSchedulesOf(rpOperations, rpEntities),
    entitlementKey: 'retention-purge',
  }),
  migrations: [{ version: '0001-init', sql: 'CREATE TABLE rp_boxes (id TEXT PRIMARY KEY);' }],
  ...testOperations(
    {
      'rp/purge': (async (ctx, i: { boxId: string }) => {
        assertAllowed(await ctx.check(RP('rp:shred'), { entityType: 'rpbox', entityId: i.boxId }));
        ctx.sql.exec('DELETE FROM rp_boxes WHERE id = ?', [i.boxId]);
        return { ok: true };
      }) as RpHandler,
    },
    { inputs: operationInputsOf(rpOperations) },
  ),
};
