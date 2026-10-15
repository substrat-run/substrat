import { emitModel } from '@substrat-run/contracts';
import { assistantEntities } from './entities.js';
import { assistantManifest } from './index.js';
import { assistantOperations } from './operations.js';

/**
 * The artifact of record for this engine (#697/#844, #976).
 *
 * `pnpm lint:model --check` re-emits this into `engines/assistant/model.json`, so a changed
 * table, a renamed field or a moved erasure declaration has to appear in a PR diff. No
 * `lifecycles` option: a tool call has states, but they are enforced in `appendEvents` rather
 * than declared as a lifecycle a vertical drives, and an empty claim would say otherwise.
 *
 * Imported by nothing, so the direction stays acyclic.
 */
export const assistantModel = emitModel(assistantEntities, {
  version: assistantManifest.version,
  operations: assistantOperations,
});
