import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { MODULES, provisionDashboard, type DashboardNode } from '../src/index.js';
import { listAppHostnames, addAppHostname, removeAppHostname } from '../src/provision.js';

/**
 * The Domains tab's backend, embedded mode (K-26 multi-surface): the check-then-
 * effect helpers the worker's `/api/apps/:scopeId/hostnames` routes call. One scope
 * can front several apps — the hostname decides which surface the vertical serves —
 * so giving a surface a URL is binding a second hostname on the SAME scope.
 * Authorization runs in the caller's own dashboard scope (`dashboard/bind-app-hostname`
 * / `dashboard/unbind-app-hostname` gate on dashboard:provision-app); the effect is
 * the directory bind. Connected mode routes the same calls through the tenant-narrowed
 * control plane; the CP's own tenant-narrowing is covered by control-plane-api tests.
 */
describe('Dashboard surface hostnames — mint, custom domain, unbind', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let staff = platformActorId.parse(ulid());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-hostnames-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m);
    staff = platformActorId.parse(ulid());
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A team + an active app whose scope holds its default hostname, like a real install. */
  const makeTeamWithApp = async (): Promise<{
    node: DashboardNode;
    appScope: ReturnType<typeof scopeId.parse>;
    appHostname: string;
  }> => {
    const node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'egeryds',
      name: 'Egeryds',
    });
    const appScope = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: node.tenantId, scopeId: appScope, vertical: 'callout' });
    await host.admin.activateScope(staff, node.tenantId, appScope);
    const appHostname = 'crm-egeryds.global.substrat.run';
    await host.admin.bindHostname(staff, {
      hostname: appHostname,
      tenantId: node.tenantId,
      scopeId: appScope,
      surface: 'app',
      region: null,
      canonical: true,
    });
    await host.admin.setHostnameStatus(staff, appHostname, 'active');
    return { node, appScope, appHostname };
  };

  it('mints a platform hostname for a second surface — live immediately, canonical for its surface', async () => {
    const { node, appScope, appHostname } = await makeTeamWithApp();
    const bound = await addAppHostname(host, { node, appScopeId: appScope, surface: 'eka', appHostname });
    // The app's own label + the surface, on the same base — the K-26 acceptance shape.
    expect(bound).toMatchObject({
      hostname: 'crm-egeryds-eka.global.substrat.run',
      surface: 'eka',
      status: 'active',
      canonical: true,
    });
    // The router resolves it to the SAME scope with the surface the vertical branches on,
    // while the original URL still serves the default surface unchanged.
    expect(await host.admin.resolveHostname('crm-egeryds-eka.global.substrat.run')).toMatchObject({
      scopeId: appScope,
      surface: 'eka',
    });
    expect(await host.admin.resolveHostname(appHostname)).toMatchObject({ scopeId: appScope, surface: 'app' });
    // The activity trail names the act.
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    const events = (await dash.invoke('dashboard/app-events', { appScopeId: appScope })) as Array<{ kind: string; detail: string | null }>;
    const boundEvent = events.find((e) => e.kind === 'hostname-bound');
    expect(boundEvent?.detail).toContain('crm-egeryds-eka.global.substrat.run');
  });

  it('records a custom domain as pending — the §4.2 lifecycle, never active by wishing', async () => {
    const { node, appScope, appHostname } = await makeTeamWithApp();
    const bound = await addAppHostname(host, {
      node, appScopeId: appScope, surface: 'eka', customDomain: 'EKA.Egeryds.se', appHostname,
    });
    expect(bound).toMatchObject({ hostname: 'eka.egeryds.se', status: 'pending', canonical: true });
    // Pending does not serve.
    expect(await host.admin.resolveHostname('eka.egeryds.se')).toBeUndefined();
    // A second binding for the SAME surface is an alias — it never demotes the first.
    const alias = await addAppHostname(host, {
      node, appScopeId: appScope, surface: 'eka', customDomain: 'avstamning.egeryds.se', appHostname,
    });
    expect(alias.canonical).toBe(false);
    // A custom-domain form must not squat platform names — that path is the mint.
    await expect(
      addAppHostname(host, { node, appScopeId: appScope, surface: 'x', customDomain: 'other-tenant.global.substrat.run', appHostname }),
    ).rejects.toThrow(/platform name/);
  });

  it('lists, unbinds (trail recorded) — but never the default hostname', async () => {
    const { node, appScope, appHostname } = await makeTeamWithApp();
    await addAppHostname(host, { node, appScopeId: appScope, surface: 'eka', appHostname });

    const rows = await listAppHostnames(host, { node, appScopeId: appScope });
    expect(rows.map((h) => h.hostname).sort()).toEqual([
      'crm-egeryds-eka.global.substrat.run', appHostname,
    ].sort());

    await removeAppHostname(host, {
      node, appScopeId: appScope, hostname: 'crm-egeryds-eka.global.substrat.run', defaultHostname: appHostname,
    });
    expect(await host.admin.resolveHostname('crm-egeryds-eka.global.substrat.run')).toBeUndefined();
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    const events = (await dash.invoke('dashboard/app-events', { appScopeId: appScope })) as Array<{ kind: string }>;
    expect(events.some((e) => e.kind === 'hostname-unbound')).toBe(true);

    // The default hostname is the URL provisioning promised — retiring it is app
    // deletion, not a row action.
    await expect(
      removeAppHostname(host, { node, appScopeId: appScope, hostname: appHostname, defaultHostname: appHostname }),
    ).rejects.toThrow(/default hostname/);
    // A hostname that is not the app's reads as not bound.
    await expect(
      removeAppHostname(host, { node, appScopeId: appScope, hostname: 'nobody.example.com', defaultHostname: appHostname }),
    ).rejects.toThrow(/not bound/);
  });

  it('both halves require app-management authority, before any effect', async () => {
    const { node, appScope, appHostname } = await makeTeamWithApp();
    const stranger: DashboardNode = { ...node, principal: principalId.parse(ulid()) };

    await expect(
      addAppHostname(host, { node: stranger, appScopeId: appScope, surface: 'eka', appHostname }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      removeAppHostname(host, { node: stranger, appScopeId: appScope, hostname: appHostname }),
    ).rejects.toThrow(/permission denied/);
    // The refusals came before any directory effect: the default hostname still
    // serves, and no surface hostname appeared.
    expect(await host.admin.resolveHostname(appHostname)).toMatchObject({ scopeId: appScope });
    expect(await listAppHostnames(host, { node, appScopeId: appScope })).toHaveLength(1);
  });
});
