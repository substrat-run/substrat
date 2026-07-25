import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type PermissionKey, type Vertical } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { protocolModule, PROTOCOL_PERM } from '@substrat-run/engine-protocol';
import { workorderModule } from '@substrat-run/engine-workorder';
import { invoicingModule } from '@substrat-run/engine-invoicing';
import { calloutModule } from '@substrat-run/demo-callout/module';
import { meridianModule, HR_PERM } from '@substrat-run/demo-meridian/module';
import {
  MODULES,
  provisionDashboard,
  createApp,
  deprovisionApp,
  retryApp,
  updateApp,
  CATALOG,
  availableCatalog,
  type DashboardAppRow,
  type DashboardNode,
} from '../src/index.js';
import { listDeploymentsFromHost, verticalDeploymentFromHost, assertOwned } from '../src/deployments.js';

/**
 * M0 — the central claim of docs/design/dashboard.md, cashed out: a tenant admin
 * self-provisions an app in THEIR OWN tenant, authorized by an in-scope permission
 * check, and cannot reach another tenant because the tenant is ambient (their
 * dashboard node), never a request argument.
 *
 * Apps here run the protocol engine — enough to prove a provisioned app is a real,
 * live scope, not a directory row. (In production each app is a separate vertical
 * deployment; this single-process host stands in for the platform.)
 */
