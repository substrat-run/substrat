// K-73: the platform's bookkeeping reads, one access-log row per pass, on the one-database host.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { accessSummaryContractSuite } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

accessSummaryContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-access-summary-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
