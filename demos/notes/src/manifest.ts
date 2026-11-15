/**
 * Notes' declarative surface — assembled from `spec/model.ts`, not written.
 */
import {
  listsDeclaredBy,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  permissionKey,
} from '@substrat-run/contracts';
import { notesEntities, notesOperations } from '../spec/model.js';

export const NOTES_PERM = {
  noteRead: permissionKey.parse('note:read'),
  noteWrite: permissionKey.parse('note:write'),
  itemNoteRead: permissionKey.parse('item-note:read'),
  itemNoteWrite: permissionKey.parse('item-note:write'),
} as const;

const surface = manifestOperations(notesOperations, {
  permissions: {
    'note:read': 'Read the notes in this workspace',
    'note:write': 'Write a note',
    'item-note:read': 'Read the notes on Todo items, once Todo has vouched for the list',
    'item-note:write': 'Write a note on a Todo item, once Todo has vouched for it',
  },
});

export const notesManifest = moduleManifest.parse({
  id: '@substrat-run/demo-notes',
  version: '0.1.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '0.1.0' },
  ...surface,
  ...manifestEntities(notesEntities, {}),
  lists: listsDeclaredBy(notesOperations, notesEntities),
  // Todo may call here AS the person signed in to it, on a peer call (#3161): the notepad's keys
  // only. The item-note keys stay out, because those operations rely on the door having asked
  // Todo to vouch, and a delegated call does not pass that door (`spec/model.ts`).
  delegations: [{ actor: 'todo', permissions: [NOTES_PERM.noteRead, NOTES_PERM.noteWrite], channels: ['peer'] }],
  entitlementKey: 'notes',
});
