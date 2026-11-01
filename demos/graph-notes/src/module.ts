/**
 * Graph notes' module: the permission half of each store-backed action.
 *
 * Module code cannot reach a scope store (it has `ctx`, and the store's door is the host's), and
 * the door checks no permission. So each handler here only checks, and `notes.ts` makes the
 * store call once the invoke has returned.
 */
import { assertAllowed, operationsFor, type ModuleRegistration } from '@substrat-run/kernel';
import { graphNotesManifest, graphNotesOperations, NOTES_PERM } from './manifest.js';

export const graphNotesModule: ModuleRegistration = {
  manifest: graphNotesManifest,
  migrations: [],
  ...operationsFor(graphNotesOperations)({
    'graph-notes/install-schema': async (ctx) => {
      assertAllowed(await ctx.check(NOTES_PERM.install));
      return {};
    },
    'graph-notes/create-note': async (ctx) => {
      assertAllowed(await ctx.check(NOTES_PERM.write));
      return {};
    },
    'graph-notes/read-notes': async (ctx) => {
      assertAllowed(await ctx.check(NOTES_PERM.read));
      return {};
    },
  }),
};
