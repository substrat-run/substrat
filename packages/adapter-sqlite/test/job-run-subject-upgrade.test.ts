import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { dataSubjectId, moduleId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { permMod } from '@substrat-run/contract-tests';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

it('upgrades legacy job runs without guessing their subject (#1632)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-job-subject-'));
  const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  let host = new SqliteScopeHost({ dir, secretBox });
  try {
    host.registerModule(permMod);
    await host.admin.createTenant(staff, { id: t, slug: `job-subject-${ulid().toLowerCase()}`, name: 'Job subject' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
    const subject = dataSubjectId.parse(ulid());
    const input = { moduleId: moduleId.parse('@test/perm'), job: 'walk', payload: { contact: subject } };
    const old = await host.startJobRun(t, s, input);
    await host.close();
    const db = new Database(join(dir, `${t}__${s}.sqlite`));
    try { db.exec('ALTER TABLE _substrat_job_runs DROP COLUMN subject_id'); }
    finally { db.close(); }

    host = new SqliteScopeHost({ dir, secretBox });
    host.registerModule(permMod);
    expect(await host.startJobRun(t, s, input)).toMatchObject({ id: old.id, subject: null, payload: input.payload });
    const declared = await host.startJobRun(t, s, { ...input, instance: 'declared', subject });
    expect(declared.subject).toBe(subject);
    expect((await host.jobRuns(t, s)).find((run) => run.id === declared.id)?.subject).toBe(subject);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