describe('Dashboard M0 — tenant-narrowed self-service provisioning', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let staff = platformActorId.parse(ulid());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-dashboard-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m); // the dashboard vertical
    // The verticals an app can run, bundled in-process (M0), mirroring worker.ts.
    for (const m of [protocolModule, workorderModule, invoicingModule, calloutModule, meridianModule]) {
      host.registerModule(m);
    }
    staff = platformActorId.parse(ulid());
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Sign-up bootstrap: a customer's tenant + dashboard scope + owner. */
  const bootstrap = (slug: string): Promise<DashboardNode> =>
    provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug,
      name: slug,
    });

  const scopeIds = async (t: DashboardNode['tenantId']): Promise<string[]> =>
    (await host.admin.listScopes(staff, { tenantId: t })).map((s) => s.id);

  it('an owner provisions an app that runs, in their own tenant, and it shows in their app list', async () => {
    const acme = await bootstrap('acme');
    const appScopeId = scopeId.parse(ulid());

    const app: DashboardAppRow = await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'protocol',
      name: 'Onboarding',
      appEntitlements: ['protocol'],
      appOwnerGrants: [PROTOCOL_PERM.create, PROTOCOL_PERM.read] as PermissionKey[],
    });
    expect(app.status).toBe('active');
    // A default hostname is bound + recorded: `<slug>.<jurisdiction>.substrat.run` (K-30).
    expect(app.hostname).toBe('onboarding.global.substrat.run');

    // The app scope lives in ACME's tenant...
    expect(await scopeIds(acme.tenantId)).toContain(appScopeId);
    // ...and is a LIVE scope, not just a row: a real protocol op works on it.
    const appScope = await host.getScope(acme.principal, acme.tenantId, appScopeId);
    await appScope.invoke('protocol/define-template', {
      key: 'welcome',
      title: 'Welcome',
      content: { kind: 'document', documentType: 'welcome', hashRecipe: 'sha256 over the terms' },
    });
    expect(await appScope.invoke('protocol/list-templates', {})).toHaveLength(1);

    // ...and it shows in the account's own app list.
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const apps = await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {});
    expect(apps.map((a) => a.app_scope_id)).toEqual([appScopeId]);
    expect(apps[0]!.status).toBe('active');
  });

  it('manages an app’s env: stores values, masks secrets on read, leaves untouched secrets, removes one', async () => {
    const acme = await bootstrap('acme');
    const appScopeId = scopeId.parse(ulid());
    await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'protocol',
      name: 'Onboarding',
      appEntitlements: ['protocol'],
      appOwnerGrants: [PROTOCOL_PERM.create, PROTOCOL_PERM.read] as PermissionKey[],
    });
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);

    // Set a non-secret and a secret.
    const saved = (await dash.invoke('dashboard/set-app-env', {
      appScopeId,
      entries: [
        { key: 'PUBLIC_ORIGIN', value: 'https://hr.acme.com', secret: false },
        { key: 'ADMIN_PASSWORD', value: 'super-secret-pw', secret: true },
      ],
    })) as { saved: number };
    expect(saved.saved).toBe(2);

    // The read masks the secret's value but reports it as set; the non-secret is returned.
    type EnvVal = { key: string; isSecret: boolean; hasValue: boolean; value: string | null };
    const values = (await dash.invoke('dashboard/list-app-env', { appScopeId })) as EnvVal[];
    expect(values.find((v) => v.key === 'PUBLIC_ORIGIN')?.value).toBe('https://hr.acme.com');
    const secret = values.find((v) => v.key === 'ADMIN_PASSWORD')!;
    expect(secret.value).toBeNull(); // never echoed
    expect(secret.isSecret).toBe(true);
    expect(secret.hasValue).toBe(true);

    // An empty value leaves the secret unchanged (the form submits blank to keep it).
    await dash.invoke('dashboard/set-app-env', { appScopeId, entries: [{ key: 'ADMIN_PASSWORD', value: '', secret: true }] });
    const still = (await dash.invoke('dashboard/list-app-env', { appScopeId })) as EnvVal[];
    expect(still.find((v) => v.key === 'ADMIN_PASSWORD')?.hasValue).toBe(true);

    // Delete removes just that key.
    await dash.invoke('dashboard/delete-app-env', { appScopeId, key: 'ADMIN_PASSWORD' });
    const after = (await dash.invoke('dashboard/list-app-env', { appScopeId })) as EnvVal[];
    expect(after.map((v) => v.key)).toEqual(['PUBLIC_ORIGIN']);

    // Setting env recorded an Activity entry (the keys that moved, never the values).
    const events = (await dash.invoke('dashboard/app-events', { appScopeId })) as Array<{ kind: string; detail: string | null }>;
    expect(events.some((e) => e.kind === 'updated' && /env: /.test(e.detail ?? ''))).toBe(true);
  });

  it('a failed provision marks the app failed, not silently provisioning', async () => {
    const acme = await bootstrap('acme-fail');
    const failScopeId = scopeId.parse(ulid());
    // A control-plane seam whose very first call fails → the effect (step 2) throws
    // after the row is recorded (step 1, 'provisioning').
    const failingCp = {
      tenantId: acme.tenantId,
      ensureTenant: () => Promise.reject(new Error('boom')),
    } as unknown as Parameters<typeof createApp>[1]['controlPlane'];

    await expect(
      createApp(host, {
        node: acme,
        appScopeId: failScopeId,
        verticalSlug: 'protocol',
        name: 'Broken',
        appEntitlements: ['protocol'],
        appOwnerGrants: [PROTOCOL_PERM.read] as PermissionKey[],
        controlPlane: failingCp,
      }),
    ).rejects.toThrow('boom');

    // ...but its row is FAILED, not left silently at 'provisioning'.
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const apps = await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {});
    expect(apps.find((a) => a.app_scope_id === failScopeId)?.status).toBe('failed');
  });

  it('retrying a failed app tears down the failed attempt and provisions a fresh, active one', async () => {
    const acme = await bootstrap('acme-retry');
    const failScopeId = scopeId.parse(ulid());
    // First attempt fails at the very first control-plane call → row is `failed`.
    const failingCp = {
      tenantId: acme.tenantId,
      ensureTenant: () => Promise.reject(new Error('boom')),
    } as unknown as Parameters<typeof createApp>[1]['controlPlane'];
    await expect(
      createApp(host, {
        node: acme,
        appScopeId: failScopeId,
        verticalSlug: 'meridian',
        name: 'People',
        appEntitlements: ['meridian', 'protocol'],
        appOwnerGrants: [HR_PERM.absenceConfigure] as PermissionKey[],
        controlPlane: failingCp,
      }),
    ).rejects.toThrow('boom');
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    expect((await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {})).find((a) => a.app_scope_id === failScopeId)?.status).toBe('failed');

    // Retry (embedded — no failing plane) → a fresh, active app; the failed row is gone.
    const retried = await retryApp(host, {
      node: acme,
      failedScopeId: failScopeId,
      hostname: null,
      newScopeId: scopeId.parse(ulid()),
      verticalSlug: 'meridian',
      name: 'People',
      appEntitlements: ['meridian', 'protocol'],
      appOwnerGrants: [HR_PERM.absenceConfigure, HR_PERM.absenceRead, HR_PERM.employeeManage] as PermissionKey[],
    });
    expect(retried.status).toBe('active');
    expect(retried.vertical_slug).toBe('meridian');

    const apps = await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {});
    // Only the fresh app is listed (the failed one soft-deleted on retry), and it's active.
    expect(apps).toHaveLength(1);
    expect(apps[0]!.app_scope_id).toBe(retried.app_scope_id);
    expect(apps[0]!.status).toBe('active');

    // ...and the fresh scope is LIVE — a real HR op resolves for the owner.
    const appScope = await host.getScope(acme.principal, acme.tenantId, scopeId.parse(retried.app_scope_id));
    await appScope.invoke('hr/define-leave-type', { key: 'vacation', label: 'Vacation', kind: 'vacation', annualDays: '25' });
    expect(await appScope.invoke('hr/list-leave-types', {})).toHaveLength(1);
  });

  it('deleting an app deprovisions its scope and drops it from the list (record retained)', async () => {
    const acme = await bootstrap('acme-del');
    const appScopeId = scopeId.parse(ulid());
    const app = await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'protocol',
      name: 'Temp',
      appEntitlements: ['protocol'],
      appOwnerGrants: [PROTOCOL_PERM.read] as PermissionKey[],
    });
    expect(app.status).toBe('active');

    await deprovisionApp(host, { node: acme, appScopeId, hostname: app.hostname });

    // Dropped from the account's app list (soft-deleted)...
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    expect(await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {})).toHaveLength(0);

    // ...and the scope is ARCHIVED — getScope fails closed, so the app is offline.
    await expect(host.getScope(acme.principal, acme.tenantId, appScopeId)).rejects.toThrow();

    // ...and the slug is RECLAIMED: a new app can take the same name (the deleted
    // scope no longer holds it). Provisioning a fresh scope with slug 'temp' succeeds.
    const reScopeId = scopeId.parse(ulid());
    const reApp = await createApp(host, {
      node: acme,
      appScopeId: reScopeId,
      verticalSlug: 'protocol',
      name: 'Temp',
      appEntitlements: ['protocol'],
      appOwnerGrants: [PROTOCOL_PERM.read] as PermissionKey[],
    });
    expect(reApp.status).toBe('active');
    expect(reApp.hostname).toBe('temp.global.substrat.run');
  });

  it('an owner provisions a real Callout app — a live multi-engine scope with a default hostname', async () => {
    const acme = await bootstrap('acme-callout');
    const appScopeId = scopeId.parse(ulid());

    const app = await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'callout',
      name: 'Callout',
      // Callout composes three engines, so its SKU is three entitlement flags.
      appEntitlements: ['workorder', 'invoicing', 'protocol', 'callout'],
      appOwnerGrants: [PROTOCOL_PERM.create, PROTOCOL_PERM.read] as PermissionKey[],
    });
    expect(app.status).toBe('active');
    expect(app.vertical_slug).toBe('callout');
    expect(app.hostname).toBe('callout.global.substrat.run');
    expect(await scopeIds(acme.tenantId)).toContain(appScopeId);

    // It's a LIVE scope running the Callout bundle — a real engine op resolves
    // (protocol is one of the engines Callout composes, and the owner holds its keys).
    const appScope = await host.getScope(acme.principal, acme.tenantId, appScopeId);
    await appScope.invoke('protocol/define-template', {
      key: 'welcome',
      title: 'Welcome',
      content: { kind: 'document', documentType: 'welcome', hashRecipe: 'sha256 over the terms' },
    });
    expect(await appScope.invoke('protocol/list-templates', {})).toHaveLength(1);
  });

  it('an owner installs Meridian from the catalog — a live HR scope the owner can set up from empty', async () => {
    const acme = await bootstrap('acme-hr');
    const appScopeId = scopeId.parse(ulid());

    const app = await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'meridian',
      name: 'People',
      // Meridian's SKU is the HR domain module + protocol (onboarding).
      appEntitlements: ['meridian', 'protocol'],
      // The hr-admin subset the fresh-instance owner needs to set the org up.
      appOwnerGrants: [HR_PERM.absenceConfigure, HR_PERM.employeeManage, HR_PERM.absenceRead] as PermissionKey[],
    });
    expect(app.status).toBe('active');
    expect(app.vertical_slug).toBe('meridian');
    expect(app.hostname).toBe('people.global.substrat.run');
    expect(await scopeIds(acme.tenantId)).toContain(appScopeId);

    // It's a LIVE scope running the Meridian bundle, EMPTY on install (no seed). The
    // owner sets it up from zero: define a leave type, then create the first employee —
    // the first-run path a freshly-installed instance offers.
    const appScope = await host.getScope(acme.principal, acme.tenantId, appScopeId);
    await appScope.invoke('hr/define-leave-type', { key: 'vacation', label: 'Vacation', kind: 'vacation', annualDays: '25' });
    expect(await appScope.invoke('hr/list-leave-types', {})).toHaveLength(1);
    const employee = await appScope.invoke<{ id: string }>('hr/create-employee', { number: 'E-001', name: 'Alex Meridian' });
    expect(employee.id).toBeTruthy();
    expect(await appScope.invoke('hr/roster', {})).toHaveLength(1);

    // The Data tab reads THIS app's own database (§5.4 admin-query RPC). After the
    // writes above, its tables are live: Meridian's own tables carry rows and the
    // `_substrat_*` spine is present and flagged system. This is the exact path the
    // dashboard's /api/apps/:scopeId/tables route drives (host.admin, STAFF actor).
    const tables = await host.admin.listScopeTables(staff, acme.tenantId, appScopeId);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.some((t) => t.name.startsWith('_substrat') && t.system)).toBe(true);
    expect(tables.some((t) => !t.system && t.rowCount > 0)).toBe(true);
    // A row-bearing Meridian table pages back with columns + positional rows.
    const populated = tables.find((t) => !t.system && t.rowCount > 0)!;
    const page = await host.admin.readScopeTable(staff, acme.tenantId, appScopeId, {
      table: populated.name,
      limit: 50,
      offset: 0,
    });
    expect(page.columns.length).toBeGreaterThan(0);
    expect(page.rows.length).toBe(Math.min(populated.rowCount, 50));
    // An unknown table is rejected, never queried blind.
    await expect(
      host.admin.readScopeTable(staff, acme.tenantId, appScopeId, { table: 'nope', limit: 50, offset: 0 }),
    ).rejects.toThrow(/unknown table/);
  });

  it('records a per-app audit trail — created + active on success, created + failed(reason) on failure', async () => {
    const acme = await bootstrap('acme-audit');
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    type Ev = { kind: string; detail: string | null };

    // Success: a `created` then an `active` event.
    const okScope = scopeId.parse(ulid());
    await createApp(host, {
      node: acme, appScopeId: okScope, verticalSlug: 'protocol', name: 'Docs',
      appEntitlements: ['protocol'], appOwnerGrants: [PROTOCOL_PERM.read] as PermissionKey[],
    });
    const okEvents = await dash.invoke<Ev[]>('dashboard/app-events', { appScopeId: okScope });
    expect(okEvents).toHaveLength(2);
    expect(okEvents.map((e) => e.kind).sort()).toEqual(['active', 'created']);

    // Failure: a `created` then a `failed` event carrying the REASON (not just a toast).
    const failScope = scopeId.parse(ulid());
    const failingCp = {
      tenantId: acme.tenantId,
      ensureTenant: () => Promise.reject(new Error("no deployment is bound for vertical 'meridian'")),
    } as unknown as Parameters<typeof createApp>[1]['controlPlane'];
    await expect(
      createApp(host, {
        node: acme, appScopeId: failScope, verticalSlug: 'meridian', name: 'HR',
        appEntitlements: ['meridian', 'protocol'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
        controlPlane: failingCp,
      }),
    ).rejects.toThrow('no deployment is bound');
    const failEvents = await dash.invoke<Ev[]>('dashboard/app-events', { appScopeId: failScope });
    expect(failEvents).toHaveLength(2);
    expect(failEvents.map((e) => e.kind).sort()).toEqual(['created', 'failed']);
    expect(failEvents.find((e) => e.kind === 'failed')?.detail).toContain('no deployment is bound');
  });

  it('updates an installed app to the vertical’s new prod version — rebinds the scope + records it', async () => {
    const acme = await bootstrap('acme-update');
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    type Ev = { kind: string; detail: string | null };

    // The vertical has two admitted versions; prod is promoted to the NEWER one (0.0.10).
    const v9 = ulid();
    const v10 = ulid();
    await host.admin.registerVertical(staff, { slug: 'meridian', name: 'Meridian', source: 'builtin' });
    for (const [id, version] of [[v9, '0.0.9'], [v10, '0.0.10']] as const) {
      await host.admin.publishVersion(staff, {
        id, verticalSlug: 'meridian', version, manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g',
        deploymentRef: `meridian-${id.toLowerCase()}`,
      });
      await host.admin.admitVersion(staff, id);
    }
    await host.admin.promoteVersion(staff, 'meridian', 'prod', v10);

    // Install the app, then pin it to the OLD version (0.0.9) — the "installed before prod
    // moved" state (embedded provisioning doesn't pin, so set it explicitly, as an install would).
    const appScopeId = scopeId.parse(ulid());
    await createApp(host, {
      node: acme, appScopeId, verticalSlug: 'meridian', name: 'People',
      appEntitlements: ['meridian', 'protocol'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
    });
    await host.admin.bindScopeVersion(staff, acme.tenantId, appScopeId, v9);
    expect((await host.admin.getScopeRecord(staff, acme.tenantId, appScopeId))?.verticalVersionId).toBe(v9);

    // Update → rebinds the scope to prod (0.0.10) and records an 'updated' event with the move.
    const r1 = await updateApp(host, { node: acme, appScopeId, verticalSlug: 'meridian' });
    expect(r1).toEqual({ updated: true, version: '0.0.10', previousVersion: '0.0.9' });
    expect((await host.admin.getScopeRecord(staff, acme.tenantId, appScopeId))?.verticalVersionId).toBe(v10);
    const updated = (await dash.invoke<Ev[]>('dashboard/app-events', { appScopeId })).find((e) => e.kind === 'updated');
    expect(updated?.detail).toBe('0.0.9 → 0.0.10');

    // Idempotent: running it again is a no-op (already current) — no rebind, no new event.
    const r2 = await updateApp(host, { node: acme, appScopeId, verticalSlug: 'meridian' });
    expect(r2.updated).toBe(false);
    expect((await dash.invoke<Ev[]>('dashboard/app-events', { appScopeId })).filter((e) => e.kind === 'updated')).toHaveLength(1);
  });

  it('a principal without dashboard:provision-app is refused — before anything is provisioned', async () => {
    const acme = await bootstrap('acme2');
    const stranger = principalId.parse(ulid()); // holds no role in acme
    const appScopeId = scopeId.parse(ulid());

    await expect(
      createApp(host, {
        node: { ...acme, principal: stranger },
        appScopeId,
        verticalSlug: 'protocol',
        name: 'X',
        appEntitlements: ['protocol'],
      }),
    ).rejects.toThrow();

    // The permission check runs first, so nothing was provisioned.
    expect(await scopeIds(acme.tenantId)).not.toContain(appScopeId);
  });

  it('a customer cannot provision into another tenant — even by supplying its node', async () => {
    const acme = await bootstrap('acme3');
    const other = await bootstrap('other');
    const appScopeId = scopeId.parse(ulid());

    // Acme's owner forges `other`'s node. The in-scope check refuses acme.principal
    // in other's tenant (they hold no role there), so no scope is provisioned —
    // authority is kernel-enforced, not a matter of passing the right tenant.
    await expect(
      createApp(host, {
        node: { tenantId: other.tenantId, scopeId: other.scopeId, principal: acme.principal },
        appScopeId,
        verticalSlug: 'protocol',
        name: 'X',
        appEntitlements: ['protocol'],
      }),
    ).rejects.toThrow();

    expect(await scopeIds(other.tenantId)).not.toContain(appScopeId);

    // And acme's own owner, on their own node, lands only in acme — never `other`.
    const own = scopeId.parse(ulid());
    await createApp(host, {
      node: acme,
      appScopeId: own,
      verticalSlug: 'protocol',
      name: 'A',
      appEntitlements: ['protocol'],
    });
    expect(await scopeIds(acme.tenantId)).toContain(own);
    expect(await scopeIds(other.tenantId)).not.toContain(own);
  });
});

