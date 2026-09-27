import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webCryptoSecretBox } from '@substrat-run/kernel';
import { scopeRepointContractSuite } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

// #1869, on the DEFAULT checker so the suite can assert decisions as well as rows.
scopeRepointContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-repoint-'));
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
