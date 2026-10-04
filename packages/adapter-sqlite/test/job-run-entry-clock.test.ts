import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { moduleId, platformActorId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { permMod } from '@substrat-run/contract-tests';
import { JOB_LEASE_MIN_MS, manualClock, ulid, webCryptoSecretBox, type JobRunStore } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #2042 review r3: an ENTRY is judged by the host's clock as the statement runs, never by a deadline
 * its driver computed before the call. The store is reached directly — the drive gives a test no
 * seam between its claim and its entry — and the clock is moved between the two, as a call that
 * waited in the scope's queue would see it.
 */
it('an entry that runs after its lease expired stamps nothing, and the next drive runs the run once (#2042 r3)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-job-entry-'));
  const clock = manualClock('2026-10-05T00:00:00.000Z');
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)), clock: clock.read });
  const PERM = moduleId.parse('@test/perm');
  let invoked = 0;
  host.registerModule(permMod);
  host.registerJob(PERM, 'walk', () => ((invoked += 1), { done: true }), { maxAttempts: 1 }, { leaseMs: JOB_LEASE_MIN_MS });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  try {
    await host.admin.createTenant(staff, { id: t, slug: `job-entry-${ulid().toLowerCase()}`, name: 'Job entry' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
    const run = await host.startJobRun(t, s, { moduleId: PERM, job: 'walk' });
    const internals = host as unknown as {
      runtime(t: TenantId, s: ScopeId): unknown;
      jobStore(rt: unknown): JobRunStore;
    };
    const store = internals.jobStore(internals.runtime(t, s));
    const row = async () => (await store.list({})).find((r) => r.id === run.id)!;
    const margin = JOB_LEASE_MIN_MS / 4;

    const at = clock.read();
    expect(await store.claim(run.id, 'late-entry', at, new Date(Date.parse(at) + JOB_LEASE_MIN_MS).toISOString())).not.toBeNull();
    clock.advance(JOB_LEASE_MIN_MS + 1); // the entry reaches the scope after the lease is over
    expect(await store.enter(run.id, 'late-entry', margin)).toBe(false);
    expect(await row()).toMatchObject({ lease_owner: 'late-entry', lease_entered_at: null });

    // Never entered, so the next drive takes it over for free and runs it, on `maxAttempts: 1`.
    expect(await host.runDueJobs(t, s)).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
    expect(invoked).toBe(1);
    expect((await host.jobRuns(t, s)).find((r) => r.id === run.id)).toMatchObject({ status: 'done', attempts: 0 });
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('twin: an entry that runs in time stamps the lease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-job-entry-'));
  const clock = manualClock('2026-10-05T00:00:00.000Z');
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)), clock: clock.read });
  const PERM = moduleId.parse('@test/perm');
  host.registerModule(permMod);
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  try {
    await host.admin.createTenant(staff, { id: t, slug: `job-entry-${ulid().toLowerCase()}`, name: 'Job entry' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
    const run = await host.startJobRun(t, s, { moduleId: PERM, job: 'walk' });
    const internals = host as unknown as {
      runtime(t: TenantId, s: ScopeId): unknown;
      jobStore(rt: unknown): JobRunStore;
    };
    const store = internals.jobStore(internals.runtime(t, s));
    const at = clock.read();
    await store.claim(run.id, 'prompt-entry', at, new Date(Date.parse(at) + JOB_LEASE_MIN_MS).toISOString());
    clock.advance(JOB_LEASE_MIN_MS / 2); // half the lease left: more than the margin
    expect(await store.enter(run.id, 'prompt-entry', JOB_LEASE_MIN_MS / 4)).toBe(true);
    expect((await store.list({})).find((r) => r.id === run.id)).toMatchObject({ lease_entered_at: clock.read() });
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
