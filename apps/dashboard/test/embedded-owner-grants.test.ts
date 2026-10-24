import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moduleManifest, principalId, scopeId, tenantId, type PermissionKey } from '@substrat-run/contracts';
import { ulid, undeclaredOperations, type ModuleRegistration } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
// HARNESS ONLY, as in scenario.test.ts: the app's vertical is mounted in-process.
import { protocolModule, PROTOCOL_PERM } from '@substrat-run/engine-protocol';
import { MODULES, provisionDashboard, createApp, type DashboardNode } from '../src/index.js';
import { allApps } from '../src/walk-all.js';

/**
 * #2531: the owner grants an embedded install gives are judged at the scope that receives them.
 * K-55 leaves this path as is because `host.admin.grant` on the app's scope already refuses a key a
 * registered module reserves to a system principal; this pins that through the install itself.
 */
const RESERVED = 'rsvd:run' as PermissionKey;
const reservingModule: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@test/reserving',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: RESERVED, description: 'only a system principal may hold this', holder: 'system' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'rsvd',
  }),
  migrations: [],
  ...undeclaredOperations('a fixture that only reserves a key', {}),
};

describe('an embedded install’s owner grants meet the reserved-key rule (#2531)', () => {
  let dir: string;
  let host: SqliteScopeHost;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-owner-grants-'));
    host = new SqliteScopeHost({ dir });
    for (const m of [...MODULES, protocolModule, reservingModule]) host.registerModule(m);
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const bootstrap = (): Promise<DashboardNode> =>
    provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'acme',
      name: 'acme',
    });

  const install = (node: DashboardNode, appScopeId: ReturnType<typeof scopeId.parse>, appOwnerGrants: PermissionKey[]) =>
    createApp(host, { node, appScopeId, verticalSlug: 'protocol', name: 'Onboarding', appEntitlements: ['protocol'], appOwnerGrants });

  const statusOf = async (node: DashboardNode, appScopeId: ReturnType<typeof scopeId.parse>) =>
    (await allApps(await host.getScope(node.principal, node.tenantId, node.scopeId))).find((a) => a.app_scope_id === appScopeId)?.status;

  it('refuses an owner grant of a reserved key: the install fails, marked failed', async () => {
    const acme = await bootstrap();
    const appScopeId = scopeId.parse(ulid());
    await expect(install(acme, appScopeId, [PROTOCOL_PERM.read as PermissionKey, RESERVED])).rejects.toThrow(
      /rsvd:run cannot be granted to a principal, an org or a connection: reserved to a system principal/,
    );
    expect(await statusOf(acme, appScopeId)).toBe('failed');
  });

  it('…and its twin: the same install without the reserved key is active, and the owner holds its grant', async () => {
    const acme = await bootstrap();
    const appScopeId = scopeId.parse(ulid());
    expect((await install(acme, appScopeId, [PROTOCOL_PERM.read as PermissionKey])).status).toBe('active');
    expect(await statusOf(acme, appScopeId)).toBe('active');
    const appScope = await host.getScope(acme.principal, acme.tenantId, appScopeId);
    await expect(appScope.invoke('protocol/list-templates', {})).resolves.toBeDefined();
  });
});
