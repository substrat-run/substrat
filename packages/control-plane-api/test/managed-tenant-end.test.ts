import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { createControlPlaneApi } from './setup/build-fixtures.js';
import { ControlPlaneError, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, type VerticalClient } from '../src/index.js';

/**
 * A managed tenant's END takes its sign-in off its manager's team auth-servers (#3261, D-72).
 *
 * A tenant a manager provisioned with `instance.signIn` signs in at one of the manager's team
 * auth-servers and is a place there, so people's account pages list it. These are the staff
 * routes that end it, over a real directory, with the auth-servers as fakes that record what
 * they are told:
 *
 *   - `deleting` takes the place off (`substrat:places:<tenant>` = `""`) and keeps the client;
 *   - a tenant or scope reap removes the client, the place and the redirect record, keyed by
 *     the scope, BEFORE anything is wiped;
 *   - an auth-server that cannot be reached stops the reap (502, nothing wiped) and is answered
 *     on the status change (502), and the retry finishes it;
 *   - only the MANAGER's issuers are asked, and a tenant no manager provisioned asks nobody.
 */

const staff = platformActorId.parse(ulid());
const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };

let dir: string;
let host: SqliteScopeHost;
const manager = tenantId.parse(ulid());
const managerIssuer = scopeId.parse(ulid());
const managerCrm = scopeId.parse(ulid());
const otherTeam = tenantId.parse(ulid());
const otherIssuer = scopeId.parse(ulid());

type Call =
  | { at: string; verb: 'configure'; tenantId: string; entries: Array<{ key: string; value: string }> }
  | { at: string; verb: 'remove'; tenantId: string; appTenantId: string; appScopeId: string }
  | { at: string; verb: 'wipe' };
let calls: Call[];
let issuerMode: 'ok' | 'down' | 'legacy';

/** One fake deployment per vertical; each records the scope it was addressed for. */
const issuerClient = {
  configureInstance: async (input: { tenantId: string; scopeId: string; entries: Array<{ key: string; value: string }> }) => {
    if (issuerMode === 'down') throw new Error('auth server unreachable');
    calls.push({ at: input.scopeId, verb: 'configure', tenantId: input.tenantId, entries: input.entries });
  },
  removeManagedClient: async (input: { tenantId: string; scopeId: string; appTenantId: string; appScopeId: string }) => {
    if (issuerMode === 'down') throw new Error('auth server unreachable');
    if (issuerMode === 'legacy') throw new ControlPlaneError(501, 'the auth server predates managed clients (#3261) — redeploy it');
    calls.push({ at: input.scopeId, verb: 'remove', tenantId: input.tenantId, appTenantId: input.appTenantId, appScopeId: input.appScopeId });
    return { removed: `client-of-${input.appScopeId}`, unlisted: true };
  },
  deleteScope: async (input: { scopeId: string }) => {
    calls.push({ at: input.scopeId, verb: 'wipe' });
  },
} as unknown as VerticalClient;
const appClient = {
  deleteScope: async (input: { scopeId: string }) => {
    calls.push({ at: input.scopeId, verb: 'wipe' });
  },
} as unknown as VerticalClient;

const api = () =>
  createControlPlaneApi({
    host,
    authenticate: UNSAFE_devPlatformActorAuth(),
    verticals: { 'team-auth': issuerClient, crm: appClient, 'managed-product': appClient },
  });

async function scope(t: TenantId, s: ScopeId, vertical: string) {
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
  await host.admin.activateScope(staff, t, s);
}

/** A business the manager provisioned (stamped as `provision-tenant` stamps it), or one nobody manages. */
async function business(managed = true) {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, {
    id: t,
    slug: `biz-${t.slice(-8).toLowerCase()}`,
    name: 'Corner Shop',
    ...(managed ? { provisionedByTenant: manager } : {}),
  });
  await scope(t, s, 'managed-product');
  return { t, s };
}

const patchStatus = (t: string, status: string) =>
  api().request(`/tenants/${t}/status`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status }) });
const reapTenant = (t: string) => api().request(`/tenants/${t}/reap`, { method: 'POST', headers: auth, body: '{}' });
const reapScope = (t: string, s: string) =>
  api().request(`/tenants/${t}/scopes/${s}/reap`, { method: 'POST', headers: auth, body: JSON.stringify({ backup: false }) });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cp-managed-end-'));
  host = new SqliteScopeHost({ dir });
  await host.admin.registerVertical(staff, { slug: 'team-auth', name: 'Team Auth', source: 'builtin', provides: ['oidc-issuer'] });
  await host.admin.registerVertical(staff, { slug: 'crm', name: 'CRM', source: 'builtin' });
  await host.admin.registerVertical(staff, { slug: 'managed-product', name: 'Managed Product', source: 'builtin' });
  await host.admin.createTenant(staff, { id: manager, slug: 'manager', name: 'Manager' });
  await scope(manager, managerIssuer, 'team-auth');
  await scope(manager, managerCrm, 'crm');
  await host.admin.createTenant(staff, { id: otherTeam, slug: 'other-team', name: 'Other Team' });
  await scope(otherTeam, otherIssuer, 'team-auth');
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  issuerMode = 'ok';
});

