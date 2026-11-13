/**
 * Notes' model — what exists, declared once.
 *
 * One entity and two operations. There is nothing here about people: no owner entity, no join,
 * no invitation. Who may call these is decided in another app, and arrives as the two roles in
 * `src/provision.ts` (see `spec/concept.md`).
 */
import { defineEntities, defineOperations, emitModel, z } from '@substrat-run/contracts';

export const notesEntities = defineEntities({
  /** A note. `author_id` is the principal who wrote it: the same id that person has in Todo. */
  note: {
    table: 'notes_notes',
    fields: z.object({
      id: z.string(),
      author_id: z.string(),
      text: z.string(),
      created_at: z.string(),
    }),
  },
});

export const NOTES_PERMISSIONS = ['note:read', 'note:write'] as const;

export const notesOperations = defineOperations(notesEntities, NOTES_PERMISSIONS)({
  'notes/add-note': {
    summary: 'Write a note',
    permission: 'note:write',
    input: z.object({ text: z.string().min(1) }),
    output: notesEntities.note.fields,
    http: { method: 'POST', path: '/notes' },
    emits: {
      entity: 'note',
      entityIdFrom: 'id',
      type: 'notes.note-added',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'author_id'],
    },
  },

  'notes/list-notes': {
    summary: 'The notes in this workspace',
    // Kernel-composed: the check, the keyset walk and the index behind it come from `paged.over`.
    derive: 'list',
    permission: 'note:read',
    output: notesEntities.note.fields,
    // Keyset over the ULID id, which is creation order.
    paged: { over: { entity: 'note', sortable: ['id'] } },
    http: { method: 'GET', path: '/notes' },
  },
});

export const notesModel = emitModel(notesEntities, { operations: notesOperations });
