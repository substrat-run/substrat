import { emitModel } from '@substrat-run/contracts';
import { protocolEntities } from './entities.js';

/**
 * The artifact of record for this engine (#697/#844, #976).
 *
 * `pnpm lint:model --check` re-emits this into `engines/protocol/model.json`, so a
 * changed table, a renamed field or a moved parent edge has to appear in a PR
 * diff. No `lifecycles` option: this engine declares no state machine, and an
 * empty one would claim otherwise.
 *
 * Imported by nothing, so the direction stays acyclic.
 */
export const protocolModel = emitModel(protocolEntities);
