import { env } from 'cloudflare:test';
import { boardImportMod, crmExportMod, verticalEventsContractSuite } from '@substrat-run/contract-tests';
import { webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

// #1705 on workerd: the export read (the (type, id) seek and the recursive hop walk), the
// import journal and the watermark's compare-and-set are DO SQL here, run by real Durable
// Objects. Two deployments, one class each, over a directory of their own.
verticalEventsContractSuite('adapter-cloudflare (workerd)', async () => {
  await warmControlPlane(env.VE_CONTROL_PLANE);
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const producer = new CloudflareScopeHost({ scope: env.CRM_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
  producer.registerModule(crmExportMod);
  const consumer = new CloudflareScopeHost({ scope: env.BOARD_SCOPE, controlPlane: env.VE_CONTROL_PLANE, secretBox });
  consumer.registerModule(boardImportMod);
  return { producer, consumer, cleanup: async () => {} };
});
