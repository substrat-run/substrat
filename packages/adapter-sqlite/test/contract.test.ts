import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import {
  atomicContractSuite,
  connectorTestFetch,
  permissionContractSuite,
  scheduleContractSuite,
  scopeHostContractSuite,
} from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

scopeHostContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-contract-'));
  const host = new SqliteScopeHost({
    dir,
    checker: UNSAFE_allowAllChecker,
    // A fixed key: the contract suite asserts the credential round-trips and
    // never leaks, not that the ciphertext is unpredictable.
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    fetch: connectorTestFetch,
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// The permission suite runs against the DEFAULT checker (the tuple engine).
permissionContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-perm-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// The schedule suite needs the DEFAULT checker too — the whole point is that the
// system grant resolves through the real tuple engine, not an allow-all.
scheduleContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-sched-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #770: sub-transactions. The DEFAULT checker — the K-34 assertion turns on a real
// `ctx.check` recording an authorization, which an allow-all never does.
atomicContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-atomic-'));
  const host = new SqliteScopeHost({
    dir,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
