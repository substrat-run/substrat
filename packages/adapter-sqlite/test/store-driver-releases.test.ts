/**
 * #2300: a store driver's releases, rollouts and holds, on the pure host. The hold-expiry
 * transition is mounted here only: this host takes a clock, and the Durable Object host does
 * not (#956).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualClock } from '@substrat-run/kernel';
import { storeDriverHoldExpiryContractSuite, storeDriverReleaseContractSuite } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

storeDriverReleaseContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-store-driver-'));
  const host = new SqliteScopeHost({ dir });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

storeDriverHoldExpiryContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-store-driver-hold-'));
  const clock = manualClock();
  const host = new SqliteScopeHost({ dir, clock: clock.read });
  return {
    host,
    clock,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
