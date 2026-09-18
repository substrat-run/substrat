import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { MODULES, ROLES, provisionDashboard, type DashboardNode } from '../src/index.js';
import { NODE_TTL_MS, PROVIDER, forgetLogin, forgetTenant, loginMemberships, newResolveMemo, resolveAccountNode, resolveNode, teamsOf, type ResolveMemo } from '../src/account.js';

/**
 * The per-request account resolve. Every `/api/*` handler opens with it, so its cost is
 * the floor under the whole portal — and it used to grow with the number of teams a
 * login is in (two audited directory reads PER TEAM, each a round trip to the one
 * directory Durable Object in production: ~3 s for a login in ten teams).
 *
 * The access log is the instrument: every audited directory read writes one row, so
 * "how many rows did a resolve write" IS "how many reads did it make", and the suite
 * can hold the count to a constant without a stopwatch.
 */
describe('Dashboard account resolve', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let staff = platformActorId.parse(ulid());
  let memo: ResolveMemo;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-account-'));
    host = new SqliteScopeHost({ dir });
    for (const m of MODULES) host.registerModule(m);
    staff = platformActorId.parse(ulid());
    memo = newResolveMemo();
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A team the way the worker's createTeam makes one; `linkScope: false` is a legacy link. */
  const makeTeam = async (slug: string, sub: string, opts: { linkScope?: boolean } = {}): Promise<DashboardNode> => {
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    const node = await provisionDashboard(host, {
      tenantId: tenantId.parse(ulid()),
      scopeId: scopeId.parse(ulid()),
      owner: principalId.parse(ulid()),
      slug,
      name: slug,
    });
    await host.admin.linkIdentity(staff, {
      provider: PROVIDER,
      externalId: sub,
      principal: node.principal,
      tenantId: node.tenantId,
      ...(opts.linkScope === false ? {} : { scopeId: node.scopeId }),
    });
    return node;
  };

  const resolve = async (sub: string, selected?: string) =>
    resolveNode(host, staff, memo, await loginMemberships(host, staff, memo, sub), selected);

  it('resolves the selected team to the node the link was made with', async () => {
    const a = await makeTeam('team-a', 'sam');
    const b = await makeTeam('team-b', 'sam');
    expect(await resolve('sam', b.tenantId)).toEqual(b);
    expect(await resolve('sam', a.tenantId)).toEqual(a);
  });

  it('never resolves into a team the login is not in, whatever the cookie says', async () => {
    const mine = await makeTeam('mine', 'sam');
    const theirs = await makeTeam('theirs', 'alex');
    // A forged `sb_team` names somebody else's team: it is ignored, not honoured —
    // the candidates come from the directory's answer, never from the cookie.
    expect(await resolve('sam', theirs.tenantId)).toEqual(mine);
    expect(await resolve('nobody', theirs.tenantId)).toBeNull();
  });

  it('neither resolves nor lists a team whose tenant is not active', async () => {
    const dead = await makeTeam('dead', 'sam');
    const live = await makeTeam('live', 'sam');
    await host.admin.setTenantStatus(staff, dead.tenantId, 'deleting');
    const memberships = await loginMemberships(host, staff, memo, 'sam');
    expect(teamsOf(memberships).map((t) => t.id)).toEqual([live.tenantId]);
    // Selecting the dead team falls through to a live one rather than landing in it.
    expect(await resolveNode(host, staff, memo, memberships, dead.tenantId)).toEqual(live);
  });

  it('still lands a link that named no scope, through the directory', async () => {
    const legacy = await makeTeam('legacy', 'sam', { linkScope: false });
    expect(await resolve('sam', legacy.tenantId)).toEqual(legacy);
  });

  it('costs ONE directory read once warm, however many teams the login is in', async () => {
    const teams: DashboardNode[] = [];
    for (let i = 0; i < 6; i++) teams.push(await makeTeam(`team-${i}`, 'sam'));
    const asker = platformActorId.parse(ulid());
    // Warm the isolate-lifetime self-heals (pool registration, role reconcile) for
    // every team, as a running worker has — what is measured is the steady state.
    for (const t of teams) await resolveNode(host, asker, memo, await loginMemberships(host, asker, memo, 'sam'), t.tenantId);
    const before = (await host.admin.accessLog(staff, { actor: asker })).length;

    for (const t of teams) {
      expect(await resolveNode(host, asker, memo, await loginMemberships(host, asker, memo, 'sam'), t.tenantId)).toEqual(t);
    }

    const rows = (await host.admin.accessLog(staff, { actor: asker })).slice(before);
    expect(rows.map((r) => r.method)).toEqual(teams.map(() => 'listIdentityMemberships'));
  });

  it('heals role drift on the first resolve, and does not re-read roles after it', async () => {
    const team = await makeTeam('drifted', 'sam');
    const owner = ROLES.find((r) => r.key === 'owner')!;
    // A tenant provisioned before a permission joined the role: fewer keys than ROLES.
    await host.admin.defineRole(staff, team.tenantId, { ...owner, permissions: owner.permissions.slice(0, 1) });

    await resolve('sam', team.tenantId);

    const healed = (await host.admin.listRoles(staff, { tenantId: team.tenantId })).find((r) => r.key === 'owner')!;
    expect([...healed.permissions].sort()).toEqual([...owner.permissions].sort());
    expect(memo.roles.has(team.tenantId)).toBe(true);
    expect(memo.pool).toBe(true);
  });

  it('gives a login with no team nothing to resolve and nothing to list', async () => {
    await makeTeam('somebody-elses', 'alex');
    expect(await resolve('sam')).toBeNull();
    expect(teamsOf(await loginMemberships(host, staff, memo, 'sam'))).toEqual([]);
  });

  describe('the 30-second node cache', () => {
    const T0 = 1_800_000_000_000;
    const reads = async (actor: ReturnType<typeof platformActorId.parse>) =>
      (await host.admin.accessLog(staff, { actor })).filter((r) => r.method === 'listIdentityMemberships').length;

    it('reuses a resolved node inside the window, and reads again once it lapses', async () => {
      const team = await makeTeam('cached', 'sam');
      const asker = platformActorId.parse(ulid());
      expect(await resolveAccountNode(host, asker, memo, 'sam', team.tenantId, T0)).toEqual(team);
      expect(await resolveAccountNode(host, asker, memo, 'sam', team.tenantId, T0 + NODE_TTL_MS - 1)).toEqual(team);
      expect(await reads(asker)).toBe(1);
      await resolveAccountNode(host, asker, memo, 'sam', team.tenantId, T0 + NODE_TTL_MS);
      expect(await reads(asker)).toBe(2);
    });

    it('is the revocation window it says it is — and no longer', async () => {
      const team = await makeTeam('revoked', 'sam');
      await resolveAccountNode(host, staff, memo, 'sam', team.tenantId, T0);
      await host.admin.unlinkIdentity(staff, team.tenantId, team.principal);
      // Another isolate would not have heard: inside the window the stale node still resolves…
      expect(await resolveAccountNode(host, staff, memo, 'sam', team.tenantId, T0 + 1)).toEqual(team);
      // …and at the boundary it is gone, with nothing else having to happen.
      expect(await resolveAccountNode(host, staff, memo, 'sam', team.tenantId, T0 + NODE_TTL_MS)).toBeNull();
    });

    it('drops a team’s entries at once in the isolate that ended the membership', async () => {
      const team = await makeTeam('removed', 'sam');
      await resolveAccountNode(host, staff, memo, 'sam', team.tenantId, T0);
      await host.admin.unlinkIdentity(staff, team.tenantId, team.principal);
      forgetTenant(memo, team.tenantId);
      expect(await resolveAccountNode(host, staff, memo, 'sam', team.tenantId, T0 + 1)).toBeNull();
    });

    it('never caches "no team", so a login resolves the moment it has one', async () => {
      expect(await resolveAccountNode(host, staff, memo, 'sam', undefined, T0)).toBeNull();
      const team = await makeTeam('first', 'sam');
      expect(await resolveAccountNode(host, staff, memo, 'sam', undefined, T0 + 1)).toEqual(team);
    });

    it('keys on the selected team, and forgets one login without touching another', async () => {
      const a = await makeTeam('ka', 'sam');
      const b = await makeTeam('kb', 'sam');
      const other = await makeTeam('kc', 'alex');
      expect(await resolveAccountNode(host, staff, memo, 'sam', a.tenantId, T0)).toEqual(a);
      expect(await resolveAccountNode(host, staff, memo, 'sam', b.tenantId, T0)).toEqual(b);
      await resolveAccountNode(host, staff, memo, 'alex', other.tenantId, T0);
      forgetLogin(memo, 'sam');
      expect([...memo.nodes.values()].map((e) => e.userId)).toEqual(['alex']);
    });
  });

  it('hands each team its own principal — one login, separate authority', async () => {
    const a = await makeTeam('pa', 'sam');
    const b = await makeTeam('pb', 'sam');
    const principals: PrincipalId[] = [(await resolve('sam', a.tenantId))!.principal, (await resolve('sam', b.tenantId))!.principal];
    expect(new Set(principals).size).toBe(2);
  });
});
