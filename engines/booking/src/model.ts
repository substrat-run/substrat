import { emitModel } from '@substrat-run/contracts';
import { bookingEntities } from './entities.js';
import { bookingLifecycles } from './index.js';

/**
 * The artifact of record for this engine (#697/#844).
 *
 * It imports the lifecycle from `index.ts` rather than a `lifecycle.ts`, because
 * that is where booking's operation map lives — see the note on `OPERATIONS`.
 * Nothing imports this file back, so the direction stays acyclic.
 */
export const bookingModel = emitModel(bookingEntities, { lifecycles: bookingLifecycles });
