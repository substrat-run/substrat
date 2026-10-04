import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { moduleId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { permMod } from '@substrat-run/contract-tests';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

it('adds the lease columns to a scope built before them, and drives its runs (#2034)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-job-lease-'));
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const PERM = moduleId.parse('@test/perm');
  const open = () => {
    const h = new SqliteScopeHost({ dir, secretBox });
    h.registerModule(permMod);
    h.registerJob(PERM, 'walk', () => ({ done: true }));
    return h;
  };
  let host = open();
  try {
    await host.admin.createTenant(staff, { id: t, slug: `job-lease-${ulid().toLowerCase()}`, name: 'Job lease' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
    const old = await host.startJobRun(t, s, { moduleId: PERM, job: 'walk' });
    await host.close();
    const db = new Database(join(dir, `${t}__${s}.sqlite`));
    try { db.exec('ALTER TABLE _substrat_job_runs DROP COLUMN lease_owner'); db.exec('ALTER TABLE _substrat_job_runs DROP COLUMN lease_entered_at'); db.exec('ALTER TABLE _substrat_job_runs DROP COLUMN admission_misses'); }
    finally { db.close(); }

    host = open();
    expect(await host.runDueJobs(t, s)).toMatchObject({ attempted: 1, completed: 1 });
    expect((await host.jobRuns(t, s)).find((run) => run.id === old.id)).toMatchObject({ status: 'done', leaseOwner: null });
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
