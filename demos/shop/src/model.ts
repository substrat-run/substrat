import { emitModel } from '@substrat-run/contracts';
import { shopEntities } from './entities.js';
import { shopLifecycles } from './module.js';

/** The artifact of record for this vertical (#697/#844). Imported by nothing, so the direction stays acyclic. */
export const shopModel = emitModel(shopEntities, { lifecycles: shopLifecycles });
