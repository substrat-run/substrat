import { emitModel } from '@substrat-run/contracts';
import { absenceEntities } from './entities.js';
import { absenceManifest } from './index.js';

/**
 * The artifact of record for this engine (#697/#844, #976).
 *
 * `pnpm lint:model --check` re-emits this into `engines/absence/model.json`, so a
 * changed table, a renamed field or a moved parent edge has to appear in a PR
 * diff. No `lifecycles` option: this engine declares no state machine, and an
 * empty one would claim otherwise.
 *
 * Imported by nothing, so the direction stays acyclic.
 *
 * It also carries `manifest.version` (#976), which makes this artifact the
 * field's reader: a bump has to appear in the same diff as the shape change it
 * announces.
 */
export const absenceModel = emitModel(absenceEntities, { version: absenceManifest.version });
