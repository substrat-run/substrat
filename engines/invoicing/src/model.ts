import { emitModel } from '@substrat-run/contracts';
import { invoicingEntities } from './entities.js';
import { invoicingLifecycles } from './index.js';

/** The artifact of record for this engine (#697/#844). Imported by nothing, so the direction stays acyclic. */
export const invoicingModel = emitModel(invoicingEntities, { lifecycles: invoicingLifecycles });
