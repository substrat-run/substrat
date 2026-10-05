import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  instant,
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
  MEMBERSHIP_EXECUTOR_ID,
  registerMembershipExecutor,
  ulid,
  type ExecutorOutcome,
  type HostAdmin,
  type ScopeHost,
} from '@substrat-run/kernel';
import { INVITEFIX_A, INVITEFIX_B, membershipFixtureMod } from './membership-module.js';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * The membership executor (#1184, K-22 §4.2) on every adapter: an accepted invite assigns the
 * invited TENANT role — and, by default, joins no org — with the admin trail correlated, a
 * redelivery changes nothing, a rolled-back accept effects nothing, and an invite for authority its sender does not
 * hold — or no longer holds, demoted or removed, before the add or while it is held in front of
 * its directory unit — is refused for good, where both the accepting call and an admin can see
 * it. Every tenant-level removal, staff's and no-op ones included, fences a pending add. Both
 * delivery paths are held: the inline tail of the accept, and `drainDue` as backstop.
 *
 * Mounted with `orgs: 'join'` (#2047), an add also joins the org and a removal leaves it, bounded
 * inside the same unit by the inviter's or remover's own live membership of that org: a scope-level
 * org grant reaches nobody through a non-member, and a join expires no later than the inviter's.
 *
 * The fixture's checker must be a REAL one: the bound is a permission-set comparison, and an
 * allow-all checker would cover everything and prove nothing.
 */
export function membershipExecutorContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  const staff = platformActorId.parse(ulid());
  const vertical = 'invitefix-vertical';

  /**
   * One tenant with two scopes, the two roles, an org, and the executor mounted. `hold`, when
   * given, holds every add's and removal's directory unit until it resolves — the gap a concurrent removal or
   * change of authority would race into. `failNextAdds` fails that many adds' units outright:
   * the transient failure the retry backstop absorbs.
   */
  const world = (opts: { hold?: () => Promise<void>; orgs?: 'join' } = {}) => {
    const w = {
      failNextAdds: 0,
      fixture: undefined as unknown as ScopeHostFixture,
      host: undefined as unknown as ScopeHost,
      t: tenantId.parse(ulid()),
      s: scopeId.parse(ulid()),
      s2: scopeId.parse(ulid()),
      org: orgId.parse(ulid()),
      alice: principalId.parse(ulid()), // lead, tenant-wide
      bob: principalId.parse(ulid()), // member, tenant-wide
    };
    beforeAll(async () => {
      w.fixture = await makeFixture();
      w.host = w.fixture.host;
      w.host.registerModule(membershipFixtureMod);
      // `baseDelayMs: 0` so the backstop case can retry inside a test.
      registerMembershipExecutor(intercepting(w.host, w, opts.hold), { actor: staff, retry: { baseDelayMs: 0 }, orgs: opts.orgs });
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

  /**
   * A gate every directory unit waits at while shut — the gap a concurrent removal or change of
   * authority races into. Open, a unit passes straight through.
   */
  const gated = () => {
    const g = {
      release: (): void => undefined,
      gate: Promise.resolve(),
      shut: () => {
        g.gate = new Promise((r) => (g.release = r));
      },
      hold: () => g.gate,
      /** Long enough for an invoke to reach the hold, and for a queued call to reach its own. */
      settle: () => new Promise((r) => setTimeout(r, 50)),
    };
    return g;
  };

  /**
   * `host`, except that an add's `applyMembership` fails while `w.failNextAdds` counts down,
   * and every unit, an add's or a removal's, otherwise waits for `hold` before it runs.
   */
  const intercepting = (host: ScopeHost, w: { failNextAdds: number }, hold?: () => Promise<void>): ScopeHost => {
    const held = (admin: HostAdmin): HostAdmin =>
      new Proxy(admin, {
        get: (t, key) =>
          key === 'applyMembership'
            ? async (...args: Parameters<HostAdmin['applyMembership']>) => {
                if (args[1].op === 'add' && w.failNextAdds > 0) {
                  w.failNextAdds -= 1;
                  throw new Error('directory unavailable');
                }
                await hold?.();
                return t.applyMembership(...args);
              }
            : Reflect.get(t, key),
      });
    return new Proxy(host, {
      get: (t, key) => {
        if (key === 'attributed') return (o: Parameters<NonNullable<ScopeHost['attributed']>>[0]) => ({ admin: held(t.attributed!(o).admin) });
        const v = Reflect.get(t, key) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  };

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

  /** `who` asks for `joiner` to be removed; returns what the inline tail did with that request. */
  const removeAs = async (w: World, who: PrincipalId, joiner: PrincipalId, roleKey: string, org: OrgId = w.org) => {
    const outcomes: ExecutorOutcome[] = [];
    await (await w.host.getScope(who, w.t, w.s)).invoke('invitefix/remove', { principal: joiner, orgId: org, roleKey }, {
      onExecutorOutcomes: (o) => outcomes.push(...o),
    });
    return outcomes.filter((o) => o.eventType === 'member.remove-requested' && o.entity === `membership:${joiner}`);
  };

  const holds = async (w: World, who: PrincipalId, permission: PermissionKey, s: ScopeId = w.s) =>
    ((await (await w.host.getScope(who, w.t, s)).invoke('invitefix/probe', { permission })) as { allowed: boolean }).allowed;

  /** Whether `who` is a live member of `org` — which the executor must never make anyone. */
  const memberOf = async (w: World, who: PrincipalId, org: OrgId = w.org) =>
    (await w.host.admin.listMembers(staff, w.t, org)).filter((m) => m.principal === who).length;

  const tenantNode = (w: World) => ({ tenantId: w.t, scopeId: null });

  /** The audit rows naming `who` with `action` — what K-21 writes only for a real change. */
  const auditedFor = async (w: World, action: 'unassignRole' | 'removeMember', who: PrincipalId) =>
    (await w.host.admin.auditLog(staff, { tenantId: w.t, action, limit: 500 })).filter((r) => JSON.stringify(r.before).includes(who));

  const causedBy = async (w: World, eventId: string): Promise<AdminLogEntry[]> =>
    (await w.host.admin.auditLog(staff, { tenantId: w.t, limit: 500 })).filter((e) => e.causedBy === eventId);

  /** A refusal, seen from both sides: the accepting call, and the journal an admin reads. */
  const expectRefused = async (w: World, outcomes: ExecutorOutcome[], who: PrincipalId, reason: RegExp) => {
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome).toBe('refused');
    expect(outcomes[0]!.error).toMatch(reason);
    const dead = (await w.host.executorDeadLetters(w.t, w.s)).find((d) => d.eventId === outcomes[0]!.eventId);
    expect(dead?.executorId).toBe(MEMBERSHIP_EXECUTOR_ID);
    expect(dead?.error).toMatch(/^refused: /);
    expect(dead?.error).toMatch(reason);
    expect(dead?.attempts).toBe(1);
    expect(await memberOf(w, who)).toBe(0);
    expect(await holds(w, who, INVITEFIX_A)).toBe(false);
    expect(await causedBy(w, outcomes[0]!.eventId)).toEqual([]);
  };

  describe(`membership executor (#1184): ${adapterName}`, () => {
    const w = world();

    it('an accepted invite assigns the tenant role inline, with the admin trail correlated to the event', async () => {
      const joe = principalId.parse(ulid());
      const inv = await send(w, w.alice, 'member');
      const outcomes = await asJoiner(w, joe, 'invitefix/accept', inv);

      expect(outcomes.map((o) => o.outcome)).toEqual(['delivered']);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
      // The role, and nothing else: the org the invitation names is not joined.
      expect(await memberOf(w, joe)).toBe(0);
      // The role carried only what was invited — tenant-wide, the one level it assigns at.
      expect(await holds(w, joe, INVITEFIX_B)).toBe(false);
      expect(await holds(w, joe, INVITEFIX_A, w.s2)).toBe(true);

      // The row joins the event that caused it, executed by the platform actor on behalf of the
      // inviter whose authority bounded it.
      const rows = await causedBy(w, outcomes[0]!.eventId);
      expect(rows.map((r) => r.action)).toEqual(['assignRole']);
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
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
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
      expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
    });

    it('an add confers no org membership — whatever the org it names holds, at the tenant or in a scope', async () => {
      // The org grants invitefix:b tenant-wide AND in one scope; bob holds only invitefix:a.
      // Joining it would confer what bob cannot, and the scope grant lives where no directory
      // unit can bound it — so the executor, mounted role-only, joins nobody to any org.
      const strong = orgId.parse(ulid());
      await w.host.admin.createOrg(staff, { id: strong, tenantId: w.t, slug: `strong-${strong.slice(-6).toLowerCase()}`, name: 'Strong' });
      await w.host.admin.grantToOrg(staff, strong, INVITEFIX_B, tenantNode(w));
      await w.host.admin.grantToOrg(staff, strong, INVITEFIX_B, { tenantId: w.t, scopeId: w.s2 });
      const joe = principalId.parse(ulid());
      const outcomes = await asJoiner(w, joe, 'invitefix/accept', await send(w, w.bob, 'member', strong));
      // The twin inside it: the role bob may confer is conferred.
      expect(outcomes.map((o) => o.outcome)).toEqual(['delivered']);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
      expect(await memberOf(w, joe, strong)).toBe(0);
      expect(await holds(w, joe, INVITEFIX_B)).toBe(false);
      expect(await holds(w, joe, INVITEFIX_B, w.s2)).toBe(false);
      // And the trail says so: one assignment, no membership row.
      expect((await causedBy(w, outcomes[0]!.eventId)).map((r) => r.action)).toEqual(['assignRole']);
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

    it('authority held in one scope does not confer a tenant-wide role', async () => {
      const erin = principalId.parse(ulid());
      await w.host.admin.assignRole(staff, { principalId: erin, roleKey: 'lead', node: { tenantId: w.t, scopeId: w.s } });
      const joe = principalId.parse(ulid());
      await expectRefused(w, await asJoiner(w, joe, 'invitefix/accept', await send(w, erin, 'lead')), joe, /invitefix:a, invitefix:b/);
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
        await expectRefused(w, await asJoiner(w, second, 'invitefix/accept', inv), second, /not first accepted by/);
      });

      it('after an acceptance somebody else wrote in the joiner\'s name', async () => {
        // The first acceptance's payload names joe, but its kernel-stamped actor is mallory.
        const joe = principalId.parse(ulid());
        const mallory = principalId.parse(ulid());
        const inv = await send(w, w.alice, 'member');
        await (await w.host.getScope(mallory, w.t, w.s)).invoke('invitefix/claim-accepted', { ...inv, principal: joe });
        await expectRefused(w, await asJoiner(w, joe, 'invitefix/accept', inv), joe, /not first accepted by/);
      });

      it('replaying an invitation after the joiner was removed — one invitation, one join', async () => {
        const joe = principalId.parse(ulid());
        const inv = await send(w, w.alice, 'member');
        expect((await asJoiner(w, joe, 'invitefix/accept', inv)).map((o) => o.outcome)).toEqual(['delivered']);
        const node = { tenantId: w.t, scopeId: null };
        await w.host.admin.unassignRole(staff, { principalId: joe, roleKey: 'member', node });
        await w.host.admin.removeMember(staff, w.t, joe, w.org);

        // A fresh request, by the very person who first accepted, naming the same invitation.
        const outcomes = await asJoiner(w, joe, 'invitefix/request', {
          entityId: joe,
          payload: { principal: joe, orgId: inv.orgId, tenantId: w.t, roleKey: 'member', invitationId: inv.invitationId },
        });
        await expectRefused(w, outcomes, joe, /invitation .* was already used/);
      });

      it('a request emitted before the acceptance it claims', async () => {
        const joe = principalId.parse(ulid());
        const outcomes = await asJoiner(w, joe, 'invitefix/accept-request-first', await send(w, w.alice, 'member'));
        await expectRefused(w, outcomes, joe, /precedes invitation .*'s acceptance/);
      });

      it('with no request shape at all', async () => {
        const joe = principalId.parse(ulid());
        const outcomes = await asJoiner(w, joe, 'invitefix/request', { entityId: joe, payload: { principal: joe } });
        await expectRefused(w, outcomes, joe, /malformed/);
      });
    });

    it('the retry backstop effects what the inline path could not', async () => {
      // The directory unit fails once — a transient failure, retried.
      const joe = principalId.parse(ulid());
      w.failNextAdds = 1;
      const inline = await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member'));
      expect(inline.map((o) => o.outcome)).toEqual(['retrying']);
      // Read off the trail, not by a probe: any invoke's own tail would drain the retry first.
      expect(await causedBy(w, inline[0]!.eventId)).toEqual([]);

      await new Promise((r) => setTimeout(r, 10)); // the retry comes due (`baseDelayMs: 0`)
      const report = await w.host.drainDue(w.t, w.s);
      expect(report.delivered).toBe(1);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
      // The backstop's row carries the same correlation id the inline attempt was for.
      expect((await causedBy(w, inline[0]!.eventId)).map((r) => r.action)).toEqual(['assignRole']);
    });

    describe('removal goes through the same seam, and wins', () => {
      it('a removal takes the role away, correlated and attributed to the remover', async () => {
        const joe = principalId.parse(ulid());
        await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member'));
        expect(await holds(w, joe, INVITEFIX_A)).toBe(true);

        const outcomes = await removeAs(w, w.alice, joe, 'member');
        expect(outcomes.map((o) => o.outcome)).toEqual(['delivered']);
        expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
        const rows = await causedBy(w, outcomes[0]!.eventId);
        expect(rows.map((r) => r.action)).toEqual(['unassignRole']);
        for (const row of rows) expect(row.onBehalfOf).toMatchObject({ principal: w.alice });
      });

      it('refuses a removal beyond the remover — the bound runs both ways', async () => {
        const joe = principalId.parse(ulid());
        await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'lead'));
        const outcomes = await removeAs(w, w.bob, joe, 'lead');
        expect(outcomes.map((o) => o.outcome)).toEqual(['refused']);
        expect(outcomes[0]!.error).toMatch(/remover .* no longer holds invitefix:b/);
        expect(await holds(w, joe, INVITEFIX_B)).toBe(true);
      });

      it('an add still retrying when the person is removed is refused when it comes due', async () => {
        const joe = principalId.parse(ulid());
        w.failNextAdds = 1;
        const inline = await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member'));
        expect(inline.map((o) => o.outcome)).toEqual(['retrying']);
        // Removed while the add waits: nothing to take yet, but the removal is on the record.
        await removeAs(w, w.alice, joe, 'member');

        await new Promise((r) => setTimeout(r, 10));
        await w.host.drainDue(w.t, w.s);
        const dead = (await w.host.executorDeadLetters(w.t, w.s)).find((d) => d.eventId === inline[0]!.eventId);
        expect(dead?.error).toMatch(/^refused: .* was removed after this request was made/);
        expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
      });

      it('a removal recorded outside the seam after the request wins too — the backlog a hand-rolled removal left', async () => {
        const joe = principalId.parse(ulid());
        w.failNextAdds = 1;
        const inline = await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member'));
        expect(inline.map((o) => o.outcome)).toEqual(['retrying']);
        // The old way: the role was granted by hand and taken back by hand, emitting nothing.
        const node = tenantNode(w);
        await w.host.admin.assignRole(staff, { principalId: joe, roleKey: 'member', node });
        await w.host.admin.unassignRole(staff, { principalId: joe, roleKey: 'member', node });

        await new Promise((r) => setTimeout(r, 10));
        await w.host.drainDue(w.t, w.s);
        const dead = (await w.host.executorDeadLetters(w.t, w.s)).find((d) => d.eventId === inline[0]!.eventId);
        expect(dead?.error).toMatch(/was removed after this request was made/);
        expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
      });

      it('a removal outside the seam moments BEFORE a new request still wins — the stated cost of the skew window', async () => {
        // The directory and the scope share no clock, so a removal within
        // MEMBERSHIP_REMOVAL_SKEW_MS of a request is taken to follow it. A NEW invite accepted
        // that soon after a staff removal is refused, and is resent. (Outside the window it
        // lands: held on SQLite, whose host takes a clock — see its own test.)
        const joe = principalId.parse(ulid());
        const node = { tenantId: w.t, scopeId: null };
        await w.host.admin.assignRole(staff, { principalId: joe, roleKey: 'member', node });
        await w.host.admin.unassignRole(staff, { principalId: joe, roleKey: 'member', node });
        await expectRefused(w, await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member')), joe, /was removed after this request was made/);
      });

      it('a staff removal that took nothing still fences a later accept inside the window — and writes no audit row', async () => {
        // joe never held the role, so `unassignRole` is a K-21 no-op: no row. The fence is raised
        // all the same, because "removed" is a decision about the person, not about what they held.
        const joe = principalId.parse(ulid());
        await w.host.admin.unassignRole(staff, { principalId: joe, roleKey: 'member', node: tenantNode(w) });
        expect(await auditedFor(w, 'unassignRole', joe)).toEqual([]);
        await expectRefused(w, await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member')), joe, /was removed after this request was made/);

        // removeMember too: never a member of the org, so no row — and the fence.
        const kim = principalId.parse(ulid());
        await w.host.admin.removeMember(staff, w.t, kim, w.org);
        expect(await auditedFor(w, 'removeMember', kim)).toEqual([]);
        await expectRefused(w, await asJoiner(w, kim, 'invitefix/accept', await send(w, w.alice, 'member')), kim, /was removed after this request was made/);

        // Twin: the same accept for someone nobody removed lands.
        const lee = principalId.parse(ulid());
        expect((await asJoiner(w, lee, 'invitefix/accept', await send(w, w.alice, 'member'))).map((o) => o.outcome)).toEqual(['delivered']);
      });

      it('a removal at a scope raises no tenant fence — the fence is the tenant node\'s', async () => {
        const joe = principalId.parse(ulid());
        await w.host.admin.unassignRole(staff, { principalId: joe, roleKey: 'member', node: { tenantId: w.t, scopeId: w.s } });
        expect((await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member'))).map((o) => o.outcome)).toEqual(['delivered']);
      });
    });

    // Last: it mounts a second executor on this host, which every later accept would also run.
    it('the effect is idempotent: re-running it over delivered events changes no membership', async () => {
      const joe = principalId.parse(ulid());
      await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'member'));
      // A crash between the effect and its journal row re-runs the handler. A second executor
      // id sees every request as never delivered, which is that re-run, for all of them.
      registerMembershipExecutor(w.host, { id: 'membership-replay', actor: staff });
      const report = await w.host.drainDue(w.t, w.s);
      expect(report.retrying).toBe(0);
      expect(report.delivered).toBeGreaterThan(0);
      expect(await memberOf(w, joe)).toBe(0);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
      expect(await holds(w, joe, INVITEFIX_B)).toBe(false);
    });
  });

  describe(`membership executor (#1184), tenant level only: ${adapterName}`, () => {
    it('refuses to mount at a scope level — a type error, and a refusal at run time', async () => {
      const fixture = await makeFixture();
      try {
        expect(() =>
          // @ts-expect-error — 'scope' is not a level the executor takes.
          registerMembershipExecutor(fixture.host, { id: 'membership-scope', actor: staff, level: 'scope' }),
        ).toThrow(/tenant-level only/);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe(`membership executor (#1184), an add held in front of its directory unit: ${adapterName}`, () => {
    // Every add waits here, after the executor's own checks and before its directory unit.
    const g = gated();
    const w = world({ hold: g.hold });
    const { shut, settle } = g;
    const release = () => g.release();

    it('a removal landing while an add is held cannot leave the access restored', async () => {
      const joe = principalId.parse(ulid());
      const node = tenantNode(w);
      // joe already holds the role, so taking it away is a real, recorded removal.
      await w.host.admin.assignRole(staff, { principalId: joe, roleKey: 'member', node });
      const inv = await send(w, w.alice, 'member');
      shut();
      const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
      // The add has passed every check and is held in front of its effects. The removal lands.
      await settle();
      await w.host.admin.unassignRole(staff, { principalId: joe, roleKey: 'member', node });
      release();
      const outcomes = await accepting;
      expect(outcomes.map((o) => o.outcome)).toEqual(['refused']);
      expect(outcomes[0]!.error).toMatch(/was removed after this request was made/);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
    });

    it('a staff removal of someone not yet a member fences their held add', async () => {
      const joe = principalId.parse(ulid());
      const inv = await send(w, w.alice, 'member');
      shut();
      const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
      await settle();
      // Nothing held yet, so nothing to revoke and no audit row — but the fence.
      await w.host.admin.unassignRole(staff, { principalId: joe, roleKey: 'member', node: tenantNode(w) });
      release();
      expect((await accepting).map((o) => o.outcome)).toEqual(['refused']);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
    });

    it('twin: a held add nobody removed lands when released', async () => {
      const joe = principalId.parse(ulid());
      const inv = await send(w, w.alice, 'member');
      shut();
      const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
      await settle();
      release();
      expect((await accepting).map((o) => o.outcome)).toEqual(['delivered']);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
    });

    it('a removal and a held add released in the same tick: the revoke and its fence are one unit, so the access never survives', async () => {
      // The removal's revoke goes out first and the add's unit right behind it. Were the revoke,
      // the audit row and the fence separate directory calls, the add would land between them:
      // past the revoke, before any record of it.
      const joe = principalId.parse(ulid());
      const node = tenantNode(w);
      await w.host.admin.assignRole(staff, { principalId: joe, roleKey: 'member', node });
      const inv = await send(w, w.alice, 'member');
      shut();
      const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
      await settle();
      const removing = w.host.admin.unassignRole(staff, { principalId: joe, roleKey: 'member', node });
      release();
      await Promise.all([accepting, removing]);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
    });

    it('a seam removal of someone whose add is held — nothing held yet — still wins', async () => {
      // Where drains run concurrently (the Durable-Object coordinator), the removal can be
      // effected while the add waits: it has nothing to take, and fences anyway, so the add's
      // own unit sees it. Where they cannot (the pure host's scope actor), the removal queues
      // behind the add and undoes it. Either way the person ends with nothing.
      const joe = principalId.parse(ulid());
      const inv = await send(w, w.alice, 'member');
      shut();
      const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
      await settle();
      const removing = removeAs(w, w.alice, joe, 'member');
      await settle();
      release();
      await Promise.all([accepting, removing]);
      expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
    });

    it('a remover demoted while their removal is held removes nobody', async () => {
      const carol = principalId.parse(ulid());
      await w.host.admin.assignRole(staff, { principalId: carol, roleKey: 'lead', node: tenantNode(w) });
      const joe = principalId.parse(ulid());
      expect((await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'lead'))).map((o) => o.outcome)).toEqual(['delivered']);
      shut();
      const removing = removeAs(w, carol, joe, 'lead');
      await settle();
      await w.host.admin.unassignRole(staff, { principalId: carol, roleKey: 'lead', node: tenantNode(w) });
      release();
      const outcomes = await removing;
      expect(outcomes.map((o) => o.outcome)).toEqual(['refused']);
      expect(outcomes[0]!.error).toMatch(/remover .* no longer holds invitefix:a, invitefix:b/);
      expect(await holds(w, joe, INVITEFIX_B)).toBe(true);
    });

    it('twin: a remover who keeps their role through the hold removes', async () => {
      const carol = principalId.parse(ulid());
      await w.host.admin.assignRole(staff, { principalId: carol, roleKey: 'lead', node: tenantNode(w) });
      const joe = principalId.parse(ulid());
      expect((await asJoiner(w, joe, 'invitefix/accept', await send(w, w.alice, 'lead'))).map((o) => o.outcome)).toEqual(['delivered']);
      shut();
      const removing = removeAs(w, carol, joe, 'lead');
      await settle();
      release();
      expect((await removing).map((o) => o.outcome)).toEqual(['delivered']);
      expect(await holds(w, joe, INVITEFIX_B)).toBe(false);
    });

    describe('the bound is asked again inside the unit — a change of authority while held is not written past', () => {
      /** A role of its own, so widening it touches no other test. */
      const freshRole = async (permissions: PermissionKey[]) => {
        const key = `held-${ulid().slice(-8).toLowerCase()}`;
        await w.host.admin.defineRole(staff, w.t, { key, permissions, source: 'vertical' });
        return key;
      };

      it('a role widened beyond the inviter while the add is held', async () => {
        const role = await freshRole([INVITEFIX_A]);
        const joe = principalId.parse(ulid());
        const inv = await send(w, w.bob, role); // bob holds invitefix:a: within reach at send
        shut();
        const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
        await settle();
        await w.host.admin.defineRole(staff, w.t, { key: role, permissions: [INVITEFIX_A, INVITEFIX_B], source: 'vertical' });
        release();
        const outcomes = await accepting;
        expect(outcomes.map((o) => o.outcome)).toEqual(['refused']);
        expect(outcomes[0]!.error).toMatch(/inviter .* no longer holds invitefix:b/);
        expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
        expect(await holds(w, joe, INVITEFIX_B)).toBe(false);
      });

      it('twin: the same widening under an inviter who holds it lands', async () => {
        const role = await freshRole([INVITEFIX_A]);
        const joe = principalId.parse(ulid());
        const inv = await send(w, w.alice, role);
        shut();
        const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
        await settle();
        await w.host.admin.defineRole(staff, w.t, { key: role, permissions: [INVITEFIX_A, INVITEFIX_B], source: 'vertical' });
        release();
        expect((await accepting).map((o) => o.outcome)).toEqual(['delivered']);
        expect(await holds(w, joe, INVITEFIX_B)).toBe(true);
      });

      it('the inviter demoted while the add is held', async () => {
        const carol = principalId.parse(ulid());
        await w.host.admin.assignRole(staff, { principalId: carol, roleKey: 'lead', node: tenantNode(w) });
        const joe = principalId.parse(ulid());
        const inv = await send(w, carol, 'lead');
        shut();
        const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
        await settle();
        await w.host.admin.unassignRole(staff, { principalId: carol, roleKey: 'lead', node: tenantNode(w) });
        release();
        const outcomes = await accepting;
        expect(outcomes.map((o) => o.outcome)).toEqual(['refused']);
        expect(outcomes[0]!.error).toMatch(/inviter .* no longer holds invitefix:a, invitefix:b/);
        expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
      });

      it('the grant the inviter held through an org, lost while the add is held', async () => {
        const grants = orgId.parse(ulid());
        await w.host.admin.createOrg(staff, { id: grants, tenantId: w.t, slug: `grants-${grants.slice(-6).toLowerCase()}`, name: 'Grants' });
        await w.host.admin.grantToOrg(staff, grants, INVITEFIX_A, tenantNode(w));
        const dave = principalId.parse(ulid());
        await w.host.admin.addMember(staff, w.t, dave, grants);
        const joe = principalId.parse(ulid());
        const inv = await send(w, dave, 'member');
        shut();
        const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
        await settle();
        await w.host.admin.removeMember(staff, w.t, dave, grants);
        release();
        const outcomes = await accepting;
        expect(outcomes.map((o) => o.outcome)).toEqual(['refused']);
        expect(outcomes[0]!.error).toMatch(/inviter .* no longer holds invitefix:a/);
        expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
      });

      it('a grant added to the invitation\'s org while the add is held reaches nobody — the add joins no org', async () => {
        const joe = principalId.parse(ulid());
        const inv = await send(w, w.bob, 'member');
        shut();
        const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
        await settle();
        await w.host.admin.grantToOrg(staff, w.org, INVITEFIX_B, tenantNode(w));
        release();
        expect((await accepting).map((o) => o.outcome)).toEqual(['delivered']);
        expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
        expect(await holds(w, joe, INVITEFIX_B)).toBe(false);
        expect(await memberOf(w, joe)).toBe(0);
      });
    });
  });
  describe(`membership executor (#2047), org joins opted into: ${adapterName}`, () => {
    const g = gated();
    const w = world({ orgs: 'join', hold: g.hold });
    const { shut, settle } = g;
    const release = () => g.release();

    /** An org of its own per test, granting `invitefix:b` ONLY in scope s2 — a grant no directory unit sees. */
    const scopeOnlyOrg = async () => {
      const org = orgId.parse(ulid());
      await w.host.admin.createOrg(staff, { id: org, tenantId: w.t, slug: `org-${org.slice(-8).toLowerCase()}`, name: 'Org' });
      await w.host.admin.grantToOrg(staff, org, INVITEFIX_B, { tenantId: w.t, scopeId: w.s2 });
      return org;
    };
    /** A lead tenant-wide — the role is never what refuses in these tests — optionally a member of `org`. */
    const lead = async (org?: OrgId, expiresAt?: string) => {
      const who = principalId.parse(ulid());
      await w.host.admin.assignRole(staff, { principalId: who, roleKey: 'lead', node: tenantNode(w) });
      if (org) await w.host.admin.addMember(staff, w.t, who, org, expiresAt ? { expiresAt: instant.parse(expiresAt) } : undefined);
      return who;
    };
    const membership = async (who: PrincipalId, org: OrgId) =>
      (await w.host.admin.listMembers(staff, w.t, org)).find((m) => m.principal === who);

    /** Refused for good, and nothing of it written: no role, no membership, no reach into s2, no trail. */
    const expectNothing = async (outcomes: ExecutorOutcome[], who: PrincipalId, org: OrgId, reason: RegExp) => {
      expect(outcomes.map((o) => o.outcome)).toEqual(['refused']);
      expect(outcomes[0]!.error).toMatch(reason);
      expect(await memberOf(w, who, org)).toBe(0);
      expect(await holds(w, who, INVITEFIX_A)).toBe(false);
      expect(await holds(w, who, INVITEFIX_B, w.s2)).toBe(false);
      // No write of this add's: neither the role's row nor the membership's.
      const written = (await causedBy(w, outcomes[0]!.eventId)).filter((r) => r.action === 'assignRole' || r.action === 'addMember');
      expect(written).toEqual([]);
    };

    it('a member of the org joins someone to it: the role and the membership in one unit, and the org reaches them in every scope', async () => {
      const org = await scopeOnlyOrg();
      const alice = await lead(org);
      const joe = principalId.parse(ulid());
      const outcomes = await asJoiner(w, joe, 'invitefix/accept', await send(w, alice, 'member', org));
      expect(outcomes.map((o) => o.outcome)).toEqual(['delivered']);
      expect(await memberOf(w, joe, org)).toBe(1);
      expect((await membership(joe, org))?.expiresAt).toBeNull();
      expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
      // What the org confers, in the one scope it confers it in, and nowhere else.
      expect(await holds(w, joe, INVITEFIX_B, w.s2)).toBe(true);
      expect(await holds(w, joe, INVITEFIX_B)).toBe(false);
      const rows = await causedBy(w, outcomes[0]!.eventId);
      expect(rows.map((r) => r.action)).toEqual(['assignRole', 'addMember']);
      for (const row of rows) expect(row.onBehalfOf).toMatchObject({ principal: alice, tenantId: w.t });
    });

    it('an inviter who is not a member of the org is refused — the role, too — however much tenant authority they hold', async () => {
      const org = await scopeOnlyOrg();
      // A lead tenant-wide, who even holds invitefix:b in s2 directly: everything the org confers.
      const admin = await lead();
      await w.host.admin.grant(staff, { principalId: admin, permission: INVITEFIX_B, node: { tenantId: w.t, scopeId: w.s2 }, grantedBy: w.alice });
      const joe = principalId.parse(ulid());
      const outcomes = await asJoiner(w, joe, 'invitefix/accept', await send(w, admin, 'member', org));
      await expectNothing(outcomes, joe, org, /inviter .* is not a member of org /);
      expect((await w.host.executorDeadLetters(w.t, w.s)).find((d) => d.eventId === outcomes[0]!.eventId)?.error).toMatch(/^refused: /);
    });

    it('a scope-level org grant cannot be laundered through another org that holds the same grant', async () => {
      // alice is a member of `mine`, which confers exactly what `theirs` does — at the same scope.
      const mine = await scopeOnlyOrg();
      const theirs = await scopeOnlyOrg();
      const alice = await lead(mine);
      const joe = principalId.parse(ulid());
      await expectNothing(await asJoiner(w, joe, 'invitefix/accept', await send(w, alice, 'member', theirs)), joe, theirs, /is not a member of org /);
      // Twin: the org she IS a member of, she can join someone to.
      const kim = principalId.parse(ulid());
      expect((await asJoiner(w, kim, 'invitefix/accept', await send(w, alice, 'member', mine))).map((o) => o.outcome)).toEqual(['delivered']);
      expect(await holds(w, kim, INVITEFIX_B, w.s2)).toBe(true);
      expect(await memberOf(w, kim, theirs)).toBe(0);
    });

    it('an inviter removed from the org while the add is held: refused in the unit, and neither the role nor the membership lands', async () => {
      const org = await scopeOnlyOrg();
      const carol = await lead(org);
      const joe = principalId.parse(ulid());
      const inv = await send(w, carol, 'member', org);
      shut();
      const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
      await settle();
      await w.host.admin.removeMember(staff, w.t, carol, org);
      release();
      await expectNothing(await accepting, joe, org, /inviter .* is not a member of org /);
    });

    it('twin: an inviter who stays a member through the hold joins them', async () => {
      const org = await scopeOnlyOrg();
      const carol = await lead(org);
      const joe = principalId.parse(ulid());
      const inv = await send(w, carol, 'member', org);
      shut();
      const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
      await settle();
      release();
      expect((await accepting).map((o) => o.outcome)).toEqual(['delivered']);
      expect(await memberOf(w, joe, org)).toBe(1);
      expect(await holds(w, joe, INVITEFIX_B, w.s2)).toBe(true);
    });

    it('an inviter demoted while the add is held: the role\'s bound refuses, and the org is not joined either', async () => {
      const org = await scopeOnlyOrg();
      const carol = await lead(org);
      const joe = principalId.parse(ulid());
      const inv = await send(w, carol, 'lead', org);
      shut();
      const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
      await settle();
      await w.host.admin.unassignRole(staff, { principalId: carol, roleKey: 'lead', node: tenantNode(w) });
      release();
      await expectNothing(await accepting, joe, org, /inviter .* no longer holds invitefix:a, invitefix:b/);
    });

    it('the joiner removed from the org while the add is held: the fence refuses both', async () => {
      const org = await scopeOnlyOrg();
      const alice = await lead(org);
      const joe = principalId.parse(ulid());
      const inv = await send(w, alice, 'member', org);
      shut();
      const accepting = asJoiner(w, joe, 'invitefix/accept', inv);
      await settle();
      await w.host.admin.removeMember(staff, w.t, joe, org);
      release();
      await expectNothing(await accepting, joe, org, /was removed after this request was made/);
    });

    describe('a temporary member cannot confer a permanent membership', () => {
      const later = '2999-01-01T00:00:00.000Z';

      it('the joiner\'s membership expires when the inviter\'s does', async () => {
        const org = await scopeOnlyOrg();
        const temp = await lead(org, later);
        const joe = principalId.parse(ulid());
        expect((await asJoiner(w, joe, 'invitefix/accept', await send(w, temp, 'member', org))).map((o) => o.outcome)).toEqual(['delivered']);
        expect((await membership(joe, org))?.expiresAt).toBe(later);
        const row = (await w.host.admin.auditLog(staff, { tenantId: w.t, action: 'addMember', limit: 500 })).find((r) => JSON.stringify(r.after).includes(joe));
        expect(row?.after).toMatchObject({ principal: joe, orgId: org, expiresAt: later });
      });

      it('twin: an inviter whose membership never lapses confers one that never lapses', async () => {
        const org = await scopeOnlyOrg();
        const alice = await lead(org);
        const joe = principalId.parse(ulid());
        await asJoiner(w, joe, 'invitefix/accept', await send(w, alice, 'member', org));
        expect(await membership(joe, org)).toMatchObject({ expiresAt: null, revokedAt: null });
      });

      it('a re-invitation by a temporary member does not cut short a membership the joiner already holds', async () => {
        const org = await scopeOnlyOrg();
        const temp = await lead(org, later);
        const joe = principalId.parse(ulid());
        await w.host.admin.addMember(staff, w.t, joe, org);
        expect((await asJoiner(w, joe, 'invitefix/accept', await send(w, temp, 'member', org))).map((o) => o.outcome)).toEqual(['delivered']);
        expect((await membership(joe, org))?.expiresAt).toBeNull();
      });

      it('an inviter whose membership has already lapsed is no member, and confers nothing', async () => {
        const org = await scopeOnlyOrg();
        const lapsed = await lead(org, '2000-01-01T00:00:00.000Z');
        const joe = principalId.parse(ulid());
        await expectNothing(await asJoiner(w, joe, 'invitefix/accept', await send(w, lapsed, 'member', org)), joe, org, /is not a member of org /);
      });
    });

    describe('removal is bounded the same way', () => {
      const joined = async () => {
        const org = await scopeOnlyOrg();
        const alice = await lead(org);
        const joe = principalId.parse(ulid());
        expect((await asJoiner(w, joe, 'invitefix/accept', await send(w, alice, 'member', org))).map((o) => o.outcome)).toEqual(['delivered']);
        return { org, alice, joe };
      };

      it('a member removes: the role and the membership go together, each audited', async () => {
        const { org, alice, joe } = await joined();
        const outcomes = await removeAs(w, alice, joe, 'member', org);
        expect(outcomes.map((o) => o.outcome)).toEqual(['delivered']);
        expect(await memberOf(w, joe, org)).toBe(0);
        expect(await holds(w, joe, INVITEFIX_A)).toBe(false);
        expect(await holds(w, joe, INVITEFIX_B, w.s2)).toBe(false);
        expect((await causedBy(w, outcomes[0]!.eventId)).map((r) => r.action)).toEqual(['unassignRole', 'removeMember']);
      });

      it('a remover who is not a member of the org removes nothing — neither the membership nor the role', async () => {
        const { org, joe } = await joined();
        const outsider = await lead();
        const outcomes = await removeAs(w, outsider, joe, 'member', org);
        expect(outcomes.map((o) => o.outcome)).toEqual(['refused']);
        expect(outcomes[0]!.error).toMatch(/remover .* is not a member of org /);
        expect(await memberOf(w, joe, org)).toBe(1);
        expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
        expect(await holds(w, joe, INVITEFIX_B, w.s2)).toBe(true);
      });

      it('a remover taken out of the org while their removal is held removes nothing', async () => {
        const { org, joe } = await joined();
        const carol = await lead(org);
        shut();
        const removing = removeAs(w, carol, joe, 'member', org);
        await settle();
        await w.host.admin.removeMember(staff, w.t, carol, org);
        release();
        const outcomes = await removing;
        expect(outcomes.map((o) => o.outcome)).toEqual(['refused']);
        expect(outcomes[0]!.error).toMatch(/remover .* is not a member of org /);
        expect(await memberOf(w, joe, org)).toBe(1);
        expect(await holds(w, joe, INVITEFIX_A)).toBe(true);
      });
    });
  });
}
