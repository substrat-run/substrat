import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { moduleId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { permMod } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('adds the lease columns on wake to a scope DO built before them, and drives its runs (#2034)', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE, controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  const PERM = moduleId.parse('@test/perm');
  host.registerModule(permMod);
  host.registerJob(PERM, 'walk', () => ({ done: true }));
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `job-lease-${ulid().toLowerCase()}`, name: 'Job lease' });
  await host.admin.grantEntitlement(staff, t, 'perm');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
  try {
    await host.admin.activateScope(staff, t, s);
    const old = await host.startJobRun(t, s, { moduleId: PERM, job: 'walk' });
    const stub = () => env.SCOPE.get(env.SCOPE.idFromName(s));
    const columns = () =>
      runInDurableObject(stub(), (_instance, state) =>
        state.storage.sql.exec("SELECT name FROM pragma_table_info('_substrat_job_runs')").toArray().map((r) => r.name));
    // The drop commits in a call of its own: an abort in the same call breaks the output gate, and
    // the write it would have flushed is lost with it.
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec('ALTER TABLE _substrat_job_runs DROP COLUMN lease_owner');
      state.storage.sql.exec('ALTER TABLE _substrat_job_runs DROP COLUMN lease_entered_at');
    });
    expect(await columns()).not.toContain('lease_owner');
    expect(await columns()).not.toContain('lease_entered_at');
    await runInDurableObject(stub(), (_instance, state) => state.abort('evicted for lease column upgrade')).catch(() => undefined);
    expect(await host.runDueJobs(t, s)).toMatchObject({ attempted: 1, completed: 1 });
    expect((await host.jobRuns(t, s)).find((run) => run.id === old.id)).toMatchObject({ status: 'done', leaseOwner: null });
    expect(await columns()).toContain('lease_owner');
    expect(await columns()).toContain('lease_entered_at');
  } finally {
    await host.admin.archiveScope(staff, t, s);
  }
});
