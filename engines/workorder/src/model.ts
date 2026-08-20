import { emitModel } from '@substrat-run/contracts';
import { workorderEntities } from './entities.js';
import { workorderLifecycles } from './lifecycle.js';

/**
 * The artifact of record for this engine (#697/#844).
 *
 * It lives here rather than beside the entities because the lifecycle needs the
 * operations and the operations need the entities: `entities.ts` importing the
 * lifecycle would close that loop into a cycle. A third file that imports both
 * and is imported by neither is the shape that does not.
 *
 * `pnpm lint:model --check` re-emits this into `engines/workorder/model.json`,
 * so a state added to the machine, an edge redirected, or a state that stops
 * admitting substates all have to appear in a PR diff. That gate is the whole
 * reason the declaration is worth more than the six guards it replaced.
 */
export const workorderModel = emitModel(workorderEntities, { lifecycles: workorderLifecycles });
