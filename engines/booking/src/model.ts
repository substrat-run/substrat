import { emitModel } from '@substrat-run/contracts';
import { bookingEntities } from './entities.js';
import { bookingManifest } from './index.js';
import { bookingLifecycles } from './lifecycle.js';

/**
 * The artifact of record for this engine (#697/#844).
 *
 * It imports the lifecycle from `lifecycle.ts`, which is where it lives now that
 * `operations.ts` gives it a declared registry to check itself against — it used
 * to have to come from `index.ts`. Nothing imports this file back, so the
 * direction stays acyclic.
 *
 * It also carries `manifest.version` (#976), which makes this artifact the
 * field's reader: a bump has to appear in the same diff as the shape change it
 * announces.
 */
export const bookingModel = emitModel(bookingEntities, {
  lifecycles: bookingLifecycles,
  version: bookingManifest.version,
});
