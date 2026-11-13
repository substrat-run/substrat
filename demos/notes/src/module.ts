/**
 * Notes' operations. One handler: `notes/list-notes` is `derive: 'list'`, so the kernel
 * writes it from the declaration.
 */
import type { EntityRow } from '@substrat-run/contracts';
import { assertAllowed, operationsFor, ulid, type ModuleRegistration } from '@substrat-run/kernel';
import { notesEntities, notesOperations } from '../spec/model.js';
import { NOTES_PERM, notesManifest } from './manifest.js';
import { notesMigrations } from './migrations.generated.js';

type NoteRow = EntityRow<typeof notesEntities, 'note'>;

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
});

export const notesModule: ModuleRegistration = {
  manifest: notesManifest,
  migrations: notesMigrations,
  ...bound,
};
