import { emitModel } from '@substrat-run/contracts';
import { notificationsEntities } from './entities.js';
import { notificationsManifest } from './index.js';
import { notificationsOperations } from './operations.js';

/**
 * The artifact of record for this engine (#697/#844, #976).
 *
 * `pnpm lint:model --check` re-emits this into `engines/notifications/model.json`, so a
 * changed table or field has to appear in a PR diff. It describes the engine with no topics:
 * the topics are a composing vertical's declaration, and appear in THAT vertical's manifest.
 *
 * Imported by nothing, so the direction stays acyclic.
 */
export const notificationsModel = emitModel(notificationsEntities, {
  version: notificationsManifest.version,
  operations: notificationsOperations,
});
