/**
 * Notes' model — what exists, declared once.
 *
 * Two entities and four operations. There is nothing here about people: no owner entity, no
 * join, no invitation. Who may call these is decided in another app, and arrives as the role in
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

  /**
   * A note on one of Todo's items. Its own table, so the workspace notepad never lists one: a
   * note on an item is for the people who may see that item, and the notepad is for everyone.
   * `item_id` and `list_id` are Todo's ids, opaque here; `list_id` is the list Todo said the item
   * is on when the note was written, so a list's notes are one read.
   */
  item_note: {
    table: 'notes_item_notes',
    fields: z.object({
      id: z.string(),
      item_id: z.string(),
      list_id: z.string(),
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

  /**
   * Write a note on one of Todo's items. No `http`: the door's route reaches it only after Todo
   * has said the caller may see the item, and hands over the list Todo named. The operation
   * cannot ask Todo itself (module code has no network), so it trusts its door for that.
   */
  'notes/add-item-note': {
    summary: 'Write a note on a Todo item',
    permission: 'note:write',
    input: z.object({ itemId: z.string().min(1), listId: z.string().min(1), text: z.string().min(1) }),
    output: notesEntities.item_note.fields,
    emits: {
      entity: 'item_note',
      entityIdFrom: 'id',
      type: 'notes.item-note-added',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'item_id', 'author_id'],
    },
  },

  /**
   * The notes on one list's items. No `http`, for the same reason, and so a handler of its own
   * rather than `derive: 'list'`, which the platform serves as a GET route.
   */
  'notes/list-item-notes': {
    summary: 'The notes on the items of one Todo list, or of every list',
    permission: 'note:read',
    // Without a list, every item note: the door's route keeps only those on lists Todo vouches for.
    input: z.object({ listId: z.string().min(1).optional() }),
    output: notesEntities.item_note.fields,
    paged: { over: { entity: 'item_note', sortable: ['id'], filterable: ['list_id'] } },
  },
});

export const notesModel = emitModel(notesEntities, { operations: notesOperations });
