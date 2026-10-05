import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orgId, platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import {
  manualClock,
  MEMBERSHIP_REMOVAL_SKEW_MS,
  registerMembershipExecutor,
  ulid,
  webCryptoSecretBox,
  type ExecutorOutcome,
  type HostAdmin,
  type ScopeHost,
} from '@substrat-run/kernel';
import { INVITEFIX_A, membershipFixtureMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1184: a removal raises the person's fence in the directory, stamped by the host's clock — the
 * one that stamps the scope event it races (Codex round 3: a wall-clock fence let a host clock
 * running ahead push a removal under the window). The skew window is for the adapter whose two
 * stores keep two clocks (the Durable-Object one); here the comparison still holds that a fence
 * at or after `occurredAt - MEMBERSHIP_REMOVAL_SKEW_MS` wins — a tie included.
 *
 * SQLite only, and that is the reason this is not in the contract suite: only the pure host
 * takes a clock, so only here can a test place a request and a removal at chosen instants; the
 * Durable-Object host takes none (`clock?: never`). The contract suite holds the in-window case
 * on both adapters.
 */
describe('membership executor — a removal outside the seam against the skew window (#1184)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const org = orgId.parse(ulid());
  const alice = principalId.parse(ulid());
  const node = { tenantId: t, scopeId: null };
  let dir: string;
  let host: SqliteScopeHost;
  const clock = manualClock(new Date());

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-membership-skew-'));
    host = new SqliteScopeHost({ dir, clock: clock.read, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    host.registerModule(membershipFixtureMod);
    registerMembershipExecutor(host, { actor: staff });
    clock.set(new Date());
    await host.admin.createTenant(staff, { id: t, slug: `skew-${t.slice(-10).toLowerCase()}`, name: 'Skew' });
    await host.admin.grantEntitlement(staff, t, 'invitefix');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'invitefix-vertical' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'member', permissions: [INVITEFIX_A], source: 'vertical' });
    await host.admin.createOrg(staff, { id: org, tenantId: t, slug: 'team', name: 'Team' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'member', node });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Remove `joe` by hand — a role granted and taken back — and answer when the fence says. */
  const removedByHand = async (joe: PrincipalId): Promise<string> => {
    await host.admin.assignRole(staff, { principalId: joe, roleKey: 'member', node });
    await host.admin.unassignRole(staff, { principalId: joe, roleKey: 'member', node });
    const directory = new Database(join(dir, '_directory.sqlite'), { readonly: true });
    try {
      const fence = directory
        .prepare('SELECT removed_at FROM _substrat_membership_fences WHERE tenant_id = ? AND principal = ?')
        .get(t, joe) as { removed_at: string };
      return fence.removed_at;
    } finally {
      directory.close();
    }
  };

  /** alice invites, `joe` accepts; what the inline tail did with joe's request. */
  const invitedAndAccepted = async (joe: PrincipalId): Promise<ExecutorOutcome['outcome'][]> => {
    const inv = { invitationId: ulid(), orgId: org, roleKey: 'member' };
    await (await host.getScope(alice, t, s)).invoke('invitefix/send', inv);
    const outcomes: ExecutorOutcome[] = [];
    await (await host.getScope(joe, t, s)).invoke('invitefix/accept', inv, { onExecutorOutcomes: (o) => outcomes.push(...o) });
    return outcomes.filter((o) => o.entity === `membership:${joe}`).map((o) => o.outcome);
  };

  it('the window is five minutes — the documented trade-off, pinned', () => {
    expect(MEMBERSHIP_REMOVAL_SKEW_MS).toBe(5 * 60_000);
  });

  it('a tie goes to the removal', async () => {
    const joe = principalId.parse(ulid());
    clock.set(await removedByHand(joe)); // the request is stamped in the removal's own millisecond
    expect(await invitedAndAccepted(joe)).toEqual(['refused']);
  });

  it('a removal stamped BEFORE the request, but within the window, still wins — the clocks are not comparable that finely', async () => {
    const joe = principalId.parse(ulid());
    const removedAt = await removedByHand(joe);
    clock.set(new Date(Date.parse(removedAt) + 4 * 60_000)); // four minutes later: inside the window
    expect(await invitedAndAccepted(joe)).toEqual(['refused']);
  });

  it('twin: a removal further back than the window does not block a new invite', async () => {
    const joe = principalId.parse(ulid());
    const removedAt = await removedByHand(joe);
    clock.set(new Date(Date.parse(removedAt) + 6 * 60_000)); // six minutes later: outside it
    expect(await invitedAndAccepted(joe)).toEqual(['delivered']);
  });

  it('a directory opened from before the fence backfills it from the admin log, so a hand removal made back then still wins', async () => {
    const joe = principalId.parse(ulid());
    const removedAt = await removedByHand(joe);
    // The directory as it stood before this code: no fence table, the removal only in the log.
    await host.close();
    const raw = new Database(join(dir, '_directory.sqlite'));
    raw.exec('DROP TABLE _substrat_membership_fences');
    raw.close();
    host = new SqliteScopeHost({ dir, clock: clock.read, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    host.registerModule(membershipFixtureMod);
    registerMembershipExecutor(host, { actor: staff });
    clock.set(new Date(Date.parse(removedAt) + 60_000));
    expect(await invitedAndAccepted(joe)).toEqual(['refused']);
    // Twin: someone the log never removed joins on the reopened directory.
    expect(await invitedAndAccepted(principalId.parse(ulid()))).toEqual(['delivered']);
  });
});

describe('membership executor — the fence and the request share the host clock (#1184, Codex round 3)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const org = orgId.parse(ulid());
  const alice = principalId.parse(ulid());
  const node = { tenantId: t, scopeId: null };
  const clock = manualClock(new Date());
  let dir: string;
  let host: SqliteScopeHost;
  let release: () => void = () => undefined;
  let gate: Promise<void> = Promise.resolve();

  /** The host, except that every membership unit waits for `gate` — the add held in front of it. */
  const holding = (real: SqliteScopeHost): ScopeHost => {
    const held = (admin: HostAdmin): HostAdmin =>
      new Proxy(admin, {
        get: (target, key) =>
          key === 'applyMembership'
            ? async (...args: Parameters<HostAdmin['applyMembership']>) => {
                await gate;
                return target.applyMembership(...args);
              }
            : Reflect.get(target, key),
      });
    return new Proxy(real, {
      get: (target, key) => {
        if (key === 'attributed') return (o: Parameters<NonNullable<ScopeHost['attributed']>>[0]) => ({ admin: held(target.attributed(o).admin) });
        const v = Reflect.get(target, key) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as ScopeHost;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-membership-clock-'));
    // Ten minutes ahead of the wall: twice the window, so a wall-clock fence would fall under it.
    clock.set(new Date(Date.now() + 10 * 60_000));
    host = new SqliteScopeHost({ dir, clock: clock.read, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    host.registerModule(membershipFixtureMod);
    registerMembershipExecutor(holding(host), { actor: staff });
    await host.admin.createTenant(staff, { id: t, slug: `clock-${t.slice(-10).toLowerCase()}`, name: 'Clock' });
    await host.admin.grantEntitlement(staff, t, 'invitefix');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'invitefix-vertical' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'member', permissions: [INVITEFIX_A], source: 'vertical' });
    await host.admin.createOrg(staff, { id: org, tenantId: t, slug: 'team', name: 'Team' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'member', node });
  });

  afterEach(async () => {
    release();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** alice invites, `joe` accepts, and the add is held; `during` runs while it waits. */
  const heldAccept = async (joe: PrincipalId, during: () => Promise<void>): Promise<ExecutorOutcome['outcome'][]> => {
    const inv = { invitationId: ulid(), orgId: org, roleKey: 'member' };
    await (await host.getScope(alice, t, s)).invoke('invitefix/send', inv);
    gate = new Promise((r) => (release = r));
    const outcomes: ExecutorOutcome[] = [];
    const accepting = (await host.getScope(joe, t, s)).invoke('invitefix/accept', inv, { onExecutorOutcomes: (o) => outcomes.push(...o) });
    await new Promise((r) => setTimeout(r, 50));
    await during();
    release();
    await accepting;
    return outcomes.filter((o) => o.entity === `membership:${joe}`).map((o) => o.outcome);
  };

  it('a no-op staff removal while the add is held refuses it, with the host clock ten minutes ahead of the wall', async () => {
    const joe = principalId.parse(ulid());
    expect(await heldAccept(joe, () => host.admin.unassignRole(staff, { principalId: joe, roleKey: 'member', node }))).toEqual(['refused']);
  });

  it('twin: the same held add with nobody removed lands', async () => {
    const joe = principalId.parse(ulid());
    expect(await heldAccept(joe, async () => undefined)).toEqual(['delivered']);
  });
});