describe("a managed tenant's end at its manager's auth-servers (#3261, D-72)", () => {
  it("deleting takes its place off the manager's auth-server only, and keeps the client", async () => {
    const { t } = await business();
    const res = await patchStatus(t, 'deleting');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('deleting');
    // Its own key, the whole set emptied; no other team's issuer, no app that is no issuer, no removal.
    expect(calls).toEqual([{ at: managerIssuer, verb: 'configure', tenantId: manager, entries: [{ key: `substrat:places:${t}`, value: '' }] }]);
  });

  it('a tenant no manager provisioned asks no auth-server, on deleting or on its reap', async () => {
    const { t, s } = await business(false);
    expect((await patchStatus(t, 'deleting')).status).toBe(200);
    await host.admin.archiveScope(staff, t, s);
    expect((await reapTenant(t)).status).toBe(200);
    expect(calls).toEqual([{ at: s, verb: 'wipe' }]);
  });

  it('an auth-server that cannot be told while deleting is answered, and repeating the request finishes it', async () => {
    const { t } = await business();
    issuerMode = 'down';
    const res = await patchStatus(t, 'deleting');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      detail: expect.stringMatching(/is deleting, but its place may still be listed/),
      reason: expect.stringContaining(`${managerIssuer}: auth server unreachable`),
    });
    // The containment did not wait on the auth-server.
    expect((await host.admin.getTenant(staff, t))?.status).toBe('deleting');
    issuerMode = 'ok';
    expect((await patchStatus(t, 'deleting')).status).toBe(200);
    expect(calls.map((c) => c.verb)).toEqual(['configure']);
  });

  it("the tenant's reap removes its client, place and record, keyed by its scope, before anything is wiped", async () => {
    const { t, s } = await business();
    await host.admin.setTenantStatus(staff, t, 'deleting');
    expect((await reapTenant(t)).status).toBe(200);
    expect(calls).toEqual([
      { at: managerIssuer, verb: 'remove', tenantId: manager, appTenantId: t, appScopeId: s },
      { at: s, verb: 'wipe' },
    ]);
    expect((await host.admin.getTenant(staff, t))?.status).toBe('reaped');
  });

  it('a reap whose auth-server cannot be reached wipes nothing, and its retry finishes the job', async () => {
    const { t, s } = await business();
    await host.admin.setTenantStatus(staff, t, 'deleting');
    issuerMode = 'down';
    const res = await reapTenant(t);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      detail: expect.stringMatching(/not reaped .* nothing was wiped/),
      reason: expect.stringContaining(`${managerIssuer}: auth server unreachable`),
    });
    expect(calls).toEqual([]);
    expect((await host.admin.getTenant(staff, t))?.status).toBe('deleting');
    expect((await host.admin.getScopeRecord(staff, t, s))?.status).toBe('active');

    issuerMode = 'ok';
    expect((await reapTenant(t)).status).toBe(200);
    expect(calls.map((c) => c.verb)).toEqual(['remove', 'wipe']);
  });

  it("an auth-server deployed before the keyed verb is told the un-registrations a delivery can say", async () => {
    const { t, s } = await business();
    await host.admin.setTenantStatus(staff, t, 'deleting');
    issuerMode = 'legacy';
    expect((await reapTenant(t)).status).toBe(200);
    expect(calls).toEqual([
      {
        at: managerIssuer,
        verb: 'configure',
        tenantId: manager,
        entries: [
          { key: `substrat:redirects:${s}`, value: '' },
          { key: `substrat:places:${t}`, value: '' },
        ],
      },
      { at: s, verb: 'wipe' },
    ]);
  });

  it("the scope reap removes that scope's sign-in, and refuses to wipe while it cannot", async () => {
    const { t, s } = await business();
    await host.admin.archiveScope(staff, t, s);
    issuerMode = 'down';
    expect((await reapScope(t, s)).status).toBe(502);
    expect(calls).toEqual([]);
    expect((await host.admin.getScopeRecord(staff, t, s))?.status).toBe('archived');
    issuerMode = 'ok';
    expect((await reapScope(t, s)).status).toBe(200);
    expect(calls).toEqual([
      { at: managerIssuer, verb: 'remove', tenantId: manager, appTenantId: t, appScopeId: s },
      { at: s, verb: 'wipe' },
    ]);
  });
});
