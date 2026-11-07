import {
  listsDeclaredBy,
  manifestEntities,
  manifestOperations,
  moduleManifest,
  permissionKey,
  type EntityGrantShape,
} from '@substrat-run/contracts';
import { entities, operations } from '../spec/model.js';

export const LISTS_PERM = {
  listCreate: permissionKey.parse('list:create'),
  listManage: permissionKey.parse('list:manage'),
  listContribute: permissionKey.parse('list:contribute'),
} as const;

/** What a person holds on their OWN `person` entity; their lists inherit it through the parent edge. */
export const OWNER_GRANTS = [LISTS_PERM.listManage, LISTS_PERM.listContribute] as const;

export const ENTITY_GRANTS: EntityGrantShape[] = [
  { entityType: 'person', permissions: [...OWNER_GRANTS], bootstrap: true, holder: 'self' },
  { entityType: 'list', permissions: [LISTS_PERM.listContribute] },
];

const surface = manifestOperations(operations, {
  permissions: {
    'list:create': 'Create lists of your own',
    'list:manage': 'Rename, delete and share a list, and delete any item on it',
    'list:contribute': 'See a list, add items, tick them, and edit or delete your own items',
  },
});

export const listsManifest = moduleManifest.parse({
  id: '@app/shared-lists',
  version: '0.1.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '0.1.0' },
  ...surface,
  events: { ...surface.events, consumes: [{ type: 'lists.person-joined', schemaVersion: 1 }] },
  ...manifestEntities(entities, {}),
  lists: listsDeclaredBy(operations, entities),
  entitlementKey: 'shared-lists',
});
