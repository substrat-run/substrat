/**
 * A job-store write must not land inside somebody else's open transaction (#1577).
 *
 * `invoke` opens a raw `BEGIN IMMEDIATE` on the scope's connection and HOLDS IT ACROSS
 * AWAITS — its guards, its handler. The run driver deliberately does NOT take the scope
 * actor for a whole pass, because a pass may take an hour and holding the scope's lock
 * for it would stop every request on that scope. The first cut drew the wrong conclusion
 * from that and issued the store's statements on `rt.db` with no turn at all, under a
 * comment claiming they "interleave exactly as any other write does". They do not: a
 * statement issued while an unrelated operation was mid-flight executed inside THAT
 * operation's transaction and rolled back with it. A step whose effect had already
 * happened would lose its ledger row and run a second time, for a reason having nothing
 * to do with the job.
 *
 * ADAPTER-SPECIFIC, which is why it is here and not in the shared conformance suite: the
 * hazard is `better-sqlite3` transaction scoping on one shared connection. The Durable
 * Object has no equivalent — its storage is per-instance and its RPCs serialize — so a
 * shared-suite version would assert nothing on the hosted side.
 *
 * The lever is an operation that suspends mid-transaction. `defineOperation` is used
 * rather than a fixture module because the handler has to be a closure the test controls.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleId, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { jobsMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

describe('a job-store write survives a concurrent operation that rolls back (#1577)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-job-turn-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const alice = principalId.parse(ulid());
  const JOBS = moduleId.parse('@test/jobs');

  /** Released by the test, so the operation's transaction stays open until then. */
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  beforeAll(async () => {
    host.registerModule(jobsMod);
    host.registerJob(JOBS, 'noop', () => ({ done: true }));
    // Suspends inside its own `BEGIN IMMEDIATE`, then throws so the transaction is
    // ROLLED BACK — which is what makes the assertion sharp. A commit would hide the
    // bug: the job row would be carried along by someone else's COMMIT and look fine.
    host.defineOperation('gate/hold', async () => {
      await held;
      throw new Error('this operation always rolls back');
    });
    await host.admin.createTenant(staff, { id: t, slug: `job-turn-${ulid().toLowerCase()}`, name: 'Job turn' });
    await host.admin.grantEntitlement(staff, t, 'jobs');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'jobs-vertical' });
    await host.admin.activateScope(staff, t, s);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts a run while an operation holds an open transaction, and keeps it', async () => {
    const stub = await host.getScope(alice, t, s);

    // In flight and suspended: its transaction is open on the scope's connection.
    const blocked = stub.invoke('gate/hold');
    // Deliberately NOT awaited before the release — with the store taking a turn this
    // cannot finish until the operation above has, and awaiting it here would deadlock
    // the test rather than fail it. That ordering IS the fix being exercised.
    const starting = host.startJobRun(t, s, { moduleId: JOBS, job: 'noop', instance: 'held' });

    release();
    await expect(blocked).rejects.toThrow(/always rolls back/);
    const run = await starting;

    // The run is still there. Un-enqueued, its INSERT executed inside the operation's
    // transaction and went with the ROLLBACK, leaving `startJobRun` returning a row
    // that no longer existed — a run the caller has the id of and the scope has never
    // heard of.
    const runs = await host.jobRuns(t, s);
    expect(runs.map((r) => r.id)).toEqual([run.id]);
    expect(runs[0]!.status).toBe('running');
  });
});
