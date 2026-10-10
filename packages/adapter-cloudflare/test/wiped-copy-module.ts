/**
 * #113 (#1722): a module with an attachment target and NO migrations, for `WipedCopyScopeDO`.
 *
 * A wiped carried copy takes no writes. Where a module set has migrations, the first call
 * after the wipe fails closed re-applying them, before any write is attempted. With none to
 * apply, the call reaches its write, and `WriteRevision` refuses it as a `conflict`. That is
 * the refusal the attachment verbs and `invoke` must answer alike, and only a migration-free
 * module set reaches it — hence a class of its own (see test/worker.ts).
 */
import { moduleManifest, permissionKey } from '@substrat-run/contracts';
import { assertAllowed, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import { testOperations } from '@substrat-run/contract-tests';

export const WIPED_READ = permissionKey.parse('wiped:read');
export const WIPED_WRITE = permissionKey.parse('wiped:write');

export const wipedCopyMod: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/wiped-copy',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [
      { key: 'wiped:read', description: 'read a document' },
      { key: 'wiped:write', description: 'write a document' },
    ],
    events: { emits: [{ type: 'wiped.touched', schemaVersion: 1 }], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [{ entityType: 'doc', readPermission: 'wiped:read', writePermission: 'wiped:write' }],
    entitlementKey: 'wiped',
  }),
  migrations: [],
  ...testOperations({
    // A write through `invoke`: one emitted event, after the same write check an upload makes.
    'wiped/touch': (async (ctx, input) => {
      assertAllowed(await ctx.check(WIPED_WRITE));
      ctx.emit({
        type: 'wiped.touched',
        schemaVersion: 1,
        entity: { entityType: 'doc', entityId: (input as { docId: string }).docId },
        piiClass: 'none',
        payload: {},
      });
    }) as OperationHandler<never, unknown>,
  }),
};
