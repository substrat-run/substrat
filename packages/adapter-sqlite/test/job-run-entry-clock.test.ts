import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { moduleId, platformActorId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { permMod } from '@substrat-run/contract-tests';
import {
  JOB_LEASE_MIN_MS,
  manualClock,
  ulid,
  webCryptoSecretBox,
  type JobHandler,
  type JobRunStore,
  type ManualClock,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #2042 review r3, r4: every lease time on the pure host is ITS clock as the statement runs — the
 * claim's due test and expiry, BEGIN's margin, a miss's backoff — never a time its driver computed.
 * The store is reached directly, since a drive gives a test no seam between its claim and its
 * BEGIN, and the host's manual clock is moved between them as a call that waited would see it.
 */
const PERM = moduleId.parse('@test/perm');

async function hostWith(clock: ManualClock, handler: JobHandler = () => ({ done: true })) {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-job-begin-'));
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)), clock: clock.read });
  host.registerModule(permMod);
  host.registerJob(PERM, 'walk', handler, { maxAttempts: 1 }, { leaseMs: JOB_LEASE_MIN_MS });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `job-begin-${ulid().toLowerCase()}`, name: 'Job begin' });
  await host.admin.grantEntitlement(staff, t, 'perm');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
  await host.admin.activateScope(staff, t, s);
  const run = await host.startJobRun(t, s, { moduleId: PERM, job: 'walk' });
  const internals = host as unknown as { runtime(t: TenantId, s: ScopeId): unknown; jobStore(rt: unknown): JobRunStore };
  const store = internals.jobStore(internals.runtime(t, s));
  const row = async () => (await store.list({})).find((r) => r.id === run.id)!;
  return {
    host, t, s, run, store, row,
    cleanup: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

it('a BEGIN that runs after its lease expired stamps nothing, and the next drive runs the run once (#2042 r3)', async () => {
  const clock = manualClock('2026-10-05T00:00:00.000Z');
  let invoked = 0;
  const h = await hostWith(clock, () => ((invoked += 1), { done: true }));
  try {
    // The claim's expiry is the host's now plus the lease, by its own clock (#2042 r4).
    expect(await h.store.claim(h.run.id, 'late-begin', JOB_LEASE_MIN_MS)).not.toBeNull();
    expect(await h.row()).toMatchObject({
      lease_owner: 'late-begin',
      next_attempt_at: new Date(Date.parse(clock.read()) + JOB_LEASE_MIN_MS).toISOString(),
    });
    clock.advance(JOB_LEASE_MIN_MS + 1); // BEGIN reaches the scope after the lease is over
    expect(await h.store.begin(h.run.id, 'late-begin', JOB_LEASE_MIN_MS / 4)).toBe(false);
    expect(await h.row()).toMatchObject({ lease_owner: 'late-begin', lease_began_at: null });
    // Never begun, so the next drive takes it over for free and runs it, on `maxAttempts: 1`.
    expect(await h.host.runDueJobs(h.t, h.s)).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
    expect(invoked).toBe(1);
    expect((await h.host.jobRuns(h.t, h.s)).find((r) => r.id === h.run.id)).toMatchObject({ status: 'done', attempts: 0 });
  } finally {
    await h.cleanup();
  }
});

it('twin: a BEGIN in time stamps the lease; a miss counts relatively, and BEGIN clears the count', async () => {
  const clock = manualClock('2026-10-05T00:00:00.000Z');
  const h = await hostWith(clock);
  try {
    for (const [owner, expected] of [['a', 1], ['b', 2]] as const) {
      expect(await h.store.claim(h.run.id, owner, JOB_LEASE_MIN_MS)).not.toBeNull();
      expect(await h.store.miss(h.run.id, owner, 'slow')).toEqual({ misses: expected, failed: false });
      expect(await h.row()).toMatchObject({ admission_misses: expected, lease_owner: null });
      clock.set((await h.row()).next_attempt_at!); // its backoff, waited out
    }
    expect(await h.store.miss(h.run.id, 'b', 'stale')).toBeNull(); // no longer the holder: nothing written
    expect(await h.store.claim(h.run.id, 'c', JOB_LEASE_MIN_MS)).not.toBeNull();
    clock.advance(JOB_LEASE_MIN_MS / 2); // half the lease left: more than the margin
    expect(await h.store.begin(h.run.id, 'c', JOB_LEASE_MIN_MS / 4)).toBe(true);
    expect(await h.row()).toMatchObject({ lease_began_at: clock.read(), admission_misses: null });
    expect(await h.store.miss(h.run.id, 'c', 'late')).toBeNull(); // begun: committed, never a miss
  } finally {
    await h.cleanup();
  }
});
