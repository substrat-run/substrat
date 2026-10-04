import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  orgId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type AdminLogEntry,
  type OrgId,
  type PermissionKey,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import {
  registerMembershipExecutor,
  ulid,
  type ExecutorOutcome,
  type ScopeHost,
} from '@substrat-run/kernel';
import { INVITEFIX_A, INVITEFIX_B, membershipFixtureMod } from './membership-module.js';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * The membership executor (#1184, K-22 §4.2) on every adapter: an accepted invite becomes a
 * member with the admin trail correlated, a redelivery changes nothing, a rolled-back accept
 * effects nothing, and an invite for authority its sender does not hold — or no longer holds,
 * demoted or removed — is refused for good, where both the accepting call and an admin can see
 * it. Both delivery paths are held: the inline tail of the accept, and `drainDue` as backstop.
 *
 * The fixture's checker must be a REAL one: the bound is a permission-set comparison, and an
 * allow-all checker would cover everything and prove nothing.
 */
export function membershipExecutorContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  const staff = platformActorId.parse(ulid());
  const vertical = 'invitefix-vertical';

  /** One tenant with two scopes, the two roles, an org, and the executor mounted at `level`. */
  const world = (level: 'scope' | 'tenant') => {
    const w = {
      fixture: undefined as unknown as ScopeHostFixture,
      host: undefined as unknown as ScopeHost,
      t: tenantId.parse(ulid()),
      s: scopeId.parse(ulid()),
      s2: scopeId.parse(ulid()),
      org: orgId.parse(ulid()) as OrgId,
      alice: principalId.parse(ulid()), // lead, tenant-wide
      bob: principalId.parse(ulid()), // member, tenant-wide
    };
    beforeAll(async () => {
      w.fixture = await makeFixture();
      w.host = w.fixture.host;
      w.host.registerModule(membershipFixtureMod);
      // `baseDelayMs: 0` so the backstop case can retry inside a test.
      registerMembershipExecutor(w.host, { actor: staff, level, retry: { baseDelayMs: 0 } });
      const { host, t } = w;
      await host.admin.createTenant(staff, { id: t, slug: `invitefix-${t.slice(-10).toLowerCase()}`, name: 'Invitefix' });
      await host.admin.grantEntitlement(staff, t, 'invitefix');
      for (const s of [w.s, w.s2]) {
        await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
        await host.admin.activateScope(staff, t, s);
      }
      await host.admin.defineRole(staff, t, { key: 'lead', permissions: [INVITEFIX_A, INVITEFIX_B], source: 'vertical' });
      await host.admin.defineRole(staff, t, { key: 'member', permissions: [INVITEFIX_A], source: 'vertical' });
      await host.admin.createOrg(staff, { id: w.org, tenantId: t, slug: 'team', name: 'Team' });
      await host.admin.assignRole(staff, { principalId: w.alice, roleKey: 'lead', node: { tenantId: t, scopeId: null } });
      await host.admin.assignRole(staff, { principalId: w.bob, roleKey: 'member', node: { tenantId: t, scopeId: null } });
    });
    afterAll(async () => {
      await w.fixture.cleanup();
    });
    return w;
  };

  type World = ReturnType<typeof world>;

  const send = async (w: World, from: PrincipalId, roleKey: string, org: OrgId = w.org) => {
    const inv = { invitationId: ulid(), orgId: org, roleKey };
    await (await w.host.getScope(from, w.t, w.s)).invoke('invitefix/send', inv);
    return inv;
  };

  /** Invoke as `who` and return what the inline tail did with `who`'s membership request. */
  const asJoiner = async (w: World, who: PrincipalId, operation: string, input: unknown): Promise<ExecutorOutcome[]> => {
    const outcomes: ExecutorOutcome[] = [];
    await (await w.host.getScope(who, w.t, w.s)).invoke(operation, input, {
      onExecutorOutcomes: (o) => outcomes.push(...o),
    });
    return outcomes.filter((o) => o.eventType === 'member.add-requested' && o.entity === `membership:${who}`);
  };

  const holds = async (w: World, who: PrincipalId, permission: PermissionKey, s: ScopeId = w.s) =>
    ((await (await w.host.getScope(who, w.t, s)).invoke('invitefix/probe', { permission })) as { allowed: boolean }).allowed;

  const memberOf = async (w: World, who: PrincipalId, org: OrgId = w.org) =>
    (await w.host.admin.listMembers(staff, w.t, org)).filter((m) => m.principal === who).length;

  const causedBy = async (w: World, eventId: string): Promise<AdminLogEntry[]> =>
    (await w.host.admin.auditLog(staff, { tenantId: w.t, limit: 500 })).filter((e) => e.causedBy === eventId);

  /** A refusal, seen from both sides: the accepting call, and the journal an admin reads. */
  const expectRefused = async (w: World, outcomes: ExecutorOutcome[], who: PrincipalId, reason: RegExp) => {
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome).toBe('refused');
    expect(outcomes[0]!.error).toMatch(reason);
    const dead = (await w.host.executorDeadLetters(w.t, w.s)).find((d) => d.eventId === outcomes[0]!.eventId);
    expect(dead?.executorId).toBe('membership');
    expect(dead?.error).toMatch(/^refused: /);
    expect(dead?.error).toMatch(reason);
    expect(dead?.attempts).toBe(1);
    expect(await memberOf(w, who)).toBe(0);
    expect(await holds(w, who, INVITEFIX_A)).toBe(false);
    expect(await causedBy(w, outcomes[0]!.eventId)).toEqual([]);
  };

  describe(`membership executor (#1184), scope level: ${adapterName}`, () => {
    const w = world('scope');

    it('an accepted invite makes a member inline, with the admin trail correlated to the event', async () => {
      const joe = principalId.parse(ulid());
      const inv = await send(w, w.alice, 'member');
      const outcomes = await asJoiner(w, joe, 'invitefix/accept', inv);

      expect(outcomes.map((o) => o.outcome)).toEqual(['delivered']);
      expect(await memberOf(w, joe)).toBe(1);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
      // The role carried only what was invited, and only in the scope it was accepted in.
      expect(await holds(w, joe, INVITEFIX_B)).toBe(false);
      expect(await holds(w, joe, INVITEFIX_A, w.s2)).toBe(false);

      // Both rows join the event that caused them, executed by the platform actor on behalf of
      // the inviter whose authority bounded them.
      const rows = await causedBy(w, outcomes[0]!.eventId);
      expect(rows.map((r) => r.action).sort()).toEqual(['addMember', 'assignRole']);
      for (const row of rows) {
        expect(row.actor).toBe(staff);
        expect(row.onBehalfOf).toMatchObject({ principal: w.alice, tenantId: w.t });
      }
    });

    it('a redelivery is a no-op: the backstop finds nothing due, and the trail gains no row', async () => {
      const joe = principalId.parse(ulid());
      const outcomes = await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member'));
      const before = await causedBy(w, outcomes[0]!.eventId);
      const report = await w.host.drainDue(w.t, w.s);
      expect(report.attempted).toBe(0);
      expect(await causedBy(w, outcomes[0]!.eventId)).toEqual(before);
      expect(await memberOf(w, joe)).toBe(1);
    });

    it('a rolled-back accept effects nothing, inline or later', async () => {
      const joe = principalId.parse(ulid());
      const inv = await send(w, w.alice, 'member');
      const outcomes: ExecutorOutcome[] = [];
      await expect(
        (await w.host.getScope(joe, w.t, w.s)).invoke('invitefix/accept-and-throw', inv, {
          onExecutorOutcomes: (o) => outcomes.push(...o),
        }),
      ).rejects.toThrow(/deliberate failure/);
      expect(outcomes).toEqual([]);
      expect((await w.host.drainDue(w.t, w.s)).attempted).toBe(0);
      expect(await memberOf(w, joe)).toBe(0);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
    });

    it('refuses an invite for a role beyond the inviter, for good, and says what was missing', async () => {
      const joe = principalId.parse(ulid());
      const outcomes = await asJoiner(w, joe, 'invitefix/accept', await send(w, w.bob, 'lead'));
      await expectRefused(w, outcomes, joe, /invitefix:b/);
      // Terminal: the backstop does not try again.
      expect((await w.host.drainDue(w.t, w.s)).attempted).toBe(0);
      expect(await memberOf(w, joe)).toBe(0);
    });

    it('refuses an invite whose sender was demoted between send and accept', async () => {
      const carol = principalId.parse(ulid());
      await w.host.admin.assignRole(staff, { principalId: carol, roleKey: 'lead', node: { tenantId: w.t, scopeId: null } });
      const inv = await send(w, carol, 'lead');
      await w.host.admin.unassignRole(staff, { principalId: carol, roleKey: 'lead', node: { tenantId: w.t, scopeId: null } });
      await w.host.admin.assignRole(staff, { principalId: carol, roleKey: 'member', node: { tenantId: w.t, scopeId: null } });
      const joe = principalId.parse(ulid());
      await expectRefused(w, await asJoiner(w, joe, 'invitefix/accept', inv), joe, /invitefix:b/);
    });

    it('refuses an invite whose sender was removed from the tenant between send and accept — and its twin delivers', async () => {
      // Dave's authority is his membership of an org the tenant granted both permissions to.
      const staffOrg = orgId.parse(ulid());
      const dave = principalId.parse(ulid());
      await w.host.admin.createOrg(staff, { id: staffOrg, tenantId: w.t, slug: 'staff', name: 'Staff' });
      for (const p of [INVITEFIX_A, INVITEFIX_B]) {
        await w.host.admin.grantToOrg(staff, staffOrg, p, { tenantId: w.t, scopeId: null });
      }
      await w.host.admin.addMember(staff, w.t, dave, staffOrg);

      // Twin: while he is a member, authority through the org is authority he can confer.
      const kept = principalId.parse(ulid());
      expect((await asJoiner(w, kept, 'invitefix/accept', await send(w, dave, 'lead'))).map((o) => o.outcome)).toEqual(['delivered']);

      const inv = await send(w, dave, 'lead');
      await w.host.admin.removeMember(staff, w.t, dave, staffOrg);
      const joe = principalId.parse(ulid());
      await expectRefused(w, await asJoiner(w, joe, 'invitefix/accept', inv), joe, /invitefix:a, invitefix:b/);
    });

    it('a role held only in this scope may be conferred in this scope', async () => {
      // The twin of the tenant-level suite's refusal below: the same authority, at the node it holds.
      const erin = principalId.parse(ulid());
      await w.host.admin.assignRole(staff, { principalId: erin, roleKey: 'lead', node: { tenantId: w.t, scopeId: w.s } });
      const joe = principalId.parse(ulid());
      expect((await asJoiner(w, joe, 'invitefix/accept', await send(w, erin, 'lead'))).map((o) => o.outcome)).toEqual(['delivered']);
      expect(await holds(w, joe, INVITEFIX_B)).toBe(true);
    });

    describe('a request the payload alone vouches for is refused', () => {
      it('naming another tenant', async () => {
        const joe = principalId.parse(ulid());
        const inv = await send(w, w.alice, 'member');
        const outcomes = await asJoiner(w, joe, 'invitefix/request', {
          entityId: joe,
          payload: { principal: joe, orgId: inv.orgId, tenantId: tenantId.parse(ulid()), roleKey: 'member', invitationId: inv.invitationId },
        });
        await expectRefused(w, outcomes, joe, /tenant other than its own/);
      });

      it('naming a principal other than the one who accepted', async () => {
        const joe = principalId.parse(ulid());
        const someoneElse = principalId.parse(ulid());
        const inv = await send(w, w.alice, 'member');
        const outcomes = await asJoiner(w, joe, 'invitefix/request', {
          entityId: joe,
          payload: { principal: someoneElse, orgId: inv.orgId, tenantId: w.t, roleKey: 'member', invitationId: inv.invitationId },
        });
        await expectRefused(w, outcomes, joe, /other than the one who accepted/);
        expect(await memberOf(w, someoneElse)).toBe(0);
      });

      it('claiming a role the invitation was not sent for', async () => {
        const joe = principalId.parse(ulid());
        const inv = await send(w, w.alice, 'member');
        const outcomes = await asJoiner(w, joe, 'invitefix/accept', { ...inv, roleKey: 'lead' });
        await expectRefused(w, outcomes, joe, /does not match invitation/);
      });

      it('for an invitation nobody sent', async () => {
        const joe = principalId.parse(ulid());
        const outcomes = await asJoiner(w, joe, 'invitefix/accept', { invitationId: ulid(), orgId: w.org, roleKey: 'member' });
        await expectRefused(w, outcomes, joe, /no single send/);
      });

      it('accepting an invitation a second time, as somebody else', async () => {
        const first = principalId.parse(ulid());
        const inv = await send(w, w.alice, 'member');
        expect((await asJoiner(w, first, 'invitefix/accept', inv)).map((o) => o.outcome)).toEqual(['delivered']);
        const second = principalId.parse(ulid());
        await expectRefused(w, await asJoiner(w, second, 'invitefix/accept', inv), second, /no single acceptance/);
      });

      it('with no request shape at all', async () => {
        const joe = principalId.parse(ulid());
        const outcomes = await asJoiner(w, joe, 'invitefix/request', { entityId: joe, payload: { principal: joe } });
        await expectRefused(w, outcomes, joe, /malformed/);
      });
    });

    it('the retry backstop effects what the inline path could not', async () => {
      // The org does not exist yet, so the inline attempt fails — a transient failure, retried.
      const late = orgId.parse(ulid());
      const joe = principalId.parse(ulid());
      const inline = await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member', late));
      expect(inline.map((o) => o.outcome)).toEqual(['retrying']);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(false);

      await w.host.admin.createOrg(staff, { id: late, tenantId: w.t, slug: 'late', name: 'Late' });
      const report = await w.host.drainDue(w.t, w.s);
      expect(report.delivered).toBe(1);
      expect(await memberOf(w, joe, late)).toBe(1);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
      // The backstop's rows carry the same correlation id the inline attempt was for.
      expect((await causedBy(w, inline[0]!.eventId)).map((r) => r.action).sort()).toEqual(['addMember', 'assignRole']);
    });

    // Last: it mounts a second executor on this host, which every later accept would also run.
    it('the effect is idempotent: re-running it over delivered events changes no membership', async () => {
      const joe = principalId.parse(ulid());
      await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member'));
      // A crash between the effect and its journal row re-runs the handler. A second executor
      // id sees every request as never delivered, which is that re-run, for all of them.
      registerMembershipExecutor(w.host, { id: 'membership-replay', actor: staff, level: 'scope' });
      const report = await w.host.drainDue(w.t, w.s);
      expect(report.retrying).toBe(0);
      expect(report.delivered).toBeGreaterThan(0);
      expect(await memberOf(w, joe)).toBe(1);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
      expect(await holds(w, joe, INVITEFIX_B)).toBe(false);
    });
  });

  describe(`membership executor (#1184), tenant level: ${adapterName}`, () => {
    const w = world('tenant');

    it('an accepted invite confers the role tenant-wide', async () => {
      const joe = principalId.parse(ulid());
      const outcomes = await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member'));
      expect(outcomes.map((o) => o.outcome)).toEqual(['delivered']);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
      expect(await holds(w, joe, INVITEFIX_A, w.s2)).toBe(true);
    });

    it('authority held in one scope does not confer a tenant-wide role', async () => {
      const erin = principalId.parse(ulid());
      await w.host.admin.assignRole(staff, { principalId: erin, roleKey: 'lead', node: { tenantId: w.t, scopeId: w.s } });
      const joe = principalId.parse(ulid());
      await expectRefused(w, await asJoiner(w, joe, 'invitefix/accept', await send(w, erin, 'lead')), joe, /invitefix:a, invitefix:b/);
    });
  });
}
