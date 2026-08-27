import { z } from '@substrat-run/contracts';
import { FIELD_TYPES } from './content-types.js';
import { manyfoldEntities } from './entities.js';

/**
 * Manyfold's operation input schemas — one description, three readers.
 *
 * They lived in `module.ts` beside the handlers that parse them, which was fine
 * until #865 asked for a declared operation surface: `operations.ts` needs these
 * objects, `module.ts` needs `operations.ts` for `operationInputsOf`, and that is
 * a cycle. Booking hit the same wall and answered it the same way — a
 * declaration imports only entities and schemas, so nothing reaches back into
 * the implementation.
 *
 * The three readers are the point of not restating them: the API catalog
 * (`api.ts`) documents these objects, the handlers parse them, and the declared
 * surface publishes them. A transcribed copy anywhere in that list is the
 * two-descriptions defect #889 found in the reference vertical.
 */

/**
 * The editorial statuses — **taken from the entity registry, not restated** (#844).
 * The column's `z.enum` is the one description; this reads its options.
 */
export const ENTRY_STATUSES = manyfoldEntities['manyfold-entry'].fields.shape.status.options;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

// `body` stays `unknown` at this boundary on purpose: an entry body's real
// schema is the CONTENT TYPE's, data-defined and validated by `buildBodySchema`
// inside the operation.
export const createEntryInput = z.object({ typeKey: z.string().min(1), body: z.unknown() });
export const saveDraftInput = z.object({ entryId: z.string().min(1), body: z.unknown() });
export const restoreRevisionInput = z.object({ entryId: z.string().min(1), revNo: z.number().int().positive() });
export const entryIdInput = z.object({ entryId: z.string().min(1) });
export const rejectInput = z.object({ entryId: z.string().min(1), note: z.string().min(1, 'a rejection needs a note') });
export const listEntriesInput = z.object({ typeKey: z.string().min(1).optional(), status: z.enum(ENTRY_STATUSES).optional() });
export const deliverInput = z.object({ typeKey: z.string().min(1), slug: z.string().min(1) });
export const listDeliveryInput = z.object({ typeKey: z.string().min(1).optional() });
export const deleteTypeInput = z.object({ key: z.string().min(1) });
export const timelineInput = z.object({ entityType: z.string().min(1), entityId: z.string().min(1) });

const fieldDefInput = z.object({
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  index: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  target: z.string().optional(),
  source: z.string().optional(),
  maxLen: z.number().int().positive().optional(),
});

export const saveTypeInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'key must be lower_snake, starting with a letter'),
  title: z.string().min(1),
  titleField: z.string().min(1),
  slugField: z.string().optional(),
  fields: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'field names are lowerCamel'), fieldDefInput),
});

export const requestSiteInput = z.object({ slug: z.string().min(1), name: z.string().min(1) });
export const archiveSiteInput = z.object({ scopeId: z.string().min(1) });
