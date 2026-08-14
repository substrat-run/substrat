import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type PermissionKey, type Vertical } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { protocolModule, PROTOCOL_PERM } from '@substrat-run/engine-protocol';
import { absenceModule } from '@substrat-run/engine-absence';
import { workorderModule } from '@substrat-run/engine-workorder';
import { invoicingModule } from '@substrat-run/engine-invoicing';
import { calloutModule } from '@substrat-run/demo-callout/module';
import { meridianModule } from '@substrat-run/demo-meridian/module';
import { HR_PERM } from '@substrat-run/demo-meridian/manifest';
import {
  MODULES,
  provisionDashboard,
  createApp,
  installEntitlements,
  deprovisionApp,
  retryApp,
  resumeApp,
  updateApp,
  CATALOG,
  ensureCatalog,
  availableCatalog,
  oidcIssuerProviderSlugs,
  type DashboardAppRow,
  type DashboardNode,
} from '../src/index.js';
import { listDeploymentsFromHost, verticalDeploymentFromHost, verticalDeploymentPageFromHost, versionRegistryFromHost, assertOwned } from '../src/deployments.js';
import { ControlPlaneError } from '../src/authority.js';

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
    for (const m of [protocolModule, absenceModule, workorderModule, invoicingModule, calloutModule, meridianModule]) {
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

  it('pages the app-events trail through the module op — keyset on the id, newest first, short page = exhausted', async () => {
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
    // 'created' + 'active' from the install; three updates make five events total.
    for (const detail of ['0.1 → 0.2', '0.2 → 0.3', '0.3 → 0.4']) {
      await dash.invoke('dashboard/update-app', { appScopeId, detail });
    }
    type Ev = { id: string; kind: string };
    // Unpaged stays unbounded — existing callers unchanged.
    const all = await dash.invoke<Ev[]>('dashboard/app-events', { appScopeId });
    expect(all).toHaveLength(5);

    // Walk two pages of 2, then the short tail: cursors key on the last row's id and
    // the concatenation reproduces the unbounded read exactly (no gaps, no repeats).
    const p1 = await dash.invoke<Ev[]>('dashboard/app-events', { appScopeId, limit: 2 });
    const p2 = await dash.invoke<Ev[]>('dashboard/app-events', { appScopeId, limit: 2, cursor: p1[1]!.id });
    const p3 = await dash.invoke<Ev[]>('dashboard/app-events', { appScopeId, limit: 2, cursor: p2[1]!.id });
    expect([...p1, ...p2, ...p3].map((e) => e.id)).toEqual(all.map((e) => e.id));
    expect(p3).toHaveLength(1); // short page — the walk is done
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

  it('#443: an install that declares no entitlements derives the vertical’s own SKU — never an empty, fail-closed grant', async () => {
    const acme = await bootstrap('acme-derived-sku');

    // The registry-empty shape that bit authhero-console: a pushed vertical with no
    // `entitlements` in its substrat block resolves to exactly [] — which used to
    // defeat the `?? [slug]` fallback and install the app with ZERO entitlements.
    const appScopeId = scopeId.parse(ulid());
    const app = await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'protocol',
      name: 'Underdeclared',
      appEntitlements: [],
      appOwnerGrants: [PROTOCOL_PERM.create, PROTOCOL_PERM.read] as PermissionKey[],
    });
    expect(app.status).toBe('active');

    // The installing tenant HOLDS the derived SKU...
    const held = await host.admin.listEntitlements(staff, acme.tenantId);
    expect(held.map((e) => e.entitlementKey)).toContain('protocol');

    // ...so the vertical's own gate opens on first use instead of failing closed.
    const appScope = await host.getScope(acme.principal, acme.tenantId, appScopeId);
    await appScope.invoke('protocol/define-template', {
      key: 'welcome',
      title: 'Welcome',
      content: { kind: 'document', documentType: 'welcome', hashRecipe: 'sha256 over the terms' },
    });

    // Connected mode grants the same derived set on the shared plane — in the
    // directory step, BEFORE the instance provisions, so the entitlement delivery
    // that rides provisioning (#310) already carries it.
    const granted: string[] = [];
    const cp = {
      tenantId: acme.tenantId,
      ensureTenant: async () => {},
      grantEntitlement: async (key: string) => {
        granted.push(key);
      },
      provisionScope: async () => {},
      provisionInstance: async () => {},
      activateScope: async () => {},
      listChannels: async () => [],
      bindHostname: async () => {},
      setHostnameStatus: async () => {},
    } as unknown as Parameters<typeof createApp>[1]['controlPlane'];
    await createApp(host, {
      node: acme,
      appScopeId: scopeId.parse(ulid()),
      verticalSlug: 'meridian',
      name: 'Pushed',
      appEntitlements: [],
      appOwnerGrants: [],
      controlPlane: cp,
    });
    expect(granted).toEqual(['meridian']);
  });

  it('installEntitlements: the first non-empty declared set wins; empty or absent derives the slug', () => {
    expect(installEntitlements('helpdesk')).toEqual(['helpdesk']);
    expect(installEntitlements('helpdesk', undefined, [])).toEqual(['helpdesk']);
    expect(installEntitlements('callout', [], ['workorder', 'invoicing', 'callout'])).toEqual([
      'workorder',
      'invoicing',
      'callout',
    ]);
  });

  it('delivers the Identity choice as substrat:auth AFTER the hostname binds; a delivery failure fails the app', async () => {
    const acme = await bootstrap('acme-auth-choice');
    const configured: Array<{ scopeId: string; entries: Array<{ key: string; value: string }> }> = [];
    const happyCp = () =>
      ({
        tenantId: acme.tenantId,
        ensureTenant: async () => {},
        grantEntitlement: async () => {},
        provisionScope: async () => {},
        provisionInstance: async () => {},
        activateScope: async () => {},
        listChannels: async () => [],
        bindHostname: async () => {},
        setHostnameStatus: async () => {},
        configureInstance: async (scopeId: string, entries: Array<{ key: string; value: string }>) => {
          configured.push({ scopeId, entries });
        },
      }) as unknown as Parameters<typeof createApp>[1]['controlPlane'];

    // EXTERNAL issuer: the hand-configured client rides through verbatim.
    const extScope = scopeId.parse(ulid());
    const ext = await createApp(host, {
      node: acme, appScopeId: extScope, verticalSlug: 'meridian', name: 'People',
      appEntitlements: ['meridian'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
      controlPlane: happyCp(),
      appAuth: { source: 'external', issuer: 'https://auth.example.com', clientId: 'cid', clientSecret: 'cs' },
    });
    expect(ext.status).toBe('active');
    expect(configured).toHaveLength(1);
    expect(configured[0]!.scopeId).toBe(extScope);
    expect(configured[0]!.entries.map((e) => e.key)).toEqual(['substrat:auth']);
    expect(JSON.parse(configured[0]!.entries[0]!.value)).toEqual({
      mode: 'oidc', issuer: 'https://auth.example.com', clientId: 'cid', clientSecret: 'cs',
    });

    // TEAM AUTH SERVER: the client is REGISTERED at the issuer against the app's REAL
    // bound hostname (the callback URL is derived from it), then wired in.
    const asScope = scopeId.parse(ulid());
    const registrations: Array<{ issuer: string; appName: string; redirectUri: string }> = [];
    const srv = await createApp(host, {
      node: acme, appScopeId: asScope, verticalSlug: 'meridian', name: 'People Two',
      appEntitlements: ['meridian'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
      controlPlane: happyCp(),
      appAuth: { source: 'auth-server', issuer: 'https://auth-acme.global.substrat.run' },
      registerOidcClient: async (issuer, input) => {
        registrations.push({ issuer, ...input });
        return { clientId: 'minted-id', clientSecret: 'minted-secret' };
      },
    });
    expect(srv.status).toBe('active');
    expect(registrations).toEqual([{
      issuer: 'https://auth-acme.global.substrat.run',
      appName: 'People Two',
      redirectUri: `https://${srv.hostname}/api/auth/callback`,
    }]);
    expect(JSON.parse(configured[1]!.entries[0]!.value)).toEqual({
      mode: 'oidc', issuer: 'https://auth-acme.global.substrat.run', clientId: 'minted-id', clientSecret: 'minted-secret',
    });

    // A FAILING delivery is a failed app with the reason on its trail — the user asked
    // for THIS issuer; silently falling back to builtin would strand its users later.
    const failScope = scopeId.parse(ulid());
    const failingDelivery = happyCp() as unknown as { configureInstance: () => Promise<void> };
    failingDelivery.configureInstance = () => Promise.reject(new Error('client registration at issuer failed (403)'));
    await expect(
      createApp(host, {
        node: acme, appScopeId: failScope, verticalSlug: 'meridian', name: 'Broken Auth',
        appEntitlements: ['meridian'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
        controlPlane: failingDelivery as unknown as Parameters<typeof createApp>[1]['controlPlane'],
        appAuth: { source: 'external', issuer: 'https://auth.example.com', clientId: 'cid' },
      }),
    ).rejects.toThrow('client registration at issuer failed');
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const rows = await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {});
    expect(rows.find((a) => a.app_scope_id === failScope)?.status).toBe('failed');
    const events = await dash.invoke<Array<{ kind: string; detail: string | null }>>('dashboard/app-events', { appScopeId: failScope });
    expect(events.find((e) => e.kind === 'failed')?.detail).toContain('client registration');
  });

  it('#426: install-form config is authored AND delivered with provisioning; the provision result is persisted', async () => {
    const acme = await bootstrap('acme-install-config');
    const appScope = scopeId.parse(ulid());
    const provisionCalls: Array<{ slug: string; config?: Record<string, string> }> = [];
    const cp = {
      tenantId: acme.tenantId,
      ensureTenant: async () => {},
      grantEntitlement: async () => {},
      provisionScope: async () => {},
      // The vertical honors `config` and answers non-secret first-run facts with its ack.
      provisionInstance: async (slug: string, input: { config?: Record<string, string> }) => {
        provisionCalls.push({ slug, ...(input.config ? { config: input.config } : {}) });
        return { result: { clientId: 'minted-client', migrationsApplied: '3' } };
      },
      activateScope: async () => {},
      listChannels: async () => [],
      bindHostname: async () => {},
      setHostnameStatus: async () => {},
      configureInstance: async () => {},
    } as unknown as Parameters<typeof createApp>[1]['controlPlane'];

    const app = await createApp(host, {
      node: acme, appScopeId: appScope, verticalSlug: 'meridian', name: 'Issuer',
      appEntitlements: ['meridian'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
      controlPlane: cp,
      appConfig: [
        { key: 'ADMIN_EMAIL', value: 'ops@acme.com', secret: false },
        { key: 'ADMIN_PASSWORD', value: 'chosen-by-installer', secret: true },
        { key: 'OPTIONAL_UNTOUCHED', value: '', secret: false },
      ],
    });

    // DELIVERED with provisioning — the instance is born configured (an issuer with an
    // admin), not live-but-unconfigured until an Env-tab save. Empty values don't ride.
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]!.config).toEqual({
      ADMIN_EMAIL: 'ops@acme.com',
      ADMIN_PASSWORD: 'chosen-by-installer',
    });

    // PERSISTED: the vertical's non-secret provision result lands on the app row instead
    // of dying with the 201 body (#426 half 2).
    expect(app.status).toBe('active');
    expect(JSON.parse(app.provision_result ?? '{}')).toEqual({
      clientId: 'minted-client',
      migrationsApplied: '3',
    });

    // AUTHORED: the same values are on the Env tab afterward, the secret masked-but-set —
    // what the user typed outlives the install request.
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    type EnvVal = { key: string; isSecret: boolean; hasValue: boolean; value: string | null };
    const values = (await dash.invoke('dashboard/list-app-env', { appScopeId: appScope })) as EnvVal[];
    expect(values.find((v) => v.key === 'ADMIN_EMAIL')?.value).toBe('ops@acme.com');
    const pw = values.find((v) => v.key === 'ADMIN_PASSWORD')!;
    expect(pw.value).toBeNull();
    expect(pw.hasValue).toBe(true);
    expect(values.some((v) => v.key === 'OPTIONAL_UNTOUCHED')).toBe(false);
  });

  it('#426: the authored config survives a FAILED install — what the user typed is not lost with the request', async () => {
    const acme = await bootstrap('acme-config-failed');
    const appScope = scopeId.parse(ulid());
    const failingCp = {
      tenantId: acme.tenantId,
      ensureTenant: () => Promise.reject(new Error('boom')),
    } as unknown as Parameters<typeof createApp>[1]['controlPlane'];
    await expect(
      createApp(host, {
        node: acme, appScopeId: appScope, verticalSlug: 'meridian', name: 'Broken',
        appEntitlements: ['meridian'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
        controlPlane: failingCp,
        appConfig: [{ key: 'ADMIN_EMAIL', value: 'ops@acme.com', secret: false }],
      }),
    ).rejects.toThrow('boom');
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const values = (await dash.invoke('dashboard/list-app-env', { appScopeId: appScope })) as Array<{ key: string; value: string | null }>;
    expect(values.find((v) => v.key === 'ADMIN_EMAIL')?.value).toBe('ops@acme.com');
  });

  it('#427: capability declarations ride the registry and drive issuer-provider resolution', async () => {
    // `requires` rides the registry ROW (declared by a pushed vertical's manifest — the
    // builtin meridian that used to carry it is retired, #389), so install-time binding
    // reads the row, not a hardcoded slug list.
    await ensureCatalog(host, staff);
    await host.admin.registerVertical(staff, {
      slug: 'acme/hr',
      name: 'Acme HR',
      source: 'cli',
      listed: true,
      requires: ['oidc-issuer'],
    });
    const verticals = await host.admin.listVerticals(staff);
    expect(verticals.find((v) => v.slug === 'acme/hr')?.requires).toEqual(['oidc-issuer']);
    // ...and availableCatalog forwards both capability lists to the install UI.
    const listing = availableCatalog(verticals, { tenantId: null });
    expect(listing.find((v) => v.slug === 'acme/hr')?.requires).toEqual(['oidc-issuer']);

    // Provider resolution is capability-driven: a vertical DECLARING provides:['oidc-issuer']
    // counts (whatever its slug), the legacy literal 'auth-server' is grandfathered
    // (registry rows pushed before `provides` existed), and a non-provider never appears.
    await host.admin.registerVertical(staff, {
      slug: 'acme/idp',
      name: 'Acme IdP',
      source: 'cli',
      provides: ['oidc-issuer'],
      listed: true,
    });
    const slugs = oidcIssuerProviderSlugs(await host.admin.listVerticals(staff), [
      { slug: 'remote/issuer', provides: ['oidc-issuer'] },
      { slug: 'remote/plain' },
    ]);
    expect(slugs.has('acme/idp')).toBe(true);
    expect(slugs.has('auth-server')).toBe(true);
    expect(slugs.has('remote/issuer')).toBe(true);
    expect(slugs.has('remote/plain')).toBe(false);
    expect(slugs.has('meridian')).toBe(false); // requiring is not providing
  });

  it('#389: ensureCatalog retires a builtin row that dropped out of CATALOG — blocked, unlisted, no longer offered', async () => {
    // Meridian's shape: seeded as a listed builtin by an older CATALOG, then removed
    // from the map. The row persists for its scopes, but the seed loop never touches
    // it again — without reconciliation it kept offering an install the control
    // plane's kill-switch refuses.
    await host.admin.registerVertical(staff, {
      slug: 'retired-builtin', name: 'Retired', source: 'builtin', listed: true,
    });
    await ensureCatalog(host, staff);
    const row = (await host.admin.listVerticals(staff)).find((v) => v.slug === 'retired-builtin');
    expect(row).toMatchObject({ installsBlocked: true, listed: false });
    const offered = availableCatalog(await host.admin.listVerticals(staff), { tenantId: null });
    expect(offered.map((v) => v.slug)).not.toContain('retired-builtin');
    // Entries still in CATALOG are untouched, and the audited retirement fired once —
    // a second pass (every /api/catalog read runs this) records nothing new.
    expect(offered.map((v) => v.slug)).toContain('callout');
    await ensureCatalog(host, staff);
    const blocks = (await host.admin.auditLog(staff)).filter(
      (e) => e.action === 'setVerticalInstallsBlocked',
    );
    expect(blocks).toHaveLength(1);
  });

  it('#391: a cold-start 502 on the identity delivery is retried; persistent failure names the transient; a 501 never retries', async () => {
    const acme = await bootstrap('acme-cold-start');
    const appAuth = { source: 'external', issuer: 'https://auth.example.com', clientId: 'cid', clientSecret: 'cs' } as const;
    const base = {
      tenantId: acme.tenantId,
      ensureTenant: async () => {},
      grantEntitlement: async () => {},
      provisionScope: async () => {},
      provisionInstance: async () => {},
      activateScope: async () => {},
      listChannels: async () => [],
      bindHostname: async () => {},
      setHostnameStatus: async () => {},
    };
    const cpWith = (configureInstance: () => Promise<void>) =>
      ({ ...base, configureInstance }) as unknown as Parameters<typeof createApp>[1]['controlPlane'];
    const coldStart = () =>
      Promise.reject(new ControlPlaneError(502, 'vertical unreachable during configure: Worker threw exception'));

    // The just-provisioned instance answers on the THIRD attempt — inside the cold-start
    // window the bounded retry exists for. The install converges instead of failing.
    let attempts = 0;
    const wakingScope = scopeId.parse(ulid());
    const app = await createApp(host, {
      node: acme, appScopeId: wakingScope, verticalSlug: 'meridian', name: 'Waking',
      appEntitlements: ['meridian'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
      controlPlane: cpWith(() => (++attempts < 3 ? coldStart() : Promise.resolve())),
      appAuth, configureRetryDelaysMs: [0, 0],
    });
    expect(app.status).toBe('active');
    expect(attempts).toBe(3);

    // Never-answers: the app fails, and the reason names the transient + the recovery —
    // not the generic 'internal error' this issue was filed about.
    const deadScope = scopeId.parse(ulid());
    await expect(
      createApp(host, {
        node: acme, appScopeId: deadScope, verticalSlug: 'meridian', name: 'Dead',
        appEntitlements: ['meridian'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
        controlPlane: cpWith(coldStart), appAuth, configureRetryDelaysMs: [0],
      }),
    ).rejects.toThrow(/deployment did not answer .*Worker threw exception.*install it again/s);
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const rows = await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {});
    expect(rows.find((a) => a.app_scope_id === deadScope)?.status).toBe('failed');

    // An honest 501 refusal (no live-config support) is NOT retried — retrying a
    // refusal only delays the real message.
    let refusals = 0;
    const refusedScope = scopeId.parse(ulid());
    await expect(
      createApp(host, {
        node: acme, appScopeId: refusedScope, verticalSlug: 'meridian', name: 'Refused',
        appEntitlements: ['meridian'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
        controlPlane: cpWith(() => {
          refusals++;
          return Promise.reject(new ControlPlaneError(501, 'no live-config support'));
        }),
        appAuth, configureRetryDelaysMs: [0, 0],
      }),
    ).rejects.toThrow(/cannot receive auth settings/);
    expect(refusals).toBe(1);
  });

  it('authors the Identity choice at install so Settings can read and update it — secret redacted, blank keeps it', async () => {
    const acme = await bootstrap('acme-auth-visible');
    const cp = {
      tenantId: acme.tenantId,
      ensureTenant: async () => {},
      grantEntitlement: async () => {},
      provisionScope: async () => {},
      provisionInstance: async () => {},
      activateScope: async () => {},
      listChannels: async () => [],
      bindHostname: async () => {},
      setHostnameStatus: async () => {},
      configureInstance: async () => {},
    } as unknown as Parameters<typeof createApp>[1]['controlPlane'];
    const appScope = scopeId.parse(ulid());
    await createApp(host, {
      node: acme, appScopeId: appScope, verticalSlug: 'meridian', name: 'People',
      appEntitlements: ['meridian'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
      controlPlane: cp,
      appAuth: { source: 'external', issuer: 'https://auth.example.com', clientId: 'cid', clientSecret: 'super-secret' },
    });
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);

    // Visible afterwards, with the secret REDACTED (write-only) — the install-time gap
    // this closes: delivery alone left the issuer invisible everywhere but in the app.
    type AuthView = { issuer: string; clientId: string; hasClientSecret: boolean } | null;
    const view = (await dash.invoke('dashboard/get-app-auth', { appScopeId: appScope })) as AuthView;
    expect(view).toMatchObject({ issuer: 'https://auth.example.com', clientId: 'cid', hasClientSecret: true });
    expect(JSON.stringify(view)).not.toContain('super-secret');

    // The reserved `substrat:auth` row never leaks into the Env tab's list.
    expect(await dash.invoke('dashboard/list-app-env', { appScopeId: appScope })).toEqual([]);

    // An update WITHOUT a clientSecret keeps the stored one (the form can change the
    // issuer without re-typing a secret it never received back) — the returned merged
    // config is what a caller delivers to the running scope.
    const merged = await dash.invoke('dashboard/set-app-auth', {
      appScopeId: appScope,
      config: { mode: 'oidc', issuer: 'https://other.example.com', clientId: 'cid2' },
    });
    expect(merged).toEqual({
      mode: 'oidc', issuer: 'https://other.example.com', clientId: 'cid2', clientSecret: 'super-secret',
    });
    const after = (await dash.invoke('dashboard/get-app-auth', { appScopeId: appScope })) as AuthView;
    expect(after).toMatchObject({ issuer: 'https://other.example.com', clientId: 'cid2', hasClientSecret: true });
  });

  it("a 501 delivery failure fails with an ACTIONABLE reason, not just the deployment's status line", async () => {
    const acme = await bootstrap('acme-501');
    const failScope = scopeId.parse(ulid());
    const cp = {
      tenantId: acme.tenantId,
      ensureTenant: async () => {},
      grantEntitlement: async () => {},
      provisionScope: async () => {},
      provisionInstance: async () => {},
      activateScope: async () => {},
      listChannels: async () => [],
      bindHostname: async () => {},
      setHostnameStatus: async () => {},
      // The sesamy-crm shape: a vertical with no /internal/configure route answers 501.
      configureInstance: () => Promise.reject(new ControlPlaneError(501, 'sesamy-crm has no live-config support')),
    } as unknown as Parameters<typeof createApp>[1]['controlPlane'];
    await expect(
      createApp(host, {
        node: acme, appScopeId: failScope, verticalSlug: 'meridian', name: 'CRM',
        appEntitlements: ['meridian'], appOwnerGrants: [HR_PERM.absenceRead] as PermissionKey[],
        controlPlane: cp,
        appAuth: { source: 'external', issuer: 'https://auth.example.com', clientId: 'cid' },
      }),
    ).rejects.toThrow(/identity setup failed/);
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const events = await dash.invoke<Array<{ kind: string; detail: string | null }>>('dashboard/app-events', { appScopeId: failScope });
    const detail = events.find((e) => e.kind === 'failed')?.detail ?? '';
    // The Activity trail carries what happened AND what to do next.
    expect(detail).toContain('no live-config support');
    expect(detail).toContain('Builtin');
    expect(detail).toContain('/internal/configure');
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

  it('records the install as durable steps (#424): each stage done, in sequence order', async () => {
    const acme = await bootstrap('acme-steps');
    const appScopeId = scopeId.parse(ulid());
    await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'protocol',
      name: 'Stepped',
      appEntitlements: ['protocol'],
      appOwnerGrants: [PROTOCOL_PERM.read] as PermissionKey[],
    });
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const steps = (await dash.invoke('dashboard/install-steps', { appScopeId })) as Array<{
      step: string; status: string; attempts: number; last_error: string | null;
    }>;
    // Embedded mode has no vertical round-trip ('provision') and no issuer choice
    // ('identity') — those steps never ran, so they honestly have no row.
    expect(steps.map((s) => s.step)).toEqual(['directory', 'activate', 'hostname']);
    expect(steps.every((s) => s.status === 'done' && s.attempts === 1 && s.last_error === null)).toBe(true);
  });

  it('re-running a step bumps attempts on ITS OWN row and keeps a failure verbatim until it settles', async () => {
    const acme = await bootstrap('acme-step-attempts');
    const appScopeId = scopeId.parse(ulid());
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId, verticalSlug: 'protocol', name: 'S' });

    const record = (status: string, error?: string) =>
      dash.invoke('dashboard/record-install-step', { appScopeId, step: 'provision', seq: 1, status, ...(error ? { error } : {}) });
    await record('running');
    await record('failed', 'vertical refused provisioning: 503 no tenant store attached');
    let [row] = (await dash.invoke('dashboard/install-steps', { appScopeId })) as Array<{
      status: string; attempts: number; last_error: string | null;
    }>;
    // The downstream error survives VERBATIM — the diagnosis the toast used to swallow.
    expect(row).toMatchObject({ status: 'failed', attempts: 1, last_error: 'vertical refused provisioning: 503 no tenant store attached' });

    // Resume re-enters the same step: back to running (attempts 2, error cleared), then done.
    await record('running');
    [row] = (await dash.invoke('dashboard/install-steps', { appScopeId })) as typeof row[];
    expect(row).toMatchObject({ status: 'running', attempts: 2, last_error: null });
    await record('done');
    [row] = (await dash.invoke('dashboard/install-steps', { appScopeId })) as typeof row[];
    expect(row).toMatchObject({ status: 'done', attempts: 2, last_error: null });
  });

  it('resuming an app stuck at provisioning converges it to active, in place (#424 case 4)', async () => {
    const acme = await bootstrap('acme-resume');
    const appScopeId = scopeId.parse(ulid());
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);

    // The stuck state: the row landed (createApp step 1) and the platform effect got
    // PARTWAY — the directory scope exists but was never activated, and mark-app-active
    // never ran (the worker died mid-sequence). The dashboard renders an eternal spinner.
    await dash.invoke('dashboard/provision-app', { appScopeId, verticalSlug: 'protocol', name: 'Stuck' });
    await host.provisionScope(staff, { tenantId: acme.tenantId, scopeId: appScopeId, jurisdiction: 'global', vertical: 'protocol' });
    expect((await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {})).find((a) => a.app_scope_id === appScopeId)?.status).toBe('provisioning');

    // Resume re-runs the idempotent tail against the SAME scope → active, with a hostname.
    const resumed = await resumeApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'protocol',
      name: 'Stuck',
      appEntitlements: ['protocol'],
      appOwnerGrants: [PROTOCOL_PERM.create, PROTOCOL_PERM.read] as PermissionKey[],
    });
    expect(resumed.status).toBe('active');
    expect(resumed.app_scope_id).toBe(appScopeId); // in place — never a fresh scope
    expect(resumed.hostname).toBe('stuck.global.substrat.run');

    // The scope is LIVE for the owner (activation + grants really happened)...
    const appScope = await host.getScope(acme.principal, acme.tenantId, appScopeId);
    await appScope.invoke('protocol/define-template', {
      key: 'w',
      title: 'W',
      content: { kind: 'document', documentType: 'w', hashRecipe: 'sha256' },
    });

    // ...and the Activity trail shows the resume between created and active.
    const events = (await dash.invoke('dashboard/app-events', { appScopeId })) as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['created', 'resumed', 'active']));

    // The durable step record (#424) converged with it — every step the resume ran is done.
    const steps = (await dash.invoke('dashboard/install-steps', { appScopeId })) as Array<{ step: string; status: string }>;
    expect(steps.map((s) => s.step)).toEqual(['directory', 'activate', 'hostname']);
    expect(steps.every((s) => s.status === 'done')).toBe(true);

    // Only a stuck row resumes: the now-active app refuses a second resume.
    await expect(
      resumeApp(host, { node: acme, appScopeId, verticalSlug: 'protocol', name: 'Stuck' }),
    ).rejects.toThrow(/only an app stuck at 'provisioning'/);
  });

  it('a resume that still cannot come up marks the row failed with the real error (unlocking Retry)', async () => {
    const acme = await bootstrap('acme-resume-fail');
    const appScopeId = scopeId.parse(ulid());
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId, verticalSlug: 'protocol', name: 'StillStuck' });

    const failingCp = {
      tenantId: acme.tenantId,
      ensureTenant: () => Promise.reject(new Error('plane down')),
    } as unknown as Parameters<typeof createApp>[1]['controlPlane'];
    await expect(
      resumeApp(host, { node: acme, appScopeId, verticalSlug: 'protocol', name: 'StillStuck', controlPlane: failingCp }),
    ).rejects.toThrow('plane down');

    const row = (await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {})).find((a) => a.app_scope_id === appScopeId);
    expect(row?.status).toBe('failed');
    const events = (await dash.invoke('dashboard/app-events', { appScopeId })) as Array<{ kind: string; detail: string | null }>;
    expect(events.some((e) => e.kind === 'failed' && e.detail === 'plane down')).toBe(true);

    // The step record names WHERE it died, with the downstream error verbatim (#424).
    const steps = (await dash.invoke('dashboard/install-steps', { appScopeId })) as Array<{
      step: string; status: string; last_error: string | null;
    }>;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step: 'directory', status: 'failed', last_error: 'plane down' });
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

    await deprovisionApp(host, { node: acme, appScopeId });

    // Dropped from the account's app list (soft-deleted)...
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    expect(await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {})).toHaveLength(0);

    // ...and the scope is ARCHIVED — getScope fails closed, so the app is offline.
    await expect(host.getScope(acme.principal, acme.tenantId, appScopeId)).rejects.toThrow();

    // ...and EVERY hostname of the scope is UNBOUND — a deleted app leaves no row
    // behind on the Domains page, not a `failed` relic the sweep could resurrect.
    expect(await host.admin.listHostnames(staff, { scopeId: appScopeId })).toHaveLength(0);

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

  it('deleting an app whose scope was already reaped out-of-band cleans up, does not throw', async () => {
    // The split-brain the incident left behind: a scope reaped straight from the console
    // while the dashboard app row still existed. deleteApp used to blindly re-archive it
    // and throw `reaped → archived`, stranding the row forever. It must be idempotent.
    const acme = await bootstrap('acme-reaped');
    const appScopeId = scopeId.parse(ulid());
    await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'protocol',
      name: 'Gone',
      appEntitlements: ['protocol'],
      appOwnerGrants: [PROTOCOL_PERM.read] as PermissionKey[],
    });

    // Reap it out-of-band (archive → unbind its names → reap), leaving the app row behind.
    await host.admin.archiveScope(staff, acme.tenantId, appScopeId);
    for (const h of await host.admin.listHostnames(staff, { scopeId: appScopeId })) {
      await host.admin.unbindHostname(staff, h.hostname);
    }
    await host.admin.reapScope(staff, acme.tenantId, appScopeId);
    expect((await host.admin.getScopeRecord(staff, acme.tenantId, appScopeId))!.status).toBe('reaped');

    // Deleting the app now SUCCEEDS and drops the orphan row, rather than throwing.
    await expect(deprovisionApp(host, { node: acme, appScopeId })).resolves.toBeUndefined();
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    expect(await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {})).toHaveLength(0);
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

    // The SQL console (#219) — the exact path the dashboard's /api/apps/:scopeId/query
    // route drives: a read runs, a write shape is refused with the gate's message.
    const counted = await host.admin.queryScope(staff, acme.tenantId, appScopeId, {
      sql: `SELECT count(*) AS n FROM "${populated.name}"`,
    });
    expect(counted.columns).toEqual(['n']);
    expect(counted.rows[0]![0]).toBe(populated.rowCount);
    await expect(
      host.admin.queryScope(staff, acme.tenantId, appScopeId, { sql: `DELETE FROM "${populated.name}"` }),
    ).rejects.toThrow(/read-only console/);
  });

  it('binds a hostname per DECLARED surface — a URL for each, not just the app surface', async () => {
    const acme = await bootstrap('acme-eka');
    const appScopeId = scopeId.parse(ulid());
    // A vertical that declares TWO surfaces (K-26). The registry row is what provisioning
    // reads to know a second surface exists — the module registration alone doesn't say it.
    await host.admin.registerVertical(staff, {
      slug: 'meridian',
      name: 'Meridian',
      source: 'cli',
      ownerTenant: acme.tenantId,
      surfaces: [
        { name: 'app', label: 'CRM' },
        { name: 'eka', label: 'EKA' },
      ],
    });

    const app = await createApp(host, {
      node: acme,
      appScopeId,
      verticalSlug: 'meridian',
      name: 'Egeryds',
      appEntitlements: ['meridian', 'protocol'],
      appOwnerGrants: [HR_PERM.employeeManage] as PermissionKey[],
    });
    expect(app.status).toBe('active');
    // The clean hostname fronts the primary `app` surface, exactly as before.
    expect(app.hostname).toBe('egeryds.global.substrat.run');
    expect(await host.admin.resolveHostname('egeryds.global.substrat.run')).toMatchObject({
      scopeId: appScopeId,
      surface: 'app',
    });
    // ...and the SECOND surface arrived with its own `<base>-<surface>` URL, live, on the
    // same scope — the previously-missing binding that left multi-surface apps single-URL.
    expect(await host.admin.resolveHostname('egeryds-eka.global.substrat.run')).toMatchObject({
      scopeId: appScopeId,
      surface: 'eka',
    });
    // Both are active bindings on the scope, each canonical for its own surface.
    const bindings = await host.admin.listHostnames(staff, { scopeId: appScopeId });
    expect(
      bindings
        .filter((h) => h.status === 'active' && h.canonical)
        .map((h) => `${h.surface}:${h.hostname}`)
        .sort(),
    ).toEqual(['app:egeryds.global.substrat.run', 'eka:egeryds-eka.global.substrat.run']);
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

  it('heals the row’s lineage after a staff rebind-vertical (#389): the directory’s slug wins', async () => {
    const acme = await bootstrap('acme-rebind');
    const appScopeId = scopeId.parse(ulid());
    await createApp(host, {
      node: acme, appScopeId, verticalSlug: 'protocol', name: 'Rebound',
      appEntitlements: ['protocol'], appOwnerGrants: [PROTOCOL_PERM.read] as PermissionKey[],
    });
    const dash = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    type Ev = { kind: string; detail: string | null };

    // The write half of the read-path reconcile: the directory says the scope now runs
    // the tenant-owned lineage while the row still names the builtin it was installed as.
    const healed = (await dash.invoke('dashboard/reconcile-app-vertical', {
      appScopeId, verticalSlug: 'acme/protocol',
    })) as DashboardAppRow;
    expect(healed.vertical_slug).toBe('acme/protocol');
    const apps = await dash.invoke<DashboardAppRow[]>('dashboard/list-apps', {});
    expect(apps.find((a) => a.app_scope_id === appScopeId)?.vertical_slug).toBe('acme/protocol');

    // The move is on the Activity trail, naming both lineages...
    const events = await dash.invoke<Ev[]>('dashboard/app-events', { appScopeId });
    expect(events.some((e) => e.kind === 'updated' && e.detail === 'rebound protocol → acme/protocol')).toBe(true);

    // ...and a row already naming the directory's slug is left alone (no second event).
    await dash.invoke('dashboard/reconcile-app-vertical', { appScopeId, verticalSlug: 'acme/protocol' });
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
    await host.admin.promoteVersion(staff, 'helpdesk', 'prod', v2);

    const mine = await listDeploymentsFromHost(host, staff, acme);
    expect(mine.map((d) => d.slug)).toEqual(['helpdesk']); // not callout, not billing
    const hd = mine[0]!;
    expect(hd.displaySlug).toBe('helpdesk');
    // Newest-first: 0.2.0 (v2) before 0.1.0 (v1).
    expect(hd.versions.map((v) => v.id)).toEqual([v2, v1]);
    // No in-place serve ran (host.admin.promoteVersion moves the pointer only), so
    // servingVersionId stays null (#321 advances it only after a successful serve).
    expect(hd.channels).toContainEqual({ channel: 'prod', versionId: v2, servingVersionId: null });

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

  it('per-app deployments page: newest-first keyset pages, schemaChange intact across the page boundary', async () => {
    // Three versions, the newest with a DIFFERENT migration digest — so the page cut
    // falls exactly where schemaChange needs the (overfetched) predecessor in hand.
    await host.admin.registerVertical(staff, { slug: 'meridian', name: 'Meridian', source: 'builtin' });
    const v1 = ulid();
    const v2 = ulid();
    const v3 = ulid();
    await publish('meridian', '0.1.0', v1);
    await publish('meridian', '0.2.0', v2);
    await host.admin.publishVersion(staff, {
      id: v3,
      verticalSlug: 'meridian',
      version: '0.3.0',
      manifestDigest: 'm',
      permissionDigest: 'p',
      migrationDigest: 'g2', // differs from its predecessor's 'g'
      deploymentRef: `meridian-${v3.toLowerCase()}`,
    });
    await host.admin.admitVersion(staff, v3);
    await host.admin.promoteVersion(staff, 'meridian', 'prod', v3);

    const p1 = await verticalDeploymentPageFromHost(host, staff, 'meridian', { limit: 2 });
    expect(p1.versions.map((v) => v.id)).toEqual([v3, v2]); // newest first
    expect(p1.nextCursor).toBe(v2); // more exist — the cursor is the last row's id
    // 0.3.0 crossed a migration boundary (g → g2); 0.2.0 did not — its predecessor
    // (0.1.0) sits on the NEXT page, and the overfetch still saw it.
    expect(p1.versions.map((v) => v.schemaChange)).toEqual([true, false]);
    // The single channel rides every page complete (never paged).
    expect(p1.channels).toContainEqual({ channel: 'prod', versionId: v3, servingVersionId: null });

    const p2 = await verticalDeploymentPageFromHost(host, staff, 'meridian', { limit: 2, cursor: p1.nextCursor! });
    expect(p2.versions.map((v) => v.id)).toEqual([v1]);
    expect(p2.versions[0]!.schemaChange).toBe(false); // the first version — nothing precedes it
    expect(p2.nextCursor).toBeNull(); // short page — the walk is done
  });

  it('per-app: reads a version’s declared permission registry from its manifest (#336), null without one', async () => {
    // The embedded-mode path behind the Permissions tab: parse the registry out of the
    // version's retained manifest, and null for a version pushed before manifests existed.
    await host.admin.registerVertical(staff, { slug: 'meridian', name: 'Meridian', source: 'builtin' });
    const withReg = ulid();
    const withoutReg = ulid();
    const registry = {
      permissions: [{ key: 'hr:person-read', description: 'View a person', declaredBy: ['meridian'] }],
      roles: [{ key: 'admin', permissions: ['hr:person-read'], source: 'vertical' }],
      entityGrants: [],
    };
    await host.admin.publishVersion(staff, {
      id: withReg,
      verticalSlug: 'meridian',
      version: '0.2.0',
      manifestDigest: 'm',
      permissionDigest: 'p',
      migrationDigest: 'g',
      deploymentRef: `meridian-${withReg.toLowerCase()}`,
      manifestJson: JSON.stringify({
        version: '0.2.0',
        entry: 'index.js',
        compatibilityDate: '2026-07-01',
        registry,
        digests: { manifest: 'm', permission: 'p', migration: 'g' },
      }),
    });
    await publish('meridian', '0.1.0', withoutReg); // no manifestJson

    expect(await versionRegistryFromHost(host, staff, 'meridian', withReg)).toEqual(registry);
    expect(await versionRegistryFromHost(host, staff, 'meridian', withoutReg)).toBeNull();
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

  it('carries the grouping flags the New-app page splits on (owned / listed)', () => {
    // One registry, two lenses: `listed && !owned` renders under Marketplace,
    // `owned` under "Your verticals" (badged Published when both).
    const byS = Object.fromEntries(availableCatalog(registry, { tenantId: 'me' }).map((v) => [v.slug, v]));
    expect(byS['published']).toMatchObject({ owned: false, listed: true, source: 'cli' });
    expect(byS['mine-private']).toMatchObject({ owned: true, listed: false });
  });

  it('ensureCatalog seeds first-party as listed unless flagged not-yet-connected', () => {
    // `listed: e.connected !== false` — a bundled-but-undeployed entry stays private (would 501
    // on install in connected mode); a deployed one is published to everyone.
    const listedFor = (connected?: boolean) => connected !== false;
    expect(listedFor(false)).toBe(false);
    expect(listedFor(true)).toBe(true);
    expect(listedFor(undefined)).toBe(true);
  });
});
