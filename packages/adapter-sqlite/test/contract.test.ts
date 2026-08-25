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
  searchContractSuite,
  entityVersionContractSuite,
  concurrencyContractSuite,
  idempotencyContractSuite,
  listContractSuite,
  inputParseContractSuite,
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

// #827: the derived FTS index. Allow-all checker — the suite is about what the
// index answers, and the permission gate over a search operation is the
// vertical's own `assertAllowed`, exercised by the demo scenario.
searchContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-search-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #901: an entity's version is the last event's ULID. Allow-all checker for the
// same reason as search — the subject is what the spine answers, not the gate
// over the operation asking.
entityVersionContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-version-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #811: the same shape for `ctx.page`. Permission is likewise not this suite's
// subject — a page is a read, and the operation's own `assertAllowed` gates it.
listContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-list-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #893: the declared `input` is parsed by the HOST, before guards and handler.
// The DEFAULT checker: the fixture's handlers run a real `ctx.check`, and
// allow-all cannot answer one — it builds its synthetic proof by interpolating
// the subject, which is a structured actor.
inputParseContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-parse-'));
  const host = new SqliteScopeHost({ dir });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #129: optimistic concurrency, on the DEFAULT checker. The suite grants a real
// role, because a precondition that only ever runs behind an allow-all has not
// been shown to run in the order the contract claims — before the guards, and
// after the permission check that would otherwise have refused the caller first.
concurrencyContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-conc-'));
  const host = new SqliteScopeHost({ dir });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

// #116: request idempotency, on the DEFAULT checker for the same reason the
// suite above uses one — a recording written behind an allow-all has not been
// shown to be written after the permission check that guards it.
idempotencyContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-idem-'));
  const host = new SqliteScopeHost({ dir });
  return {
    host,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
