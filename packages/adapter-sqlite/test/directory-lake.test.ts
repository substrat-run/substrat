// K-70: the directory's outbox to the lake, on the one-database host.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { directoryLakeContractSuite } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

directoryLakeContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-directory-lake-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
