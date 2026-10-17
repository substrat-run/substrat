import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import Database from 'better-sqlite3';
import { UPL_READ, UPL_WRITE, uploadLinkMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #2314: a scope whose vertical holds no blob store keeps no files, so a pass over it answers that,
 * marked `bucket: 'none'`, instead of failing every time the platform's sweep visits it. The mark is
 * what keeps it apart from a store that held nothing, which answers unmarked; and the guards still
 * come first, so a pass the scope may not take is refused, not answered "no store".
 */
describe('orphan sweep over a scope with no blob store (#2314)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;

  const scope = async (vertical: string): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
    await host.admin.activateScope(staff, t, s);
    return s;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-orphan-no-store-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    await host.admin.createTenant(staff, { id: t, slug: `ns-${t.toLowerCase()}`, name: 'No store' });
    await host.admin.createTenant(staff, { id: other, slug: `ns-${other.toLowerCase()}`, name: 'Elsewhere' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers bucket 'none' for a vertical with no store, and refuses another tenant's pass first", async () => {
    const s = await scope('no-files');
    expect(await host.sweepOrphanAttachments(t, s, { dryRun: true })).toEqual({
      listed: 0, candidates: 0, orphans: 0, deleted: 0, keys: [], dryRun: true, bucket: 'none',
    });
    await expect(host.sweepOrphanAttachments(other, s)).rejects.toThrow();
  });

  it('a scope that holds an attachment row but whose store is gone fails: its binding is missing', async () => {
    const alice = principalId.parse(ulid());
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'lost-store', binding: 'ATTACHMENTS' });
    host.registerModule(uploadLinkMod);
    await host.admin.grantEntitlement(staff, t, 'upl');
    await host.admin.defineRole(staff, t, { key: 'owner', permissions: [UPL_READ, UPL_WRITE], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t, scopeId: null } });
    const s = await scope('lost-store');
    await (await host.attachments(alice, t, s)).upload({
      entity: { entityType: 'udoc', entityId: 'doc-1' },
      filename: 'a.txt',
      contentType: 'text/plain',
      visibility: 'internal',
      body: new TextEncoder().encode('kept'),
    });
    // The store's directory row removed, as a store that was never provisioned for the tenant.
    (host as unknown as { directory: Database.Database }).directory
      .prepare('DELETE FROM blob_stores WHERE tenant_id = ? AND vertical = ?')
      .run(t, 'lost-store');
    await expect(host.sweepOrphanAttachments(t, s, { dryRun: true })).rejects.toThrow(/holds attachment rows.*store binding is missing/);
  });

  it('a vertical whose store holds nothing answers unmarked', async () => {
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'with-files', binding: 'ATTACHMENTS' });
    const s = await scope('with-files');
    const report = await host.sweepOrphanAttachments(t, s, { dryRun: true });
    expect(report).toEqual({ listed: 0, candidates: 0, orphans: 0, deleted: 0, keys: [], dryRun: true });
    // A dry run that found nothing licenses no destructive pass (#2350).
    await expect(host.sweepOrphanAttachments(t, s)).rejects.toThrow(/no orphan-sweep dry run/);
  });
});
