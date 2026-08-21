import { emitModel } from '@substrat-run/contracts';
import { manyfoldEntities } from './entities.js';
import { manyfoldLifecycles } from './module.js';

/**
 * The artifact of record for this vertical (#697/#844).
 *
 * It imports `module.ts` for the lifecycle, which is why it is not in
 * `entities.ts` — `module.ts` imports the entities, so emitting from there would
 * close a cycle. Nothing imports this file back.
 */
export const manyfoldModel = emitModel(manyfoldEntities, { lifecycles: manyfoldLifecycles });
