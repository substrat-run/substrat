/**
 * Graph notes' entity-check claim, read by `pnpm lint:conformance` (CONFORMANCE.md).
 */
import { declareNodeOnly } from '@substrat-run/contract-tests/conformance';
import { graphNotesOperations } from '../src/manifest.js';

export const conformance = declareNodeOnly({
  subject: 'graph-notes',
  operations: graphNotesOperations,
  because:
    'Three operations, every check at the node. The notes live in the scope’s graph store, not in ' +
    'entities of this vertical, so there is no entity to narrow a check to: a role over the scope ' +
    'decides who may install the schema, write notes and read them, and no entity-grant shape is declared.',
});
