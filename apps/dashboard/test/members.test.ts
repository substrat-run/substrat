import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { orgId, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { MODULES, provisionDashboard, reconcileRoles, ensureRosterSeeded, type DashboardNode } from '../src/index.js';
import type { DashboardMemberRow } from '../src/module.js';

/**
 * Phase 3 — team membership. An invite composes the invites engine (hashed,
 * accept-required); accepting flips the roster projection to active and (in the
 * worker) becomes a kernel role assignment. This test drives the module layer: the
 * §5.1 bound at invite time, the hash gate at accept time, and the roster.
 */
describe('Dashboard teams — invite + accept', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let staff = platformActorId.parse(ulid());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-members-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m);
    staff = platformActorId.parse(ulid());
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const PROVIDER = 'authhero';

  /** Bootstrap a team the way the worker's createTeam does: provision + org + init. */
  const makeTeam = async (slug: string, ownerEmail: string): Promise<DashboardNode> => {
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    const node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug,
      name: slug,
    });
    const org = orgId.parse(ulid());
    await host.admin.createOrg(staff, { id: org, tenantId: node.tenantId, slug: 'team', name: slug });
    const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await scope.invoke('dashboard/init-team', { orgId: org, ownerEmail });
    return node;
  };

  const members = async (node: DashboardNode): Promise<DashboardMemberRow[]> => {
    const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
    return scope.invoke<DashboardMemberRow[]>('dashboard/list-members', {});
  };

  it('delete-team is owner-only: revokes the roster and returns the members to unlink', async () => {
    const acme = await makeTeam('acme', 'owner@acme.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);

    // A non-owner principal (no roster row) is refused before anything changes.
    const stranger = principalId.parse(ulid());
    await host.admin.assignRole(staff, {
      principalId: stranger,
      roleKey: 'admin',
      node: { tenantId: acme.tenantId, scopeId: null },
    });
    const strangerScope = await host.getScope(stranger, acme.tenantId, acme.scopeId);
    await expect(strangerScope.invoke('dashboard/delete-team', {})).rejects.toThrow(
      /only the owner/,
    );
    expect(await members(acme)).not.toHaveLength(0);

    // The owner deletes: every roster row revoked, the member list returned.
    const result = (await ownerScope.invoke('dashboard/delete-team', {})) as {
      members: Array<{ principal: string; roleKey: string }>;
    };
    expect(result.members.some((m) => m.principal === acme.principal)).toBe(true);
    expect((await members(acme)).filter((m) => m.status === 'active')).toHaveLength(0);
  });

  it('a pre-roster team self-heals: the resolving caller is seeded as owner and can delete', async () => {
    // Provision the way pre-#191 code did: no org, no init-team — the roster tables
    // exist (migrations ran) but are empty. The tenant id is hand-built with a
    // pre-ROSTER_EPOCH timestamp so the heal's ULID gate lets it through.
    const legacy = await provisionDashboard(host, {
      tenantId: tenantId.parse('01KY54SRTR' + ulid().slice(10)),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug: 'legacy',
      name: 'legacy',
    });
    const scope = await host.getScope(legacy.principal, legacy.tenantId, legacy.scopeId);

    // The bug: the owner-by-kernel-role is refused because the roster has no row.
    await expect(scope.invoke('dashboard/delete-team', {})).rejects.toThrow(/only the owner/);

    // The heal seeds the resolving caller as the owner row (and the invite org).
    await ensureRosterSeeded(host, staff, legacy, 'owner@legacy.com');
    const roster = await members(legacy);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ email: 'owner@legacy.com', role_key: 'owner', status: 'active', principal: legacy.principal });
    expect(await host.admin.listOrgs(staff, legacy.tenantId)).toHaveLength(1);

    // An already-seeded team is left untouched — the roster read short-circuits.
    const acme = await makeTeam('acme-heal', 'owner@acme-heal.com');
    await ensureRosterSeeded(host, staff, acme, 'someone-else@acme-heal.com');
    const acmeRoster = await members(acme);
    expect(acmeRoster).toHaveLength(1);
    expect(acmeRoster[0]!.email).toBe('owner@acme-heal.com');

    // And the healed owner can now delete the organization.
    const result = (await scope.invoke('dashboard/delete-team', {})) as {
      members: Array<{ principal: string; roleKey: string }>;
    };
    expect(result.members).toEqual([{ principal: legacy.principal, roleKey: 'owner' }]);
  });

  it('owner invites, recipient accepts with the matching email, and the roster reflects it', async () => {
    const acme = await makeTeam('acme', 'owner@acme.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);

    // Owner seeded as the first active member.
    let roster = await members(acme);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ email: 'owner@acme.com', role_key: 'owner', status: 'active' });

    // Invite at 'member' → a pending roster row + an invitation.
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'jane@acme.com',
      roleKey: 'member',
    });
    roster = await members(acme);
    expect(roster.find((m) => m.email === 'jane@acme.com')).toMatchObject({ status: 'invited', role_key: 'member', principal: null });

    // Accept as a freshly-minted recipient principal, presenting the matching email.
    const jane = principalId.parse(ulid());
    const janeScope = await host.getScope(jane, acme.tenantId, acme.scopeId);
    const res = await janeScope.invoke<{ roleKey: string }>('dashboard/accept-invite', {
      invitationId,
      identifier: 'jane@acme.com',
    });
    expect(res.roleKey).toBe('member');

    // The roster row is now active and bound to Jane's principal.
    roster = await members(acme);
    expect(roster.find((m) => m.email === 'jane@acme.com')).toMatchObject({ status: 'active', principal: jane });
  });

  it('accepting with the wrong email is refused (the hash is the gate)', async () => {
    const acme = await makeTeam('acme2', 'owner@acme2.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'jane@acme2.com',
      roleKey: 'viewer',
    });
    const mallory = principalId.parse(ulid());
    const malloryScope = await host.getScope(mallory, acme.tenantId, acme.scopeId);
    await expect(
      malloryScope.invoke('dashboard/accept-invite', { invitationId, identifier: 'mallory@evil.com' }),
    ).rejects.toThrow(/not acceptable/);
  });

  it('a member cannot invite (§5.1: they lack manage-members)', async () => {
    const acme = await makeTeam('acme3', 'owner@acme3.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    // Invite + accept a plain member.
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'sam@acme3.com',
      roleKey: 'member',
    });
    const sam = principalId.parse(ulid());
    const samScope = await host.getScope(sam, acme.tenantId, acme.scopeId);
    await samScope.invoke('dashboard/accept-invite', { invitationId, identifier: 'sam@acme3.com' });
    // Sam has 'member' access in-scope (read/provision) but NOT the role at the tenant
    // node yet — the worker assigns that. So to isolate the §5.1 check, grant Sam the
    // member role at the tenant node and confirm they still cannot invite anyone.
    await host.admin.assignRole(staff, { principalId: sam, roleKey: 'member', node: { tenantId: acme.tenantId, scopeId: null } });
    await expect(
      samScope.invoke('dashboard/invite-member', { email: 'x@acme3.com', roleKey: 'viewer' }),
    ).rejects.toThrow(/permission denied/);
  });

  it('removing an active member revokes their role (unassignRole) and drops them from the roster', async () => {
    const acme = await makeTeam('acme5', 'owner@acme5.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'kim@acme5.com',
      roleKey: 'member',
    });
    const kim = principalId.parse(ulid());
    const kimScope = await host.getScope(kim, acme.tenantId, acme.scopeId);
    await kimScope.invoke('dashboard/accept-invite', { invitationId, identifier: 'kim@acme5.com' });
    // Mirror the worker's accept: assign Kim the member role (proven by a gated read
    // succeeding) and link her identity so the team is in her switcher.
    await host.admin.assignRole(staff, { principalId: kim, roleKey: 'member', node: { tenantId: acme.tenantId, scopeId: null } });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'kim-sub', principal: kim, tenantId: acme.tenantId, scopeId: acme.scopeId });
    await expect(kimScope.invoke('dashboard/list-members', {})).resolves.toBeDefined();
    expect(await host.admin.listIdentityTenants(staff, PROVIDER, 'kim-sub')).toContain(acme.tenantId);

    // Remove her: the op returns what to unassign, then the worker (here, the test) cuts
    // access (unassignRole) AND severs her login (unlinkIdentity).
    const removed = await ownerScope.invoke<{ principal: string; roleKey: string } | null>('dashboard/remove-member', {
      memberId: (await members(acme)).find((m) => m.email === 'kim@acme5.com')!.id,
    });
    expect(removed).toMatchObject({ principal: kim, roleKey: 'member' });
    await host.admin.unassignRole(staff, { principalId: kim, roleKey: 'member', node: { tenantId: acme.tenantId, scopeId: null } });
    await host.admin.unlinkIdentity(staff, acme.tenantId, kim);

    // Access is gone (the gated read denies), she is off the roster, and the team no
    // longer appears in her switcher.
    await expect(kimScope.invoke('dashboard/list-members', {})).rejects.toThrow(/permission denied/);
    expect((await members(acme)).find((m) => m.email === 'kim@acme5.com')).toBeUndefined();
    expect(await host.admin.listIdentityTenants(staff, PROVIDER, 'kim-sub')).not.toContain(acme.tenantId);
  });

  it('leaving a team detaches the caller (roster revoked + identity unlinked)', async () => {
    const acme = await makeTeam('acme7', 'owner@acme7.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'lee@acme7.com',
      roleKey: 'member',
    });
    const lee = principalId.parse(ulid());
    const leeScope = await host.getScope(lee, acme.tenantId, acme.scopeId);
    await leeScope.invoke('dashboard/accept-invite', { invitationId, identifier: 'lee@acme7.com' });
    await host.admin.assignRole(staff, { principalId: lee, roleKey: 'member', node: { tenantId: acme.tenantId, scopeId: null } });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'lee-sub', principal: lee, tenantId: acme.tenantId, scopeId: acme.scopeId });
    expect(await host.admin.listIdentityTenants(staff, PROVIDER, 'lee-sub')).toContain(acme.tenantId);

    // Lee leaves — mirror the worker: mark own row revoked, then unlink identity.
    await leeScope.invoke('dashboard/leave-self', {});
    await host.admin.unlinkIdentity(staff, acme.tenantId, lee);

    expect(await host.admin.listIdentityTenants(staff, PROVIDER, 'lee-sub')).not.toContain(acme.tenantId);
    expect((await members(acme)).find((m) => m.email === 'lee@acme7.com')).toBeUndefined();
  });

  it('the owner cannot be removed', async () => {
    const acme = await makeTeam('acme6', 'owner@acme6.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const ownerRow = (await members(acme)).find((m) => m.role_key === 'owner')!;
    const removed = await ownerScope.invoke<{ principal: string } | null>('dashboard/remove-member', { memberId: ownerRow.id });
    expect(removed).toBeNull();
    expect((await members(acme)).find((m) => m.role_key === 'owner')).toBeDefined();
  });

  it('resending a pending invite keeps the same id + address and stays acceptable', async () => {
    const acme = await makeTeam('acme8', 'owner@acme8.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'rae@acme8.com',
      roleKey: 'member',
    });

    // Resend: the still-open invitation is idempotent, so the id + address come back
    // unchanged and no duplicate roster row appears.
    const resent = await ownerScope.invoke<{ invitationId: string; email: string; roleKey: string } | null>(
      'dashboard/resend-invite',
      { invitationId },
    );
    expect(resent).toMatchObject({ invitationId, email: 'rae@acme8.com', roleKey: 'member' });
    expect((await members(acme)).filter((m) => m.email === 'rae@acme8.com')).toHaveLength(1);

    // The invitation the resend points at still accepts with the matching email.
    const rae = principalId.parse(ulid());
    const raeScope = await host.getScope(rae, acme.tenantId, acme.scopeId);
    const res = await raeScope.invoke<{ roleKey: string }>('dashboard/accept-invite', {
      invitationId: resent!.invitationId,
      identifier: 'rae@acme8.com',
    });
    expect(res.roleKey).toBe('member');
  });

  it('previews a pending invite (email + role) and returns null once it is settled', async () => {
    const acme = await makeTeam('acme10', 'owner@acme10.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'ivy@acme10.com',
      roleKey: 'admin',
    });

    // Preview needs no role — the signed token is the authority (the worker verifies it
    // before invoking). Here we invoke as a fresh, unrelated principal to prove that.
    const stranger = principalId.parse(ulid());
    const strangerScope = await host.getScope(stranger, acme.tenantId, acme.scopeId);
    const preview = await strangerScope.invoke<{ email: string; roleKey: string } | null>('dashboard/preview-invite', {
      invitationId,
    });
    expect(preview).toEqual({ email: 'ivy@acme10.com', roleKey: 'admin' });

    // Once revoked it is no longer pending, so there is nothing to preview.
    await ownerScope.invoke('dashboard/revoke-invite', { invitationId });
    await expect(strangerScope.invoke('dashboard/preview-invite', { invitationId })).resolves.toBeNull();
    await expect(strangerScope.invoke('dashboard/preview-invite', { invitationId: ulid() })).resolves.toBeNull();
  });

  it('resending a non-existent (or already settled) invite returns null', async () => {
    const acme = await makeTeam('acme9', 'owner@acme9.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'nel@acme9.com',
      roleKey: 'viewer',
    });
    await ownerScope.invoke('dashboard/revoke-invite', { invitationId });
    // The row is no longer 'invited', so there is nothing to resend.
    await expect(ownerScope.invoke('dashboard/resend-invite', { invitationId })).resolves.toBeNull();
    await expect(ownerScope.invoke('dashboard/resend-invite', { invitationId: ulid() })).resolves.toBeNull();
  });

  it('a revoked invite drops out of the roster and cannot be accepted', async () => {
    const acme = await makeTeam('acme4', 'owner@acme4.com');
    const ownerScope = await host.getScope(acme.principal, acme.tenantId, acme.scopeId);
    const { invitationId } = await ownerScope.invoke<{ invitationId: string }>('dashboard/invite-member', {
      email: 'gone@acme4.com',
      roleKey: 'member',
    });
    await ownerScope.invoke('dashboard/revoke-invite', { invitationId });
    expect((await members(acme)).find((m) => m.email === 'gone@acme4.com')).toBeUndefined();
    const p = principalId.parse(ulid());
    const pScope = await host.getScope(p, acme.tenantId, acme.scopeId);
    await expect(
      pScope.invoke('dashboard/accept-invite', { invitationId, identifier: 'gone@acme4.com' }),
    ).rejects.toThrow(/not acceptable/);
  });

  it('reconcileRoles backfills a permission added to a role after provisioning', async () => {
    // Simulates the real production case: a tenant provisioned before
    // dashboard:manage-integrations existed. Its owner role lacks the key, so the
    // in-scope check would deny — until reconcileRoles brings the role set current.
    const acme = await makeTeam('acme-recon', 'owner@recon.com');
    const owner = () =>
      host.admin.listRoles(staff, { tenantId: acme.tenantId }).then((rs) => rs.find((r) => r.key === 'owner')!);

    // Regress the owner role to a pre-feature set (read only).
    await host.admin.defineRole(staff, acme.tenantId, { key: 'owner', permissions: ['dashboard:read'] as never, source: 'vertical' });
    expect((await owner()).permissions).not.toContain('dashboard:manage-integrations');

    await reconcileRoles(host, staff, acme.tenantId);

    const perms = (await owner()).permissions;
    expect(perms).toContain('dashboard:manage-integrations'); // the new key is back
    expect(perms).toContain('dashboard:manage-members'); // and the rest of owner's set
  });
});
