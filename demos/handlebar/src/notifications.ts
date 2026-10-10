import { notify } from '@substrat-run/engine-notifications';
import type { ConsumerHandler } from '@substrat-run/kernel';
import { z } from 'zod';

/**
 * What Handlebar tells people, and when — engine-notifications composed by call.
 *
 * A mechanic hears when a repair is assigned to them. The workorder engine emits
 * `workorder.assigned` from `workorder/assign`; this is Handlebar's own consumer of it, which
 * reads the payload with its own schema (never the workorder engine's types) and calls
 * `notify` in the same transaction. The template is the workshop's vocabulary, so it lives here.
 *
 * The event names the order and the technician and nothing more, so the mail can say which
 * repair but not its title: a fatter mail wants a fatter event, which is the workorder engine's
 * additive change to make, not a cross-module read here.
 */
const assignedPayload = z.object({ orderId: z.string(), technician: z.string() });

export const notifyOnAssignment: ConsumerHandler = async (ctx, event) => {
  const { orderId, technician } = assignedPayload.parse(event.payload);
  notify(ctx, {
    topic: 'repair-assigned',
    description: 'En reparation tilldelades dig',
    // The event's id: a redelivered `workorder.assigned` mails nobody twice.
    dedupeKey: event.id,
    recipients: [technician],
    vars: { orderId },
    about: event.entity,
    template: {
      subject: 'Ny reparation tilldelad dig',
      text: 'Du har tilldelats reparation {{orderId}}.\n\nÖppna Handlebar för att se den.',
    },
  });
};
