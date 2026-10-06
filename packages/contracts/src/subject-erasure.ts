/**
 * Subject erasure reaching a module's OWN tables (#2068) — the vocabulary the model, the
 * manifest and the kernel share.
 *
 * `shredSubject` (#37, K-37) redacts the spine and crypto-shreds the platform-retained copies.
 * Until this, it stopped there: a field a model marked `erasable` was kept off every event, so
 * the spine half held, but the row the field lives on is the module's, and nothing reached it.
 * kernel-design.md §13.1 listed that as limit 2.
 *
 * An entity now says how an erasure reaches it, beside the `erasable` list it already has:
 *
 *     erasure: { subjects: ['author_contact_id'] }            // blank the erasable fields
 *     erasure: { subjects: ['owner'], mode: 'delete' }         // delete the row
 *     erasure: { mode: 'custom' }                              // the module's hook does it
 *
 * `subjects` names the columns whose value IS a data subject id (a contact's id, a principal's
 * id: both are ULIDs, so one id space serves customers and staff). A row is the subject's when
 * any of those columns equals the id being erased. `blank` — the default — sets each erasable
 * field to NULL when the field admits NULL, else to `''`, and keeps the row: the envelope stays
 * the way the spine's does (§5.3, "pseudonymous keys and transaction facts remain"). `delete`
 * removes the row, for an entity that IS the person's data rather than a record that mentions
 * them. `custom` says the module's `onSubjectErased` hook reaches the entity, for a link the row
 * does not hold itself (a rating reached through its conversation).
 *
 * An entity with `erasable` fields and no `erasure` is not refused — that would break every
 * model written before this — but it is UNREACHED, and says so: in the manifest below, on every
 * erasure receipt, and as a warning from `lint:model`.
 */
import { z } from 'zod';
import { SQL_IDENTIFIER } from './introspection.js';

/** How an erasure reaches one entity. `unreached` is derived, never declared. */
export const subjectErasureMode = z.enum(['blank', 'delete', 'custom', 'unreached']);
export type SubjectErasureMode = z.infer<typeof subjectErasureMode>;

/** A plain SQL identifier — a table or a column the kernel interpolates into DDL-free DML. */
const sqlName = z.string().regex(SQL_IDENTIFIER);

/**
 * One entity's erasure, as the manifest carries it. Derived by `subjectErasureOf` from the
 * model — never written by hand in a vertical — so the columns and the blank values are the
 * model's own facts.
 */
export const entityErasure = z
  .object({
    entityType: z.string().min(1),
    table: sqlName,
    mode: subjectErasureMode,
    /** The columns whose value is a data subject id. Required for `blank` and `delete`. */
    subjects: z.array(sqlName).min(1).optional(),
    /**
     * The erasable fields, each with what a blank writes into it: NULL where the field admits
     * it, else the empty string. Decided from the field's schema at derive time, so a NOT NULL
     * column is never handed a NULL it would refuse mid-erasure.
     */
    fields: z.array(z.object({ name: sqlName, blank: z.union([z.null(), z.literal('')]) })).min(1),
  })
  .superRefine((e, ctx) => {
    const linked = e.mode === 'blank' || e.mode === 'delete';
    if (linked && !e.subjects) {
      ctx.addIssue({ code: 'custom', message: `${e.entityType}: a ${e.mode} erasure names its subject columns` });
    }
    if (!linked && e.subjects) {
      ctx.addIssue({ code: 'custom', message: `${e.entityType}: a ${e.mode} erasure names no subject columns` });
    }
  });
export type EntityErasure = z.infer<typeof entityErasure>;

/**
 * A module's erasure declaration (`manifest.erasure`).
 *
 * `tables` is every table the module's model declares, erasable or not, and it is the REACH of
 * the module's `onSubjectErased` hook: the kernel refuses any statement the hook runs that names
 * a table outside it. A hook that needs a conversation's requester to find a rating reads the
 * conversation table — its own — and nothing else.
 */
export const subjectErasureDeclaration = z.object({
  tables: z.array(sqlName).min(1),
  entities: z.array(entityErasure),
});
export type SubjectErasureDeclaration = z.infer<typeof subjectErasureDeclaration>;

/** One entity's line on an erasure receipt: what the declared erasure did there. */
export const erasedEntityCount = z.object({
  module: z.string().min(1),
  entityType: z.string().min(1),
  mode: subjectErasureMode.extract(['blank', 'delete']),
  /** Rows blanked or deleted by this call. Zero on a re-run — the first one did it. */
  rows: z.number().int().nonnegative(),
});
export type ErasedEntityCount = z.infer<typeof erasedEntityCount>;

/** One module's `onSubjectErased` hook on a receipt: the rows its statements changed. */
export const erasureHookCount = z.object({
  module: z.string().min(1),
  rows: z.number().int().nonnegative(),
});
export type ErasureHookCount = z.infer<typeof erasureHookCount>;

/** An entity holding erasable fields that no erasure reaches — named on every receipt. */
export const unreachedEntity = z.object({
  module: z.string().min(1),
  entityType: z.string().min(1),
});
export type UnreachedEntity = z.infer<typeof unreachedEntity>;
