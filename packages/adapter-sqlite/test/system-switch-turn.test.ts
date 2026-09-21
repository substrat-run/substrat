/**
 * The schedule kill switch and `grantToSystem` take a turn on the scope actor (#1666 review).
 *
 * The same hazard `job-store-turn.test.ts` pins for the job store (#1577): `invoke` opens a
 * raw `BEGIN IMMEDIATE` on the scope's connection and HOLDS IT ACROSS AWAITS. A switch's
 * `db.transaction` issued meanwhile became a SAVEPOINT inside that transaction, and a grant's
 * INSERT simply joined it — so a stranger's ROLLBACK took the switch (or the grant) with it,
 * after the verb had answered success and audited `applied`.
 *
 * The turn is RE-ENTRANT: a caller already inside one of this scope's actor tasks joins it
 * rather than queueing behind itself, which would never return. The last case pins that.
 *
 * ADAPTER-SPECIFIC, for the reason the job-store test gives: the Durable Object serializes
 * its RPCs, so a shared-suite version would assert nothing on the hosted side.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { scheduleMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

describe('the schedule switch and grantToSystem survive a concurrent operation that rolls back (#1666)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-switch-turn-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const alice = principalId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  const reason = 'incident: runaway tick';

  /** Set per case: the held operation announces it is inside its transaction, then waits. */
  let entered!: () => void;
  let held!: Promise<void>;
  /** The scope `gate/reenter` acts on — its own, set by the case that invokes it. */
  let reenterScope!: ScopeId;

  const off = (s: ScopeId) =>
    host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason });
  const grant = (s: ScopeId, key: string) =>
    host.admin.grantToSystem(staff, {
      moduleId: SCHED,
      permission: permissionKey.parse(key),
      node: { tenantId: t, scopeId: s },
      grantedBy: staff,
    });
  const newScope = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    // Seats `sched:tick` for `system:@test/sched` (#1659) — what the switch takes.
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    await host.admin.activateScope(staff, t, s);
    return s;
  };
  /** An operation in flight and suspended INSIDE its transaction, released by the test. */
  const holdOpen = async (s: ScopeId) => {
    let release!: () => void;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = (await host.getScope(alice, t, s)).invoke('gate/hold');
    await inside;
    return { blocked, release };
  };
  /** A promise that fails the case instead of hanging it. */
  const within = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms))]);
  const phases = async (s: ScopeId) =>
    (await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['revokeFromSystem'] })).map(
      (e) => (e.after as { phase: string }).phase,
    );

  beforeAll(async () => {
    host.registerModule(scheduleMod);
    // Suspends inside its own `BEGIN IMMEDIATE`, then throws so the transaction ROLLS BACK
    // — a commit would carry a joined write along and hide the bug.
    host.defineOperation('gate/hold', async () => {
      entered();
      await held;
      throw new Error('this operation always rolls back');
    });
    // Re-entrancy: an operation that pulls the switch and grants on its OWN scope, from
    // inside its own actor task, then commits.
    host.defineOperation('gate/reenter', async () => {
      const node = { tenantId: t, scopeId: reenterScope };
      await host.admin.grantToSystem(staff, {
        moduleId: SCHED,
        permission: permissionKey.parse('sched:admin'),
        node,
        grantedBy: staff,
      });
      return host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason });
    });
    await host.admin.createTenant(staff, { id: t, slug: `switch-turn-${ulid().toLowerCase()}`, name: 'Switch turn' });
    await host.admin.grantEntitlement(staff, t, 'sched');
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a switch pulled while an operation holds an open transaction stays pulled when it rolls back', async () => {
    const s = await newScope();
    const { blocked, release } = await holdOpen(s);
    // NOT awaited before the release: with the turn, it cannot finish until the operation
    // has — awaiting it here would deadlock the test rather than fail it.
    const switching = off(s);
    release();
    await expect(blocked).rejects.toThrow(/always rolls back/);
    expect(await switching).toMatchObject({ schedules: 'off', changed: true, permissions: ['sched:tick'] });

    // Still off: a repeat is a no-op, a regrant is refused, and nothing fires.
    expect(await off(s)).toMatchObject({ changed: false });
    await expect(grant(s, 'sched:tick')).rejects.toSatisfy((e) => errorCodeOf(e) === 'conflict');
    expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 0, switchedOff: true });
    // And the audit agrees with the tuples: `applied` for a switch that did land.
    expect(await phases(s)).toEqual(['intent', 'applied', 'intent', 'applied']);
  });

  it('a grantToSystem issued while an operation holds an open transaction survives its rollback', async () => {
    const s = await newScope();
    const { blocked, release } = await holdOpen(s);
    const granting = grant(s, 'sched:admin');
    release();
    await expect(blocked).rejects.toThrow(/always rolls back/);
    await granting;
    // The grant is live: OFF tombstones every live grant the module holds, and names it.
    expect((await off(s)).permissions.slice().sort()).toEqual(['sched:admin', 'sched:tick']);
  });

  it('twin: with no operation in flight, the switch and the grant behave exactly as before', async () => {
    const s = await newScope();
    await grant(s, 'sched:admin');
    const result = await off(s);
    expect(result).toMatchObject({ schedules: 'off', changed: true });
    expect(result.permissions.slice().sort()).toEqual(['sched:admin', 'sched:tick']);
    expect(await phases(s)).toEqual(['intent', 'applied']);
  });

  it('re-entrant: called from inside the scope\'s own actor task, both join it instead of deadlocking', async () => {
    const s = await newScope();
    reenterScope = s;
    const result = (await within((await host.getScope(alice, t, s)).invoke('gate/reenter'))) as {
      changed: boolean;
      permissions: string[];
    };
    expect(result.changed).toBe(true);
    expect(result.permissions.slice().sort()).toEqual(['sched:admin', 'sched:tick']);
    // Committed with the operation that made them.
    expect(await off(s)).toMatchObject({ changed: false });
  });
});
