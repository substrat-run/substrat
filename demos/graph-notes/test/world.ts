/**
 * The test world: a pure-adapter host with this vertical's modules and its declared scope store
 * bound to the runner a suite gives, one tenant and scope, and a person in each role.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { scopeStoreRunnersFor, SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, type ScopeStoreRunner } from '@substrat-run/kernel';
import { graphNotesManifest, SCOPE_STORES } from '../src/manifest.js';
import { graphNotes, type Caller } from '../src/notes.js';
import { MODULES, permissions, ROLES } from '../src/provision.js';

export interface World {
  readonly host: SqliteScopeHost;
  readonly notes: ReturnType<typeof graphNotes>;
  readonly admin: Caller;
  readonly writer: Caller;
  readonly reader: Caller;
  close(): Promise<void>;
}

export async function buildWorld(graph: ScopeStoreRunner): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'graph-notes-'));
  const host = new SqliteScopeHost({
    dir,
    permissions,
    scopeStores: { vertical: 'graph-notes', runners: scopeStoreRunnersFor(SCOPE_STORES, { graph }) },
  });
  for (const m of MODULES) host.registerModule(m);

  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `graph-notes-${t.toLowerCase()}`, name: 'Graph notes' });
  await host.admin.grantEntitlement(staff, t, graphNotesManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'graph-notes' });
  await host.admin.activateScope(staff, t, s);
  for (const role of ROLES) await host.admin.defineRole(staff, t, role);

  const person = async (roleKey: string): Promise<Caller> => {
    const principal: PrincipalId = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: principal, roleKey, node: { tenantId: t, scopeId: s } });
    return { principal, tenantId: t, scopeId: s };
  };

  return {
    host,
    notes: graphNotes(host),
    admin: await person('admin'),
    writer: await person('writer'),
    reader: await person('reader'),
    async close() {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
