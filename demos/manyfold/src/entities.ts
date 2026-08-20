import { defineEntities } from '@substrat-run/contracts';
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
      /**
       * The six editorial statuses (#844). Declared HERE, on the column, rather
       * than as a bare `z.string()` with the real set living in a `const` array
       * in `module.ts` — two descriptions of one fact. `ENTRY_STATUSES` now
       * reads this schema's own options.
       */
      status: z.enum(['draft', 'in_review', 'approved', 'published', 'unpublished', 'archived']),
      slug: z.string().nullable(),
      draft_rev: z.number(),
      published_rev: z.number().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
  },
});

/**
 * Moved to `src/model.ts` (#844): the emitted model now carries the entry's
 * lifecycle, and the lifecycle is declared beside the operation map in
 * `module.ts` — which imports this file, so emitting from here would be a cycle.
 */
