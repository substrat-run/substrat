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
} as const;

const surface = manifestOperations(notesOperations, {
  permissions: {
    'note:read': 'Read the notes in this workspace',
    'note:write': 'Write a note',
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
  entitlementKey: 'notes',
});
