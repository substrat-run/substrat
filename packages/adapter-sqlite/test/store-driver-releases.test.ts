/**
 * #2300: a store driver's releases, rollouts and holds, on the pure host. The hold-expiry
 * transition is mounted here only: this host takes a clock, and the Durable Object host does
 * not (#956).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { STORE_DRIVER_RELEASES_DDL, manualClock } from '@substrat-run/kernel';
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

it('adds approval tables to an existing directory without changing its stored release', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-store-driver-approval-upgrade-'));
  const file = join(dir, '_directory.sqlite');
  try {
    const before = new DatabaseSync(file);
    before.exec(STORE_DRIVER_RELEASES_DDL);
    before.exec('DROP TABLE store_driver_revoke_walks; DROP INDEX store_driver_approvals_one_live; DROP TABLE store_driver_approvals');
    before.prepare(`INSERT INTO store_driver_releases
      (driver, sha256, source_commit, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?)`).run(
      'graph', 'a'.repeat(64), 'b'.repeat(40), 'staff', '2026-10-28',
    );
    before.close();

    for (let i = 0; i < 2; i++) {
      const host = new SqliteScopeHost({ dir });
      await host.close();
    }

    const after = new DatabaseSync(file);
    expect(after.prepare('SELECT driver, sha256, source_commit FROM store_driver_releases').get()).toEqual({
      driver: 'graph', sha256: 'a'.repeat(64), source_commit: 'b'.repeat(40),
    });
    for (const name of ['store_driver_approvals', 'store_driver_revoke_walks']) {
      expect(after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)).toEqual({ name });
    }
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
