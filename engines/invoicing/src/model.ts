import { emitModel } from '@substrat-run/contracts';
import { invoicingEntities } from './entities.js';
import { invoicingLifecycles, invoicingManifest } from './index.js';

/**
 * The artifact of record for this engine (#697/#844). Imported by nothing, so the direction stays acyclic.
 *
 * It also carries `manifest.version` (#976), which makes this artifact the field's reader:
 * a bump has to appear in the same diff as the shape change it announces.
 */
export const invoicingModel = emitModel(invoicingEntities, {
  lifecycles: invoicingLifecycles,
  version: invoicingManifest.version,
});