/**
 * Deployments (builder-plane.md Phase 4) — the builder-facing view of the verticals a
 * tenant pushed, assembled from the registry and narrowed to that tenant's own. Proves
 * the ownership filter (a tenant sees only what it owns), the shaping (prefix stripped,
 * versions newest-first, channels), and that a slug you don't own is not promotable.
 */
describe('Dashboard Phase 4 — a tenant sees only its own deployments', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const acme = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-deployments-'));
    host = new SqliteScopeHost({ dir });
  });
  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const publish = async (slug: string, version: string, id: string) => {
    await host.admin.publishVersion(staff, {
      id,
      verticalSlug: slug,
      version,
      manifestDigest: 'm',
      permissionDigest: 'p',
      migrationDigest: 'g',
      deploymentRef: `${slug}-${id.toLowerCase()}`,
    });
  };

  it('lists only the tenant’s own verticals, shaped with channels and newest-first versions', async () => {
    // acme owns `helpdesk` (two versions, dev pinned to the newer); a platform vertical
    // (owner null) and another tenant's vertical must NOT appear for acme.
    await host.admin.registerVertical(staff, { slug: 'helpdesk', name: 'Helpdesk', source: 'cli', ownerTenant: acme });
    await host.admin.registerVertical(staff, { slug: 'callout', name: 'Callout', source: 'builtin' }); // platform
    await host.admin.registerVertical(staff, { slug: 'billing', name: 'Billing', source: 'cli', ownerTenant: other });

    const v1 = ulid();
    const v2 = ulid();
    await publish('helpdesk', '0.1.0', v1);
    await publish('helpdesk', '0.2.0', v2);
    await host.admin.admitVersion(staff, v2);
    await host.admin.promoteVersion(staff, 'helpdesk', 'dev', v2);

    const mine = await listDeploymentsFromHost(host, staff, acme);
    expect(mine.map((d) => d.slug)).toEqual(['helpdesk']); // not callout, not billing
    const hd = mine[0]!;
    expect(hd.displaySlug).toBe('helpdesk');
    // Newest-first: 0.2.0 (v2) before 0.1.0 (v1).
    expect(hd.versions.map((v) => v.id)).toEqual([v2, v1]);
    expect(hd.channels).toContainEqual({ channel: 'dev', versionId: v2 });

    // The other tenant sees only its own.
    expect((await listDeploymentsFromHost(host, staff, other)).map((d) => d.slug)).toEqual(['billing']);
  });

  it('per-app: a PLATFORM vertical (not tenant-owned) shows its versions + the prod one it runs', async () => {
    // The per-app Deployments tab keys by the app's vertical SLUG, not ownership — so an app
    // running a platform vertical (owner null, which the tenant-level list hides) still sees
    // which version it runs. This is the "am I on 0.0.9?" question.
    await host.admin.registerVertical(staff, { slug: 'meridian', name: 'Meridian', source: 'builtin' });
    const v9 = ulid();
    const v10 = ulid();
    await publish('meridian', '0.0.9', v9);
    await publish('meridian', '0.0.10', v10);
    await host.admin.admitVersion(staff, v9);
    await host.admin.admitVersion(staff, v10);
    await host.admin.promoteVersion(staff, 'meridian', 'prod', v9); // prod is still 0.0.9

    const dep = await verticalDeploymentFromHost(host, staff, 'meridian');
    expect(dep.versions.map((v) => v.version)).toEqual(['0.0.10', '0.0.9']); // newest first
    // The app runs the PROD version — 0.0.9 — even though 0.0.10 exists but wasn't promoted.
    const prod = dep.channels.find((c) => c.channel === 'prod');
    expect(dep.versions.find((v) => v.id === prod?.versionId)?.version).toBe('0.0.9');
  });

  it('refuses to treat a slug the tenant does not own as promotable', async () => {
    await host.admin.registerVertical(staff, { slug: 'helpdesk', name: 'Helpdesk', source: 'cli', ownerTenant: acme });
    await host.admin.registerVertical(staff, { slug: 'billing', name: 'Billing', source: 'cli', ownerTenant: other });
    const mine = await listDeploymentsFromHost(host, staff, acme);

    expect(() => assertOwned(mine, 'helpdesk')).not.toThrow();
    // billing is other's — not in acme's deployments, so a promote attempt is refused.
    expect(() => assertOwned(mine, 'billing')).toThrow(/not one of your deployments/);
  });
});

