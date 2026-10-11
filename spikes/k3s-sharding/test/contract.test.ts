/**
 * `scopeHostContractSuite`, unchanged (D-14), against the host a shard builds: a
 * `SqliteScopeHost` behind the lease/fence layer, its leases taken from the real
 * control-plane process over HTTP.
 *
 * What this shows: the fence wraps every stub the host mints and still breaks no part of the
 * contract — every invocation in the suite went through an `admit` and a `stillHeld`.
 *
 * What it does NOT show, stated where the binding is: the issue's "the multi-process host
 * passes the contract suite". The suite runs in this process, against one host. A host whose
 * scopes live in other processes cannot run it today, for two reasons that are the rest of
 * the real adapter (FINDINGS.md, top):
 *   - the suite registers executors and handlers as closures over its own test state
 *     (`effected.push(…)`), which cannot run in a shard process; and
 *   - it drives the directory (`host.admin`: tenants, grants, audit) on the same object as
 *     the scopes, and a directory every shard shares is question 5.
 */
import { afterAll, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { connectorTestFetch, scopeHostContractSuite } from '@substrat-run/contract-tests';
import { fenceScopeHost, type ScopeGuard } from '../src/fence.js';
import { LeaseClient, LeaseGuard } from '../src/lease-client.js';
import { Cluster } from './cluster.js';

// Counted, so a pass cannot come from a wrapper that wrapped nothing: every invocation the
// suite made was admitted, every one that returned was re-checked, and there are hundreds.
// (Fewer checks than admissions: an invocation the suite expects to be refused throws
// before the re-check, and the refusal reaches it unchanged.)
const seen = { admitted: 0, checked: 0, scopes: new Set<string>() };
afterAll(() => {
  expect(seen.admitted).toBeGreaterThan(200);
  expect(seen.checked).toBeGreaterThan(200);
  expect(seen.checked).toBeLessThan(seen.admitted);
  expect(seen.scopes.size).toBeGreaterThan(3);
});

scopeHostContractSuite('k3s-sharding: sqlite behind the lease fence', async () => {
  const cluster = await new Cluster({ shards: 0, routerTimeoutsMs: [], leaseTtlMs: 5_000 }).start();
  const guard = new LeaseGuard(new LeaseClient(cluster.controlPlane, 'todo-0', 500));
  guard.startRenewing(1_000);
  const dir = mkdtempSync(join(tmpdir(), 'k3s-sharding-contract-'));
  const inner = new SqliteScopeHost({
    dir,
    checker: UNSAFE_allowAllChecker,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    fetch: connectorTestFetch,
  });
  return {
    host: fenceScopeHost(inner, counted(guard)),
    cleanup: async () => {
      guard.stop();
      await inner.close();
      rmSync(dir, { recursive: true, force: true });
      await cluster.stop();
    },
  };
});

function counted(guard: ScopeGuard): ScopeGuard {
  return {
    admit: (scope) => {
      seen.admitted++;
      seen.scopes.add(scope);
      return guard.admit(scope);
    },
    stillHeld: (scope) => {
      seen.checked++;
      return guard.stillHeld(scope);
    },
  };
}
