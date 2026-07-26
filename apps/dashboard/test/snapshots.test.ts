import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { MODULES, provisionDashboard, type DashboardNode } from '../src/index.js';
import { createApp, snapshotApp, listAppSnapshots, deleteAppSnapshot } from '../src/provision.js';

/**
 * The Snapshots tab's backend, embedded mode (preview-and-snapshots.md §3): the
 * check-then-effect helpers the worker routes call. Authorization runs in the
 * caller's own dashboard scope (`dashboard/snapshot-app` gates on
 * dashboard:provision-app); the effect is the platform fork. Connected mode routes
 * the same calls through the tenant-narrowed control plane instead — that seam is
 * covered by authority.test.ts.
 */
describe('Dashboard snapshots — create, list, expire, delete', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let staff = platformActorId.parse(ulid());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-snapshots-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m);
    staff = platformActorId.parse(ulid());
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeTeamWithApp = async (): Promise<{ node: DashboardNode; appScope: ReturnType<typeof scopeId.parse> }> => {
    const node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'acme',
      name: 'Acme',
    });
    // An app scope in the same tenant — embedded mode, so it lives in this host.
    const appScope = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: node.tenantId, scopeId: appScope, vertical: 'callout' });
    await host.admin.activateScope(staff, node.tenantId, appScope);
    return { node, appScope };
  };

  it('creates a TTL’d copy, lists it with provenance, and deletes it', async () => {
    const { node, appScope } = await makeTeamWithApp();

    const created = await snapshotApp(host, { node, appScopeId: appScope, ttlDays: 7 });
    expect(created.expiresAt).not.toBeNull();

    const listed = await listAppSnapshots(host, { node, appScopeId: appScope });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);
    expect(listed[0]!.forkedFrom).toBe(appScope);
    expect(listed[0]!.kind).toBe('archive');
    expect(listed[0]!.expiresAt).toBe(created.expiresAt);

    await deleteAppSnapshot(host, {
      node,
      appScopeId: appScope,
      snapshotScopeId: scopeId.parse(created.id),
    });
    expect(await listAppSnapshots(host, { node, appScopeId: appScope })).toHaveLength(0);
    expect(await host.admin.getScopeRecord(staff, node.tenantId, scopeId.parse(created.id))).toBeUndefined();
  });

  it('binds a `--s` preview URL to the copy, and delete removes it', async () => {
    const { node, appScope } = await makeTeamWithApp();
    const created = await snapshotApp(host, {
      node,
      appScopeId: appScope,
      ttlDays: 7,
      appHostname: 'acme-hr.global.substrat.run',
    });
    // The copy's URL: the app's own label + a `--s<tail>` tag — never the bare label.
    expect(created.url).toMatch(/^acme-hr--s[a-z0-9]{4}\.global\.substrat\.run$/);

    const listed = await listAppSnapshots(host, { node, appScopeId: appScope });
    expect(listed[0]!.url).toBe(created.url);

    await deleteAppSnapshot(host, {
      node,
      appScopeId: appScope,
      snapshotScopeId: scopeId.parse(created.id),
    });
    // The binding went with the copy — the preview URL stops resolving.
    expect(await host.admin.listHostnames(staff, { scopeId: scopeId.parse(created.id) })).toHaveLength(0);
  });

  it('new apps get team-suffixed hostnames (`<app>-<team>`)', async () => {
    const node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'sesamy-x1',
      name: 'Sesamy',
    });
    const appRow = await createApp(host, {
      node,
      appScopeId: scopeId.parse(ulid()),
      verticalSlug: 'callout',
      name: 'Callout',
      teamHandle: 'sesamy',
    });
    expect(appRow.hostname).toBe('callout-sesamy.global.substrat.run');
  });

  it('a copy with no TTL is pinned (expiresAt null)', async () => {
    const { node, appScope } = await makeTeamWithApp();
    const created = await snapshotApp(host, { node, appScopeId: appScope });
    expect(created.expiresAt).toBeNull();
    const listed = await listAppSnapshots(host, { node, appScopeId: appScope });
    expect(listed[0]!.expiresAt).toBeNull();
  });

  it('the snapshot ops require app-management authority', async () => {
    const { node, appScope } = await makeTeamWithApp();
    // A principal with NO role in this tenant cannot snapshot: the in-scope check
    // (dashboard:provision-app) refuses before any platform effect.
    const stranger: DashboardNode = { ...node, principal: principalId.parse(ulid()) };
    await expect(snapshotApp(host, { node: stranger, appScopeId: appScope })).rejects.toThrow(
      /permission denied/,
    );
    expect(await listAppSnapshots(host, { node, appScopeId: appScope })).toHaveLength(0);
  });
});