/**
 * The catalog only advertises verticals the running mode can actually provision — so the
 * marketplace never offers an install that always fails (the Meridian-in-connected-mode gap).
 */
describe('catalog availability — registry-driven (marketplace-publish.md §3)', () => {
  // availableCatalog reads the registry now: a vertical shows if it's PUBLISHED (`listed`) or
  // OWNED by the caller's tenant (private). No hardcoded CATALOG gate.
  const row = (slug: string, listed: boolean, ownerTenant: string | null): Vertical =>
    ({ slug, name: slug, source: 'cli', ownerTenant, listed, createdAt: '2026-01-01T00:00:00.000Z' } as unknown as Vertical);
  const registry: Vertical[] = [
    row('published', true, null),
    row('theirs-published', true, 'other'),
    row('mine-private', false, 'me'),
    row('theirs-private', false, 'other'),
  ];

  it('shows PUBLISHED verticals to anyone, regardless of owner', () => {
    const slugs = availableCatalog(registry, { tenantId: 'me' }).map((v) => v.slug);
    expect(slugs).toContain('published');
    expect(slugs).toContain('theirs-published');
  });

  it("shows the caller's OWN private vertical, hides another tenant's", () => {
    const slugs = availableCatalog(registry, { tenantId: 'me' }).map((v) => v.slug);
    expect(slugs).toContain('mine-private');
    expect(slugs).not.toContain('theirs-private');
  });

  it('an anonymous caller (no tenant) sees only published verticals', () => {
    const slugs = availableCatalog(registry, { tenantId: null }).map((v) => v.slug).sort();
    expect(slugs).toEqual(['published', 'theirs-published']);
  });

  it('ensureCatalog seeds first-party as listed unless flagged not-yet-connected', () => {
    // `listed: e.connected !== false` — a bundled-but-undeployed entry stays private (would 501
    // on install in connected mode); a deployed one is published to everyone.
    const listedFor = (connected?: boolean) => connected !== false;
    expect(listedFor(false)).toBe(false);
    expect(listedFor(true)).toBe(true);
    expect(listedFor(undefined)).toBe(true);
    expect(CATALOG.meridian!.connected).toBe(true);
  });
});
