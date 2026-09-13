import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { manualClock, ulid, type ManualClock } from '@substrat-run/kernel';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { MODULES, ROLES, provisionDashboard, type DashboardNode } from '../src/index.js';
import { deriveIdentityDivergence } from '../src/identity-mirror.js';

/**
 * What the dashboard's OWN directory holds (#1343).
 *
 * `docs/briefs/dashboard-control-plane-retirement.md` inventories this in prose, from
 * reading the code. Prose is what the architecture note already had, and it was wrong —
 * it described the directory as holding identity links when it holds a whole host's
 * worth of state. So the inventory is asserted here too, against a real host running the
 * real `provisionDashboard`.
 *
 * What this is FOR, beyond documentation: the migration's whole risk is a fact that
 * lives only in the local directory and is not carried across. Every such fact is named
 * below, so adding a new one — a role, an entitlement, another tenant-level write in
 * `provisionDashboard` — fails here rather than being discovered during a cutover.
 *
 * It deliberately does NOT assert the shared side. That is production state, reachable
 * only over HTTP with staff credentials, and the brief keeps it as a step a human runs.
 */
describe('the dashboard directory, as provisioning leaves it (#1343)', () => {
  let dir: string;
  let clock: ManualClock;
  let host: SqliteScopeHost;
  let node: DashboardNode;
  const staff = '01JZ000000000000000000DAS1' as never;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-dash-inventory-'));
    clock = manualClock('2026-09-13T09:00:00.000Z');
    host = new SqliteScopeHost({ dir, clock: clock.read });
    for (const m of MODULES) host.registerModule(m);
    node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'acme',
      name: 'Acme',
    });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a tenant — the one fact the mirror carries across', () => {
    // `ensureTenant` + the name sync in `identity-mirror.ts` put this in the shared
    // directory on every `/api/me`. It is the only row below with a path across today.
    return expect(host.admin.getTenant(staff, node.tenantId)).resolves.toMatchObject({
      slug: 'acme',
      name: 'Acme',
    });
  });

  it('writes a dashboard SCOPE that exists in no other directory', async () => {
    // The shared plane knows a team's APPS, provisioned through `authority.ts`. This
    // scope is not one of them: nothing provisions it there, so a cutover that assumed
    // the mirror had covered the team would find the team's own workspace missing.
    const scopes = await host.admin.listScopes(staff, { tenantId: node.tenantId, vertical: 'dashboard' });
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.id).toBe(node.scopeId);
    expect(scopes[0]!.status).toBe('active');
  });

  it('grants both entitlements, which exist in no other directory', async () => {
    // Both are default-deny gates: without them the vertical's operations do not
    // resolve at all, so a backfill that forgot them would leave a signed-in owner
    // looking at a workspace whose every call 404s.
    const held = (await host.admin.listEntitlements(staff, node.tenantId)).map((e) => e.entitlementKey);
    expect(held).toContain('dashboard');
    // The invites engine runs in this scope and is gated separately.
    expect(held).toContain('invites');
  });

  it('defines roles and seats the owner — tuples that exist in no other directory', async () => {
    // The owner seat is what makes the signed-in user anything at all. #1343's stated
    // hazard is "a window in which a signed-in user resolves to no principal", and this
    // row is the one that decides it.
    const roles = await host.admin.listRoles(staff, { tenantId: node.tenantId });
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.map((r) => r.key)).toContain('owner');
  });

  it('names every local-only fact the migration has to carry', async () => {
    // The inventory, as one assertion, so the brief's table stops being prose that can
    // drift away from the code the way §3's description did. Pinned to the actual
    // constants: if `provisionDashboard` grows a role or an entitlement, this fails,
    // which is the point — a fact nobody added to the backfill is the failure mode.
    const [scopes, roles, held] = await Promise.all([
      host.admin.listScopes(staff, { tenantId: node.tenantId, vertical: 'dashboard' }),
      host.admin.listRoles(staff, { tenantId: node.tenantId }),
      host.admin.listEntitlements(staff, node.tenantId),
    ]);
    expect({
      dashboardScopes: scopes.map((x) => x.status),
      roles: roles.map((r) => r.key).sort(),
      entitlements: held.map((e) => e.entitlementKey).sort(),
    }).toEqual({
      dashboardScopes: ['active'],
      roles: ROLES.map((r) => r.key).sort(),
      entitlements: ['dashboard', 'invites'],
    });
  });

  it('reads a divergence with nothing on the shared side as ALL missing, never as agreement', async () => {
    // The state a team that predates the mirror is in. `deriveIdentityDivergence` is
    // already the right instrument for the migration's reconciliation step — this pins
    // that an empty shared side reads as work to do rather than as "in sync", which is
    // how an empty result would read if the caller only counted conflicts.
    const divergence = deriveIdentityDivergence(
      [{ provider: 'authhero', externalId: 'user-1', principal: node.principal, tenantId: node.tenantId }] as never,
      [],
    );
    expect(divergence.missing).toHaveLength(1);
    expect(divergence.conflicting).toHaveLength(0);
    expect(divergence.inSync).toBe(false);
  });
});
