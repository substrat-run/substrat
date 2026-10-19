/**
 * The module set the workerd suite's Durable Object closes over — a DO cannot receive
 * handler closures over RPC, so it is code-time, imported by both `worker.ts` and the suite.
 *
 * The engine, and a stand-in vertical composing it by call: an operation that emits
 * `workorder.assigned`, and the vertical's own consumer of that event, which calls `notify`.
 */
import { moduleManifest, permissionKey, type DomainEventInput } from '@substrat-run/contracts';
import { assertAllowed, undeclaredOperations, type ModuleRegistration } from '@substrat-run/kernel';
import { z } from 'zod';
import { notificationsModule, notify } from '../../src/index.js';

export const PROBE_EMIT = permissionKey.parse('probe:emit');

const assigned = z.object({ orderId: z.string(), technician: z.string() });

export const vertical: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: 'notifications-workerd-vertical',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: PROBE_EMIT, description: 'Emit an event (test probe)' }],
    events: {
      emits: [{ type: 'workorder.assigned', schemaVersion: 1 }],
      consumes: [{ type: 'workorder.assigned', schemaVersion: 1 }],
    },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'probe',
  }),
  consumers: {
    'workorder.assigned': async (ctx, event) => {
      const p = assigned.parse(event.payload);
      notify(ctx, {
        topic: 'order-assigned',
        description: 'A work order was assigned to you',
        dedupeKey: event.id,
        recipients: [p.technician],
        vars: { orderId: p.orderId },
        about: event.entity,
        template: { subject: 'Assigned: {{orderId}}', text: 'You have work order {{orderId}}.' },
      });
    },
  },
  ...undeclaredOperations('a test probe standing in for the vertical operation that emits', {
    'probe/emit': async (ctx, input) => {
      assertAllowed(await ctx.check(PROBE_EMIT));
      ctx.emit(input as DomainEventInput);
      return { emitted: true };
    },
    // Test-only time travel: the Durable-Object host takes no clock, so a held message is made
    // a day old by moving its stamp, which is the one thing a digest's due-ness reads.
    'probe/age-held': async (ctx) => {
      assertAllowed(await ctx.check(PROBE_EMIT));
      ctx.sql.exec(`UPDATE notifications_digest_items SET queued_at = '2000-01-01T00:00:00.000Z'`);
      return { aged: true };
    },
    // Test-only drift: the newest held row stops reading, as a version skew would leave it.
    'probe/poison-newest-held': async (ctx) => {
      assertAllowed(await ctx.check(PROBE_EMIT));
      ctx.sql.exec(
        `UPDATE notifications_digest_items SET subject = X'00'
          WHERE rowid = (SELECT MAX(rowid) FROM notifications_digest_items)`,
      );
      return { poisoned: true };
    },
  }),
};

export const MODULES = [notificationsModule, vertical];
