import { emitModel } from '@substrat-run/contracts';
import { protocolEntities } from './entities.js';
import { protocolLifecycles } from './lifecycle.js';

/**
 * The artifact of record for this engine (#697/#844, #976).
 *
 * `pnpm lint:model --check` re-emits this into `engines/protocol/model.json`, so a
 * changed table, a renamed field, a moved parent edge — and now a state added to
 * the machine, an edge redirected, or a state that stops admitting substates —
 * all have to appear in a PR diff.
 *
 * It lives here rather than beside the entities because the lifecycle needs the
 * operations and the operations need the entities: `entities.ts` importing the
 * lifecycle would close that loop into a cycle. A third file that imports both
 * and is imported by neither is the shape that does not.
 */
export const protocolModel = emitModel(protocolEntities, { lifecycles: protocolLifecycles });
