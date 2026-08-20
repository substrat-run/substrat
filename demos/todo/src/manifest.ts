/**
 * Todo's declarative surface — assembled, not written.
 *
 * Both halves are derived from `spec/model.ts`: `manifestOperations` reads the
 * permission keys and emitted events off the operations, `manifestEntities`
 * reads the parent edges off the entities. What is left here is what is
 * genuinely a fact about this DEPLOYMENT rather than about the app — its id,
 * its version, where its journal lives.
 *
 * Permission descriptions are prose, so they are supplied rather than derived —
 * but the key SET is checked against what the operations actually require, and a
 * key nobody described is an error rather than an undocumented permission.
 */
import { manifestEntities, manifestOperations, moduleManifest, permissionKey } from '@substrat-run/contracts';
import { todoEntities, todoOperations } from '../spec/model.js';

export const TODO_PERM = {
  listCreate: permissionKey.parse('list:create'),
  listManage: permissionKey.parse('list:manage'),
  listContribute: permissionKey.parse('list:contribute'),
} as const;

export const todoManifest = moduleManifest.parse({
  id: '@substrat-run/demo-todo',
  version: '0.1.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '0.1.0' },
  ...manifestOperations(todoOperations, {
    permissions: {
      'list:create': 'Create lists of your own',
      'list:manage': 'Rename, delete and share a list, and delete items on it',
      'list:contribute': 'See a list, add items to it, and tick them off',
    },
  }),
  // #827. `item` only, and only `text`. The kernel derives a per-scope FTS5 index
  // and its triggers from this line; `table` and the id column come from
  // `todoEntities`, so nothing here restates where an item lives.
  //
  // Nothing else is declared, deliberately. `list.name` would index a handful of
  // rows a person can already see in one screen, and `owner`/`share` carry the
  // only `erasable` fields in the app — an index over an address is a second copy
  // of it, and the migration that builds it is not the place to discover that.
  //
  // Left on the default `prefix` tokenizer: someone typing into a todo list is
  // completing a word they wrote, not searching inside one, and `substring` costs a
  // substantially larger index. Switching is one word, and the migration re-runs.
  ...manifestEntities(todoEntities, {
    searchables: [{ entityType: 'item', fields: ['text'] }],
  }),
  entitlementKey: 'todo',
});
