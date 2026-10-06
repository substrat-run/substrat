/**
 * Entity archive and trash (#119) — the vocabulary the kernel and a module share.
 *
 * Three different acts get habitually conflated, and only one of them lives here:
 *
 * - **Subject erasure** (#37, K-37) removes a person's data from everywhere the platform can
 *   reach, history included. Not reversible, and not about an entity.
 * - **Tenant delete and retention** (#36) removes a whole tenant after a grace window. Not
 *   about an entity either.
 * - **Archive and trash** — this — hide ONE entity from active views and keep it. Both are
 *   reversible, both keep the row, and neither touches history: the events about the entity
 *   stay exactly as they were.
 *
 * Archive and trash are deliberately two acts with two permission keys. Archive says "done
 * with this, keep it": the row stays readable through the entity's ordinary read authority.
 * Trash says "I meant to delete this": the row stays recoverable, but only someone holding
 * the declared trash key can see it or bring it back.
 *
 * ## The state is two columns, and the visible state is derived from them
 *
 * An entity that declares either one gets kernel-owned columns on its own table,
 * `_substrat_archived_at` and `_substrat_trashed_at`. Stored apart rather than as one enum,
 * so trash never forgets an archive: trashing an archived row and restoring it brings it back
 * archived, never silently into the active view. What a reader sees is one state, derived:
 *
 *     trashed   when `_substrat_trashed_at` is set
 *     archived  else when `_substrat_archived_at` is set
 *     active    otherwise
 */
import { z } from 'zod';
import { entityRef } from './events.js';
import { permissionKey } from './ids.js';

/** The state an archivable or trashable entity is in, as a reader sees it. */
export const entityStateName = z.enum(['active', 'archived', 'trashed']);
export type EntityStateName = z.infer<typeof entityStateName>;

/** The kernel-owned column that records an archive. */
export const ARCHIVED_AT_COLUMN = '_substrat_archived_at';
/** The kernel-owned column that records a trash. */
export const TRASHED_AT_COLUMN = '_substrat_trashed_at';

/**
 * One entity's declaration, as the manifest carries it.
 *
 * Written into a model as `archive: { permission }` / `trash: { permission }` on the entity
 * (`defineEntities`); `manifestEntities()` turns that into this and fills in `table` and
 * `idColumn` from the registry, as it does for `searchables`. A hand-written manifest (an
 * engine's) may declare it directly.
 *
 * `archivePermission` gates `ctx.archive` and `ctx.unarchive`; `trashPermission` gates
 * `ctx.trash`, `ctx.restore` and the trashed readers. At least one is required. A key here
 * must be one the module declares.
 */
export const entityStateDeclaration = z.object({
  entityType: z.string().min(1),
  archivePermission: permissionKey.optional(),
  trashPermission: permissionKey.optional(),
  table: z.string().min(1).optional(),
  idColumn: z.string().min(1).optional(),
});
export type EntityStateDeclaration = z.infer<typeof entityStateDeclaration>;

/** `ctx.archive` moved an entity out of the active view. Entity: the entity. */
export const ENTITY_ARCHIVED = 'entity.archived';
/** `ctx.unarchive` brought an archived entity back. Entity: the entity. */
export const ENTITY_UNARCHIVED = 'entity.unarchived';
/** `ctx.trash` moved an entity into the trash. Entity: the entity. */
export const ENTITY_TRASHED = 'entity.trashed';
/** `ctx.restore` took an entity out of the trash, back to the state it was trashed from. */
export const ENTITY_RESTORED = 'entity.restored';

/**
 * The one payload all four carry: the entity, and the visible state before and after.
 *
 * Who did it and when are not here — they are the envelope's actor and `occurredAt`, stamped
 * by the kernel, with the K-34 authorization chain beside them. `from` and `to` are the
 * derived states, so `entity.restored` says where the entity went back to (`active` or
 * `archived`) without the reader having to replay anything.
 */
export const entityStateChangedPayload = z.object({
  entity: entityRef,
  from: entityStateName,
  to: entityStateName,
});
export type EntityStateChangedPayload = z.infer<typeof entityStateChangedPayload>;
