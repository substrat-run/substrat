/**
 * Notes' operations. `notes/list-notes` is `derive: 'list'`, so the kernel writes it from the
 * declaration; the item-note read has no route, so it is a handler over the same paged walk.
 */
import type { EntityRow } from '@substrat-run/contracts';
import { assertAllowed, operationsFor, ulid, type ModuleRegistration } from '@substrat-run/kernel';
import { notesEntities, notesOperations } from '../spec/model.js';
import { NOTES_PERM, notesManifest } from './manifest.js';
import { notesMigrations } from './migrations.generated.js';

type NoteRow = EntityRow<typeof notesEntities, 'note'>;
type ItemNoteRow = EntityRow<typeof notesEntities, 'item_note'>;

const bound = operationsFor(notesOperations)({
  'notes/add-note': async (ctx, input) => {
    assertAllowed(await ctx.check(NOTES_PERM.noteWrite));
    const id = ulid();
    ctx.sql.exec('INSERT INTO notes_notes (id, author_id, text, created_at) VALUES (?, ?, ?, ?)', [
      id,
      ctx.principal,
      input.text,
      ctx.now(),
    ]);
    const row = ctx.sql.query<NoteRow>('SELECT id, author_id, text, created_at FROM notes_notes WHERE id = ?', [id])[0]!;
    ctx.emit({
      type: 'notes.note-added',
      schemaVersion: 1,
      entity: { entityType: 'note', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, author_id: row.author_id },
    });
    return row;
  },

  'notes/list-item-notes': async (ctx, input) => {
    assertAllowed(await ctx.check(NOTES_PERM.noteRead));
    const { listId, ...page } = input;
    return ctx.page<ItemNoteRow>('item_note', listId === undefined ? page : { ...page, filters: { list_id: listId } });
  },

  'notes/add-item-note': async (ctx, input) => {
    assertAllowed(await ctx.check(NOTES_PERM.noteWrite));
    const id = ulid();
    ctx.sql.exec('INSERT INTO notes_item_notes (id, item_id, list_id, author_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      input.itemId,
      input.listId,
      ctx.principal,
      input.text,
      ctx.now(),
    ]);
    const row = ctx.sql.query<ItemNoteRow>(
      'SELECT id, item_id, list_id, author_id, text, created_at FROM notes_item_notes WHERE id = ?',
      [id],
    )[0]!;
    ctx.emit({
      type: 'notes.item-note-added',
      schemaVersion: 1,
      entity: { entityType: 'item_note', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, item_id: row.item_id, author_id: row.author_id },
    });
    return row;
  },
});

export const notesModule: ModuleRegistration = {
  manifest: notesManifest,
  migrations: notesMigrations,
  ...bound,
};
