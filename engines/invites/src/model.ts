import { emitModel } from '@substrat-run/contracts';
import { invitesEntities } from './entities.js';

/**
 * The artifact of record for this engine (#697/#844, #976).
 *
 * `pnpm lint:model --check` re-emits this into `engines/invites/model.json`, so a
 * changed table, a renamed field or a moved parent edge has to appear in a PR
 * diff. No `lifecycles` option: this engine declares no state machine, and an
 * empty one would claim otherwise.
 *
 * Imported by nothing, so the direction stays acyclic.
 */
export const invitesModel = emitModel(invitesEntities);
