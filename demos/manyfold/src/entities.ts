import { defineEntities, emitModel } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * Manyfold's entity (#697).
 *
 * One entity across eleven tables. Revisions, the status log, deliveries and the
 * content-type registry are rows this vertical owns; only the ENTRY is what the
 * platform points at.
 *
 * NOT declared, and it cannot be: a content type creates its own `ct_<key>` table
 * at RUNTIME, so those table names do not exist at build time. A registry keyed
 * by static table names has nothing to say about them. They are also not
 * entities — an entry is the thing, and its typed fields live in its ct_ row.
 */
export const manyfoldEntities = defineEntities({
  'manyfold-entry': {
    table: 'manyfold_entry',
    fields: z.object({
      id: z.string(),
      type_key: z.string(),
      status: z.string(),
      slug: z.string().nullable(),
      draft_rev: z.number(),
      published_rev: z.number().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
  },
});

export const manyfoldModel = emitModel(manyfoldEntities);
