import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { dataSubjectId, moduleId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { permMod } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('upgrades legacy job runs on wake and tolerates a second wake (#1632)', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE, controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  host.registerModule(permMod);
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `job-subject-${ulid().toLowerCase()}`, name: 'Job subject' });
  await host.admin.grantEntitlement(staff, t, 'perm');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
  try {
    await host.admin.activateScope(staff, t, s);
    const subject = dataSubjectId.parse(ulid());
    const input = { moduleId: moduleId.parse('@test/perm'), job: 'walk', payload: { contact: subject } };
    const old = await host.startJobRun(t, s, input);
    const fresh = () => env.SCOPE.get(env.SCOPE.idFromName(s));
    await runInDurableObject(fresh(), (_instance, state) => {
      state.storage.sql.exec('ALTER TABLE _substrat_job_runs DROP COLUMN subject_id');
      state.abort('evicted for subject column upgrade');
    }).catch(() => undefined);
    expect(await host.startJobRun(t, s, input)).toMatchObject({ id: old.id, subject: null, payload: input.payload });
    const declared = await host.startJobRun(t, s, { ...input, instance: 'declared', subject });
    expect(declared.subject).toBe(subject);
    await runInDurableObject(fresh(), (_instance, state) => {
      state.abort('evicted to check repeat subject column upgrade');
    }).catch(() => undefined);
    expect((await host.jobRuns(t, s)).find((run) => run.id === declared.id)?.subject).toBe(subject);
  } finally {
    await host.admin.archiveScope(staff, t, s);
  }
});
