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
import {
  listsDeclaredBy,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  permissionKey,
  type EntityGrantShape,
} from '@substrat-run/contracts';
import { todoEntities, todoOperations } from '../spec/model.js';

export const TODO_PERM = {
  listCreate: permissionKey.parse('list:create'),
  listManage: permissionKey.parse('list:manage'),
  listContribute: permissionKey.parse('list:contribute'),
  listArchive: permissionKey.parse('list:archive'),
  listTrash: permissionKey.parse('list:trash'),
} as const;

/**
 * What a person holds on their OWN `owner` entity — the bootstrap every list they create
 * inherits through the declared parent edge, and the only grant a person is given rather than
 * delegated.
 *
 * One list, read by both places that need it: the seed that mints it and the permission
 * snapshot that shows it to a reviewer (`ENTITY_GRANTS`). They were two literals until #119,
 * which is how a key added to one would have reached the review and not the people.
 */
export const OWNER_GRANTS = [
  TODO_PERM.listManage,
  TODO_PERM.listContribute,
  TODO_PERM.listArchive,
  TODO_PERM.listTrash,
] as const;

/**
 * The owner grant as a declared SHAPE (#2071): what `grantOwner` gives, what every boot tops
 * owners up to, and the `owner` row of `ENTITY_GRANTS`. Only this shape is reconciled. The
 * `list` row of `ENTITY_GRANTS` is SHARING, reached through `ctx.grant`, so a person holding it
 * is a sharee, never a holder to top up.
 */
export const OWNER_SHAPE: EntityGrantShape = { entityType: 'owner', permissions: [...OWNER_GRANTS] };

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
      'list:archive': 'Archive a list, or bring it back from the archive',
      'list:trash': 'Move a list to the trash, see what is in it, and restore it',
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
  // #811: derived from the operations' own `paged.over`, never written twice —
  // the index the kernel builds and the vocabulary the read offers are one fact.
  lists: listsDeclaredBy(todoOperations, todoEntities),
  entitlementKey: 'todo',
});
