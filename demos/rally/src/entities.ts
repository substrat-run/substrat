import { defineEntities, emitModel } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * Rally's entities (#697).
 *
 * Fourteen tables, one entity. The prepaid balance is an append-only ledger, and
 * the rest are rows this vertical owns — a ledger delta is not something a grant
 * narrows to.
 *
 * `reservation` is engine-booking's, not ours: the club's edge
 * `reservation → member` is declared in the manifest against that engine's
 * registry, not here.
 */
export const rallyEntities = defineEntities({
  member: {
    table: 'rally_members',
    fields: z.object({
      id: z.string(),
      party_ref: z.string(),
      name: z.string(),
      phone: z.string().nullable(),
      level: z.string().nullable(),
      created_at: z.string(),
    }),
    key: ['party_ref'],
    // A club member is a private person; the phone is how you reach them.
    erasable: ['name', 'phone'],
  },
});

export const rallyModel = emitModel(rallyEntities);
