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
} from '@substrat-run/kernel';
import { INVITEFIX_A, membershipFixtureMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1184: a removal raises the person's fence in the directory, on the directory's clock; the
 * request it races is a scope event on the scope's. The two share no causal order, so a fence
 * at or after `occurredAt - MEMBERSHIP_REMOVAL_SKEW_MS` wins — a tie included.
 *
 * SQLite only, and that is the reason this is not in the contract suite: the pure host takes a
 * clock, which is what moves a request's `occurredAt` away from the wall clock the admin rows
 * keep; the Durable-Object host takes none (`clock?: never`). The contract suite holds the
 * in-window case on both adapters.
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
});
