import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  connectionId, dataSubjectId, errorCodeOf, moduleManifest, permissionKey,
  platformActorId, principalId, scopeId, tenantId, type ScopeId,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

// SQLite-local: Cloudflare's admin RPC does not yet preserve these typed refusals.
const doors = [
  'restore', 'snapshot', 'deleteSnapshot', 'principal', 'connector', 'attachments',
  'impersonation', 'system', 'migrate', 'subjectKeys', 'transition', 'connectionGrant',
  'hostname', 'version', 'provisioned', 'servingRef', 'expiry', 'bookmarks', 'reap',
  'scopeRead', 'scopeWrite',
] as const;

describe('unknown scope refusals', () => {
  it.each(doors)('%s: missing and foreign scopes are typed, unchanged; own scope succeeds', async (door) => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-unknown-scope-'));
    const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test', new Uint8Array(32).fill(7)) });
    const staff = platformActorId.parse(ulid());
    const principal = principalId.parse(ulid());
    const own = tenantId.parse(ulid());
    const foreign = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const other = scopeId.parse(ulid());
    const missing = scopeId.parse(ulid());
    const conn = connectionId.parse(ulid());
    const version = ulid();
    const subject = dataSubjectId.parse(ulid());
    const manifest = moduleManifest.parse({
      attachmentTargets: [], entitlementKey: 'refusals',
      id: '@test/refusals', version: '1.0.0', kernelContract: '^0.0.1', permissions: [],
      events: { emits: [], consumes: [] }, migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    });
    let directory: Database.Database | undefined;
    try {
      host.registerModule({ manifest, migrations: [], operations: {} });
      await host.admin.createTenant(staff, { id: own, slug: 'own', name: 'Own' });
      await host.admin.createTenant(staff, { id: foreign, slug: 'foreign', name: 'Foreign' });
      await host.admin.grantEntitlement(staff, own, 'refusals');
      await host.admin.grantEntitlement(staff, foreign, 'refusals');
      for (const [tenant, scope] of [[own, s], [foreign, other]] as const) {
        await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'callout', kind: 'preview' });
        await host.admin.activateScope(staff, tenant, scope);
      }
      await host.admin.createConnection(staff, {
        id: conn, tenantId: own, vertical: 'callout', provider: 'test', label: 'Test', secret: { token: 'test' },
      });
      await host.admin.registerVertical(staff, { slug: 'callout', name: 'Callout', source: 'builtin' });
      await host.admin.publishVersion(staff, {
        id: version, verticalSlug: 'callout', version: '1.0.0', manifestDigest: 'm1',
        permissionDigest: 'p1', migrationDigest: 'g1', deploymentRef: null,
      });
      await host.provisionBlobStore(staff, { tenantId: own, vertical: 'callout', binding: 'ATTACHMENTS' });
      const dump = await host.admin.exportScope(staff, own, s);
      const session = await host.admin.beginImpersonation(staff, {
        tenantId: own, scopeId: s, principal, reason: 'Test scope confinement',
      });
      directory = new Database(join(dir, '_directory.sqlite'));
      if (door === 'reap') await host.admin.archiveScope(staff, own, s);
      const call = (target: ScopeId): Promise<unknown> => {
        switch (door) {
          case 'restore': return host.restoreScope(staff, own, target, dump);
          case 'snapshot': return host.snapshotScope(staff, own, target);
          case 'deleteSnapshot': return host.deleteSnapshot(staff, own, target);
          case 'principal': return host.getScope(principal, own, target);
          case 'connector': return host.getConnectorScope(conn, target);
          case 'attachments': return host.getConnectorAttachments(conn, target);
          case 'impersonation': return host.getImpersonatedScope(session.id, own, target);
          case 'system': return host.getSystemScope(manifest.id, own, target);
          case 'migrate': return host.migrateScope(own, target);
          case 'subjectKeys': return host.admin.sealSubjectPayloads(staff, own, target, [{ subjectId: subject, plaintext: 'canary' }]);
          case 'transition': return host.admin.suspendScope(staff, own, target);
          case 'connectionGrant': return host.admin.grantToConnection(staff, { connectionId: conn, permission: permissionKey.parse('test:read'), node: { tenantId: own, scopeId: target }, grantedBy: staff });
          case 'hostname': return host.admin.bindHostname(staff, { hostname: 'refusal.example.test', tenantId: own, scopeId: target, surface: 'app', region: null, canonical: true });
          case 'version': return host.admin.bindScopeVersion(staff, own, target, version);
          case 'provisioned': return host.admin.markScopeProvisioned(staff, own, target, version);
          case 'servingRef': return host.admin.setScopeServingRef(staff, own, target, 'test-ref');
          case 'expiry': return host.admin.setScopeExpiresAt(staff, own, target, '2099-01-01T00:00:00.000Z');
          case 'bookmarks': return host.admin.scopeMigrationBookmarks(staff, own, target);
          case 'reap': return host.admin.reapScope(staff, own, target, { force: true });
          case 'scopeRead': return host.admin.listScopeTables(staff, own, target);
          case 'scopeWrite': return host.admin.markEventsDrained(staff, own, target, []);
        }
      };
      // Compare every stored row, including mutation audits and subject keys. The three
      // snapshot doors retain their existing getScopeRecord access audit on a refusal.
      const state = () => readdirSync(dir, { recursive: true }).filter((p): p is string => typeof p === 'string' && p.endsWith('.sqlite')).sort().map((file) => {
        const db = new Database(join(dir, file), { readonly: true });
        try {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
          return [file, tables.filter(({ name }) => name !== '_substrat_access_log').map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()])];
        } finally { db.close(); }
      });
      for (const target of [missing, other]) {
        if (door === 'impersonation') {
          // Model a stale/misbound session. The public issuer correctly refuses to mint
          // these; the public door must still validate the scope after session validation.
          directory.prepare('UPDATE _substrat_impersonations SET scope_id = ? WHERE id = ?').run(target, session.id);
        }
        const accessBefore = directory.prepare('SELECT * FROM _substrat_access_log ORDER BY id').all();
        const before = state();
        const files = readdirSync(dir, { recursive: true }).sort();
        let refusal: unknown;
        try { await call(target); } catch (error) { refusal = error; }
        expect(errorCodeOf(refusal)).toBe('not_found');
        const message = ['connector', 'attachments'].includes(door) ? `unknown scope for connection: ${target}`
          : door === 'system' ? `unknown scope: ${target}`
          : ['restore', 'snapshot', 'deleteSnapshot', 'connectionGrant', 'hostname', 'version', 'provisioned', 'servingRef', 'expiry', 'bookmarks'].includes(door)
            ? `unknown scope ${target} in tenant ${own}` : `unknown scope for tenant: (${own}, ${target})`;
        expect(refusal).toHaveProperty('message', message);
        expect(state()).toEqual(before);
        const accessAfter = directory.prepare('SELECT * FROM _substrat_access_log ORDER BY id').all();
        if (['restore', 'snapshot', 'deleteSnapshot'].includes(door)) {
          expect(accessAfter.slice(0, -1)).toEqual(accessBefore);
          expect(accessAfter.at(-1)).toMatchObject({ method: 'getScopeRecord', tenant_id: own, scope_id: target, result_count: 0 });
        } else {
          expect(accessAfter).toEqual(accessBefore);
        }
        expect(readdirSync(dir, { recursive: true }).sort()).toEqual(files);
      }
      if (door === 'impersonation') directory.prepare('UPDATE _substrat_impersonations SET scope_id = ? WHERE id = ?').run(s, session.id);
      await expect(call(s)).resolves.not.toThrow();
    } finally {
      directory?.close();
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
