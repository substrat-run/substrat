/**
 * The signals `version` dimension on the outbox (#1242, the deferred half of #1231's
 * outbox stamp): a host handed a version REGISTRY id stamps it into every emitted
 * row's `version` column, and a host handed none stamps NULL — unstamped, never a
 * guessed value. The id arrives through host options, the same seam the deploy's
 * `SUBSTRAT_VERSION_ID` binding fills on the Cloudflare side, and deliberately NOT
 * from the co-located directory's `scopes` table: a column filled from data one
 * adapter can reach and the other cannot is value-level drift `lint:spine-ddl`
 * cannot see. The configured half of the Cloudflare twin lives in
 * adapter-cloudflare/test/version-stamp.test.ts; the NULL half lives here because
 * a worker's env is script-wide and cannot be absent for just one suite.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { UNSAFE_allowAllChecker, ulid } from '@substrat-run/kernel';
import { contractTestBareOps } from '@substrat-run/contract-tests';
import { SqliteScopeHost, type SqliteScopeHostOptions } from '../src/index.js';

interface OutboxRow {
  type: string;
  operation: string | null;
  version: string | null;
}

const VERSION = '01JTESTVRSN0000000000000AA';

describe('the outbox version stamp (#1242)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  const emittedRows = async (options: Partial<SqliteScopeHostOptions>): Promise<OutboxRow[]> => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-version-stamp-'));
    const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker, ...options });
    cleanups.push(async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    });
    for (const [name, handler] of Object.entries(contractTestBareOps)) {
      host.defineOperation(name, handler);
    }
    const staff = platformActorId.parse(ulid());
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t1, slug: `version-${ulid().toLowerCase()}`, name: 'Version' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'version-vertical' });
    await host.admin.activateScope(staff, t1, s1);
    const stub = await host.getScope(principalId.parse(ulid()), t1, s1);
    await stub.invoke('test/emit-event');
    return stub.invoke<OutboxRow[]>('test/read-outbox');
  };

  it('a host handed a versionId stamps it onto every emitted row', async () => {
    const rows = await emittedRows({ versionId: VERSION });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.version).toBe(VERSION);
  });

  it('a host handed no versionId stamps NULL — unstamped, not a guessed value', async () => {
    const rows = await emittedRows({});
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.version).toBeNull();
  });
});
