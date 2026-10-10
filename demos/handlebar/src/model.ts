import { emitModel } from '@substrat-run/contracts';
import { handlebarEntities } from './entities.js';
import { handlebarOperations } from './operations.js';

/**
 * The artifact of record for this vertical (#697). Here rather than in `entities.ts` because it
 * renders who writes each handler (#1773), and the operations import the entities. Imported by
 * nothing but its test, so the direction stays acyclic.
 */
export const handlebarModel = emitModel(handlebarEntities, { operations: handlebarOperations });
