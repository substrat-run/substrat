/**
 * Graph notes' declarative surface: its permission keys, its operations, and the scope store it
 * declares.
 *
 * The vertical keeps no tables of its own. Its data lives in one scope store, `GRAPH`, of the
 * `graph` driver. A store call does not check a permission (the door does not either), so each
 * thing a caller may do is an operation here whose only work is the check; `notes.ts` invokes it
 * before it calls the store.
 */
import {
  defineEntities,
  defineOperations,
  manifestOperations,
  moduleManifest,
  permissionKey,
  scopeStoreNeed,
  z,
} from '@substrat-run/contracts';

/**
 * The scope stores this vertical declares, in the shape of `runtimeNeeds.scopeStores`.
 *
 * Declared here rather than in `package.json` because this vertical has no worker yet:
 * `runtimeNeeds` names a worker entry, and the deploy gates bundle it. The hosted step moves
 * this list into `substrat.runtimeNeeds` beside that entry.
 */
export const SCOPE_STORES = z.array(scopeStoreNeed).parse([{ binding: 'GRAPH', driver: 'graph' }]);
export const GRAPH_BINDING = 'GRAPH';

export const GRAPH_NOTES_PERMISSIONS = ['notes:read', 'notes:write', 'graph:install'] as const;

export const NOTES_PERM = {
  read: permissionKey.parse('notes:read'),
  write: permissionKey.parse('notes:write'),
  install: permissionKey.parse('graph:install'),
} as const;

const entities = defineEntities({});
const admitted = z.object({});

export const graphNotesOperations = defineOperations(entities, GRAPH_NOTES_PERMISSIONS)({
  'graph-notes/install-schema': {
    summary: 'May the caller install the notes schema in this scope’s graph store',
    permission: 'graph:install',
    output: admitted,
  },
  'graph-notes/create-note': {
    summary: 'May the caller write a note to this scope’s graph store',
    permission: 'notes:write',
    output: admitted,
  },
  'graph-notes/read-notes': {
    summary: 'May the caller list and read the notes in this scope’s graph store',
    permission: 'notes:read',
    output: admitted,
  },
});

export const graphNotesManifest = moduleManifest.parse({
  id: '@substrat-run/demo-graph-notes',
  version: '0.1.0',
  kernelContract: '^0.0.1',
  migrations: { journalDir: './migrations', compatibleFrom: '0.1.0' },
  ...manifestOperations(graphNotesOperations, {
    permissions: {
      'notes:read': 'List and read the notes in the graph store',
      'notes:write': 'Write notes to the graph store',
      'graph:install': 'Install the notes schema in the graph store',
    },
  }),
  attachmentTargets: [],
  entitlementKey: 'graph-notes',
});
