import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardImportMod, crmExportMod, verticalEventsContractSuite } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

// Two deployments over ONE directory (#1705): the producer vertical's host and the consumer
// vertical's host, each registering only its own module, as a platform with one deployment
// per vertical runs them. The default tuple checker on both, because the suite's authority
// claims are about real grants.
verticalEventsContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-vertical-events-'));
  const producer = new SqliteScopeHost({ dir });
  producer.registerModule(crmExportMod);
  const consumer = new SqliteScopeHost({ dir });
  consumer.registerModule(boardImportMod);
  return {
    producer,
    consumer,
    cleanup: async () => {
      await producer.close();
      await consumer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
