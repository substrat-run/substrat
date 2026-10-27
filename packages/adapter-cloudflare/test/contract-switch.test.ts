// The contract suites on the DO path, part 2 of 3: schedules, the resumable run driver and the
// schedule kill switch — its delegation, its record, the scope-local projection and the #1819
// PITR rewind hold. Parts 1 and 3 are contract-hosts.test.ts and contract-data.test.ts; CI runs
// each on its own shard (tools/ci-scope.mjs PARTS).
import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { warmControlPlane, warmSwitchHolds } from './do-warmup.js';
import { seedProjectedRole, seedProjectedTenantTuple, tombstoneProjectedRole } from './seed-projection.js';
import {
  armRewind,
  holdsStub as holdsOf,
  landRewind,
  restartNow,
  TEST_HOLD_SETTLE_MS,
  TEST_HOLD_SNAPSHOT_MS,
} from './pitr-emulation.js';
import {
  connectionId,
  errorCodeOf,
  instant,
  moduleId,
  orgId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ModuleId,
  type RoleDefinition,
  type ScopeId,
} from '@substrat-run/contracts';
import {
  ulid,
  UNSAFE_allowAllChecker,
  webCryptoSecretBox,
  type SwitchSql,
  type JobPassContext,
  JOB_DEFER_MS,
  JOB_RUN_DUE_AT,
  JOB_ADMISSION_MISS_MAX,
  JOB_LEASE_TOO_SHORT_NOTE,
  admissionBackoffMs,
  SYSTEM_DOOR_WAIT,
} from '@substrat-run/kernel';
import {
  scheduleContractSuite,
  scheduleEntitlementContractSuite,
  schedulePlatformRequestsContractSuite,
  scheduleMod,
  jobRunContractSuite,
  systemSwitchContractSuite,
  heldVersion,
} from '@substrat-run/contract-tests';
import {
  CloudflareScopeHost,
  SWITCH_HOLD_EXTRA_WAITS,
  SWITCH_HOLD_PENDING_MAX_MS,
  SWITCH_HOLD_SETTLE_MS,
  SWITCH_HOLD_SNAPSHOT_MS,
  SWITCH_HOLDS_NAME,
} from './test-host.js';
import { SYSTEM_DOOR_REGATES } from '../src/system-door.js';
import { refuseAdminRows, refuseSwitchRecord } from './contract-support.js';

// Absorb the inter-file DO reload before any suite's first directory call
// (see do-warmup.ts) — file-level, so it runs before every suite below.
beforeAll(() => warmControlPlane(env.CONTROL_PLANE));
// …and the #1819 hold object every schedule pass over SCOPE reads.
beforeAll(() => warmSwitchHolds(env.SCOPE));

// The schedule suite (#383) also runs against the default tuple checker — it must
// resolve the projected system grant, not an allow-all. Its sweep walks every active
// scope in the directory it is handed and asserts exact fired/skipped counts, so it is
// handed a directory no other suite writes to, and scopes that read it (#1899).
scheduleContractSuite('adapter-cloudflare', async () => {
  await warmControlPlane(env.SCHED_CONTROL_PLANE);
  await warmSwitchHolds(env.SCHED_SCOPE);
  const host = new CloudflareScopeHost({
    scope: env.SCHED_SCOPE,
    controlPlane: env.SCHED_CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
}, (host, suspend, resumeBeforeCatch) => {
  // Interpose after the coordinator's cadence read and before the system door.
  const target = host as unknown as { openSystemDoor: (...args: unknown[]) => Promise<unknown> };
  const original = target.openSystemDoor.bind(host);
  target.openSystemDoor = async (...args) => {
    target.openSystemDoor = original;
    await suspend();
    try {
      return await original(...args);
    } catch (error) {
      await resumeBeforeCatch?.();
      throw error;
    }
  };
  return () => { target.openSystemDoor = original; };
}, (host, suspend) => {
  // Every fire's invoke drains its executors in its tail: the first drain is after the first fire.
  const target = host as unknown as { drainExecutors: (...args: unknown[]) => Promise<unknown> };
  const original = target.drainExecutors.bind(host);
  target.drainExecutors = async (...args) => {
    target.drainExecutors = original;
    const drained = await original(...args);
    await suspend();
    return drained;
  };
  return () => { target.drainExecutors = original; };
});

// #1654: a composed engine's own schedule runs without the engine's SKU, and nothing else
// the exception could reach does. The DEFAULT checker: the user-door case holds the
// permission through a real role, so only the SKU gate can refuse it. `runDueSchedules`
// directly, never a sweep, so the shared directory is safe here.
scheduleEntitlementContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #2431: a scheduled pass reports the platform requests it enqueued, counted on the coordinator
// from what the ScopeDO hands back for each fire. `runDueSchedules` directly, never a sweep, so
// the shared directory is safe here.
schedulePlatformRequestsContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
}, async (_tenant, scope, sql, params = []) => {
  await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_, state) => {
    state.storage.sql.exec(sql, ...(params as SqlStorageValue[]));
  });
});

// #1577: the resumable-run driver, on the DURABLE half of D-14 — the run record and
// the step ledger live in the scope DO, the pass engine on the coordinator. The
// DEFAULT tuple checker: a job's steps act through the system door, and what they
// may do has to resolve through the real grant (`jobsMod` declares no schedules, so
// the suite writes the system grant itself).
jobRunContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, cleanup: async () => host.close() };
});

// #1666: the schedule kill switch, on the adapter that is deployed — the gate and the
// switch both run in the scope DO. The DEFAULT checker: what the switch stops is a system
// principal's own `ctx.check`, which an allow-all would pass regardless.
systemSwitchContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return { host, refuseAdminRows, refuseSwitchRecord, cleanup: async () => host.close() };
});

// #1823: the same suite with tenant tuples PROJECTED into each scope, as production runs.
// A tenant-level system grant then lives in the scope's own storage too, and every
// tenant-level write re-projects it — which must not bring a switched-off module back.
systemSwitchContractSuite('adapter-cloudflare, scope-local permissions', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    scopeLocalPermissions: true,
  });
  return { host, refuseAdminRows, refuseSwitchRecord, cleanup: async () => host.close() };
});

/**
 * #1666 on the SHARED control plane's host: `systemSwitchDelegation` set, as
 * `apps/control-plane` sets it. A hosted scope's grants live in its vertical's deployment,
 * and this host's own `SCOPE` namespace is the placeholder — so the switch must be moved
 * THERE and audited HERE. The far end is a recording fake; the real one (the VerticalClient
 * against a deployed vertical's `/internal/system-switch`) is proven in `demos/meridian`.
 *
 * The placeholder is not empty in this test, deliberately: the scope is provisioned on
 * this host, so its own DO holds a live grant. That is what makes "the placeholder was
 * not switched" observable — its schedules still fire after the delegated revoke.
 */
/**
 * #2045: a fake deployment that honours the switch fence — what every deployment built with it
 * answers. A fake that should model a deployment from before the fence leaves this out.
 */
const fencedFor = (a: { fence?: string }) => (a.fence !== undefined ? { fenced: true as const } : {});

describe('#1666 — the switch is moved in the serving deployment, and audited here', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  type Call = { tenantId: string; scopeId: string; moduleId: string; to: 'on' | 'off'; tenantHeld?: boolean; fence?: string };

  const setup = async (
    answer: (call: Call) => { held: boolean; changed: boolean; permissions: string[]; deniesTenantGrants?: true },
    /** `null` provisions a scope bound to no vertical. */
    vertical: string | null = 'sched-vertical',
  ) => {
    const calls: Call[] = [];
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      systemSwitchDelegation: {
        // #2045 (Codex r3): a deployment built with the switch fence.
        fenceSupported: async () => true,
        switch: async (a) => {
          calls.push({ ...a });
          const out = answer(a);
          return { ...fencedFor(a), ...out, permissions: out.permissions.map((p) => permissionKey.parse(p)) };
        },
        // Not exercised by this describe block (#1674 has its own), but required by
        // `SystemSwitchDelegation` — a fake that cannot answer the read would make a
        // status-read test here fail confusingly rather than at its own call site.
        status: async () => {
          throw new Error('not exercised by this fixture — see the #1674 describe block');
        },
      },
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `hosted-${t.slice(-10).toLowerCase()}`, name: 'Hosted' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, ...(vertical ? { vertical } : {}) });
    await host.admin.activateScope(staff, t, s);
    const audit = () => host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['revokeFromSystem', 'restoreToSystem'] });
    return { host, t, s, calls, audit };
  };

  /** The admin-log rows for one scope, flattened: action + the `after` payload. */
  const rows = async (
    audit: () => Promise<{ action: string; vertical: string | null; after: unknown }[]>,
  ): Promise<Record<string, unknown>[]> =>
    (await audit()).map((e) => ({ action: e.action, vertical: e.vertical, ...(e.after as Record<string, unknown>) }));

  it('delegates the write, leaves the placeholder alone, and audits intent then outcome here, with the reason', async () => {
    const { host, t, s, calls, audit } = await setup(() => ({ held: true, changed: true, permissions: ['sched:tick'] }));
    const result = await host.admin.revokeFromSystem(staff, {
      moduleId: SCHED,
      node: { tenantId: t, scopeId: s },
      reason: 'incident 42',
    });
    expect(result).toEqual({
      operationId: expect.any(String),
      moduleId: SCHED,
      schedules: 'off',
      changed: true,
      permissions: ['sched:tick'],
    });
    expect(calls).toEqual([{ tenantId: t, scopeId: s, moduleId: SCHED, to: 'off', tenantHeld: false, fence: result.operationId }]);
    // The placeholder DO still holds its live grant and no marker: nothing was written here.
    expect((await host.runDueSchedules(SCHED, t, s)).fired).toBe(2);
    const common = { action: 'revokeFromSystem', vertical: 'sched-vertical', operationId: result.operationId, moduleId: SCHED, schedules: 'off' };
    expect(await rows(audit)).toEqual([
      { ...common, phase: 'intent', reason: 'incident 42' },
      { ...common, phase: 'applied', changed: true, permissions: ['sched:tick'] },
    ]);

    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'ok' });
    expect(calls.at(-1)).toEqual({ tenantId: t, scopeId: s, moduleId: SCHED, to: 'on', tenantHeld: false, fence: expect.any(String) });
    expect((await rows(audit)).map((r) => [r.action, r.phase])).toEqual([
      ['revokeFromSystem', 'intent'],
      ['revokeFromSystem', 'applied'],
      ['restoreToSystem', 'intent'],
      ['restoreToSystem', 'applied'],
    ]);
  });

  it('tells the deployment when the directory holds a live tenant-level grant for the module (#1823)', async () => {
    const { host, t, s, calls } = await setup(() => ({ held: true, changed: true, permissions: [], deniesTenantGrants: true }));
    const tenantGrant = (key: string, module = SCHED, expiresAt?: string) =>
      host.admin.grantToSystem(staff, {
        moduleId: module,
        permission: permissionKey.parse(key),
        node: { tenantId: t, scopeId: null },
        grantedBy: staff,
        ...(expiresAt ? { expiresAt: instant.parse(expiresAt) } : {}),
      });
    // An expired tenant grant, and a live one of ANOTHER module, hold nothing for this one.
    await tenantGrant('sched:tick', SCHED, '2020-01-01T00:00:00.000Z');
    await tenantGrant('jobs:write', moduleId.parse('@test/jobs'));
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'r' });
    expect(calls.at(-1)).toMatchObject({ to: 'off', tenantHeld: false });
    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'ok' });
    // A live one does, and the deployment is told so on both moves.
    await tenantGrant('sched:tick');
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'r' });
    expect(calls.at(-1)).toMatchObject({ to: 'off', tenantHeld: true });
    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'ok' });
    expect(calls.at(-1)).toMatchObject({ to: 'on', tenantHeld: true });
  });

  /**
   * #1823: `held: true` says the marker landed, not that anything reads it for a tenant-level
   * grant. A deployment built before #1823 drops `tenantHeld`, switches the module's scope-level
   * grants, answers `held: true` — and its evaluator still authorizes the tenant-level grant. So
   * an OFF of a tenant-held module needs the far end's `deniesTenantGrants`, or it is refused.
   *
   * #2045 (Codex r3): such a deployment is refused at the fence preflight before this can arise
   * (every build with the fence is post-#1823), so an unattested answer here means a rollback
   * between the preflight and the move. It is NOT compensated with an opposite move, which could
   * undo a newer call's switch: the record stays off and owed, and every re-assert refuses until
   * the vertical is redeployed.
   */
  describe('an OFF of a tenant-held module needs the deployment to attest the tenant-grant denial', () => {
    /** `old`: a deployment built before #1823. */
    const far = { old: true, changed: true };
    const answer = () => ({
      held: true,
      changed: far.changed,
      permissions: ['sched:tick'],
      ...(far.old ? {} : { deniesTenantGrants: true as const }),
    });
    const tenantHeld = async () => {
      Object.assign(far, { old: true, changed: true });
      const fx = await setup(answer);
      await fx.host.admin.grantToSystem(staff, {
        moduleId: SCHED,
        permission: permissionKey.parse('sched:tick'),
        node: { tenantId: fx.t, scopeId: null },
        grantedBy: staff,
      });
      const node = { tenantId: fx.t, scopeId: fx.s };
      const position = async () =>
        (await fx.host.admin.listSystemSwitches(staff, { tenantId: fx.t })).filter((r) => r.scopeId === fx.s).map((r) => r.position);
      return { ...fx, node, position };
    };

    it('an unattested answer is refused with nothing put back: the record stays off, owed a re-assert', async () => {
      const { host, node, calls, audit, position } = await tenantHeld();
      const e = await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' }).then(() => null, (x: unknown) => x);
      expect(errorCodeOf(e)).toBe('precondition_failed');
      expect(String((e as Error).message)).toMatch(/predates the kill switch's tenant-grant denial.*Redeploy the vertical/);
      // No compensating ON: it could undo a newer call's switch.
      expect(calls.map((c) => [c.to, c.tenantHeld])).toEqual([['off', true]]);
      expect(await position()).toEqual(['off']);
      expect((await rows(audit)).map((r) => [r.phase, r.recordKept, r.reassertOwed])).toEqual([
        ['intent', undefined, undefined],
        ['refused', true, true],
      ]);
      // The owed mark holds the scope's receipt back until a re-assert the deployment can attest.
      await host.admin.markScopeProvisioned(staff, node.tenantId, node.scopeId, 'v1');
      expect((await host.admin.getScopeRecord(staff, node.tenantId, node.scopeId))?.provisionedVersionId).toBeNull();
      await expect(host.admin.reassertSystemSwitches(staff, node)).rejects.toThrow(/predates the kill switch's tenant-grant denial/);
      far.old = false; // redeployed
      await host.admin.reassertSystemSwitches(staff, node);
      await host.admin.markScopeProvisioned(staff, node.tenantId, node.scopeId, 'v1');
      expect((await host.admin.getScopeRecord(staff, node.tenantId, node.scopeId))?.provisionedVersionId).toBe('v1');
    });

    it('a deployment that attests it is recorded OFF', async () => {
      const { host, node, calls, position } = await tenantHeld();
      far.old = false;
      await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' });
      expect(calls.map((c) => c.to)).toEqual(['off']);
      expect(await position()).toEqual(['off']);
    });

    it("a re-assert against an old deployment throws, so a carry's reconcile records no receipt", async () => {
      const { host, node, position } = await tenantHeld();
      far.old = false;
      await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' });
      // The scope's version rolled back to a deployment built before #1823.
      far.old = true;
      await expect(host.admin.reassertSystemSwitches(staff, node)).rejects.toThrow(/predates the kill switch's tenant-grant denial/);
      expect(await position()).toEqual(['off']);
    });

    it('a module that is not tenant-held needs no attestation, on an old deployment too', async () => {
      Object.assign(far, { old: true, changed: true });
      const { host, t, s, calls } = await setup(answer);
      await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'r' });
      expect(calls.map((c) => [c.to, c.tenantHeld])).toEqual([['off', false]]);
      await host.admin.reassertSystemSwitches(staff, { tenantId: t, scopeId: s });
    });
  });

  it('a far end that holds nothing is a 404 audited as refused, and a no-op is still audited', async () => {
    let held = false;
    const { host, t, s, audit } = await setup(() => ({ held, changed: false, permissions: [] }));
    const input = { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'r' };
    const refused = await host.admin.revokeFromSystem(staff, input).then(() => null, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('not_found');
    held = true;
    expect(await host.admin.revokeFromSystem(staff, input)).toMatchObject({ changed: false });
    expect((await rows(audit)).map((r) => [r.phase, r.changed])).toEqual([
      ['intent', undefined],
      ['refused', false],
      ['intent', undefined],
      ['applied', false],
    ]);
  });

  it('a far end that fails fails the verb, and the audit shows the intent and the failure', async () => {
    const { host, t, s, audit } = await setup(() => {
      throw new Error('vertical unreachable during system-switch: Durable Object reset');
    });
    await expect(
      host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'r' }),
    ).rejects.toThrow(/unreachable/);
    const log = await rows(audit);
    expect(log.map((r) => r.phase)).toEqual(['intent', 'failed']);
    expect(log[1]).toMatchObject({ operationId: log[0]!.operationId, error: expect.stringMatching(/unreachable/) });
  });

  it('a retry after the far end moved but the answer was lost is audited too — changed: false is no excuse', async () => {
    // The far end applies the switch and THEN the answer is lost (a crash between the
    // mutation and the outcome row looks the same from the log's side). #2045: the call retries
    // its move once under its own fence, finds it already off (`changed: false`), and succeeds.
    // An operator's repeat still leaves its own pair of rows.
    let off = false;
    let lose = true;
    const { host, t, s, audit } = await setup(() => {
      const changed = !off;
      off = true;
      if (lose) {
        lose = false;
        throw new Error('vertical unreachable during system-switch: connection reset after write');
      }
      return { held: true, changed, permissions: changed ? ['sched:tick'] : [] };
    });
    const input = { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'retry me' };
    expect(await host.admin.revokeFromSystem(staff, input)).toMatchObject({ changed: false });
    expect(await host.admin.revokeFromSystem(staff, input)).toMatchObject({ changed: false });
    const log = await rows(audit);
    expect(log.map((r) => r.phase)).toEqual(['intent', 'applied', 'intent', 'applied']);
    expect(log[0]!.operationId).not.toBe(log[2]!.operationId);
    expect(log[3]).toMatchObject({ operationId: log[2]!.operationId, changed: false });
  });

  it("the DO's pre-#1666 `hasSystemGrant` answers the new question — a coordinator a deploy behind cannot run a switched-off scope", async () => {
    // Not delegated: the switch is moved in THIS host's own DO, which is the one asked.
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `legacy-${t.slice(-10).toLowerCase()}`, name: 'Legacy' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    await host.admin.activateScope(staff, t, s);
    const raw = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as { hasSystemGrant(m: string): Promise<boolean> };
    const node = { tenantId: t, scopeId: s };
    expect(await raw.hasSystemGrant(SCHED)).toBe(true);
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    // The marker is itself a live `system:` tuple — exactly what the old predicate ("any
    // live system: tuple") would have counted as a grant.
    expect(await raw.hasSystemGrant(SCHED)).toBe(false);
    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    expect(await raw.hasSystemGrant(SCHED)).toBe(true);
  });

  it('a scope bound to no vertical is switched locally, never through the delegation (#1666 review)', async () => {
    const { host, t, s, calls, audit } = await setup(() => {
      throw new Error('no deployment serving scope (the delegation must not be reached)');
    }, null);
    const node = { tenantId: t, scopeId: s };
    // A module it never held: the local no-grant outcome — `not_found` "holds no system
    // grant" — rather than the delegation's "no deployment serving scope".
    const refused = await host.admin
      .revokeFromSystem(staff, { moduleId: moduleId.parse('@test/never-held'), node, reason: 'r' })
      .then(() => null, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('not_found');
    expect(String(refused)).toMatch(/holds no system grant/);
    // A module it does hold (provisioning seats a registered module's schedule grant with
    // or without a vertical): the switch moves in THIS host's DO, which is where the
    // scope's store is, and its schedules stop.
    expect(await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' })).toMatchObject({
      schedules: 'off',
      changed: true,
      permissions: ['sched:tick'],
    });
    expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 0, switchedOff: true });
    expect(calls).toEqual([]);
    expect((await rows(audit)).map((r) => [r.phase, r.vertical])).toEqual([
      ['intent', null],
      ['refused', null],
      ['intent', null],
      ['applied', null],
    ]);
  });

  it('twin: a scope WITH a vertical and no serving deployment still reaches the delegation, and fails loudly', async () => {
    const { host, t, s, calls, audit } = await setup(() => {
      throw new Error("no deployment serving scope (vertical 'sched-vertical') — cannot switch its schedules off");
    });
    await expect(
      host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'r' }),
    ).rejects.toThrow(/no deployment serving scope/);
    // #2045: the move and its one retry, under the same fence.
    const call = { tenantId: t, scopeId: s, moduleId: SCHED, to: 'off', tenantHeld: false, fence: calls[0]!.fence };
    expect(calls).toEqual([call, call]);
    expect((await rows(audit)).map((r) => [r.phase, r.recordKept])).toEqual([
      ['intent', undefined],
      ['failed', true],
    ]);
  });

  /**
   * #2178 (review of #2181, round 2): a switch clears the scope's reconcile receipt here (and only
   * here: SQLite keeps it). Until the sweep reconciles the install again, it may not have run the
   * retirement its version declares, so a drop that would strand its bound people waits for it.
   */
  it('a switch that clears the receipt holds a binding-shape drop until the install reconciles again (#2178)', async () => {
    const slug = `acme/sw-${ulid().slice(-8).toLowerCase()}`;
    const { host, t, s } = await setup(() => ({ held: true, changed: true, permissions: ['sched:tick'] }), slug);
    await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
    const HOLDER = { table: 'bind_records', idColumn: 'id', principalColumn: 'principal' };
    const publish = async (permissions: string[], retired?: string[]) => {
      const id = ulid();
      const shape = { entityType: 'contact', permissions, ...(retired ? { retired } : {}), bootstrap: true, holder: HOLDER, bind: { permission: 'contact:invite' } };
      await host.admin.publishVersion(staff, await heldVersion({
        id, verticalSlug: slug, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`,
        permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
        manifestJson: JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [shape] } }),
      }));
      await host.admin.admitVersion(staff, id);
      return id;
    };
    const binds = await publish(['contact:read-own']);
    const retired = await publish([], ['contact:read-own']);
    const dropped = ulid();
    await host.admin.publishVersion(staff, await heldVersion({
      id: dropped, verticalSlug: slug, version: '9.0.0', manifestDigest: 'm-d', permissionDigest: 'p', migrationDigest: 'g',
      deploymentRef: null, manifestJson: JSON.stringify({ registry: { permissions: [], roles: [], entityGrants: [] } }),
    }));
    await host.admin.admitVersion(staff, dropped);
    await host.admin.bindScopeVersion(staff, t, s, binds);
    await host.admin.markScopeProvisioned(staff, t, s, binds, { retirementsFinished: true });
    await host.admin.bindScopeVersion(staff, t, s, retired);
    await host.admin.markScopeProvisioned(staff, t, s, retired, { retirementsFinished: true });
    expect((await host.admin.getScopeRecord(staff, t, s))?.retirementsFinishedVersionId).toBe(retired);
    // The switch clears the receipt in the same write as its record, and (#2185) the version whose
    // retirements finished with it.
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'r' });
    expect((await host.admin.getScopeRecord(staff, t, s))?.provisionedVersionId).toBeNull();
    expect((await host.admin.getScopeRecord(staff, t, s))?.retirementsFinishedVersionId).toBeNull();
    const refused = await host.admin.bindScopeVersion(staff, t, s, dropped).then(() => null, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('precondition_failed');
    expect(String((refused as Error).message)).toMatch(new RegExp(`drops the shape.*no reconcile receipt.*\\(one is ${s}\\)`));
    // The twin: the sweep's reconcile writes the receipt again, its retirements finished, and the drop binds.
    await host.admin.markScopeProvisioned(staff, t, s, retired, { retirementsFinished: true });
    await host.admin.bindScopeVersion(staff, t, s, dropped);
    expect((await host.admin.getScopeRecord(staff, t, s))?.verticalVersionId).toBe(dropped);
  });

  it('refuses a scope the directory does not have before reaching anything', async () => {
    const { host, t, calls } = await setup(() => ({ held: true, changed: true, permissions: [] }));
    const refused = await host.admin
      .revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: scopeId.parse(ulid()) }, reason: 'r' })
      .then(() => null, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('not_found');
    expect(calls).toEqual([]);
  });
});

/**
 * #1674 — the status read's own delegation, on the SAME `systemSwitchDelegation` seam the
 * write above uses. `status` here is a genuine fake position (not a recording stub that
 * throws): it reflects whatever `switch` last moved, so the admin-log join this host
 * performs — reading rows `revokeFromSystem`/`restoreToSystem` wrote HERE, regardless of
 * where the position itself lives — is exercised against a real off/on history.
 */
describe('#1674 — the status read is delegated exactly like the switch, and joined with the admin log here', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  type StatusCall = { tenantId: string; scopeId: string };

  const setup = async (vertical: string | null = 'sched-vertical') => {
    const statusCalls: StatusCall[] = [];
    let position: 'on' | 'off' = 'on';
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      systemSwitchDelegation: {
        // #2045 (Codex r3): a deployment built with the switch fence.
        fenceSupported: async () => true,
        switch: async (a) => {
          const changed = position !== a.to;
          position = a.to;
          return { ...fencedFor(a), held: true, changed, permissions: changed ? [permissionKey.parse('sched:tick')] : [] };
        },
        status: async (a) => {
          statusCalls.push({ ...a });
          return [{ moduleId: SCHED, schedules: position }];
        },
      },
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `hosted-status-${t.slice(-10).toLowerCase()}`, name: 'Hosted' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, ...(vertical ? { vertical } : {}) });
    await host.admin.activateScope(staff, t, s);
    return { host, t, s, statusCalls };
  };

  it('delegates the read, leaves the placeholder alone, and joins its OWN admin log by moduleId', async () => {
    const { host, t, s, statusCalls } = await setup();
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'incident 99' });

    const status = await host.admin.systemGrantsStatus(staff, { tenantId: t, scopeId: s });
    expect(status).toEqual([
      {
        moduleId: SCHED,
        schedules: 'off',
        switchedOff: { actor: staff, reason: 'incident 99', at: expect.any(String) },
        recorded: 'off',
      },
    ]);
    expect(statusCalls).toEqual([{ tenantId: t, scopeId: s }]);
    // The placeholder DO's own grant was never touched by the delegated write (#1666's own
    // assertion) — its schedules still fire, proving the position genuinely came from the
    // delegation and not from a local fallback.
    expect((await host.runDueSchedules(SCHED, t, s)).fired).toBe(2);

    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'resolved' });
    expect(await host.admin.systemGrantsStatus(staff, { tenantId: t, scopeId: s })).toEqual([
      { moduleId: SCHED, schedules: 'on', switchedOff: null, recorded: 'on' },
    ]);
  });

  it('a scope bound to no vertical is read locally, never through the delegation', async () => {
    const { host, t, s, statusCalls } = await setup(null);
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'local incident' });
    const status = await host.admin.systemGrantsStatus(staff, { tenantId: t, scopeId: s });
    expect(status).toEqual([
      {
        moduleId: SCHED,
        schedules: 'off',
        switchedOff: { actor: staff, reason: 'local incident', at: expect.any(String) },
        recorded: 'off',
      },
    ]);
    expect(statusCalls).toEqual([]);
  });

  /**
   * #1674 review: a hosted scope (vertical bound, on a non-cpLess host) with NO
   * `systemSwitchDelegation` configured at all must fail loudly rather than silently
   * answer from this host's own placeholder DO — an unrelated, and here empty, position.
   * If the fallback the review flagged is ever reinstated, this comes back `[]` (200)
   * instead of throwing, and the test goes red.
   */
  it('a hosted scope with NO delegation configured fails loudly instead of answering the placeholder', async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      // systemSwitchDelegation deliberately omitted.
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `hosted-nodeleg-${t.slice(-10).toLowerCase()}`, name: 'Hosted' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    await host.admin.activateScope(staff, t, s);

    const refused = await host.admin.systemGrantsStatus(staff, { tenantId: t, scopeId: s }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorCodeOf(refused)).toBe('unavailable');
    expect(String(refused)).toMatch(/no delegation configured for hosted scope/);
  });
});

/**
 * #1674 — the directory's record for a HOSTED scope. The record lives HERE, in the shared
 * control plane's directory, while the switch lives in the deployment serving the scope;
 * the re-assert reaches that switch over the SAME delegation `revokeFromSystem` does. The
 * fake deployment models the one thing that matters: a store whose marker can be lost.
 */
describe('#1674 — a hosted scope is re-asserted through the delegation, after the deployment seats', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  type Deployment = { position: 'on' | 'off' | 'wiped'; fail: boolean; switchCalls: string[] };

  const setup = async () => {
    const deployment: Deployment = { position: 'on', fail: false, switchCalls: [] };
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      systemSwitchDelegation: {
        // #2045 (Codex r3): a deployment built with the switch fence.
        fenceSupported: async () => true,
        switch: async (a) => {
          deployment.switchCalls.push(a.to);
          if (deployment.fail) throw new Error('vertical unreachable during system-switch');
          // A wiped store holds nothing for the module until its own provision seats it.
          if (deployment.position === 'wiped') return { ...fencedFor(a), held: false, changed: false, permissions: [] };
          const changed = deployment.position !== a.to;
          deployment.position = a.to;
          return { ...fencedFor(a), held: true, changed, permissions: changed ? [permissionKey.parse('sched:tick')] : [] };
        },
        status: async () =>
          deployment.position === 'wiped' ? [] : [{ moduleId: SCHED, schedules: deployment.position }],
      },
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `hosted-rec-${t.slice(-10).toLowerCase()}`, name: 'Hosted' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    await host.admin.activateScope(staff, t, s);
    const node = { tenantId: t, scopeId: s };
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'incident 7' });
    deployment.switchCalls.length = 0;
    return { host, t, s, node, deployment };
  };

  it('a wiped deployment store: drift shows, the reconcile reseats it on, and the re-assert switches it off THERE', async () => {
    const { host, s, node, deployment } = await setup();
    deployment.position = 'wiped';
    expect(await host.admin.systemGrantsStatus(staff, node)).toEqual([
      { moduleId: SCHED, schedules: 'ungranted', switchedOff: null, recorded: 'off' },
    ]);
    // The deployment's own reconcile seats the grant live (#1659) — the window this closes.
    deployment.position = 'on';
    expect(await host.admin.reassertSystemSwitches(staff, node)).toEqual([
      { moduleId: SCHED, held: true, changed: true },
    ]);
    expect(deployment.switchCalls).toEqual(['off']);
    expect(deployment.position).toBe('off');
    const log = await host.admin.auditLog(staff, { scopeId: s, action: ['reassertSystemSwitch'] });
    expect(log.map((e) => [e.vertical, (e.after as { moduleId: string }).moduleId])).toEqual([['sched-vertical', SCHED]]);
    expect((await host.admin.systemGrantsStatus(staff, node))[0]).toMatchObject({
      schedules: 'off',
      recorded: 'off',
      switchedOff: { reason: 'incident 7' },
    });
  });

  it('a restore the wiped deployment refuses leaves the record off, and the reconcile after the seat switches it off (#1674 review)', async () => {
    const { host, node, deployment } = await setup();
    deployment.position = 'wiped';
    const refused = await host.admin
      .restoreToSystem(staff, { moduleId: SCHED, node, reason: 'fixed' })
      .then(() => null, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('not_found');
    expect(await host.admin.listSystemSwitches(staff, { scopeId: node.scopeId })).toEqual([
      expect.objectContaining({ position: 'off', reason: 'incident 7' }),
    ]);
    deployment.position = 'on'; // the deployment's reconcile seats the grants
    await host.admin.reassertSystemSwitches(staff, node);
    expect(deployment.position).toBe('off');
  });

  it('a hosted scope on a host with NO delegation: the re-assert refuses `unavailable` instead of reaching the placeholder (Copilot review)', async () => {
    // Without DISPATCH/PLATFORM_SECRET the control plane configures no delegation, and this
    // host's own SCOPE namespace is the module-less placeholder. A re-assert that switched
    // THERE would answer success, and a reconcile would write its receipt, while the
    // deployment serving the scope kept its schedules running.
    const bare = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    bare.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await bare.admin.createTenant(staff, { id: t, slug: `bare-${t.slice(-10).toLowerCase()}`, name: 'Bare' });
    await bare.admin.grantEntitlement(staff, t, 'sched');
    await bare.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    await bare.admin.activateScope(staff, t, s);
    await bare.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'incident' });
    const refused = await bare.admin
      .reassertSystemSwitches(staff, { tenantId: t, scopeId: s })
      .then(() => null, (e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('unavailable');
    expect(String(refused)).toMatch(/no delegation configured for hosted scope/);
    // …and a re-provision of that scope is not taken down by it: the CP-full seat landed in
    // the placeholder, which is not where this scope's switch lives, so it re-asserts nothing.
    await expect(bare.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' })).resolves.toBeUndefined();
  });

  it('a far end that cannot be reached fails the re-assert, so no caller records a receipt for a scope left on', async () => {
    const { host, node, deployment } = await setup();
    deployment.fail = true;
    await expect(host.admin.reassertSystemSwitches(staff, node)).rejects.toThrow(/unreachable/);
  });

  it("the CP's own provisionScope never re-asserts a delegated scope — that would run before the deployment seats it", async () => {
    const { host, t, s, deployment } = await setup();
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    expect(deployment.switchCalls).toEqual([]);
  });

  it('a restore through the record: ON updates it before the far end moves, and a failed ON is owed', async () => {
    const { host, node, deployment } = await setup();
    deployment.fail = true;
    await expect(
      host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'fixed' }),
    ).rejects.toThrow(/unreachable/);
    // #2045: the move threw twice, so no readback can settle it. The record keeps the operator's ON
    // under its fence, and the subject is owed the next re-assert.
    expect(await host.admin.listSystemSwitches(staff, { scopeId: node.scopeId })).toEqual([
      expect.objectContaining({ position: 'on', reason: 'fixed', vertical: 'sched-vertical' }),
    ]);
    expect(deployment.position).toBe('off');
    deployment.fail = false;
    // The re-assert converges the scope to the record — ON, which a record turns on only when owed.
    expect(await host.admin.reassertSystemSwitches(staff, node)).toEqual([{ moduleId: SCHED, held: true, changed: true }]);
    expect(deployment.position).toBe('on');
    // Settled: the mark is gone, and a record of ON turns nothing on again.
    expect(await host.admin.reassertSystemSwitches(staff, node)).toEqual([]);
  });
});

/**
 * #1742 review round 2 — the stale-carry revert's ordering on the delegated path, where every
 * read and move is its own call and a staff OFF can land between any two of them. The control
 * plane's stub is wrapped so a hook runs right after the re-assert's first record read; the
 * fake deployment can run one inside the revert's own move.
 */
describe('#1742 — a staff OFF racing the stale-carry revert still ends OFF', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');

  const setup = async () => {
    let afterRecordsRead: (() => Promise<void>) | null = null;
    const hooked = {
      idFromName: (name: string) => env.CONTROL_PLANE.idFromName(name),
      get: (id: DurableObjectId) => {
        const real = env.CONTROL_PLANE.get(id) as unknown as Record<string, (...a: unknown[]) => unknown>;
        return new Proxy(real, {
          get: (target, prop) => {
            const value = target[prop as string];
            if (typeof value !== 'function') return value;
            return async (...a: unknown[]) => {
              const result = await target[prop as string]!(...a);
              if (prop === 'switchRecordsOf' && afterRecordsRead) {
                const hook = afterRecordsRead;
                afterRecordsRead = null; // one-shot
                await hook();
              }
              return result;
            };
          },
        });
      },
    } as unknown as DurableObjectNamespace;
    const deployment = {
      position: 'on' as 'on' | 'off',
      calls: [] as ('on' | 'off')[],
      /** Runs inside the next ON move, before it applies. */
      duringOn: null as (() => Promise<void>) | null,
      /** An OFF whose move is reported but does not touch the position: it "landed before" the ON. */
      offMovedEarlier: false,
    };
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: hooked,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      systemSwitchDelegation: {
        // #2045 (Codex r3): a deployment built with the switch fence.
        fenceSupported: async () => true,
        switch: async (a) => {
          deployment.calls.push(a.to);
          if (a.to === 'off' && deployment.offMovedEarlier) return { ...fencedFor(a), held: true, changed: true, permissions: [] };
          if (a.to === 'on' && deployment.duringOn) {
            const hook = deployment.duringOn;
            deployment.duringOn = null;
            await hook();
          }
          const changed = deployment.position !== a.to;
          deployment.position = a.to;
          return { ...fencedFor(a), held: true, changed, permissions: [] };
        },
        status: async () => [{ moduleId: SCHED, schedules: deployment.position }],
      },
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `race-${t.slice(-10).toLowerCase()}`, name: 'Race' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    await host.admin.activateScope(staff, t, s);
    const node = { tenantId: t, scopeId: s };
    // Off, then restored by an operator: record `on`. Then the deployment applies a stale list.
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'incident' });
    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'resolved' });
    deployment.position = 'off';
    deployment.calls.length = 0;
    const staffOff = () => host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'again' }).then(() => undefined);
    const reassert = () =>
      host.admin.reassertSystemSwitches(staff, node, {
        appliedInUnit: [{ moduleId: SCHED, changed: true, permissions: [] }],
      });
    const rows = async () =>
      (await host.admin.auditLog(staff, { scopeId: s, action: ['reassertSystemSwitch'] })).map((e) => e.after as Record<string, unknown>);
    const arm = (hook: () => Promise<void>) => {
      afterRecordsRead = hook;
    };
    return { host, deployment, staffOff, reassert, rows, arm };
  };

  it('an OFF completed after the first record read gets no transient ON: the revert re-reads first', async () => {
    const { deployment, staffOff, reassert, rows, arm } = await setup();
    arm(staffOff); // record `off` (and the deployment already off) before the revert's move
    await reassert();
    expect(deployment.calls).not.toContain('on');
    expect(deployment.position).toBe('off');
    expect(JSON.stringify(await rows())).not.toContain('staleCarry');
  });

  it('an OFF whose record lands during the revert is switched off by the pass after it: the OFF pass re-reads the record', async () => {
    const { deployment, staffOff, reassert, rows } = await setup();
    // The OFF's move lands before the revert's ON (so the ON overrides it) and its record
    // lands before the OFF pass reads the record again.
    deployment.duringOn = async () => {
      deployment.offMovedEarlier = true;
      await staffOff();
      deployment.offMovedEarlier = false;
    };
    await reassert();
    expect(deployment.calls).toEqual(['on', 'off', 'off']);
    expect(deployment.position).toBe('off');
    // One row per move that stood: the revert, then the OFF pass. The deployment's in-unit
    // move was undone by the revert, so it is not credited as an in-unit OFF too.
    expect((await rows()).map((r) => [r.schedules, r.staleCarry ?? null, r.inUnit ?? null])).toEqual([
      ['on', true, null],
      ['off', null, null],
    ]);
  });

  it('twin: with no OFF racing, the revert stands and the module ends ON', async () => {
    const { deployment, reassert, rows } = await setup();
    await reassert();
    expect(deployment.calls).toEqual(['on']);
    expect(deployment.position).toBe('on');
    expect((await rows()).map((r) => r.staleCarry ?? null)).toEqual([true]);
  });
});

/**
 * #1674 review #5, and #1823 — the switch's directory record is written BEFORE the scope
 * moves, both ways, so a failed record write fails the call with nothing moved; the record's
 * UNDO (after a move that threw or held nothing) is retried once, and a failure of both is
 * never swallowed: it lands on the outcome row as `recordError`. The control plane's stub is
 * wrapped so one named method fails a set number of times; every other call goes to the
 * real directory DO (through an arrow on the real stub — never `.bind` on a stub proxy).
 */
describe('#1674 — a failed switch-record write is answered, never swallowed', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');

  const setup = async (method: string, failures: number) => {
    let remaining = failures;
    const flaky = {
      idFromName: (name: string) => env.CONTROL_PLANE.idFromName(name),
      get: (id: DurableObjectId) => {
        const real = env.CONTROL_PLANE.get(id) as unknown as Record<string, (...a: unknown[]) => unknown>;
        return new Proxy(real, {
          get: (target, prop) => {
            if (prop === method && remaining > 0) {
              return async () => {
                remaining--;
                throw new Error('control plane unreachable');
              };
            }
            const value = target[prop as string];
            return typeof value === 'function' ? (...a: unknown[]) => target[prop as string]!(...a) : value;
          },
        });
      },
    } as unknown as DurableObjectNamespace;
    const deployment = {
      position: 'on' as 'on' | 'off',
      fail: false,
      /** Whether the module holds anything on the scope: false, and a move holds nothing. */
      holds: true,
      calls: 0,
      /** #1823: run inside the move — the window between the record write and the scope moving. */
      during: undefined as (() => Promise<void>) | undefined,
    };
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: flaky,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      systemSwitchDelegation: {
        // #2045 (Codex r3): a deployment built with the switch fence.
        fenceSupported: async () => true,
        switch: async (a) => {
          deployment.calls++;
          await deployment.during?.();
          if (deployment.fail) throw new Error('vertical unreachable during system-switch');
          if (!deployment.holds) return { ...fencedFor(a), held: false, changed: false, permissions: [] };
          const changed = deployment.position !== a.to;
          deployment.position = a.to;
          return { ...fencedFor(a), held: true, changed, permissions: [] };
        },
        status: async () => [{ moduleId: SCHED, schedules: deployment.position }],
      },
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `flaky-${t.slice(-10).toLowerCase()}`, name: 'Flaky' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    await host.admin.activateScope(staff, t, s);
    const node = { tenantId: t, scopeId: s };
    const outcomes = async () =>
      (await host.admin.auditLog(staff, { scopeId: s, action: ['revokeFromSystem', 'restoreToSystem'] }))
        .map((e) => e.after as { phase: string; recordError?: string })
        .filter((a) => a.phase !== 'intent');
    const records = () => host.admin.listSystemSwitches(staff, { scopeId: s });
    /** #2045: the subjects this scope still owes a re-assert, read from the directory DO itself. */
    const owed = async () => {
      const cp = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
        switchesOwedOf(kind: 'system', tenantId: string, scopeId: string): Promise<[string, string][]>;
      };
      return cp.switchesOwedOf('system', t, s);
    };
    return { host, node, deployment, outcomes, records, owed };
  };

  it('an OFF whose record write fails moves nothing: the call fails, audited, and a repeat records and moves (#1823)', async () => {
    const { host, node, deployment, outcomes, records } = await setup('recordSwitchedOff', 1);
    const e = await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' }).then(() => null, (x: unknown) => x);
    expect(String(e)).toMatch(/control plane unreachable/);
    expect(deployment.calls).toBe(0);
    expect(deployment.position).toBe('on');
    expect(await records()).toEqual([]);
    expect((await outcomes()).map((o) => o.phase)).toEqual(['failed']);
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    expect(deployment.position).toBe('off');
    expect(await records()).toEqual([expect.objectContaining({ position: 'off' })]);
  });

  it('the record is written before the scope moves: a tenant grant issued in between is refused (#1823)', async () => {
    const { host, node, deployment, records } = await setup('none', 0);
    let during: unknown = 'not reached';
    deployment.during = async () => {
      // Inside the move: the scope has not switched yet, and the record already says off.
      expect(await records()).toEqual([expect.objectContaining({ position: 'off' })]);
      during = await host.admin
        .grantToSystem(staff, {
          moduleId: SCHED,
          permission: permissionKey.parse('sched:tick'),
          node: { tenantId: node.tenantId, scopeId: null },
          grantedBy: staff,
        })
        .then(() => null, (x: unknown) => x);
    };
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    expect(errorCodeOf(during)).toBe('conflict');
    expect(String(during)).toContain(node.scopeId);
  });

  it('an OFF whose move throws twice keeps its record and is owed the re-assert that completes it (#2045)', async () => {
    const { host, node, deployment, outcomes, records } = await setup('none', 0);
    deployment.fail = true;
    await expect(host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' })).rejects.toThrow(/unreachable/);
    expect(deployment.calls).toBe(2); // the move, and its one retry
    expect(await records()).toEqual([expect.objectContaining({ position: 'off' })]);
    expect((await outcomes()).map((o) => [o.phase, (o as { recordKept?: true }).recordKept])).toEqual([['failed', true]]);
    deployment.fail = false;
    await host.admin.reassertSystemSwitches(staff, node);
    expect(deployment.position).toBe('off');
  });

  it('a call that held nothing takes its owed mark back with its undo, in one transaction — no separate clear to fail (#2045)', async () => {
    // A separate clear that failed here would strand the mark for good: the undo puts back the prior
    // call's OLDER operation id, every later re-assert confirms under that fence, and a mark newer
    // than its fence is never cleared, so the scope would be reconciled on every pass.
    const { host, node, deployment, outcomes, records, owed } = await setup('clearSwitchOwed', Infinity);
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'first' });
    const [first] = await records();
    expect(await owed()).toEqual([[SCHED, first!.operationId]]); // the held call's own clear failed: owed
    deployment.holds = false;
    const e = await host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'second' }).then(() => null, (x: unknown) => x);
    expect(errorCodeOf(e)).toBe('not_found');
    expect((await outcomes()).at(-1)).toMatchObject({ phase: 'refused' });
    expect((await outcomes()).at(-1)).not.toHaveProperty('recordError');
    // The record is the first call's again, under its older id. The second call's mark (one row per
    // subject, so it had replaced the first's) went with the undo, though every separate clear fails:
    // left behind, it would sit newer than the fence any re-assert of this record confirms under.
    expect(await records()).toEqual([expect.objectContaining({ position: 'off', reason: 'first', operationId: first!.operationId })]);
    expect(await owed()).toEqual([]);
  });

  it('twin: a call that held something clears its own mark, with nothing to undo (#2045)', async () => {
    const { host, node, owed } = await setup('none', 0);
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    expect(await owed()).toEqual([]);
  });

  it('a failed ON keeps its record too, so no undo is attempted that could fail (#2045)', async () => {
    const { host, node, deployment, outcomes, records } = await setup('restoreSwitchRecord', 2);
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    deployment.fail = true;
    await expect(host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'fixed' })).rejects.toThrow(/unreachable/);
    expect((await outcomes()).map((o) => [o.phase, o.recordError])).toEqual([
      ['applied', undefined],
      ['failed', undefined],
    ]);
    expect(await records()).toEqual([expect.objectContaining({ position: 'on', reason: 'fixed' })]);
  });
});

/**
 * #1674 — the switch record's one-time backfill, on DO SQLite. The kernel test proves the
 * statement on node's SQLite; this proves it where it runs in production (`json_extract` and
 * a window function, inside the directory DO), through the real path that reaches it: a
 * directory restored from a dump taken before the table existed. A fresh DO name is a
 * fresh, isolated directory.
 */
describe('#1674 — the switch record is backfilled from the admin log, once, on DO SQLite', () => {
  type Directory = {
    exportDump(): Promise<{ name: string; ddl: string; columns: string[]; rows: unknown[][] }[]>;
    importDump(tables: unknown[]): Promise<void>;
    listSystemSwitches(filter: object): Promise<{ scopeId: string; moduleId: string; position: string; reason: string }[]>;
  };
  const directory = () => env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`backfill-${ulid()}`)) as unknown as Directory;
  let seq = 0;
  const history = (columns: string[]) => {
    const row = (action: string, scope: string, after: object) => {
      const values: Record<string, unknown> = {
        id: `01BACKFILL${String(++seq).padStart(16, '0')}`,
        actor: 'staff',
        action,
        tenant_id: 'tenant-a',
        scope_id: scope,
        after: JSON.stringify(after),
        at: '2026-09-01T00:00:00.000Z',
      };
      return columns.map((c) => values[c] ?? null);
    };
    const call = (to: 'on' | 'off', scope: string, outcome: string, reason: string) => {
      const action = to === 'off' ? 'revokeFromSystem' : 'restoreToSystem';
      const operationId = `op-${ulid()}`;
      const common = { operationId, moduleId: '@test/sched', schedules: to };
      return [row(action, scope, { ...common, phase: 'intent', reason }), row(action, scope, { ...common, phase: outcome })];
    };
    return [
      ...call('off', 's-latest', 'applied', 'first'),
      ...call('on', 's-latest', 'applied', 'fixed'),
      ...call('off', 's-latest', 'applied', 'again'),
      ...call('off', 's-refused', 'refused', 'typo'),
    ];
  };
  const withHistory = async (keepRecordTable: boolean) => {
    const dir = directory();
    const tables = await dir.exportDump();
    return tables
      .filter((t) => keepRecordTable || t.name !== '_substrat_system_switches')
      .map((t) => (t.name === '_substrat_admin_log' ? { ...t, rows: [...t.rows, ...history(t.columns)] } : t));
  };

  it('a restored directory from before the table gets it backfilled: the latest APPLIED call, never a refused one', async () => {
    const dir = directory();
    await dir.importDump(await withHistory(false));
    expect((await dir.listSystemSwitches({})).map((r) => [r.scopeId, r.position, r.reason])).toEqual([
      ['s-latest', 'off', 'again'],
    ]);
  });

  it('a backfill that fails rolls the whole restore back, and the directory keeps what it held (Copilot review)', async () => {
    const dir = directory();
    // A pre-table dump with a switch row whose payload is not JSON: the backfill's read of
    // `after` fails outright. (#1898: it runs inside the restore's transaction now, since the
    // dump's admin log no longer brings its own DDL, so a renamed column cannot fail it.)
    const tables = (await withHistory(false)).map((t) => {
      if (t.name !== '_substrat_admin_log') return t;
      const at = (c: string) => t.columns.indexOf(c);
      const bad = t.columns.map(() => null as unknown);
      [bad[at('id')], bad[at('actor')], bad[at('action')], bad[at('after')], bad[at('at')]] =
        ['01BACKFILLBAD000000000000000', 'staff', 'revokeFromSystem', 'not json', '2026-09-01T00:00:00.000Z'];
      return { ...t, rows: [...t.rows, bad] };
    });
    const before = await dir.exportDump();
    await expect(() => dir.importDump(tables)).rejects.toThrow(/JSON/i);
    expect(await dir.exportDump()).toEqual(before);
  });

  it('twin: a dump that already carries the table is not backfilled — it runs once, when the table is created', async () => {
    const dir = directory();
    await dir.importDump(await withHistory(true));
    expect(await dir.listSystemSwitches({})).toEqual([]);
  });
});

/**
 * #1666's two write-side guarantees on DO SQLite, each with the one lever a contract suite
 * cannot hold: a newer VERSION of a module (a second facade registering a manifest that
 * declares one more schedule permission — the coordinator's `provisionScope` seats from
 * the facade's registrations), and a grant revoked independently of the switch (a raw
 * K-21 tombstone, since no verb revokes one `system:` grant).
 */
describe('#1666 — OFF holds against a newer version, and ON gives back only what OFF took', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  const hostWith = (mod: typeof scheduleMod) => {
    const h = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    h.registerModule(mod);
    return h;
  };
  /** The same module, one version on: its tick schedule now also declares `sched:admin`. */
  const newer: typeof scheduleMod = {
    ...scheduleMod,
    manifest: {
      ...scheduleMod.manifest,
      schedules: scheduleMod.manifest.schedules!.map((sch, i) =>
        i === 0 ? { ...sch, permissions: [...sch.permissions, permissionKey.parse('sched:admin')] } : sch,
      ),
    },
  };
  const raw = (s: string) =>
    env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as {
      revokeTuple(subject: string, relation: string, object: string, at: string): Promise<boolean>;
      introspectQuery(sql: string): Promise<{ rows: unknown[][] }>;
    };
  const grants = async (s: string): Promise<[string, boolean][]> =>
    (
      await raw(s).introspectQuery(
        `SELECT relation, revoked_at FROM _substrat_tuples WHERE subject = 'system:${SCHED}' AND substr(relation, 1, 8) = 'granted:' ORDER BY relation`,
      )
    ).rows.map((r) => [String(r[0]), r[1] !== null]);
  const newScope = async () => {
    const host = hostWith(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `hold-${t.slice(-10).toLowerCase()}`, name: 'Hold' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    await host.admin.activateScope(staff, t, s);
    return { host, t, s, node: { tenantId: t, scopeId: s } };
  };

  it("a reconcile of a newer version seats none of its new permission while the switch is off — and does, once it is on", async () => {
    const { host, t, s, node } = await newScope();
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    await hostWith(newer).provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    expect(await grants(s)).toEqual([['granted:sched:tick', true]]); // no `sched:admin` at all

    // The twin: restored, the same reconcile seats the new permission live.
    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'r' });
    await hostWith(newer).provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    expect(await grants(s)).toEqual([
      ['granted:sched:admin', false],
      ['granted:sched:tick', false],
    ]);
  });

  it('a grant revoked independently BEFORE the switch stays revoked through OFF and ON; the one OFF took comes back', async () => {
    const { host, s, node } = await newScope();
    await host.admin.grantToSystem(staff, { moduleId: SCHED, permission: permissionKey.parse('sched:admin'), node, grantedBy: staff });
    await raw(s).revokeTuple(`system:${SCHED}`, 'granted:sched:admin', `scope:${s}`, '2026-09-01T00:00:00.000Z');
    expect(await grants(s)).toEqual([
      ['granted:sched:admin', true],
      ['granted:sched:tick', false],
    ]);
    expect((await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'r' })).permissions).toEqual(['sched:tick']);
    expect((await host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'r' })).permissions).toEqual(['sched:tick']);
    expect(await grants(s)).toEqual([
      ['granted:sched:admin', true], // still revoked — ON never widens the system principal
      ['granted:sched:tick', false],
    ]);
  });
});

/**
 * The Cloudflare half of #32 — the same guarantee the pure adapter asserts, on the
 * adapter that is actually deployed. It matters more here: the projection is done
 * by the COORDINATOR after the ScopeDO reports, so a rejected `migrate()` used to
 * skip the write entirely and leave the scope rendering as healthy.
 *
 * Points at BROKEN_SCOPE (worker.ts) — a DO class carrying only the module whose
 * migration cannot apply, since a DO closes over a code-time module set.
 *
 * Lives in THIS file rather than its own: files run one at a time on storage that is never
 * rolled back, and a second test file re-evaluates the worker mid-run, which invalidates
 * every live DO ("worker.ts changed").
 */
describe('migration failure is recorded in the directory', () => {
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.BROKEN_SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    // Default-deny (§4.3): without the grant the module never loads and its
    // migration never runs, so this suite would pass vacuously.
    await host.admin.grantEntitlement(staff, t, 'broken');
    await expect(
      host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' }),
    ).rejects.toThrow(/scope fails closed/);
  });

  afterAll(async () => {
    await host.close();
  });

  it('fails the scope closed rather than serving a half-migrated schema', async () => {
    await expect(host.getScope(alice, t, s)).rejects.toThrow(/scope fails closed/);
  });

  it('records which module@version failed, through the coordinator', async () => {
    const record = await host.admin.getScopeRecord(staff, t, s);
    expect(record?.migrationFailure).not.toBeNull();
    expect(record?.migrationFailure?.version).toBe('@test/broken@0002-broken');
    expect(record?.migrationFailure?.attempts).toBeGreaterThan(0);
  });

  it('projects the count that actually landed, not the pre-attempt value', async () => {
    const record = await host.admin.getScopeRecord(staff, t, s);
    expect(record?.schemaVersion).toBe('1');
  });

  /**
   * The #49 retry affordance, proven at the exact seam the issue named: the
   * ScopeDO memoises its migration promise, and a REJECTED promise stays
   * assigned — so an ordinary wake on a warm instance returns the cached
   * rejection without re-attempting anything. The instance-run counter is the
   * observable that tells the two apart (the directory's `attempts` cannot:
   * the coordinator increments it on cached rejections too).
   */
  it('migrateScope defeats the memoised rejection — a fresh attempt, not the cached one (#49)', async () => {
    interface MigrationProbe {
      migrationAttemptsOnInstance(): Promise<number>;
    }
    const probe = env.BROKEN_SCOPE.get(env.BROKEN_SCOPE.idFromName(s)) as unknown as MigrationProbe;
    const before = await probe.migrationAttemptsOnInstance();
    expect(before).toBeGreaterThan(0);

    // The ordinary wake: rejects, but from the cache — no new run on this instance.
    await expect(host.getScope(alice, t, s)).rejects.toThrow(/scope fails closed/);
    expect(await probe.migrationAttemptsOnInstance()).toBe(before);

    // The sweep's door: clears the latch, actually re-runs, reports structurally.
    const outcome = await host.migrateScope(t, s);
    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { version: '@test/broken@0002-broken' },
    });
    expect(await probe.migrationAttemptsOnInstance()).toBe(before + 1);
  });

  it('each retry advances the directory attempt counter, so the sweep can back off (#49)', async () => {
    const read = async () =>
      (await host.admin.getScopeRecord(staff, t, s))?.migrationFailure?.attempts ?? 0;
    const before = await read();
    expect(before).toBeGreaterThan(0);
    await host.migrateScope(t, s);
    expect(await read()).toBe(before + 1);
  });
});

/**
 * The Cloudflare half of #1589 — and the half the shared contract suite cannot state.
 *
 * `scopeHostContractSuite` asserts the CONTRACT (a restore whose dump omits a module
 * table leaves that table working afterwards), which is what makes the two adapters
 * agree. What it cannot say is WHY this adapter used to break it: `ensureMigrations`
 * memoises its pass in `migrationPromise`, so a WARM ScopeDO kept answering
 * "migrations are done" over a scope whose tables the dump had just dropped — until
 * an eviction or `migrateScope`, neither of which a restore triggers. Dev, CI and
 * self-host are all green on the pure host, which re-reads its applied set on every
 * pass, so nothing but a warm DO reproduces it.
 *
 * `migrationAttemptsOnInstance` is the observable that makes "warm" a fact rather
 * than an assumption, exactly as it is for #49 above: it counts passes on THIS
 * instance. A count that goes 1 → 2 across the restore can only be one instance
 * running a second pass — a DO evicted and reconstructed in between would report 1,
 * its own first.
 *
 * Lives in THIS file for the reason the block above gives: a second test file
 * re-evaluates the worker mid-run and invalidates every live DO, which is the one
 * thing a warm-instance test cannot survive.
 */
describe('a restore forgets the memoised migration pass (#1589)', () => {
  interface MigrationProbe {
    migrationAttemptsOnInstance(): Promise<number>;
  }
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      checker: UNSAFE_allowAllChecker,
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    // Default-deny (§4.3): without the grant `@test/mod` never loads, its migration
    // never runs, and every assertion below would pass over an absent module.
    await host.admin.grantEntitlement(staff, t, 'testmod');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' });
    await host.admin.activateScope(staff, t, s);
  });

  afterAll(async () => {
    await host.close();
  });

  it('re-runs the pass on the SAME instance, so the dump-dropped table comes back', async () => {
    const probe = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as MigrationProbe;
    // Warm it: one real operation, so the pass is memoised before the dump lands.
    const warm = await host.getScope(alice, t, s);
    await warm.invoke('testmod/add', { id: 'before-restore', box: 'b1' });
    const passes = await probe.migrationAttemptsOnInstance();
    expect(passes).toBe(1); // provisioning's pass, and nothing since

    // A targeted repair dump: `@test/mod`'s tables and its journal rows removed,
    // everything else as captured. Both tables go — one migration creates the pair.
    const backup = await host.admin.exportScope(staff, t, s);
    const journal = backup.tables.find((tbl) => tbl.name === '_substrat_migrations')!;
    const moduleCol = journal.columns.indexOf('module_id');
    expect(journal.rows.some((r) => r[moduleCol] === '@test/mod')).toBe(true);
    await host.restoreScope(staff, t, s, {
      ...backup,
      tables: backup.tables
        .filter((tbl) => tbl.name !== 'testmod_items' && tbl.name !== 'testmod_notes')
        .map((tbl) =>
          tbl.name === '_substrat_migrations'
            ? { ...tbl, rows: tbl.rows.filter((r) => r[moduleCol] !== '@test/mod') }
            : tbl,
        ),
    });
    // The restore itself migrates nothing — it only forgets that a pass ever ran.
    expect(await probe.migrationAttemptsOnInstance()).toBe(passes);

    // The next operation is what re-runs it. Pre-fix this threw `no such table:
    // testmod_items`, because the memoised promise answered before the set was read.
    const after = await host.getScope(alice, t, s);
    await after.invoke('testmod/add', { id: 'after-restore', box: 'b1' });
    expect(await after.invoke<{ id: string }[]>('testmod/read-items')).toEqual([
      { id: 'after-restore' },
    ]);
    // …on the instance that had already migrated. A cold one would read 1 here.
    expect(await probe.migrationAttemptsOnInstance()).toBe(passes + 1);
  });
});

/**
 * Scope-local permissions, Phase 1 (docs/architecture/scope-local-permissions.md): the
 * ScopeDO can evaluate a tenant-level role from its OWN projected storage instead
 * of the control-plane DO. This proves the local reader is parity with RPC, that a
 * tombstoned projection stops granting, and — the load-bearing safety property —
 * that flipping a scope to 'local' WITHOUT projecting denies (fail closed), even
 * where the RPC path would have allowed. Lives in this file for the same
 * single-worker reason as the block above.
 */
describe('scope-local permissions — the projected local reader (Phase 1)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const sProj = scopeId.parse(ulid()); // projected → local
  const sEmpty = scopeId.parse(ulid()); // flipped to local with nothing projected
  const alice = principalId.parse(ulid());
  const PERM_ADMIN = permissionKey.parse('perm:admin');
  let host: CloudflareScopeHost;

  const probe = async (scope: typeof sProj): Promise<boolean> =>
    (await (await host.getScope(alice, t, scope)).invoke<{ allowed: boolean }>('perm/probe', { permission: PERM_ADMIN }))
      .allowed;

  interface ProjectionRpc {
    setPermissionSource(source: 'local' | 'control-plane'): Promise<void>;
  }
  const stubOf = (scope: string) => env.SCOPE.get(env.SCOPE.idFromName(scope));
  const projection = (scope: string): ProjectionRpc => stubOf(scope) as unknown as ProjectionRpc;

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'perm'); // default-deny (§4.3)
    for (const s of [sProj, sEmpty]) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t, s);
    }
    // A tenant-level role — lands in the control plane, so it resolves for BOTH
    // scopes over RPC until one is flipped to local.
    await host.admin.defineRole(staff, t, { key: 'admin', permissions: [PERM_ADMIN], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
  });

  afterAll(async () => host.close());

  it('resolves via RPC by default, then identically via the local projection', async () => {
    expect(await probe(sProj)).toBe(true); // RPC baseline

    await seedProjectedRole(stubOf(sProj), t, { key: 'admin', permissions: [PERM_ADMIN], source: 'vertical' });
    await seedProjectedTenantTuple(stubOf(sProj), t, { subject: `principal:${alice}`, relation: 'role:admin', object: `tenant:${t}` });
    await projection(sProj).setPermissionSource('local');
    expect(await probe(sProj)).toBe(true); // now resolved locally — parity
  });

  it('a tombstoned projected role stops granting (K-21)', async () => {
    await tombstoneProjectedRole(stubOf(sProj), t, 'admin', new Date().toISOString());
    expect(await probe(sProj)).toBe(false);
  });

  it('fails closed: local source with nothing projected denies, though RPC would allow', async () => {
    expect(await probe(sEmpty)).toBe(true); // RPC still allows — the role is in the control plane
    await projection(sEmpty).setPermissionSource('local'); // flip WITHOUT projecting
    expect(await probe(sEmpty)).toBe(false); // empty projection ⇒ deny
  });
});

/**
 * Scope-local permissions, Phase 2: with `scopeLocalPermissions` ON, the host
 * PROJECTS a tenant's roles/tuples into its scopes on every tenant-level write and
 * evaluates locally. This exercises the automatic fan-out end to end — including the
 * subtle cases: a tenant role assigned AFTER its scopes exist must still reach them,
 * a membership tombstone must fan out, and `reconcileTenantProjection` must repair a
 * stale scope. (The full permission MODEL is already covered by the RPC contract
 * suite above; this asserts the projection machinery, not the checker algebra.)
 */
describe('scope-local permissions — automatic fan-out on write (Phase 2)', () => {
  let host: CloudflareScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const s2 = scopeId.parse(ulid());
  const alice = principalId.parse(ulid()); // tenant-level admin
  const bob = principalId.parse(ulid()); // scope role at s1 only
  const carol = principalId.parse(ulid()); // org member
  const acme = orgId.parse(ulid());
  const ADMIN = permissionKey.parse('perm:admin');
  const READ = permissionKey.parse('perm:read');

  const probe = async (who: typeof alice, scope: typeof s1, perm: typeof ADMIN): Promise<boolean> =>
    (await (await host.getScope(who, t, scope)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm })).allowed;

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      scopeLocalPermissions: true,
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    // Scopes exist FIRST — so the assignments below must fan OUT into them, the
    // case a "project at provision" alone would miss.
    for (const s of [s1, s2]) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t, s);
    }
    await host.admin.defineRole(staff, t, { key: 'admin', permissions: [ADMIN, READ], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'tech', permissions: [READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
    await host.admin.assignRole(staff, { principalId: bob, roleKey: 'tech', node: { tenantId: t, scopeId: s1 } });
    await host.admin.createOrg(staff, { id: acme, tenantId: t, slug: 'acme', name: 'Acme' });
    await host.admin.addMember(staff, t, carol, acme);
    await host.admin.grantToOrg(staff, acme, READ, { tenantId: t, scopeId: null });
  });

  afterAll(async () => host.close());

  it('does not project into an archived scope', async () => {
    // A tenant-level write fans out to every scope in the tenant. Unfiltered, that
    // included `archived` and `reaped` rows — and a reaped scope's storage was
    // deliberately `deleteAll()`d ("the bytes are gone, so there is no restore",
    // tenancy.ts), so a projection write would recreate storage for a scope the
    // platform believes dead: silently, on every membership change, and unboundedly
    // in the number of apps a tenant has ever archived.
    //
    // Observed through the scope DO directly, because `getScope` fails closed on an
    // archived scope either way — reading its own projected rows is the only way to
    // tell "we did not write" from "we cannot look".
    const dead = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: dead, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, dead);
    await host.admin.archiveScope(staff, t, dead);

    const dave = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: dave, roleKey: 'admin', node: { tenantId: t, scopeId: null } });

    // The live scopes converged…
    expect(await probe(dave, s1, ADMIN)).toBe(true);
    expect(await probe(dave, s2, ADMIN)).toBe(true);

    const tuplesOf = async (scope: string): Promise<string> => {
      const rpc = env.SCOPE.get(env.SCOPE.idFromName(scope)) as unknown as {
        introspectTable(table: string, limit: number, offset: number): Promise<{ rows: unknown[] }>;
      };
      return JSON.stringify((await rpc.introspectTable('_substrat_tenant_tuples', 200, 0)).rows);
    };
    // …and the archived scope did not receive the new principal, while a live one did
    // — the second assertion is what proves the first is about the FILTER rather than
    // about the fan-out having failed everywhere.
    expect(await tuplesOf(s1)).toContain(dave);
    expect(await tuplesOf(dead)).not.toContain(dave);
  });

  it('unarchive refreshes the projection — a revoke that landed while archived holds (#1473)', async () => {
    // The other half of the filter above. An archived scope is skipped by every
    // fan-out, so a tenant-level revoke never reaches its local projection — and an
    // unarchive that only flipped the directory status would put that stale
    // projection back on duty: the revoked principal keeps their access on the
    // revived scope until the next tenant-level write or the reconciliation sweep.
    // Before #1386 every fan-out reached archived scopes, so this window is new.
    const parked = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: parked, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, parked);

    const erin = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: erin, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
    expect(await probe(erin, parked, ADMIN)).toBe(true);

    await host.admin.archiveScope(staff, t, parked);
    // Revoked while archived: the tombstone fans out to the live scopes only.
    await host.admin.unassignRole(staff, { principalId: erin, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
    expect(await probe(erin, s1, ADMIN)).toBe(false);

    await host.admin.unarchiveScope(staff, t, parked);

    // Denied on the revived scope — and the positive control beside it is what proves
    // the denial comes from a REFRESHED projection rather than from an empty one
    // failing closed: alice's tenant-level role was never revoked, and still serves.
    expect(await probe(erin, parked, ADMIN)).toBe(false);
    expect(await probe(alice, parked, ADMIN)).toBe(true);
  });

  it('unarchive through a tenant the scope does not belong to is refused and pins no receipt (#1738)', async () => {
    // A legacy scope (no receipt yet) is where a wrong tenant could otherwise become the
    // scope's first, permanent claim: the URL's tenant reaches `projectScope`, not the record's.
    const legacy = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: legacy, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, legacy);
    await host.admin.archiveScope(staff, t, legacy);
    const receipt = () =>
      runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(legacy)), async (_i, state) =>
        (state.storage.sql.exec(`SELECT value FROM _substrat_meta WHERE key = 'provisioned_for'`).toArray()[0] as { value: string } | undefined)?.value ?? null,
      );
    await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(legacy)), async (_i, state) => {
      state.storage.sql.exec(`DELETE FROM _substrat_meta WHERE key = 'provisioned_for'`);
    });
    const wrong = tenantId.parse(ulid());
    const refusal = await host.admin.unarchiveScope(staff, wrong, legacy).then(() => undefined, (e: unknown) => e);
    expect(errorCodeOf(refusal)).toBe('not_found');
    expect(await receipt()).toBeNull();
    // Nothing was pinned, so the real tenant unarchives it, pins ITS receipt, and its
    // fan-out (which now includes the revived scope) still converges rather than refusing.
    await host.admin.unarchiveScope(staff, t, legacy);
    expect(await receipt()).toBe(t);
    await expect(host.reconcileTenantProjection(t)).resolves.toBeUndefined();
  });

  it('one scope that refuses a projection does not stop its siblings, and the error names it (#1738)', async () => {
    const bad = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: bad, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, bad);
    const setReceipt = (value: string) =>
      runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(bad)), async (_i, state) => {
        state.storage.sql.exec(`INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('provisioned_for', ?)`, value);
      });
    await setReceipt(tenantId.parse(ulid()));
    try {
      const frank = principalId.parse(ulid());
      const e = await host.admin
        .assignRole(staff, { principalId: frank, roleKey: 'admin', node: { tenantId: t, scopeId: null } })
        .then(() => undefined, (x: unknown) => x);
      expect(String((e as Error)?.message)).toContain(bad);
      expect(String((e as Error)?.message)).toContain('not converged');
      // The healthy siblings converged all the same.
      expect(await probe(frank, s1, ADMIN)).toBe(true);
      expect(await probe(frank, s2, ADMIN)).toBe(true);
    } finally {
      await setReceipt(t); // leave the shared fixture as it was found
    }
  });

  it('unarchive holds a revoke that lands BETWEEN its snapshot and the flip (#1473)', async () => {
    // The interleaving a single push-then-flip cannot cover. `projectScope` reads the
    // tenant's state, then writes it; a revoke that commits in between fans out to the
    // scopes live at that moment — and this one is still archived, so its fan-out
    // skips it — and the flip then puts the OLDER snapshot on duty. The revoked
    // principal keeps their access on the revived scope until the next fan-out or the
    // sweep, exactly the window the unarchive refresh was meant to close.
    //
    // Pinned by driving the revoke from inside the gap: a second host over the same
    // DOs, whose control-plane stub runs the revoke the first time `getScopeRecord` is
    // read — which `projectScope` does after its snapshot and before its write.
    const parked = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: parked, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, parked);
    const frank = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: frank, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
    expect(await probe(frank, parked, ADMIN)).toBe(true);
    await host.admin.archiveScope(staff, t, parked);

    let armed = true;
    const real = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as Record<string, unknown>;
    const tapped = new Proxy(real, {
      get(target, prop) {
        if (prop === 'getScopeRecord') {
          return async (...args: unknown[]) => {
            const record = await (target.getScopeRecord as (...a: unknown[]) => Promise<unknown>)(...args);
            if (armed) {
              armed = false;
              // The revoke lands on the directory and fans out — to the live scopes.
              await host.admin.unassignRole(staff, { principalId: frank, roleKey: 'admin', node: { tenantId: t, scopeId: null } });
            }
            return record;
          };
        }
        // Every other method forwards through a closure. Not `.bind`: a property of an
        // RPC stub is itself a pipelined call, so binding it would try to send the
        // stub over the wire.
        const v = Reflect.get(target, prop);
        return typeof v === 'function'
          ? (...args: unknown[]) => (target[prop as string] as (...a: unknown[]) => unknown)(...args)
          : v;
      },
    });
    const racing = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: { idFromName: () => ({}) as never, get: () => tapped as never } as unknown as typeof env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      scopeLocalPermissions: true,
    });
    try {
      await racing.admin.unarchiveScope(staff, t, parked);
    } finally {
      await racing.close();
    }
    expect(armed).toBe(false); // the revoke really ran inside the gap
    expect(await probe(frank, s1, ADMIN)).toBe(false);
    // Denied on the revived scope too — the post-flip refresh caught the revoke the
    // first snapshot predated. The positive control is the same as above.
    expect(await probe(frank, parked, ADMIN)).toBe(false);
    expect(await probe(alice, parked, ADMIN)).toBe(true);
  });

  it('refuses a projection that arrives AFTER the scope was reaped', async () => {
    // The residual race the status filter alone cannot close: fan-out selects live
    // scopes, then writes, and a reap can land between the two. The selected scope
    // was legitimately live when chosen, so the projection is already in flight when
    // its bytes are destroyed — and `destroyStorage` is `deleteAll()`, which leaves a
    // DO indistinguishable from a fresh one. Without a fence the late write silently
    // recreates storage for a scope the platform believes gone.
    const doomed = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: doomed, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, doomed);

    const rpc = env.SCOPE.get(env.SCOPE.idFromName(doomed)) as unknown as {
      destroyStorage(): Promise<void>;
      applyProjection(
        tenantId: string,
        roles: { role_key: string; permissions: string; source: string }[],
        tuples: unknown[],
      ): Promise<void>;
      introspectTable(table: string, limit: number, offset: number): Promise<{ rows: unknown[] }>;
    };

    // The reap happens, then the in-flight projection lands.
    await rpc.destroyStorage();
    await rpc.applyProjection(t, [{ role_key: 'admin', permissions: '["perm:admin"]', source: 'vertical' }], []);

    // Dropped, not applied — and the observation is stronger than an empty table:
    // the table does not EXIST. `deleteAll()` took it, and the refused projection
    // did not bring it back, so the scope's storage stays genuinely destroyed
    // rather than resurrected holding the tenant's roles, tuples and identity links.
    await expect(() => rpc.introspectTable('_substrat_roles', 200, 0)).rejects.toThrow(/unknown table/);
  });

  it('a tenant role fans out to scopes that already existed when it was assigned', async () => {
    expect(await probe(alice, s1, ADMIN)).toBe(true);
    expect(await probe(alice, s2, ADMIN)).toBe(true);
  });

  it('a scope role stays confined to its scope', async () => {
    expect(await probe(bob, s1, READ)).toBe(true);
    expect(await probe(bob, s2, READ)).toBe(false);
  });

  it('org membership + an org grant fan out (rule 4)', async () => {
    expect(await probe(carol, s1, READ)).toBe(true);
  });

  // #2526 review: the tenant-level connection grant fanned out nothing, unlike `grant`, `grantToOrg`
  // and `grantToSystem`, so a projected scope lacked it until a reconcile. Its twin: one at a scope
  // node projects no tenant tuple.
  it.each([
    ['the tenant node', null, [{ relation: 'granted:perm:read' }]],
    ['a scope node', 's1', []],
  ] as const)('a connection grant at %s projects its tenant tuple into the scopes as it should', async (_where, at, projected) => {
    const conn = connectionId.parse(ulid());
    await host.admin.createConnection(staff, { id: conn, tenantId: t, vertical: 'perm-vertical', provider: `fan-${conn.toLowerCase()}`,
      label: 'Fan-out provider', secret: { accessToken: 'tok' }, scopes: [] });
    await host.admin.grantToConnection(staff, { connectionId: conn, permission: READ, node: { tenantId: t, scopeId: at ? s1 : null }, grantedBy: staff });
    for (const s of [s1, s2]) {
      expect(await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_, state) => state.storage.sql.exec(
        'SELECT relation FROM _substrat_tenant_tuples WHERE subject = ? AND revoked_at IS NULL', `connection:${conn}`,
      ).toArray())).toEqual(projected);
    }
  });

  it('revoking a membership fans the tombstone out — access stops', async () => {
    await host.admin.removeMember(staff, t, carol, acme);
    expect(await probe(carol, s1, READ)).toBe(false);
  });

  it('projects a connection\'s PUBLIC sealing key, and a scope seals to it (#687)', async () => {
    // The whole carrier on the DO adapter, end to end: the platform mints the
    // keypair in the directory, projects only the public half into the scope, module
    // code seals to it without any control-plane binding, and the connector opens the
    // envelope with a private half that never left the directory.
    //
    // This is the shape a hosted vertical runs — the scope reads its own storage and
    // nothing else — and it is the only way a scope can hand a connector a value the
    // spine must not carry in the clear.
    const conn = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: conn,
      tenantId: t,
      vertical: 'perm-vertical',
      provider: 'sealed-provider',
      label: 'Sealed provider',
      secret: { accessToken: 'tok' },
      scopes: [],
    });
    // Any tenant-level write fans out; this is the explicit form of the same thing.
    await host.reconcileTenantProjection(t);

    const scope = await host.getScope(alice, t, s1);
    const sealed = await scope.invoke<{ keyId: string; ciphertext: string }>(
      'perm/seal-to-connection',
      { provider: 'sealed-provider', plaintext: 'anna@kund.se' },
    );
    // It names the key that opens it — a cell that cannot is a cell that can never
    // be rotated retroactively.
    expect(sealed.keyId).toContain(conn);
    expect(sealed.ciphertext).not.toContain('anna@kund.se');

    // And only the private half opens it, from where a connector runs.
    const opened = await host.admin.connectionSealingKey(conn);
    expect(opened.keyId).toBe(sealed.keyId);
    let unsealed: string | undefined;
    host.registerConnector('sealed-reader', 'perm.acted', async (ctx) => {
      const c = await ctx.connection('sealed-provider');
      unsealed = await c.unseal(sealed);
    });
    // Any emit will do — what is under test is the connector's side of the seam,
    // reached the way every connector is reached: a delivered event.
    await scope.invoke('perm/authorized-emit', { permission: ADMIN });
    await host.drainDue(t, s1);
    expect(unsealed).toBe('anna@kund.se');
  });

  it('refuses to seal for a provider whose key never reached the scope (#687)', async () => {
    // The deploy-order hazard, fail-closed: between projecting a key and the vertical
    // asking for one, a request must break loudly rather than emit with the value
    // silently dropped — which is the invisible failure the carrier exists to end.
    const scope = await host.getScope(alice, t, s1);
    await expect(
      scope.invoke('perm/seal-to-connection', { provider: 'never-connected', plaintext: 'x' }),
    ).rejects.toThrow(/no 'never-connected' sealing key is available/);
  });

  it('reconcileTenantProjection repairs a scope whose projection drifted', async () => {
    // Simulate a dropped fan-out by wiping s2's projection directly.
    const stub = env.SCOPE.get(env.SCOPE.idFromName(s2)) as unknown as {
      applyProjection(tenantId: string, roles: unknown[], tuples: unknown[]): Promise<void>;
    };
    await stub.applyProjection(t, [], []);
    expect(await probe(alice, s2, ADMIN)).toBe(false); // stale → denies
    await host.reconcileTenantProjection(t);
    expect(await probe(alice, s2, ADMIN)).toBe(true); // repaired
  });
});

/**
 * Scope-local permissions, Phase 3: a host with NO control plane — a scope-local /
 * untrusted vertical. It provisions via `provisionScopeLocal` (grant the owner at
 * scope level + project the role defs) and serves entirely from the scope's own
 * storage. The null-object control plane no-ops the router-gated hot path
 * (validateScopeAccess / entitlement / audit) and throws for the admin surface it
 * genuinely lacks.
 */
describe('scope-local permissions — a CP-less host (Phase 3)', () => {
  let host: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const stranger = principalId.parse(ulid());
  const ADMIN = permissionKey.parse('perm:admin');
  const READ = permissionKey.parse('perm:read');

  const probe = async (who: typeof owner, perm: typeof ADMIN): Promise<boolean> =>
    (await (await host.getScope(who, t, s)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm })).allowed;

  beforeAll(async () => {
    // No `controlPlane` — the host runs on the null-object stand-in.
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [ADMIN, READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  });

  afterAll(async () => host.close());

  it("serves the owner's permission from the scope alone — no control plane, entitlement trusted", async () => {
    expect(await probe(owner, ADMIN)).toBe(true);
    expect(await probe(owner, READ)).toBe(true);
  });

  it('denies a stranger (fail closed), still with no control plane', async () => {
    expect(await probe(stranger, ADMIN)).toBe(false);
  });

  it('assignScopeRole grants an invited member the role’s permissions — scope-local, no CP', async () => {
    // The member half of the invite flow: a newly-invited principal, granted the role at
    // scope level, resolves that role's permissions from the scope's own storage.
    const member = principalId.parse(ulid());
    expect(await probe(member, ADMIN)).toBe(false); // no grant yet
    await host.assignScopeRole(s, member, 'office-admin');
    expect(await probe(member, ADMIN)).toBe(true); // now holds the role's perms
    expect(await probe(member, READ)).toBe(true);
    expect(await probe(stranger, READ)).toBe(false); // an un-granted principal is still denied
  });

  it('assignScopeRole to a role the scope never projected grants nothing (fail closed)', async () => {
    const member = principalId.parse(ulid());
    await host.assignScopeRole(s, member, 'not-a-projected-role');
    expect(await probe(member, READ)).toBe(false);
  });

  it('revokeScopeRole takes the role back — the next check is denied (#1161)', async () => {
    const member = principalId.parse(ulid());
    await host.assignScopeRole(s, member, 'office-admin');
    expect(await probe(member, ADMIN)).toBe(true);
    expect(await host.revokeScopeRole(s, member, 'office-admin')).toBe(true);
    expect(await probe(member, ADMIN)).toBe(false);
    expect(await probe(member, READ)).toBe(false);
    // The owner's own seat is untouched — the tombstone is one (principal, role) row.
    expect(await probe(owner, ADMIN)).toBe(true);
  });

  it('revokeScopeRole twice is idempotent — the second is a silent no-op', async () => {
    const member = principalId.parse(ulid());
    await host.assignScopeRole(s, member, 'office-admin');
    expect(await host.revokeScopeRole(s, member, 'office-admin')).toBe(true);
    expect(await host.revokeScopeRole(s, member, 'office-admin')).toBe(false);
    expect(await probe(member, READ)).toBe(false);
  });

  it('revokeScopeRole on a never-assigned role is a no-op, not an error', async () => {
    const member = principalId.parse(ulid());
    expect(await host.revokeScopeRole(s, member, 'office-admin')).toBe(false);
    expect(await host.revokeScopeRole(s, member, 'not-a-projected-role')).toBe(false);
    expect(await probe(member, READ)).toBe(false);
  });

  it('assignScopeRole after revokeScopeRole grants again — the tombstone is replaced', async () => {
    const member = principalId.parse(ulid());
    await host.assignScopeRole(s, member, 'office-admin');
    await host.revokeScopeRole(s, member, 'office-admin');
    expect(await probe(member, ADMIN)).toBe(false);
    await host.assignScopeRole(s, member, 'office-admin');
    expect(await probe(member, ADMIN)).toBe(true);
    expect(await probe(member, READ)).toBe(true);
  });

  it('revokeScopeRole takes back ONE role — a second role the member holds survives', async () => {
    // A projected reader role beside office-admin, so the revoke has a sibling to leave alone.
    const scope = scopeId.parse(ulid());
    const member = principalId.parse(ulid());
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: scope,
      owner,
      roles: [
        { key: 'office-admin', permissions: [ADMIN, READ], source: 'vertical' },
        { key: 'reader', permissions: [READ], source: 'vertical' },
      ],
      ownerRoleKey: 'office-admin',
    });
    const probeIn = async (perm: typeof ADMIN): Promise<boolean> =>
      (await (await host.getScope(member, t, scope)).invoke<{ allowed: boolean }>('perm/probe', { permission: perm })).allowed;
    await host.assignScopeRole(scope, member, 'office-admin');
    await host.assignScopeRole(scope, member, 'reader');
    expect(await probeIn(ADMIN)).toBe(true);
    expect(await host.revokeScopeRole(scope, member, 'office-admin')).toBe(true);
    expect(await probeIn(ADMIN)).toBe(false); // office-admin is gone
    expect(await probeIn(READ)).toBe(true); // reader still holds READ
  });

  it('the admin directory surface throws — it genuinely has no control plane', async () => {
    await expect(
      host.admin.createTenant(platformActorId.parse(ulid()), { id: t, slug: `x-${t.toLowerCase()}`, name: 'X' }),
    ).rejects.toThrow(/control plane unavailable/);
  });
});

/**
 * #461: declared schedules must run on a CP-less host. Two seams, both pinned here:
 * `provisionScopeLocal` projects the `system:<moduleId>` grants (the CP-less mirror of
 * `provisionScope`'s loop — without it the grant-is-the-switch check reports `fired: 0`
 * forever, indistinguishable from "nothing due"), and `runDueSchedules` runs without
 * the directory liveness read a CP-less host cannot answer.
 */
describe('CP-less schedules — declared schedules run without a control plane (#461)', () => {
  let host: CloudflareScopeHost;
  const SCHED = moduleId.parse('@test/sched');
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const READ = permissionKey.parse('perm:read');

  beforeAll(async () => {
    // No `controlPlane` — the null-object stand-in, exactly the hosted-vertical shape.
    host = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  });

  afterAll(async () => host.close());

  it('fires the due schedule from the projected grant alone — no directory, no error', async () => {
    const report = await host.runDueSchedules(SCHED, t, s);
    expect(report.errors).toEqual([]);
    // Two: `sched/tick`, and #1288's collision fixture `freshness:sched.ticked`.
    expect(report.fired).toBe(2);
    // The tick really landed in the scope, attributed to the module, not a person.
    const stub = await host.getScope(owner, t, s);
    expect(await stub.invoke('sched/count')).toBe(1);
    const outbox = (await stub.invoke('sched/read-outbox')) as { type: string; actor: string }[];
    const tick = outbox.find((r) => r.type === 'sched.ticked');
    expect(tick).toBeDefined();
    expect(JSON.parse(tick!.actor)).toEqual({ system: '@test/sched' });
  });

  it('cadence still gates the second pass — skipped, not re-fired', async () => {
    const report = await host.runDueSchedules(SCHED, t, s);
    expect(report.fired).toBe(0);
    expect(report.skipped).toBe(2);
  });

  it('ctx.check stays the gate — the system door is refused an unscheduled permission', async () => {
    // `sched:admin` is declared but never scheduled, so the projection grants the
    // system principal `sched:tick` only — same lever as the CP-full suite.
    const sys = await host.getSystemScope(SCHED, t, s);
    await expect(sys.invoke('sched/needs-admin')).rejects.toThrow();
  });
});

/**
 * #1742 — the hosted half of the kill switch's re-assert, on the host a vertical's own
 * deployment runs: no control plane, the switch in this DO. A wiped scope's reconcile
 * re-seats the module's `system:` grants (#1659), and the platform's re-assert used to
 * follow as a second call, so this deployment's own sweeper could fire the module in
 * between. The platform now carries the record's off list into the call, and the seat's
 * unit switches those modules off before anything can run.
 *
 * Every assertion that matters is the pass run IMMEDIATELY after the call, with no
 * re-assert in between: that pass is the sweep that used to land in the window.
 */
describe('#1742 — a wiped scope is switched off inside the unit that re-seats it (CP-less)', () => {
  const SCHED = moduleId.parse('@test/sched');
  const NOT_HELD = moduleId.parse('@test/not-held');
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const READ = permissionKey.parse('perm:read');
  const roles: RoleDefinition[] = [{ key: 'office-admin', permissions: [READ], source: 'vertical' }];

  /** A deployment's host; `withSchedules: false` is a version that does not ship the module. */
  const deployment = (withSchedules = true) => {
    const h = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    if (withSchedules) h.registerModule(scheduleMod);
    return h;
  };
  const host = deployment();
  afterAll(async () => host.close());

  /** The reconcile's kernel half, as `/internal/reconcile` calls it. */
  const reconcile = (s: ScopeId, extra: { switchedOff?: ModuleId[]; tenantHeld?: ModuleId[] } = {}, on = host) =>
    on.provisionScopeLocal({ tenantId: t, scopeId: s, owner, roles, ownerRoleKey: 'office-admin', ...extra });
  const newScope = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await reconcile(s);
    return s;
  };
  const off = (s: ScopeId) => host.systemSwitchLocal(s, SCHED, 'off');
  /** The scope's storage, gone: an empty restore re-asserts the bare spine (#321). */
  const wipe = (s: ScopeId) => host.restoreScopeLocal(s, []);
  const pass = (s: ScopeId) => host.runDueSchedules(SCHED, t, s);
  const tookBack = { moduleId: SCHED, held: true, changed: true, permissions: ['sched:tick'], deniesTenantGrants: true };

  // #1823: a module whose only authority on the scope is a TENANT-level grant has nothing here
  // for the in-unit OFF to find. The platform names it in `tenantHeld`, and the unit holds it.
  // Read IMMEDIATELY after the call, before any re-assert: that is the window the carry closes.
  const TENANT_ONLY = moduleId.parse('@test/tenant-only');
  const tenantOnlyOff = { moduleId: TENANT_ONLY, held: true, changed: true, permissions: [], deniesTenantGrants: true };
  const offIn = async (s: ScopeId) =>
    (await host.systemGrantsStatusLocal(s)).filter((e) => e.moduleId === TENANT_ONLY).map((e) => e.schedules);

  it('a reconcile carrying tenantHeld switches a tenant-only module off in its own unit (#1823)', async () => {
    const s = await newScope();
    expect(await reconcile(s, { switchedOff: [TENANT_ONLY], tenantHeld: [TENANT_ONLY] })).toEqual({
      switchedOff: [tenantOnlyOff],
    });
    expect(await offIn(s)).toEqual(['off']);
  });

  it('twin: the same carry without tenantHeld holds nothing for that module, and writes nothing (#1823)', async () => {
    const s = await newScope();
    expect(await reconcile(s, { switchedOff: [TENANT_ONLY] })).toEqual({
      switchedOff: [{ moduleId: TENANT_ONLY, held: false, changed: false, permissions: [], deniesTenantGrants: true }],
    });
    expect(await offIn(s)).toEqual([]);
  });

  it('a restore carrying tenantHeld lands the tenant-only module off in the replay (#1823)', async () => {
    const s = await newScope();
    const before = await host.exportScopeLocal(s);
    expect(await host.restoreScopeLocal(s, before, { switchedOff: [TENANT_ONLY], tenantHeld: [TENANT_ONLY] })).toMatchObject({
      switchedOff: [tenantOnlyOff],
    });
    expect(await offIn(s)).toEqual(['off']);
  });

  it('a wiped scope reconciled WITH its off list runs nothing on the very next pass, and ON gives back what the unit took', async () => {
    const s = await newScope();
    await off(s);
    await wipe(s);
    expect(await host.systemGrantsStatusLocal(s)).toEqual([]); // the marker is gone with the storage

    expect(await reconcile(s, { switchedOff: [SCHED] })).toEqual({ switchedOff: [tookBack] });
    expect(await pass(s)).toMatchObject({ fired: 0, skipped: 2, failed: 0, switchedOff: true });
    expect(await host.systemGrantsStatusLocal(s)).toEqual([{ moduleId: SCHED, schedules: 'off' }]);

    // The grants the seat re-created are exactly what OFF recorded, so ON returns them.
    expect(await host.systemSwitchLocal(s, SCHED, 'on')).toEqual({
      held: true,
      changed: true,
      permissions: ['sched:tick'],
      deniesTenantGrants: true,
    });
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  it('the same reconcile WITHOUT the field fires on that pass — the window the post-call re-assert is the fallback for', async () => {
    const s = await newScope();
    await off(s);
    await wipe(s);
    expect(await reconcile(s)).toEqual({});
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  it("the list reaches only the scope being reconciled: another scope's module still fires", async () => {
    const a = await newScope();
    const b = await newScope();
    await off(a);
    await wipe(a);
    await reconcile(a, { switchedOff: [SCHED] });
    await reconcile(b); // b was never switched off, and reconciles with no list
    expect(await pass(a)).toMatchObject({ fired: 0, switchedOff: true });
    expect(await host.systemGrantsStatusLocal(b)).toEqual([{ moduleId: SCHED, schedules: 'on' }]);
    expect(await pass(b)).toMatchObject({ fired: 2, failed: 0 });
  });

  it('a live marker is left alone: the list re-asserts, it never double-moves', async () => {
    const s = await newScope();
    await off(s);
    // Not wiped: the marker survived, so the seat seated nothing and the unit moves nothing.
    expect(await reconcile(s, { switchedOff: [SCHED, SCHED] })).toEqual({
      switchedOff: [{ moduleId: SCHED, held: true, changed: false, permissions: [], deniesTenantGrants: true }],
    });
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it('a module the deployment does not ship is held: false and plants no marker — and is switched off in the reconcile that first seats it', async () => {
    const s = scopeId.parse(ulid());
    const older = deployment(false);
    // A version without the module: its seat holds nothing for it, so OFF writes nothing.
    expect(await reconcile(s, { switchedOff: [SCHED, NOT_HELD] }, older)).toEqual({
      switchedOff: [
        { moduleId: SCHED, held: false, changed: false, permissions: [], deniesTenantGrants: true },
        { moduleId: NOT_HELD, held: false, changed: false, permissions: [], deniesTenantGrants: true },
      ],
    });
    expect(await host.systemGrantsStatusLocal(s)).toEqual([]);
    // The version that ships it arrives. Its first seat creates the grants, and the same
    // unit switches them off, so the module never runs on this scope, not even once.
    expect(await reconcile(s, { switchedOff: [SCHED] })).toEqual({ switchedOff: [tookBack] });
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
    await older.close();
  });

  it('a module added later with nothing recorded off still fires — the twin: no marker was planted', async () => {
    const s = scopeId.parse(ulid());
    const older = deployment(false);
    await reconcile(s, { switchedOff: [NOT_HELD] }, older);
    await reconcile(s);
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
    await older.close();
  });

  /**
   * #1742 review: the switch runs inside the replay's own transaction. A switch that throws
   * part-way through a restore must roll the whole restore back rather than commit the dump's
   * live grants with no switch over them. Outside the transaction, the replay committed first
   * and the throw came after it.
   *
   * A dump cannot make the switch throw any more: it used to carry a CHECK on
   * `_substrat_tuples`, and since #1883 that table is built from KERNEL_DDL. So the fault is
   * injected at the switch's own write instead: this scope's DO instance refuses the OFF
   * marker for as long as `refuseMarker`'s undo has not run.
   */
  const refuseMarker = async (s: ScopeId): Promise<() => Promise<void>> => {
    const stub = () => env.SCOPE.get(env.SCOPE.idFromName(s));
    await runInDurableObject(stub(), (instance) => {
      const target = instance as unknown as { switchSql(): SwitchSql };
      const real = target.switchSql.bind(target);
      target.switchSql = () => {
        const sql = real();
        return {
          all: sql.all,
          run: (q, ...params) => {
            if (params.includes('switch:off')) throw new Error('the OFF marker was refused (test fault)');
            sql.run(q, ...params);
          },
        };
      };
    });
    return () =>
      runInDurableObject(stub(), (instance) => {
        delete (instance as unknown as { switchSql?: unknown }).switchSql;
      });
  };

  it('a switch that fails inside a restore rolls the whole restore back: the scope stays off', async () => {
    const s = await newScope();
    const before = await host.exportScopeLocal(s);
    await off(s);
    const undo = await refuseMarker(s);
    try {
      await expect(host.restoreScopeLocal(s, before, { switchedOff: [SCHED] })).rejects.toThrow(
        /the OFF marker was refused \(test fault\)/,
      );
    } finally {
      await undo();
    }
    // Nothing of the dump landed: the marker the scope had is still live.
    expect(await host.systemGrantsStatusLocal(s)).toEqual([{ moduleId: SCHED, schedules: 'off' }]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it('twin: under the same fault, a restore with nothing to switch lands, and fires', async () => {
    const s = await newScope();
    const before = await host.exportScopeLocal(s);
    await off(s);
    const undo = await refuseMarker(s);
    try {
      expect(await host.restoreScopeLocal(s, before)).toEqual({ tables: before.length });
    } finally {
      await undo();
    }
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  /**
   * #1742 review round 2: the spine re-assert runs inside the replay's `storage.transaction`. A
   * dump from before #1288 used to be replayed as the old table and rebuilt there in a nested
   * `transactionSync`. Since #1883 the table is built from KERNEL_DDL and each row's `kind` is
   * derived as it goes in, so no rebuild runs (the wake-time rebuild has its own test in
   * `schedule-invocation-column.test.ts`). This holds the rest: an old dump restores, its row
   * is carried with `kind`, and the switch in the same transaction holds.
   */
  const pre1288 = (dump: Awaited<ReturnType<CloudflareScopeHost['exportScopeLocal']>>) =>
    dump.map((tbl) =>
      tbl.name === '_substrat_schedule_state'
        ? {
            name: tbl.name,
            ddl: 'CREATE TABLE _substrat_schedule_state (schedule_op TEXT PRIMARY KEY, last_run_at TEXT, last_status TEXT)',
            columns: ['schedule_op', 'last_run_at', 'last_status'],
            // Ran two hours ago, so with a 60-minute cadence it is due again.
            rows: [['sched/tick', new Date(Date.now() - 2 * 3_600_000).toISOString(), 'ok']],
          }
        : tbl,
    );
  const scheduleState = async (s: ScopeId) =>
    (await (await host.getScope(owner, t, s)).invoke('sched/schedule-state')) as { kind: string; schedule_op: string }[];

  it('a pre-#1288 dump restores inside the transaction: its row gets kind, and the switch holds', async () => {
    const s = await newScope();
    const old = pre1288(await host.exportScopeLocal(s));
    expect(old.some((tbl) => tbl.name === '_substrat_schedule_state')).toBe(true);
    await off(s);
    expect(await host.restoreScopeLocal(s, old, { switchedOff: [SCHED] })).toMatchObject({ switchedOff: [tookBack] });
    expect(await scheduleState(s)).toEqual([expect.objectContaining({ kind: 'schedule', schedule_op: 'sched/tick' })]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it('twin: the same pre-#1288 dump with no list restores, and fires', async () => {
    const s = await newScope();
    const old = pre1288(await host.exportScopeLocal(s));
    await off(s);
    await host.restoreScopeLocal(s, old);
    expect(await scheduleState(s)).toEqual([expect.objectContaining({ kind: 'schedule', schedule_op: 'sched/tick' })]);
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  it('a restore of a dump from before the switch lands off when the off list rides it; without it, it fires', async () => {
    const s = await newScope();
    const before = await host.exportScopeLocal(s);
    await off(s);
    const restored = await host.restoreScopeLocal(s, before, { switchedOff: [SCHED] });
    expect(restored).toEqual({ tables: before.length, switchedOff: [tookBack] });
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });

    const twin = await newScope();
    const beforeTwin = await host.exportScopeLocal(twin);
    await host.systemSwitchLocal(twin, SCHED, 'off');
    expect(await host.restoreScopeLocal(twin, beforeTwin)).toEqual({ tables: beforeTwin.length });
    expect(await pass(twin)).toMatchObject({ fired: 2, failed: 0 });
  });
});

/**
 * #1742 on the CP-full host, for a scope whose store is this host's own (bound to no
 * vertical). The provision's seat and the restore's replay now switch the recorded-off
 * modules off in their own DO unit; the re-assert after them finds nothing to move. What
 * tells the two apart from outside is the audit row: only an in-unit move is marked
 * `inUnit`, so a seat or replay that stopped switching (leaving the window to the re-assert
 * after it) turns these red even though the end state is the same.
 */
describe('#1742 — the CP-full seat and restore switch off in their own unit', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  host.registerModule(scheduleMod);
  const t = tenantId.parse(ulid());
  beforeAll(async () => {
    await host.admin.createTenant(staff, { id: t, slug: `unit-${t.slice(-10).toLowerCase()}`, name: 'Unit' });
    await host.admin.grantEntitlement(staff, t, 'sched');
  });
  afterAll(async () => host.close());

  const newScope = async () => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    return s;
  };
  const off = (s: ScopeId) =>
    host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'incident' });
  const reasserts = async (s: ScopeId) =>
    (await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['reassertSystemSwitch'] })).map((e) => e.after);
  const inUnit = expect.objectContaining({ moduleId: SCHED, changed: true, inUnit: true, permissions: ['sched:tick'] });

  it("a wiped scope's re-provision switches the module off in the seat's unit", async () => {
    const s = await newScope();
    await off(s);
    await host.restoreScope(staff, t, s, { tenantId: t, scopeId: s, capturedAt: new Date().toISOString(), tables: [], stores: [] });
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    expect(await reasserts(s)).toEqual([inUnit]);
    expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it("a restore from before the switch switches the module off in the replay's event", async () => {
    const s = await newScope();
    const before = await host.admin.exportScope(staff, t, s);
    await off(s);
    await host.restoreScope(staff, t, s, before);
    expect(await reasserts(s)).toEqual([inUnit]);
    expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it('twin: a scope never switched off provisions and restores with no re-assert at all, and fires', async () => {
    const s = await newScope();
    const before = await host.admin.exportScope(staff, t, s);
    await host.restoreScope(staff, t, s, before);
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    expect(await reasserts(s)).toEqual([]);
    expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 2, failed: 0 });
  });
});

/**
 * #1819 — a PITR rewind to a bookmark from before the kill switch was pulled. The rewound
 * storage has the module's `system:` grants live and no OFF marker, and nothing re-asserts the
 * switch until the platform's next reconcile. The rewind now holds the scope's OFF modules on
 * `SWITCH_HOLDS_NAME`, outside the object it rewinds, and the pass skips a held module.
 *
 * The rewind is EMULATED (`pitr-emulation.ts`): workerd has no PITR. The DO's real
 * `rewindToBookmark` runs, and so does the restart it causes; the rewound bytes are a dump from
 * before the switch, written into the restarted object with no host code in between.
 */
// Every rewind settles before it rewinds. The hosts settle on `TEST_HOLD_SNAPSHOT_MS`; one case runs
// the production values.
describe('#1819 — a PITR rewind to before the switch runs nothing until the switch is back', () => {
  const SCHED = moduleId.parse('@test/sched');
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const READ = permissionKey.parse('perm:read');
  const roles: RoleDefinition[] = [{ key: 'office-admin', permissions: [READ], source: 'vertical' }];

  /**
   * A deployment's host over `ns` (the scope namespace, or a counting wrapper of it). `timing: {}`
   * builds it as production does, with the default hold timing.
   */
  const deployment = (
    ns: DurableObjectNamespace = env.SCOPE,
    timing: { switchHoldSnapshotMs?: number } = { switchHoldSnapshotMs: TEST_HOLD_SNAPSHOT_MS },
  ) => {
    const h = new CloudflareScopeHost({ scope: ns, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)), ...timing });
    h.registerModule(scheduleMod);
    return h;
  };
  const host = deployment();
  afterAll(async () => host.close());

  const reconcile = (s: ScopeId, extra: { switchedOff?: ModuleId[] } = {}) =>
    host.provisionScopeLocal({ tenantId: t, scopeId: s, owner, roles, ownerRoleKey: 'office-admin', ...extra });
  const newScope = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await reconcile(s);
    return s;
  };
  const off = (s: ScopeId) => host.systemSwitchLocal(s, SCHED, 'off');
  /** A fresh host each pass, the way the sweeper builds one per pass. */
  const pass = (s: ScopeId, on = deployment()) => on.runDueSchedules(SCHED, t, s);
  const holdsStub = () => holdsOf(env.SCOPE);
  const heldOn = async (s: ScopeId) =>
    (await holdsStub().switchHoldsAll()).filter((h) => h.scopeId === s).map((h) => h.moduleId);
  /** The claims on this scope's SCHED rows. */
  const claimsOn = async (s: ScopeId) => (await holdsStub().switchHoldClaims(s)).filter((c) => c.moduleId === SCHED);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A claim written the way a rewind writes one: with a token read just before. */
  const claim = async (s: ScopeId, moduleIds: string[], claimId: string) =>
    holdsStub().switchHoldClaim(s, moduleIds, claimId, await holdsStub().switchHoldToken());
  /**
   * #1839 review: a rewind whose steps the test places, instead of sleeping a fraction of the
   * settle. It runs on a counting host and stops at its `read`-th status read of the scope (the
   * capture is the first, the re-check after the settle the second): `before` that read, or just
   * `after` it, before it claims what it read. `paused` resolves there, and it goes on at `resume()`.
   */
  const gatedRewind = (s: ScopeId, at: 'before' | 'after' = 'before', read = 2) => {
    const rewinder = countingScopes(env.SCOPE);
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    rewinder.aroundStatusRead = async (n, phase) => {
      if (n !== read || phase !== at) return;
      reached();
      await gate;
    };
    const rewinding = deployment(rewinder.ns).rewindScopeLocal(s, 'bm', { force: true });
    return { rewinder, rewinding, paused, resume };
  };

  /** Switch off (or not), then rewind to a bookmark taken before that (the whole issue). */
  const rewoundPastTheSwitch = async (
    switchOff = true,
    beforeBookmark?: (s: ScopeId) => Promise<unknown>,
    by = host,
  ): Promise<ScopeId> => {
    const s = await newScope();
    await beforeBookmark?.(s);
    const atBookmark = await host.exportScopeLocal(s);
    if (switchOff) await off(s);
    await armRewind(env.SCOPE, s);
    expect(await by.rewindScopeLocal(s, 'bm-before-switch', { force: true })).toEqual({
      rewindingTo: 'bm-before-switch',
    });
    await landRewind(env.SCOPE, s, atBookmark);
    // The rewound storage really has the switch undone: this is the state the issue is about.
    expect(await host.systemGrantsStatusLocal(s)).toEqual([{ moduleId: SCHED, schedules: 'on' }]);
    return s;
  };

  it('every pass stays off until re-assert; OFF clears the hold and ON resumes the schedules', async () => {
    const s = await rewoundPastTheSwitch();
    expect(await heldOn(s)).toEqual([SCHED]);
    for (let i = 0; i < 3; i++) {
      expect(await pass(s)).toMatchObject({ fired: 0, skipped: 2, failed: 0, errors: [], switchedOff: true });
    }
    // `/internal/system-switch`'s far end, which the platform's re-assert lands on.
    expect(await off(s)).toEqual({ held: true, changed: true, permissions: ['sched:tick'], deniesTenantGrants: true });
    expect(await heldOn(s)).toEqual([]);
    expect(await host.systemGrantsStatusLocal(s)).toEqual([{ moduleId: SCHED, schedules: 'off' }]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
    // And the lever still works: ON brings the schedules back.
    await host.systemSwitchLocal(s, SCHED, 'on');
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  it('twin: nothing recorded off — the rewind holds nothing, and the next pass fires', async () => {
    const s = await rewoundPastTheSwitch(false);
    expect(await heldOn(s)).toEqual([]);
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  /**
   * #1834: a resumable job run acts through the same system door as a schedule, and the door is
   * what gates now — its state read, then the hold, then every call pinned to the instance that
   * read came from. The job's tick is `sched/tick`, which the scope's seated `system:` grant allows.
   */
  const RACE_LEASE_MS = 1_000;
  const jobDeployment = (ns: DurableObjectNamespace = env.SCOPE) => {
    const h = deployment(ns);
    h.registerJob(
      SCHED,
      'tick',
      async (p: JobPassContext) => {
        const scope = await p.scope();
        await p.step('tick', () => scope.invoke('sched/tick'));
        return { done: true };
      },
      { maxAttempts: 3, baseDelayMs: 0 },
    );
    // A run that never opens the door: on a held scope it has nothing to wait for.
    h.registerJob(SCHED, 'idle', () => ({ done: true }));
    // #2034: the same, counted, on a short lease with runner headroom.
    // `maxAttempts: 1`, so a claim wrongly charged an attempt would end the run before it ran (#2042 r2).
    h.registerJob(SCHED, 'brief', () => ((briefPasses += 1), { done: true }), { maxAttempts: 1 }, { leaseMs: RACE_LEASE_MS });
    // #2028 review: a handler that KEEPS the door's refusal and throws it again on a later pass,
    // raw or (with `inStep`) as the step's wrapper the driver handed back.
    h.registerJob(
      SCHED,
      'hoard',
      async (p: JobPassContext) => {
        const { inStep } = p.payload as { inStep: boolean };
        if (hoarded) throw hoarded;
        const scope = await p.scope();
        try {
          if (inStep) await p.step('tick', () => scope.invoke('sched/tick'));
          else await scope.invoke('sched/tick');
        } catch (err) {
          hoarded = err;
          throw err;
        }
        return { done: true };
      },
      { maxAttempts: 3, baseDelayMs: 0 },
    );
    return h;
  };
  let hoarded: unknown = null;
  let briefPasses = 0;
  /** The deferral's deadline, passed: each waiting run on the scope became due just now. */
  const deadlinePassed = (s: ScopeId) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE _substrat_job_runs SET next_attempt_at = ? WHERE status = 'running' AND next_attempt_at IS NOT NULL`,
        new Date().toISOString(),
      );
    });
  /** The deferral's wait, skipped: every running run on the scope is due now. */
  const dueNow = (s: ScopeId) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_instance, state) => {
      state.storage.sql.exec(`UPDATE _substrat_job_runs SET next_attempt_at = NULL WHERE status = 'running'`);
    });
  // Workerd's DO clock and the runner can advance independently while an RPC is held.
  const waitPastBriefLease = () =>
    new Promise<void>((resolve) => setTimeout(resolve, RACE_LEASE_MS + 500));
  /** The ticks the scope's storage holds: what actually ran through the door. */
  const ticksIn = async (s: ScopeId) =>
    (await host.exportScopeLocal(s)).find((table) => table.name === 'sched_ticks')?.rows.length ?? 0;
  const startTick = (s: ScopeId) => jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'tick', instance: 'one', payload: {} });
  const runOf = async (s: ScopeId, id: string) => (await host.jobRuns(t, s)).find((r) => r.id === id);

  it('a job run of a held module is refused at the system door and kept, and runs once the switch is back', async () => {
    let runId = '';
    const s = await rewoundPastTheSwitch(true, async (sc) => (runId = (await startTick(sc)).id));
    expect(await heldOn(s)).toEqual([SCHED]);
    // Before any reconcile: the pass reaches the door, the door says wait, and nothing ticks. The
    // pass is DEFERRED, as a held schedule is skipped: no attempt is spent and no error recorded,
    // so drives past the job's whole budget (3) still leave it running. Each deferral makes the run
    // due again only after `JOB_DEFER_MS`, which `dueNow` skips here.
    for (let i = 0; i < 4; i += 1) {
      const before = Date.now();
      expect(await jobDeployment().runDueJobs(t, s)).toMatchObject({
        attempted: 1, deferred: 1, completed: 0, advanced: 0, failed: 0, retrying: 0, errors: [],
      });
      const waiting = await runOf(s, runId);
      expect(waiting).toMatchObject({ status: 'running', attempts: 0, lastError: null });
      expect(Date.parse(waiting!.nextAttemptAt!)).toBeGreaterThanOrEqual(before + JOB_DEFER_MS);
      expect((await jobDeployment().runDueJobs(t, s)).attempted).toBe(0); // not due until then
      await dueNow(s);
    }
    expect(await ticksIn(s)).toBe(0);
    // The schedules, unchanged: skipped on the same hold.
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });

    // ON is the operator's newer word: the hold goes, and the same run's next pass ticks and completes.
    await host.systemSwitchLocal(s, SCHED, 'on');
    await dueNow(s);
    expect(await jobDeployment().runDueJobs(t, s)).toMatchObject({ completed: 1, errors: [] });
    expect(await runOf(s, runId)).toMatchObject({ status: 'done' });
    expect(await ticksIn(s)).toBe(1);
  });

  /**
   * #1834 review: a waiting run must not take the turn of one behind it. The due order is by id, so
   * an older held run would head every drive; its deferral makes it ineligible for `JOB_DEFER_MS`.
   */
  it('an older held run does not starve a later run, even one run per drive', async () => {
    let heldId = '';
    const s = await rewoundPastTheSwitch(true, async (sc) => (heldId = (await startTick(sc)).id));
    const later = await jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'idle', instance: 'later', payload: {} });
    expect(later.id > heldId).toBe(true); // older by id AND by start: it heads the first drive
    expect(await jobDeployment().runDueJobs(t, s, { limit: 1 })).toMatchObject({ attempted: 1, deferred: 1 });
    // Its deadline passes: both are due now, and the held one became due LAST, so it queues behind.
    await deadlinePassed(s);
    expect(await jobDeployment().runDueJobs(t, s, { limit: 1 })).toMatchObject({ attempted: 1, completed: 1, deferred: 0 });
    expect(await runOf(s, later.id)).toMatchObject({ status: 'done' });
    expect(await runOf(s, heldId)).toMatchObject({ status: 'running', attempts: 0 });
    // …and with nothing ahead of it, the held run (still past its deadline) has its turn, and waits again.
    expect(await jobDeployment().runDueJobs(t, s, { limit: 1 })).toMatchObject({ attempted: 1, deferred: 1 });
  });

  /**
   * #2028 review r3: one snapshot per drive, each row claimed before it runs (#2034), on the DO. Between the
   * snapshot and the claims, where another writer can move rows, one picked run is moved past now and one unpicked
   * run becomes due. The moved one is skipped and runs on the next drive; the newly due one is not
   * lost, the next drive runs it; nothing runs twice.
   */
  it('a drive acts on its one snapshot, claiming each run before it runs it', async () => {
    const s = await newScope();
    const start = (instance: string) =>
      jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'idle', instance, payload: {} });
    const a = await start('a');
    const b = await start('b');
    const c = await start('c');
    const setNext = (id: string, at: string | null) =>
      runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_instance, state) => {
        state.storage.sql.exec('UPDATE _substrat_job_runs SET next_attempt_at = ? WHERE id = ?', at, id);
      });
    await setNext(c.id, new Date(Date.now() + 3_600_000).toISOString()); // not due at the snapshot
    const counting = countingScopes(env.SCOPE);
    let moves = 0;
    counting.afterDueKeys = async () => {
      if (moves++ > 0) return;
      await setNext(b.id, new Date(Date.now() + 3_600_000).toISOString()); // picked, then moved past now
      await setNext(c.id, null); // unpicked, then due
    };
    const h = jobDeployment(counting.ns);
    expect(await h.runDueJobs(t, s, { limit: 2 })).toMatchObject({ attempted: 1, completed: 1 });
    expect(await runOf(s, a.id)).toMatchObject({ status: 'done' });
    expect(await runOf(s, b.id)).toMatchObject({ status: 'running', attempts: 0 });
    expect(await runOf(s, c.id)).toMatchObject({ status: 'running', attempts: 0 });
    // The next drive: C, due since the last snapshot, runs; B once its wait is over.
    expect(await h.runDueJobs(t, s, { limit: 2 })).toMatchObject({ attempted: 1, completed: 1 });
    expect(await runOf(s, c.id)).toMatchObject({ status: 'done' });
    await setNext(b.id, null);
    expect(await h.runDueJobs(t, s, { limit: 2 })).toMatchObject({ attempted: 1, completed: 1 });
    expect(await runOf(s, b.id)).toMatchObject({ status: 'done' });
  });

  /**
   * #2034 (#2042 review r1): a claim's answer that comes back after its lease ran out is not
   * begun. The claim is written in the DO; before its answer reaches the drive, the lease
   * expires and another drive takes the run over and finishes it. The late drive runs nothing.
   */
  it('#2034: a claim answered after its lease ran out runs nothing; another drive has the run', async () => {
    const s = await newScope();
    briefPasses = 0;
    const run = await jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'brief', instance: 'late', payload: {} });
    const counting = countingScopes(env.SCOPE);
    let rival: unknown = null;
    counting.afterJobClaim = async () => {
      counting.afterJobClaim = null;
      await waitPastBriefLease();
      rival = await jobDeployment().runDueJobs(t, s);
    };
    expect(await jobDeployment(counting.ns).runDueJobs(t, s)).toMatchObject({ attempted: 0, superseded: 1, completed: 0 });
    expect(rival).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
    expect(briefPasses).toBe(1);
    // The late claim never began its pass, so the takeover cost nothing (#2042 r2).
    expect(await runOf(s, run.id)).toMatchObject({ status: 'done', leaseOwner: null, attempts: 0, lastError: null });
  });

  it('#2034: a claim answered with too little of its lease left enters nothing, and releases the run', async () => {
    const s = await newScope();
    briefPasses = 0;
    const run = await jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'brief', instance: 'thin', payload: {} });
    const counting = countingScopes(env.SCOPE);
    counting.afterJobClaim = async () => {
      counting.afterJobClaim = null;
      // Still its own lease, but its reply left less than the margin of it: the drive does not begin.
      await new Promise((resolve) => setTimeout(resolve, RACE_LEASE_MS * 0.85));
    };
    expect(await jobDeployment(counting.ns).runDueJobs(t, s)).toMatchObject({ attempted: 0, superseded: 1 });
    expect(briefPasses).toBe(0);
    expect(await runOf(s, run.id)).toMatchObject({ status: 'running', attempts: 0, admissionMisses: 1, leaseOwner: null });
    // Released after its admission backoff (skipped here); the next drive runs it, even on `maxAttempts: 1`.
    await dueNow(s);
    expect(await jobDeployment().runDueJobs(t, s)).toMatchObject({ attempted: 1, completed: 1 });
    expect(briefPasses).toBe(1);
    expect(await runOf(s, run.id)).toMatchObject({ status: 'done', admissionMisses: 0 });
  });

  /**
   * #2034 (#2042 review r3, r4): BEGIN is judged by the DO's clock as it runs. Here the BEGIN RPC is
   * held in transit until the lease is over; the DO then refuses to stamp it, whether or not a
   * rival took the run over meanwhile.
   */
  it('#2034: a BEGIN delayed past its lease stamps nothing, and a rival runs the run once', async () => {
    const s = await newScope();
    briefPasses = 0;
    const run = await jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'brief', instance: 'late-entry', payload: {} });
    const counting = countingScopes(env.SCOPE);
    let rival: unknown = null;
    counting.beforeJobBegin = async () => {
      counting.beforeJobBegin = null;
      await waitPastBriefLease();
      rival = await jobDeployment().runDueJobs(t, s);
    };
    expect(await jobDeployment(counting.ns).runDueJobs(t, s)).toMatchObject({ attempted: 0, superseded: 1 });
    expect(counting.jobBeginAnswers).toEqual([false]);
    expect(rival).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
    expect(briefPasses).toBe(1);
    expect(await runOf(s, run.id)).toMatchObject({ status: 'done', attempts: 0 });
  });

  it('#2034: a BEGIN delayed past its lease with no rival is refused by the DO itself', async () => {
    const s = await newScope();
    briefPasses = 0;
    const run = await jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'brief', instance: 'late-alone', payload: {} });
    const counting = countingScopes(env.SCOPE);
    counting.beforeJobBegin = async () => {
      counting.beforeJobBegin = null;
      await waitPastBriefLease();
    };
    expect(await jobDeployment(counting.ns).runDueJobs(t, s)).toMatchObject({ attempted: 0, superseded: 1 });
    // Still the claim's own lease, so only the DO's own clock can have refused the stamp.
    expect(counting.jobBeginAnswers).toEqual([false]);
    expect(briefPasses).toBe(0);
    expect(await runOf(s, run.id)).toMatchObject({ status: 'running', attempts: 0, leaseOwner: null });
  });

  /**
   * #2034 (#2042 review r3): a run whose every claim comes back too late is not claimed forever.
   * Each miss is counted on the row and backs the next claim off (the waits are skipped here), and
   * at JOB_ADMISSION_MISS_MAX it fails, its lease too short for where it runs.
   */
  it('#2034: consecutive admission misses back off, then fail the run, lease too short', async () => {
    const s = await newScope();
    briefPasses = 0;
    const run = await jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'brief', instance: 'always-late', payload: {} });
    const counting = countingScopes(env.SCOPE);
    counting.afterJobClaim = () => new Promise((resolve) => setTimeout(resolve, RACE_LEASE_MS * 0.85));
    const h = jobDeployment(counting.ns);
    for (let miss = 1; miss < JOB_ADMISSION_MISS_MAX; miss += 1) {
      const before = Date.now();
      expect(await h.runDueJobs(t, s)).toMatchObject({ attempted: 0, superseded: 1, failed: 0 });
      const row = await runOf(s, run.id);
      expect(row).toMatchObject({ status: 'running', attempts: 0, admissionMisses: miss, leaseOwner: null });
      expect(Date.parse(row!.nextAttemptAt!)).toBeGreaterThanOrEqual(before + admissionBackoffMs(miss));
      await dueNow(s);
    }
    const last = await h.runDueJobs(t, s);
    expect(last).toMatchObject({ attempted: 0, failed: 1 });
    expect(last.errors[0]!.error).toContain(JOB_LEASE_TOO_SHORT_NOTE);
    expect(await runOf(s, run.id)).toMatchObject({
      status: 'failed',
      attempts: 0,
      admissionMisses: JOB_ADMISSION_MISS_MAX,
      lastError: expect.stringContaining(`leaseMs ${RACE_LEASE_MS}`),
    });
    expect(briefPasses).toBe(0);
    // JOB_ADMISSION_MISS_MAX claims, each held 0.85 × RACE_LEASE_MS: ~8.5 s of deliberate waiting.
  });

  it('#2034: twin — a BEGIN resets the admission misses', async () => {
    const s = await newScope();
    briefPasses = 0;
    const run = await jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'brief', instance: 'late-then-prompt', payload: {} });
    const counting = countingScopes(env.SCOPE);
    counting.afterJobClaim = () => new Promise((resolve) => setTimeout(resolve, RACE_LEASE_MS * 0.85));
    for (let i = 0; i < 3; i += 1) {
      await jobDeployment(counting.ns).runDueJobs(t, s);
      await dueNow(s);
    }
    expect(await runOf(s, run.id)).toMatchObject({ admissionMisses: 3 });
    counting.afterJobClaim = null;
    expect(await jobDeployment(counting.ns).runDueJobs(t, s)).toMatchObject({ attempted: 1, completed: 1 });
    expect(await runOf(s, run.id)).toMatchObject({ status: 'done', admissionMisses: 0 });
    expect(briefPasses).toBe(1);
  });

  it("#2034: the DO's miss counts relatively, by its own clock, and BEGIN clears the count", async () => {
    const s = await newScope();
    const run = await jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'brief', instance: 'reset', payload: {} });
    type Store = {
      jobRunClaim(id: string, owner: string, leaseMs: number): Promise<unknown>;
      jobRunBegin(id: string, owner: string, marginMs: number): Promise<boolean>;
      jobRunMiss(id: string, owner: string, note: string): Promise<{ misses: number; failed: boolean } | null>;
    };
    const stub = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as Store;
    const due = () => dueNow(s);
    for (const [owner, expected] of [['a', 1], ['b', 2], ['c', 3]] as const) {
      expect(await stub.jobRunClaim(run.id, owner, 60_000)).not.toBeNull();
      expect(await stub.jobRunMiss(run.id, owner, 'slow')).toEqual({ misses: expected, failed: false });
      await due();
    }
    // A miss by a claim that no longer holds the run writes nothing.
    expect(await stub.jobRunMiss(run.id, 'c', 'stale')).toBeNull();
    expect(await runOf(s, run.id)).toMatchObject({ admissionMisses: 3, leaseOwner: null });
    expect(await stub.jobRunClaim(run.id, 'd', 60_000)).not.toBeNull();
    expect(await stub.jobRunBegin(run.id, 'd', 1_000)).toBe(true);
    expect(await runOf(s, run.id)).toMatchObject({ admissionMisses: 0, leaseOwner: 'd' });
    // Begun: a miss is refused — the pass is committed.
    expect(await stub.jobRunMiss(run.id, 'd', 'late')).toBeNull();
  });

  it('#2034: twin — a claim answered in time runs its pass once', async () => {
    const s = await newScope();
    briefPasses = 0;
    await jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'brief', instance: 'prompt', payload: {} });
    const counting = countingScopes(env.SCOPE);
    expect(await jobDeployment(counting.ns).runDueJobs(t, s)).toMatchObject({ attempted: 1, completed: 1, superseded: 0 });
    expect(briefPasses).toBe(1);
  });

  /**
   * #2034 (#2042 review r1): a coordinator from before leases, in a deploy's overlap with this DO,
   * drives nothing. Its drive is replayed here call for call against the real DO: #2028's (due keys,
   * then a re-read it runs without claiming) and #1834's predecessor's (due rows, run as read). Both
   * re-reads are fenced, so neither drive has a row to run — with a claim holding the run, and with
   * the run due and unclaimed.
   */
  it('#2034: a pre-lease coordinator drives nothing against this DO, claimed or not; the new one drives', async () => {
    const s = await newScope();
    type Legacy = {
      jobRunsDueKeys(now: string, max: number): Promise<{ id: string }[]>;
      jobRunById(id: string): Promise<{ status: string; next_attempt_at: string | null } | null>;
      jobRunsDue(now: string, limit: number): Promise<unknown[]>;
    };
    const legacy = () => env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as Legacy;
    /** What an old drive would have run: every row its own reads handed it as running and due. */
    const oldDrive = async () => {
      const now = new Date().toISOString();
      const keys = await legacy().jobRunsDueKeys(now, 500);
      let runnable = 0;
      for (const key of keys) {
        const row = await legacy().jobRunById(key.id);
        if (row && row.status === 'running' && (row.next_attempt_at === null || row.next_attempt_at <= now)) runnable += 1;
      }
      runnable += (await legacy().jobRunsDue(now, 50)).length;
      return { keys: keys.length, runnable };
    };
    const run = await jobDeployment().startJobRun(t, s, { moduleId: SCHED, job: 'idle', instance: 'legacy', payload: {} });
    // Due and unclaimed: the old drive sees the key — it is the fence, not the snapshot, that stops it.
    expect(await oldDrive()).toEqual({ keys: 1, runnable: 0 });
    // Claimed: a new drive holds it, mid-pass.
    const counting = countingScopes(env.SCOPE);
    let during: unknown = null;
    counting.afterJobClaim = async () => {
      counting.afterJobClaim = null;
      during = await oldDrive();
    };
    expect(await jobDeployment(counting.ns).runDueJobs(t, s)).toMatchObject({ attempted: 1, completed: 1 });
    expect(during).toEqual({ keys: 0, runnable: 0 });
    expect(await runOf(s, run.id)).toMatchObject({ status: 'done' });
  });

  /** #2028 review: the due order is served by its own index on the DO's SQLite, with no sort step. */
  it('the due read seeks _substrat_job_runs_due_at and sorts nothing', async () => {
    const s = await newScope();
    const plan = await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_instance, state) =>
      state.storage.sql
        .exec(
          `EXPLAIN QUERY PLAN SELECT * FROM _substrat_job_runs
            WHERE status = 'running' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
              AND (? IS NULL OR ${JOB_RUN_DUE_AT} > ? OR (${JOB_RUN_DUE_AT} = ? AND id > ?))
            ORDER BY ${JOB_RUN_DUE_AT}, id LIMIT ?`,
          '2026-01-01T00:00:00.000Z', null, null, null, null, 50,
        )
        .toArray()
        .map((r) => String(r.detail)),
    );
    expect(plan.join(' | ')).toMatch(/USING INDEX _substrat_job_runs_due_at/);
    expect(plan.join(' | ')).not.toMatch(/TEMP B-TREE/);
  });

  /**
   * #2028 review: a mark proves the door threw it, and only for the pass it threw on. A handler that
   * keeps a real refusal from a hold and throws it again after the switch is back gets no wait out
   * of it: that pass counts, as any failure does — raw, or as the step wrapper the driver gave it.
   */
  for (const inStep of [false, true]) {
    it(`a door refusal kept and thrown again on a later pass is an ordinary failure there${inStep ? ' (from a step)' : ''}`, async () => {
      hoarded = null;
      let runId = '';
      const h = jobDeployment(); // ONE host for every pass: its marks are what a stale throw would reuse
      const s = await rewoundPastTheSwitch(true, async (sc) =>
        (runId = (await h.startJobRun(t, sc, { moduleId: SCHED, job: 'hoard', instance: 'keep', payload: { inStep } })).id),
      );
      // The real refusal, during the hold: deferred, and the handler keeps it.
      expect(await h.runDueJobs(t, s)).toMatchObject({ deferred: 1, retrying: 0 });
      expect(hoarded).not.toBeNull();
      // The switch is back, and the handler throws the same object again.
      await host.systemSwitchLocal(s, SCHED, 'on');
      await dueNow(s);
      expect(await h.runDueJobs(t, s)).toMatchObject({ deferred: 0, retrying: 1 });
      expect(await runOf(s, runId)).toMatchObject({ status: 'running', attempts: 1, lastError: expect.stringMatching(/held off/) });
      hoarded = null;
    });
  }

  it('twin: nothing recorded off — the rewound job run passes the door and completes', async () => {
    let runId = '';
    const s = await rewoundPastTheSwitch(false, async (sc) => (runId = (await startTick(sc)).id));
    expect(await jobDeployment().runDueJobs(t, s)).toMatchObject({ attempted: 1, completed: 1, errors: [] });
    expect(await runOf(s, runId)).toMatchObject({ status: 'done' });
    expect(await ticksIn(s)).toBe(1);
  });

  /**
   * #1834's own argument: a pass opens the door once and then runs for as long as it runs. A door
   * opened BEFORE the rewind gated pre-rewind storage, and its hold read predates the hold. The
   * pin is what stops it: the rewound scope is a new instance, so the call is refused as moved,
   * gated again, and that gate sees the hold. No clock is involved.
   */
  it('a system door opened before the rewind refuses a call that lands after it', async () => {
    const s = await newScope();
    const atBookmark = await host.exportScopeLocal(s);
    const door = await host.getSystemScope(SCHED, t, s); // gated now: on, not held
    await off(s);
    await armRewind(env.SCOPE, s);
    await host.rewindScopeLocal(s, 'bm-before-switch', { force: true });
    await landRewind(env.SCOPE, s, atBookmark);
    await expect(door.invoke('sched/tick')).rejects.toMatchObject({
      code: 'forbidden',
      extensions: { reason: SYSTEM_DOOR_WAIT },
      message: expect.stringMatching(/held off on this scope/),
    });
    expect(await ticksIn(s)).toBe(0);
  });

  it('twin: nothing recorded off — the same door re-gates the restarted scope and the call runs', async () => {
    const s = await newScope();
    const atBookmark = await host.exportScopeLocal(s);
    const door = await host.getSystemScope(SCHED, t, s);
    await armRewind(env.SCOPE, s);
    await host.rewindScopeLocal(s, 'bm', { force: true });
    await landRewind(env.SCOPE, s, atBookmark);
    await door.invoke('sched/tick');
    expect(await ticksIn(s)).toBe(1);
  });

  it("a module's attachment open goes through the same door, and a held module's is refused", async () => {
    // A bucket is resolved before any open; none is read, since nothing here gets that far.
    const h = new CloudflareScopeHost({
      scope: env.SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      attachmentBuckets: () => ({}),
      switchHoldSnapshotMs: TEST_HOLD_SNAPSHOT_MS,
    });
    h.registerModule(scheduleMod);
    const held = await rewoundPastTheSwitch();
    const surface = await h.getSystemAttachments(SCHED, t, held);
    await expect(surface.open('no-such-attachment')).rejects.toThrow(/held off on this scope/);
    // Twin: a scope nothing holds answers the open (here: nothing to open).
    const free = await newScope();
    expect(await (await h.getSystemAttachments(SCHED, t, free)).open('no-such-attachment')).toBeNull();
  });

  it('a scope that keeps restarting under the door fails closed after a bounded number of gates', async () => {
    const s = await newScope();
    const moving = countingScopes(env.SCOPE);
    const h = deployment(moving.ns);
    moving.movingInstance = true;
    const door = await h.getSystemScope(SCHED, t, s);
    const refused = await door.invoke('sched/tick').then(() => null, (err: unknown) => err);
    expect(String(refused)).toMatch(/kept restarting under the system door/);
    expect(refused).toMatchObject({ code: 'unavailable', extensions: { reason: SYSTEM_DOOR_WAIT } });
    // The door's own gate, then one more per refusal, up to the bound — and no further.
    expect(moving.doorGates).toBe(1 + SYSTEM_DOOR_REGATES);
    expect(await ticksIn(s)).toBe(0);
    // The schedule pass, on the same scope, fails closed the same way rather than firing.
    moving.doorGates = 0;
    expect(await h.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 0, failed: 2 });
    expect(moving.doorGates).toBe(1 + 2 * SYSTEM_DOOR_REGATES); // the pass's gate, then each fire's re-gates
    expect(await ticksIn(s)).toBe(0);
    // Twin: the same host, once the instance holds still, runs the same call.
    moving.movingInstance = false;
    await (await h.getSystemScope(SCHED, t, s)).invoke('sched/tick');
    expect(await ticksIn(s)).toBe(1);
  });

  /**
   * #1834: the door is the only way in, on the wire too. The DO acts as `system:<moduleId>` only
   * for a call carrying the instance a door's gate read — so a new host path that reached the DO
   * with a module and no door would be refused here, whatever the host-side types allowed.
   */
  it('a system-subject call that reaches the DO without the door is refused; with the pin it runs', async () => {
    const s = await newScope();
    const raw = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as {
      invoke(...args: unknown[]): Promise<{ failure?: { message: string; code?: string } }>;
      systemAttachmentAuthorize(...args: unknown[]): Promise<unknown>;
      systemDoorState(moduleId: string): Promise<{ state: string; instance: string }>;
    };
    const asModule = (pin?: string) =>
      raw.invoke('sched/tick', undefined, SCHED, t, s, undefined, undefined, SCHED, true, undefined, undefined, undefined, undefined, pin);
    expect((await asModule()).failure).toMatchObject({
      code: 'forbidden',
      extensions: { reason: SYSTEM_DOOR_WAIT },
      message: expect.stringMatching(/without passing the system door/),
    });
    await expect(() => raw.systemAttachmentAuthorize('no-such-attachment', SCHED, t, s)).rejects.toThrow(/without passing the system door/);
    expect(await ticksIn(s)).toBe(0);
    // Twin: pinned to the serving instance, the same call runs.
    const { instance } = await raw.systemDoorState(SCHED);
    expect((await asModule(instance)).failure).toBeUndefined();
    expect(await raw.systemAttachmentAuthorize('no-such-attachment', SCHED, t, s, instance)).toBeNull();
    expect(await ticksIn(s)).toBe(1);
  });

  /**
   * #1834 review: "moved" is an answer only the DO's pin check gives, never read from an error's
   * text. An operation failing with the very words of the old refusal reaches its caller as itself,
   * after ONE invocation: no re-gate, no re-invoke, no `unavailable` in its place.
   */
  it("an operation's error that reads like a moved pin is its own failure, after one invocation", async () => {
    const s = await newScope();
    const counting = countingScopes(env.SCOPE);
    const door = await deployment(counting.ns).getSystemScope(SCHED, t, s);
    const gatesBefore = counting.doorStateReads;
    counting.invokes = 0;
    const text = "system door moved: the scope restarted after the system door's gate read it; gate it again";
    const refused = await door.invoke('sched/fail', { message: text }).then(() => null, (err: unknown) => err);
    expect(String(refused)).toContain(text);
    expect(errorCodeOf(refused)).not.toBe('unavailable');
    expect(counting.invokes).toBe(1);
    expect(counting.doorStateReads).toBe(gatesBefore); // never gated again
  });

  it("the hold is this scope's only: another scope's module still fires while it holds", async () => {
    const held = await rewoundPastTheSwitch();
    const other = await newScope();
    const h = deployment();
    expect(await pass(held, h)).toMatchObject({ fired: 0, switchedOff: true });
    expect(await pass(other, h)).toMatchObject({ fired: 2, failed: 0 });
  });

  it('the hold survives the restart the rewind causes, and a restart of the object holding it', async () => {
    const s = await rewoundPastTheSwitch(); // `landRewind` waited out the scope's own restart
    await runInDurableObject(holdsOf(env.SCOPE) as unknown as DurableObjectStub, (_i, state) => {
      state.abort('restart the hold object');
    }).catch(() => undefined);
    expect(await heldOn(s)).toEqual([SCHED]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it("an operator's ON clears the hold: the module fires on the next pass", async () => {
    const s = await rewoundPastTheSwitch();
    expect(await host.systemSwitchLocal(s, SCHED, 'on')).toMatchObject({ held: true });
    expect(await heldOn(s)).toEqual([]);
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  it('a reconcile carrying the off list leaves no gap, and the re-assert after it clears the hold', async () => {
    const s = await rewoundPastTheSwitch();
    await reconcile(s, { switchedOff: [SCHED] });
    // #1742 still holds: switched off in the reconcile's own unit, so the very next pass is off.
    expect(await host.systemGrantsStatusLocal(s)).toEqual([{ moduleId: SCHED, schedules: 'off' }]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
    // The in-unit move does not release (its answer names no instance); the platform's
    // re-assert right after the call does.
    expect(await heldOn(s)).toEqual([SCHED]);
    await off(s);
    expect(await heldOn(s)).toEqual([]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it('twin: a reconcile with no list leaves the hold, so the pass still fires nothing', async () => {
    const s = await rewoundPastTheSwitch();
    await reconcile(s);
    expect(await heldOn(s)).toEqual([SCHED]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it('a restore carrying the off list leaves no gap, and the re-assert after it clears the hold', async () => {
    const s = await rewoundPastTheSwitch();
    await host.restoreScopeLocal(s, await host.exportScopeLocal(s), { switchedOff: [SCHED] });
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
    expect(await heldOn(s)).toEqual([SCHED]);
    await off(s);
    expect(await heldOn(s)).toEqual([]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  /**
   * Copilot review on #1838: a release has to be ordered against the rewind. A switch move that
   * lands in storage the rewind will discard must not release the hold, or the rewind restores
   * live grants with nothing holding them.
   */
  it('an OFF during the settle releases nothing: after the rewind lands, the next pass still fires nothing', async () => {
    const s = await newScope();
    const atBookmark = await host.exportScopeLocal(s);
    await off(s);
    await armRewind(env.SCOPE, s);
    const r = gatedRewind(s);
    await r.paused;
    // A repeated OFF inside the settle: the scope holds its grants, but the write is in the
    // pre-rewind storage, and the claim is still pending.
    expect(await off(s)).toMatchObject({ held: true });
    expect(await heldOn(s)).toEqual([SCHED]);
    r.resume();
    await r.rewinding;
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
    // The first re-assert AFTER the rewind landed is what clears it.
    await off(s);
    expect(await heldOn(s)).toEqual([]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  /**
   * #1839: an OFF pulled while a rewind settles, on a module that was ON at the capture. Its marker
   * lands in storage the rewind discards. These rewinds have something to claim (a module an
   * earlier rewind still holds here, which the capture includes), so they settle; SCHED is ON
   * at the capture.
   */
  const EARLIER = '@test/held-by-an-earlier-rewind';
  const EARLIER_CLAIM = 'earlier-rewind';
  const settlingScope = async () => {
    const s = await newScope();
    const atBookmark = await host.exportScopeLocal(s);
    await claim(s, [EARLIER], EARLIER_CLAIM);
    await holdsStub().switchHoldArm(s, EARLIER_CLAIM, null);
    onTestFinished(() => holdsStub().switchHoldRelease(s, null, null));
    return { s, atBookmark };
  };

  it('an OFF during the settle joins the pending claim at once, and after the rewind lands the pass fires nothing', async () => {
    const { s, atBookmark } = await settlingScope();
    await armRewind(env.SCOPE, s);
    const r = gatedRewind(s);
    await r.paused; // settled, and held before its re-check: the claim is pending
    expect(await off(s)).toMatchObject({ held: true, changed: true });
    // Joined by the move itself, while the rewind is still settling: not left to its re-read.
    expect(await claimsOn(s)).toMatchObject([{ state: 'pending', doomed: null }]);
    r.resume();
    await r.rewinding;
    expect(await claimsOn(s)).toMatchObject([{ state: 'armed', doomed: expect.any(String) }]);
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await host.systemGrantsStatusLocal(s)).toEqual([{ moduleId: SCHED, schedules: 'on' }]);
    expect(await pass(s)).toMatchObject({ fired: 0, skipped: 2, failed: 0, errors: [], switchedOff: true });
    // It joined as the claim's own row, so the first re-assert after landing releases it.
    await off(s);
    expect(await claimsOn(s)).toEqual([]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it('an OFF on the doomed instance joins the armed claim; the first move on the restored storage releases it', async () => {
    const { s, atBookmark } = await settlingScope();
    await armRewind(env.SCOPE, s, { holdAbort: true });
    await host.rewindScopeLocal(s, 'bm', { force: true });
    // The armed instance still serves: this OFF is written where the restart discards it.
    expect(await off(s)).toStrictEqual({ held: true, changed: true, permissions: ['sched:tick'], deniesTenantGrants: true });
    expect(await claimsOn(s)).toMatchObject([{ state: 'armed', doomed: expect.any(String) }]);
    await restartNow(env.SCOPE, s);
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
    await off(s);
    expect(await claimsOn(s)).toEqual([]);
  });

  it('an OFF the move rule never sees (a reconcile carrying the list, in its own unit) is claimed by the re-read after the settle', async () => {
    const { s, atBookmark } = await settlingScope();
    await armRewind(env.SCOPE, s);
    const r = gatedRewind(s);
    await r.paused;
    await reconcile(s, { switchedOff: [SCHED] });
    expect(await claimsOn(s)).toEqual([]); // no switch move joined it
    r.resume();
    await r.rewinding;
    expect(await claimsOn(s)).toMatchObject([{ state: 'armed' }]);
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  /**
   * #1839 review: the OFF was queued behind a rewind's capture, and the rewind wrote its claim
   * while the move ran. S0 predates that claim; the join re-reads after the move and finds it.
   */
  it('an OFF joins a claim written while it was queued: the join re-reads the claims after the move', async () => {
    const s = await newScope();
    onTestFinished(() => holdsStub().switchHoldRelease(s, null, null));
    const counting = countingScopes(env.SCOPE);
    counting.afterMove = () => claim(s, [EARLIER], 'written-while-queued');
    expect(await deployment(counting.ns).systemSwitchLocal(s, SCHED, 'off')).toMatchObject({ changed: true });
    expect(await claimsOn(s)).toMatchObject([{ claimId: 'written-while-queued', state: 'pending' }]);
  });

  /**
   * #1839 review: a join never recreates a claim with no rows left. Here the claim was dropped
   * (its rewind refused) between the OFF's claims read and its join; a row created for it would
   * hold SCHED with no rewind behind it.
   */
  it('an OFF does not join a claim dropped while it moved, so no orphan row holds the module', async () => {
    const s = await newScope();
    onTestFinished(() => holdsStub().switchHoldRelease(s, null, null));
    await claim(s, [EARLIER], 'refused-mid-move');
    const counting = countingScopes(env.SCOPE);
    counting.afterMove = () => holdsStub().switchHoldDrop(s, 'refused-mid-move');
    expect(await deployment(counting.ns).systemSwitchLocal(s, SCHED, 'off')).toMatchObject({ changed: true });
    expect(await holdsStub().switchHoldClaims(s)).toEqual([]);
  });

  /**
   * #1839: the settle argument, per row. A pass that read its snapshot just before the late OFF
   * joined must not act on that snapshot against the rewound storage. The rewind waits until the
   * joined row is a full settle old, on the hold object's clock, so that snapshot is too old by
   * then and is read again. Without the wait the rewind arms right after the join.
   */
  it('the rewind waits until the joined row is a settle old, so a pass whose snapshot predates it re-reads', async () => {
    const { s, atBookmark } = await settlingScope();
    const sweeper = countingScopes(env.SCOPE);
    const swept = deployment(sweeper.ns);
    const bystander = await newScope();
    await armRewind(env.SCOPE, s);
    const r = gatedRewind(s);
    await r.paused;
    await pass(bystander, swept); // the snapshot, read before the join below
    expect(sweeper.holdReads).toBe(1);
    const joinedBy = Date.now();
    await off(s);
    r.resume();
    await r.rewinding;
    expect(Date.now() - joinedBy).toBeGreaterThanOrEqual(TEST_HOLD_SETTLE_MS);
    expect(r.rewinder.ageReads).toBe(2); // one after the settle, one after the wait it asked for
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await pass(s, swept)).toMatchObject({ fired: 0, switchedOff: true });
    expect(sweeper.holdReads).toBe(2);
  });

  it('twin: a rewind with no late OFF asks the age once and does not wait again', async () => {
    const { s, atBookmark } = await settlingScope();
    const rewinder = countingScopes(env.SCOPE);
    await armRewind(env.SCOPE, s);
    await deployment(rewinder.ns).rewindScopeLocal(s, 'bm', { force: true });
    expect(rewinder.ageReads).toBe(1);
    await landRewind(env.SCOPE, s, atBookmark);
  });

  /**
   * #1839 review: the re-check after the settle can fail (here the age read). Nothing was asked to
   * arm yet, so the rewind drops its own claim, keeps any other, and throws.
   */
  it("a failed re-check drops this rewind's claim, arms nothing, and throws", async () => {
    const { s } = await settlingScope();
    const rewinder = countingScopes(env.SCOPE);
    rewinder.failAgeReads = true;
    await armRewind(env.SCOPE, s);
    await expect(deployment(rewinder.ns).rewindScopeLocal(s, 'bm', { force: true })).rejects.toThrow(/age read down/);
    const scope = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as { rewindProbe(): Promise<{ armed: boolean }> };
    expect(await scope.rewindProbe()).toMatchObject({ armed: false });
    expect([...new Set((await holdsStub().switchHoldClaims(s)).map((c) => c.claimId))]).toEqual([EARLIER_CLAIM]);
  });

  /**
   * #1839 review: past the bound the rewind is REFUSED, not armed with a young row. Nothing was
   * asked to arm, so the OFFs pulled meanwhile stay in the scope's own storage, and a retry's
   * capture reads them.
   */
  it(
    'the wait is bounded: a claim that keeps getting younger is refused after the extra waits, and a retry holds',
    { timeout: 45_000 },
    async () => {
      const { s, atBookmark } = await settlingScope();
      await armRewind(env.SCOPE, s);
      const r = gatedRewind(s);
      await r.paused;
      const [ours] = (await holdsStub().switchHoldClaims(s)).filter((c) => c.claimId !== EARLIER_CLAIM);
      // The operator pulls SCHED, then every age read finds another module's OFF joined just
      // before it: switches pulled again and again through the wait.
      expect(await off(s)).toMatchObject({ changed: true });
      let late = 0;
      r.rewinder.beforeAgeRead = () => holdsStub().switchHoldJoin(s, `@test/late-${late++}`, [ours!.claimId]);
      r.resume();
      await expect(r.rewinding).rejects.toThrow(/^rewind refused: schedule switches kept being pulled off/);
      expect(r.rewinder.ageReads).toBe(1 + SWITCH_HOLD_EXTRA_WAITS);
      // Nothing armed, this rewind's claim is gone (only the earlier one is left), and SCHED is
      // still off in the scope's own storage.
      const scope = env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as {
        rewindProbe(): Promise<{ armed: boolean }>;
      };
      expect(await scope.rewindProbe()).toMatchObject({ armed: false });
      expect([...new Set((await holdsStub().switchHoldClaims(s)).map((c) => c.claimId))]).toEqual([EARLIER_CLAIM]);
      expect(await host.systemGrantsStatusLocal(s)).toEqual([{ moduleId: SCHED, schedules: 'off' }]);
      // The retry captures SCHED as off, settles, and the rewound scope is held.
      expect(await host.rewindScopeLocal(s, 'bm', { force: true })).toEqual({ rewindingTo: 'bm' });
      await landRewind(env.SCOPE, s, atBookmark);
      expect(await host.systemGrantsStatusLocal(s)).toEqual([{ moduleId: SCHED, schedules: 'on' }]);
      expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
    },
  );

  /**
   * #1839 review (Copilot): the re-check's status read and its claim write are two objects. An
   * operator's ON can move and release the claim between them; the claim write must not bring the
   * module back from that stale read. The ON tombstones the module after its move, and a claim
   * whose token predates the tombstone skips it.
   */
  it("an ON between the re-check's status read and its claim write wins: the stale read claims nothing", async () => {
    const s = await newScope();
    onTestFinished(() => holdsStub().switchHoldRelease(s, null, null));
    const atBookmark = await host.exportScopeLocal(s);
    await off(s); // SCHED off at the capture: claimed, and the rewind settles
    await armRewind(env.SCOPE, s);
    const r = gatedRewind(s, 'after'); // held just after the re-check read SCHED off
    await r.paused;
    await host.systemSwitchLocal(s, SCHED, 'on'); // moves, then releases the claim
    expect(await heldOn(s)).toEqual([]);
    r.resume();
    await r.rewinding;
    expect(await heldOn(s)).toEqual([]);
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  it("an ON between the capture's status read and its claim write is not claimed", async () => {
    const s = await newScope();
    onTestFinished(() => holdsStub().switchHoldRelease(s, null, null));
    const atBookmark = await host.exportScopeLocal(s);
    await off(s);
    await armRewind(env.SCOPE, s);
    const r = gatedRewind(s, 'after', 1); // held just after the capture read SCHED off
    await r.paused;
    await host.systemSwitchLocal(s, SCHED, 'on');
    r.resume();
    await r.rewinding;
    expect(await heldOn(s)).toEqual([]);
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  it('twin: the tombstone refuses only a read that predates it, and an OFF after the ON still joins', async () => {
    const s = await newScope();
    onTestFinished(() => holdsStub().switchHoldRelease(s, null, null));
    await claim(s, [EARLIER], 'a-rewind');
    const stale = await holdsStub().switchHoldToken();
    await host.systemSwitchLocal(s, SCHED, 'on'); // tombstones SCHED
    await holdsStub().switchHoldClaim(s, [SCHED], 'a-rewind', stale);
    expect(await claimsOn(s)).toEqual([]);
    await holdsStub().switchHoldClaim(s, [SCHED], 'a-rewind', await holdsStub().switchHoldToken());
    expect(await claimsOn(s)).toMatchObject([{ claimId: 'a-rewind' }]);
    // A newer OFF is a move, and its join is not a read: the tombstone does not stand in its way.
    await holdsStub().switchHoldRelease(s, SCHED, ['a-rewind']);
    await host.systemSwitchLocal(s, SCHED, 'on');
    expect(await off(s)).toMatchObject({ changed: true });
    expect(await claimsOn(s)).toMatchObject([{ claimId: 'a-rewind', state: 'pending' }]);
  });

  it('a move the doomed instance applies releases nothing; after an eviction, the next instance releases', async () => {
    const s = await newScope();
    const atBookmark = await host.exportScopeLocal(s);
    await off(s);
    await armRewind(env.SCOPE, s, { holdAbort: true });
    // The wire answer names no instance.
    expect(await host.rewindScopeLocal(s, 'bm', { force: true })).toStrictEqual({ rewindingTo: 'bm' });
    // The armed instance is still serving: its write is discarded at the restart.
    expect(await off(s)).toStrictEqual({ held: true, changed: false, permissions: [], deniesTenantGrants: true });
    expect(await heldOn(s)).toEqual([SCHED]);
    expect((await claimsOn(s))[0]).toMatchObject({ state: 'armed', doomed: expect.any(String) });
    // It is evicted before its own abort: the next instance is a new id, on restored storage.
    await restartNow(env.SCOPE, s);
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
    expect(await off(s)).toStrictEqual({ held: true, changed: true, permissions: ['sched:tick'], deniesTenantGrants: true });
    expect(await heldOn(s)).toEqual([]);
  });

  /**
   * Why the claims are read BEFORE the move. Here a move lands while the claim is still pending,
   * and before its answer is back, the rewind arms on a different instance (the one serving had
   * been evicted). That move was in storage the rewind discards. Read before the move, the claim
   * was pending, so it stays. Read after it, the claim would look armed with a doomed instance
   * that is not the move's, and would be released.
   */
  it('a claim armed while a move is in flight stays: the release reads the claims before the move', async () => {
    const s = await newScope();
    await off(s);
    await claim(s, [SCHED], 'arming-now');
    const counting = countingScopes(env.SCOPE);
    counting.afterMove = () => holdsStub().switchHoldArm(s, 'arming-now', 'an-instance-started-after-this-move');
    expect(await deployment(counting.ns).systemSwitchLocal(s, SCHED, 'off')).toMatchObject({ held: true });
    expect(await heldOn(s)).toEqual([SCHED]);
    await holdsStub().switchHoldRelease(s, null, null);
  });

  /**
   * Re-review on #1838: a LATER rewind can doom the instance a release runs on. After R1 lands,
   * the module is ON in storage and held, so R2 found nothing off and claimed nothing. A re-assert
   * OFF then landed on R2's doomed instance, which is not R1's, so it released R1's claim; R2's
   * restart discarded the OFF, and the pass fired. R2 now also claims what is held on the scope.
   */
  it('a second rewind claims what an earlier one still holds, so a re-assert on its doomed instance releases nothing', async () => {
    const s = await newScope();
    const atBookmark = await host.exportScopeLocal(s);
    await off(s);
    await armRewind(env.SCOPE, s);
    await host.rewindScopeLocal(s, 'bm-1', { force: true });
    await landRewind(env.SCOPE, s, atBookmark); // R1 landed: ON in storage, held
    await armRewind(env.SCOPE, s, { holdAbort: true });
    await host.rewindScopeLocal(s, 'bm-2', { force: true }); // R2 armed on the serving instance
    expect((await claimsOn(s)).length).toBe(2);
    await off(s); // the re-assert lands on R2's doomed instance
    await restartNow(env.SCOPE, s);
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
    // The first re-assert after R2 landed clears both.
    await off(s);
    expect(await heldOn(s)).toEqual([]);
  });

  /**
   * Re-review on #1838: an operator's ON during the settle, or on the doomed instance, is
   * discarded by the rewind, and it used to leave the claim in place. Nothing then cleared it:
   * the module stayed off while the directory and the status read said ON. ON now releases
   * every claim it read, surviving or not.
   */
  it("an operator's ON on the doomed instance releases the hold: the module runs once the rewind lands", async () => {
    const s = await newScope();
    const atBookmark = await host.exportScopeLocal(s);
    await off(s);
    await armRewind(env.SCOPE, s, { holdAbort: true });
    await host.rewindScopeLocal(s, 'bm', { force: true });
    expect(await host.systemSwitchLocal(s, SCHED, 'on')).toMatchObject({ held: true });
    expect(await heldOn(s)).toEqual([]);
    await restartNow(env.SCOPE, s);
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  it("an operator's ON during the settle releases the hold too; twin: an OFF there does not (above)", async () => {
    const s = await newScope();
    const atBookmark = await host.exportScopeLocal(s);
    await off(s);
    await armRewind(env.SCOPE, s);
    const r = gatedRewind(s);
    await r.paused;
    await host.systemSwitchLocal(s, SCHED, 'on');
    expect(await heldOn(s)).toEqual([]);
    r.resume();
    await r.rewinding;
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await heldOn(s)).toEqual([]); // arming a released claim does not bring it back
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  /**
   * Re-review on #1838: the ambiguous-throw probe can land while the restore call is still in
   * flight. The DO now counts itself arming from BEFORE that call, so such a probe answers armed,
   * naming this instance as doomed, rather than "not armed" and a claim that any move releases.
   */
  it('a probe while the restore call is in flight answers armed', async () => {
    const s = await newScope();
    const scope = () =>
      env.SCOPE.get(env.SCOPE.idFromName(s)) as unknown as {
        rewindProbe(): Promise<{ instance: string; armed: boolean }>;
        rewindToBookmark(b: string, o: { force: boolean }): Promise<unknown>;
      };
    expect(await scope().rewindProbe()).toMatchObject({ armed: false });
    let open!: () => void;
    await armRewind(env.SCOPE, s, { gate: new Promise<void>((resolve) => (open = resolve)), holdAbort: true });
    const rewinding = scope().rewindToBookmark('bm', { force: true });
    await sleep(50);
    expect(await scope().rewindProbe()).toMatchObject({ armed: true });
    open();
    await rewinding;
    await restartNow(env.SCOPE, s);
  });

  it('a claim still pending past the bound is released by a move; a fresh pending one is not', async () => {
    const s = await newScope();
    await off(s);
    const stale = new Date(Date.now() - SWITCH_HOLD_PENDING_MAX_MS - 60_000).toISOString();
    // A rewinding request that died between capture and arm left this one. The hold object
    // stamps its own clock, so the row is aged in place.
    await claim(s, [SCHED], 'died-mid-rewind');
    await restampClaim(s, 'died-mid-rewind', stale);
    await off(s);
    expect(await heldOn(s)).toEqual([]);
    // Twin: a pending claim inside the bound may belong to a rewind about to arm.
    await claim(s, [SCHED], 'still-rewinding');
    await off(s);
    expect(await heldOn(s)).toEqual([SCHED]);
    await holdsStub().switchHoldRelease(s, null, null);
  });

  it('deleting the scope releases its holds', async () => {
    const s = await rewoundPastTheSwitch();
    await host.deleteScopeLocal(s);
    expect(await heldOn(s)).toEqual([]);
  });

  it('a definite refusal releases what it held, and nothing else', async () => {
    const s = await newScope();
    await off(s);
    // Not armed, and no such bookmark: the DO refuses before anything is restored, and says so.
    await expect(host.rewindScopeLocal(s, 'no-such-bookmark')).rejects.toThrow(/^rewind refused: unknown bookmark/);
    expect(await heldOn(s)).toEqual([]);
    // Twin: an earlier rewind's claim that was already there stays.
    await claim(s, [SCHED], 'earlier-rewind');
    await holdsStub().switchHoldArm(s, 'earlier-rewind', null);
    await expect(host.rewindScopeLocal(s, 'no-such-bookmark')).rejects.toThrow(/^rewind refused: /);
    expect((await claimsOn(s)).map((c) => c.claimId)).toEqual(['earlier-rewind']);
    await holdsStub().switchHoldRelease(s, null, null);
  });

  /**
   * Copilot review on #1838: two rewinds of one scope at once. A is refused, B succeeds. With one
   * shared row, A's refusal released the row B relied on, and B's rewind landed with no hold. Each
   * rewind now owns its claim, and a refusal drops only its own.
   */
  it("concurrent rewinds: A's refusal leaves B's claim, and the rewound scope stays held", async () => {
    const s = await newScope();
    const atBookmark = await host.exportScopeLocal(s);
    await off(s);
    await armRewind(env.SCOPE, s);
    const [a, b] = await Promise.allSettled([
      host.rewindScopeLocal(s, 'no-such-bookmark'), // A: definitely refused
      host.rewindScopeLocal(s, 'bm', { force: true }), // B: armed
    ]);
    expect(a.status).toBe('rejected');
    expect(String((a as PromiseRejectedResult).reason)).toMatch(/rewind refused: unknown bookmark/);
    expect(b).toMatchObject({ status: 'fulfilled', value: { rewindingTo: 'bm' } });
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await heldOn(s)).toEqual([SCHED]);
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it('an ambiguous throw keeps the hold: the DO may have armed the bookmark', async () => {
    const s = await newScope();
    await off(s);
    // A raw failure with no refusal prefix, after the DO got as far as arming. The host cannot
    // tell whether the scope will come back rewound, so it keeps the hold.
    await armRewind(env.SCOPE, s, { throwing: 'Network connection lost.' });
    await expect(host.rewindScopeLocal(s, 'bm', { force: true })).rejects.toThrow(/Network connection lost/);
    expect(await heldOn(s)).toEqual([SCHED]);
    // Inert on a scope that is still off. The operator's ON releases it; an OFF would wait for
    // the next instance, since the probe found this one arming and named it doomed.
    expect(await pass(s)).toMatchObject({ fired: 0, switchedOff: true });
    await host.systemSwitchLocal(s, SCHED, 'on');
    expect(await heldOn(s)).toEqual([]);
    expect(await pass(s)).toMatchObject({ fired: 2, failed: 0 });
  });

  /**
   * The race the order in `runDueSchedules` closes. One pass reads the hold ONCE and keeps it
   * for `SWITCH_HOLD_SNAPSHOT_MS`. A pass that read it before the rewind wrote its hold must
   * not act on that read when it meets the rewound storage. The rewind waits longer than a
   * snapshot lives, so that snapshot is always too old by then. The one case on the production
   * values: both hosts are built with no `switchHoldSnapshotMs`.
   */
  it('a pass that read the hold before the rewind re-reads it before acting on the rewound scope', async () => {
    const counting = countingScopes(env.SCOPE);
    const h = deployment(counting.ns, {});
    const bystander = await newScope();
    await pass(bystander, h); // the snapshot, taken before any hold for `s` exists
    expect(counting.holdReads).toBe(1);
    const s = await rewoundPastTheSwitch(true, undefined, deployment(env.SCOPE, {}));
    expect(await pass(s, h)).toMatchObject({ fired: 0, switchedOff: true });
    expect(counting.holdReads).toBe(2);
  });

  /**
   * The ORDER, pinned (review 6a): the consult comes after the scope's state read. This pass
   * takes its snapshot before the hold exists, then its state read is held until the rewind has
   * landed, so that read meets rewound storage. Consulting after it finds the snapshot too old
   * and re-reads. A consult moved before the state read would use the pre-hold snapshot while it
   * was still fresh, and fire.
   */
  it('a state read that lands after the rewind is judged against a hold read after it', async () => {
    const counting = countingScopes(env.SCOPE);
    const h = deployment(counting.ns);
    const s = await newScope();
    const atBookmark = await host.exportScopeLocal(s);
    await off(s);
    await pass(await newScope(), h); // the snapshot, taken before any hold for `s`
    expect(counting.holdReads).toBe(1);
    let open!: () => void;
    counting.gateStateRead = { scopeId: s, until: new Promise<void>((resolve) => (open = resolve)) };
    const racing = pass(s, h); // starts now; its state read waits at the gate
    await armRewind(env.SCOPE, s);
    await host.rewindScopeLocal(s, 'bm', { force: true });
    await landRewind(env.SCOPE, s, atBookmark);
    open();
    expect(await racing).toMatchObject({ fired: 0, switchedOff: true });
    expect(counting.holdReads).toBe(2);
  });

  it('twin, pinning the constants that argument rests on: the rewind outwaits a snapshot', () => {
    expect(SWITCH_HOLD_SETTLE_MS).toBeGreaterThan(SWITCH_HOLD_SNAPSHOT_MS);
  });

  // A snapshot age that never expires, or a settle that waits nothing, is refused at construction.
  it('a host refuses a snapshot age that is not a positive, finite number', () => {
    for (const switchHoldSnapshotMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => deployment(env.SCOPE, { switchHoldSnapshotMs })).toThrow(/switchHoldSnapshotMs must be a positive, finite number/);
    }
  });

  /**
   * The cost on the hot path. A pass reads the hold once, whatever the number of scopes, and
   * a scope that was never rewound costs no RPC of its own.
   */
  it('a pass over many scopes reads the hold once, not once per scope', async () => {
    const scopes = await Promise.all(Array.from({ length: 10 }, () => newScope()));
    const counting = countingScopes(env.SCOPE);
    // The production snapshot age: the cost it buys is what this measures, and it waits on nothing.
    const h = deployment(counting.ns, {});
    const started = Date.now();
    for (const s of scopes) expect(await pass(s, h)).toMatchObject({ fired: 2 });
    const passMs = Date.now() - started;
    const readStarted = Date.now();
    await holdsStub().switchHoldsAll();
    const readMs = Date.now() - readStarted;
    // Once per snapshot age: one read, unless this machine took longer than that for the pass.
    expect(counting.holdReads).toBeGreaterThanOrEqual(1);
    expect(counting.holdReads).toBeLessThanOrEqual(1 + Math.floor(passMs / SWITCH_HOLD_SNAPSHOT_MS));
    expect(counting.holdReads).toBeLessThan(scopes.length);
    expect(counting.scopeCalls).toBeGreaterThanOrEqual(scopes.length * 4);
    console.log(
      `#1819 cost: ${scopes.length} scopes, ${counting.scopeCalls} scope RPCs, ${counting.holdReads} hold read; ` +
        `pass ${passMs} ms, one hold read ${readMs} ms`,
    );
  });

  /**
   * Copilot review on #1838: the sweepers run up to eight scopes at once on one host. Each
   * consult that finds the snapshot missing used to send its own read; they now join one.
   */
  it('concurrent consults on a cold host send exactly one hold read, and report a failure once', async () => {
    const scopes = await Promise.all(Array.from({ length: 8 }, () => newScope()));
    const counting = countingScopes(env.SCOPE);
    const h = deployment(counting.ns);
    const reports = await Promise.all(scopes.map((s) => pass(s, h)));
    expect(reports.every((r) => r.fired === 2)).toBe(true);
    expect(counting.holdReads).toBe(1);

    // Fresh scopes: the eight above are remembered clear now (#2029), and would read nothing.
    const fresh = await Promise.all(Array.from({ length: 8 }, () => newScope()));
    const failing = countingScopes(env.SCOPE);
    failing.failReads = true;
    const cold = deployment(failing.ns);
    const failed = await Promise.all(fresh.map((s) => pass(s, cold)));
    expect(failing.holdReads).toBe(1);
    expect(failed.flatMap((r) => r.errors).filter((e) => e.operation === 'switch-hold')).toHaveLength(1);
  });

  /**
   * #2029: a host lives for one request, so its snapshot does not outlive it. A scope instance a
   * door found with no claim at all is remembered clear for the isolate, and later doors on it read
   * nothing from the hold object: a scope never rewound costs no hold read after its first. A
   * rewind restarts the scope, and the new instance reads the hold afresh.
   */
  it('a scope instance read clear costs no further hold read, and a rewound one reads again', async () => {
    const s = await newScope();
    const first = countingScopes(env.SCOPE);
    await pass(s, deployment(first.ns));
    expect(first.holdReads).toBe(1);
    const later = countingScopes(env.SCOPE);
    for (let i = 0; i < 3; i++) await pass(s, deployment(later.ns));
    expect(later.holdReads).toBe(0);
    // Rewound past its switch: a new instance, which reads the hold, finds the claim, and holds.
    const atBookmark = await host.exportScopeLocal(s);
    await off(s);
    await armRewind(env.SCOPE, s);
    await host.rewindScopeLocal(s, 'bm-before-switch', { force: true });
    await landRewind(env.SCOPE, s, atBookmark);
    const after = countingScopes(env.SCOPE);
    expect(await pass(s, deployment(after.ns))).toMatchObject({ fired: 0, switchedOff: true });
    expect(after.holdReads).toBe(1);
  });

  it('twin: a failed read is not remembered — the next door on that instance reads again', async () => {
    const s = await newScope();
    const failing = countingScopes(env.SCOPE);
    failing.failReads = true;
    await pass(s, deployment(failing.ns));
    const next = countingScopes(env.SCOPE);
    await pass(s, deployment(next.ns));
    expect(next.holdReads).toBe(1);
  });

  it('a consult does not join a read that went out longer ago than the snapshot age', async () => {
    const [a, b] = await Promise.all([newScope(), newScope()]);
    const counting = countingScopes(env.SCOPE);
    const h = deployment(counting.ns);
    counting.slowNextReadMs = TEST_HOLD_SNAPSHOT_MS + 1_000;
    const first = pass(a, h); // its read is still in flight when the next consult comes
    await sleep(TEST_HOLD_SNAPSHOT_MS + 300);
    await pass(b, h); // too old to join: it sends its own read
    await first;
    expect(counting.holdReads).toBe(2);
  });

  /**
   * A hold object that cannot be read fails OPEN, except for what the pass already knows is
   * held. Closed would stop every schedule in the deployment over one object; open reopens only
   * this issue's gap, for a rewind during the outage. The error is reported either way.
   */
  it('an unreadable hold fails open, and says so', async () => {
    const s = await rewoundPastTheSwitch();
    const counting = countingScopes(env.SCOPE);
    counting.failReads = true;
    const r = await pass(s, deployment(counting.ns));
    expect(r).toMatchObject({ fired: 2, failed: 0 });
    expect(r.errors).toEqual([
      { operation: 'switch-hold', error: expect.stringMatching(/unreadable \(holds down\); no earlier read in this pass, so no hold applied/) },
    ]);
    await holdsStub().switchHoldRelease(s, null, null);
  });

  it('twin: a hold this pass already read stays held when a later read fails', async () => {
    const s = await rewoundPastTheSwitch();
    const counting = countingScopes(env.SCOPE);
    const h = deployment(counting.ns);
    expect(await pass(s, h)).toMatchObject({ fired: 0, switchedOff: true });
    await sleep(TEST_HOLD_SNAPSHOT_MS + 100);
    counting.failReads = true;
    const r = await pass(s, h);
    expect(r).toMatchObject({ fired: 0, switchedOff: true });
    expect(r.errors).toEqual([
      {
        operation: 'switch-hold',
        error: expect.stringMatching(/unreadable \(holds down\); the \d+ hold\(s\) from this pass's last good read still applied/),
      },
    ]);
    expect(counting.holdReads).toBe(2);
  });
});

/**
 * #1819 on the CP-full host, for a scope whose store is this host's own: the co-located
 * rewind (`admin.rewindScope`, `localApply`) holds, and the platform's own lever and
 * reconcile release it here.
 */
describe('#1819 — the co-located rewind holds, and the CP-full switch releases it', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    switchHoldSnapshotMs: TEST_HOLD_SNAPSHOT_MS,
  });
  host.registerModule(scheduleMod);
  const t = tenantId.parse(ulid());
  beforeAll(async () => {
    await host.admin.createTenant(staff, { id: t, slug: `hold-${t.slice(-10).toLowerCase()}`, name: 'Hold' });
    await host.admin.grantEntitlement(staff, t, 'sched');
  });
  afterAll(async () => host.close());

  const node = (s: ScopeId) => ({ tenantId: t, scopeId: s });
  const rewound = async (): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, node(s));
    await host.admin.activateScope(staff, t, s);
    const atBookmark = await host.admin.exportScope(staff, t, s);
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: node(s), reason: 'incident' });
    await armRewind(env.SCOPE, s);
    await host.admin.rewindScope(staff, t, s, 'bm', { force: true, localApply: true });
    await landRewind(env.SCOPE, s, atBookmark.tables);
    return s;
  };

  it('the next pass fires nothing; the reconcile re-asserts it and the hold is gone', async () => {
    const s = await rewound();
    expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 0, switchedOff: true });
    await host.provisionScope(staff, node(s));
    const held = (await holdsOf(env.SCOPE).switchHoldsAll()).filter((h) => h.scopeId === s);
    expect(held).toEqual([]);
    expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 0, switchedOff: true });
  });

  it("twin: the operator's restore releases it, and the module fires", async () => {
    const s = await rewound();
    await host.admin.restoreToSystem(staff, { moduleId: SCHED, node: node(s), reason: 'fixed' });
    expect(await host.runDueSchedules(SCHED, t, s)).toMatchObject({ fired: 2, failed: 0 });
  });

  /**
   * #2029, fixing #1823 × #1834 as merged: a module held on a scope ONLY by a tenant-level grant
   * has no row there, so a rewind to before its switch leaves it `ungranted` in the scope, not
   * `on`, while the tenant grant still authorizes it. The system door used to read the hold only
   * for an `on` module, so such a module ran on the rewound scope. It now reads the hold for every
   * subject the scope does not already have off.
   */
  describe('a module held only by a tenant-level grant (#2029 × #1823)', () => {
    // A tenant of its own: the cases above leave SCHED switched off on scopes of `t`, and a
    // tenant-level grant is refused while any scope of the tenant has it off (#1743).
    const t = tenantId.parse(ulid());
    const node = (s: ScopeId) => ({ tenantId: t, scopeId: s });
    const tick = async (s: ScopeId) => (await host.getSystemScope(SCHED, t, s)).invoke('sched/tick');
    /** Provisioned by a host that registers no module, so the scope seats no `system:` grant at all. */
    const bareScope = async (): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      const bare = new CloudflareScopeHost({
        scope: env.SCOPE,
        controlPlane: env.CONTROL_PLANE,
        secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      });
      await bare.provisionScope(staff, node(s));
      await host.admin.activateScope(staff, t, s);
      return s;
    };
    beforeAll(async () => {
      await host.admin.createTenant(staff, { id: t, slug: `hold-tw-${t.slice(-10).toLowerCase()}`, name: 'Hold TW' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      await host.admin.grantToSystem(staff, {
        moduleId: SCHED,
        permission: permissionKey.parse('sched:tick'),
        node: { tenantId: t, scopeId: null },
        grantedBy: staff,
      });
    });

    it('the rewound module is held at the door before any reconcile, and runs again after ON', async () => {
      const s = await bareScope();
      await expect(tick(s)).resolves.toBeUndefined(); // the tenant grant authorizes it here
      const atBookmark = await host.admin.exportScope(staff, t, s);
      await expect(
        host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: node(s), reason: 'incident' }),
      ).resolves.toMatchObject({ changed: true, permissions: [] });
      await armRewind(env.SCOPE, s);
      await host.admin.rewindScope(staff, t, s, 'bm', { force: true, localApply: true });
      await landRewind(env.SCOPE, s, atBookmark.tables);
      expect((await holdsOf(env.SCOPE).switchHoldsAll()).filter((h) => h.scopeId === s).map((h) => h.moduleId)).toEqual([
        SCHED,
      ]);
      await expect(tick(s)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/held off/) });
      await host.admin.restoreToSystem(staff, { moduleId: SCHED, node: node(s), reason: 'fixed' });
      await expect(tick(s)).resolves.toBeUndefined();
    });

    it('twin: nothing switched off — the rewound module is not held, and runs', async () => {
      const s = await bareScope();
      const atBookmark = await host.admin.exportScope(staff, t, s);
      await armRewind(env.SCOPE, s);
      await host.admin.rewindScope(staff, t, s, 'bm', { force: true, localApply: true });
      await landRewind(env.SCOPE, s, atBookmark.tables);
      await expect(tick(s)).resolves.toBeUndefined();
    });
  });
});

/** #1839: set a claim's rows' stamp in place, since the hold object stamps its own clock. */
async function restampClaim(scopeId: string, claimId: string, heldAt: string): Promise<void> {
  await runInDurableObject(holdsOf(env.SCOPE) as unknown as DurableObjectStub, (_i, state) => {
    state.storage.sql.exec(
      'UPDATE _substrat_switch_holds SET held_at = ? WHERE scope_id = ? AND claim_id = ?',
      heldAt,
      scopeId,
      claimId,
    );
  });
}

/**
 * #1819: the scope namespace as a host sees it, counting what it asks of the hold object and
 * of the scopes, and able to make the hold unreadable. Calls go through arrows on the real
 * stub, never `.bind` (workerd stub proxies).
 */
function countingScopes(ns: DurableObjectNamespace) {
  const holdsId = ns.idFromName(SWITCH_HOLDS_NAME);
  const counts = {
    holdReads: 0,
    /** #1839: how often a rewind asked the hold object for its claim's youngest row. */
    ageReads: 0,
    /** #1839: make the rewind's age read throw, to reach its failed re-check. */
    failAgeReads: false,
    /** #1839: run before each rewind age read. */
    beforeAgeRead: null as (() => Promise<void>) | null,
    /** #1839: how many `systemGrantsStatus` reads went to a scope, and a hook around each (1-based). */
    statusReads: 0,
    aroundStatusRead: null as ((n: number, phase: 'before' | 'after') => Promise<void>) | null,
    scopeCalls: 0,
    failReads: false,
    /** Hold one scope's state read (the system door's gate, #1834) until `until` settles: to place a pass's state read. */
    gateStateRead: null as { scopeId: string; until: Promise<void> } | null,
    /** Run after a scope's switch move completes, before its answer returns to the host. */
    afterMove: null as (() => Promise<void>) | null,
    /** Delay the NEXT hold read by this long, once: a slow read still in flight. */
    slowNextReadMs: 0,
    /** #1823: make the switch's claim read throw. `switchInScope` reads it, moves the scope, and
     *  only then throws, so this is a failure AFTER the scope's switch committed. */
    failClaimReads: false,
    /** #1834: answer every system-door gate with an instance that is never the serving one. */
    movingInstance: false,
    /** #1834: how many system-door gates were read while `movingInstance` was set. */
    doorGates: 0,
    /** #1834: every system-door state read, and every `invoke` sent to a scope. */
    doorStateReads: 0,
    invokes: 0,
    /** #1834 (#2028 r3): runs after a drive's due-key snapshot is read, before it returns: a concurrent drive's window. */
    afterDueKeys: null as (() => Promise<void>) | null,
    /** #2034 (#2042 r1): runs after a claim was written in the scope, before its answer returns: a slow answer. */
    afterJobClaim: null as (() => Promise<void>) | null,
    /** #2034 (#2042 r3, r4): runs before a BEGIN reaches the scope (delayed in transit); then sees its answer. */
    beforeJobBegin: null as (() => Promise<void>) | null,
    jobBeginAnswers: [] as boolean[],
  };
  type Rpc = Record<string, (...a: unknown[]) => unknown>;
  const counted = (real: Rpc, id: DurableObjectId) =>
    new Proxy(
      {},
      {
        // Not thenable: an `await` of the stub must not read `then` as an RPC method.
        get: (_t, prop: string) =>
          prop === 'then'
            ? undefined
            : async (...args: unknown[]) => {
                counts.scopeCalls += 1;
                if (prop === 'systemDoorState') counts.doorStateReads += 1;
                if (prop === 'invoke') counts.invokes += 1;
                const gate = counts.gateStateRead;
                if (prop === 'systemDoorState' && gate && id.equals(ns.idFromName(gate.scopeId))) {
                  await gate.until;
                }
                // #1834: the gate answers an instance that never serves, so every pinned call is refused as moved.
                if (prop === 'systemDoorState' && counts.movingInstance) {
                  counts.doorGates += 1;
                  const answer = (await real[prop]!(...args)) as { state: string; instance: string };
                  return { ...answer, instance: crypto.randomUUID() };
                }
                if (prop === 'jobRunBegin') {
                  if (counts.beforeJobBegin) await counts.beforeJobBegin();
                  const began = (await real[prop]!(...args)) as boolean;
                  counts.jobBeginAnswers.push(began);
                  return began;
                }
                const statusRead = prop === 'systemGrantsStatus' ? ++counts.statusReads : 0;
                if (statusRead && counts.aroundStatusRead) await counts.aroundStatusRead(statusRead, 'before');
                const answer = await real[prop]!(...args);
                if (statusRead && counts.aroundStatusRead) await counts.aroundStatusRead(statusRead, 'after');
                if (prop === 'switchSystemSchedules' && counts.afterMove) await counts.afterMove();
                if (prop === 'jobRunsDueKeys' && counts.afterDueKeys) await counts.afterDueKeys();
                if (prop === 'jobRunClaim' && counts.afterJobClaim) await counts.afterJobClaim();
                return answer;
              },
      },
    );
  const holds = (real: Rpc) =>
    new Proxy(
      {},
      {
        get: (_t, prop: string) =>
          prop === 'then'
            ? undefined
            : prop === 'switchHoldsAll'
              ? async () => {
                  counts.holdReads += 1;
                  if (counts.failReads) throw new Error('holds down');
                  const slow = counts.slowNextReadMs;
                  counts.slowNextReadMs = 0;
                  if (slow > 0) await new Promise((resolve) => setTimeout(resolve, slow));
                  return real.switchHoldsAll!();
                }
              : async (...args: unknown[]) => {
                  if (prop === 'switchHoldClaims' && counts.failClaimReads) throw new Error('hold claims down');
                  if (prop === 'switchHoldYoungestMs') {
                    if (counts.beforeAgeRead) await counts.beforeAgeRead();
                    counts.ageReads += 1;
                    if (counts.failAgeReads) throw new Error('age read down');
                  }
                  return real[prop]!(...args);
                },
      },
    );
  const counting = {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => {
      const real = ns.get(id) as unknown as Rpc;
      return id.equals(holdsId) ? holds(real) : counted(real, id);
    },
  } as unknown as DurableObjectNamespace;
  return Object.assign(counts, { ns: counting });
}

/**
 * #1823: an OFF whose move throws AFTER the scope's switch committed keeps the directory's
 * record. The record is written before the move, and a throw does not say the scope did not
 * move, so it is undone only when the scope reads back not off. Otherwise a first OFF could
 * leave the scope off with no record, and a wipe or restore would have nothing to re-assert.
 */
describe('#1823 — an OFF that throws after the scope moved keeps its record', () => {
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');

  it('a hold read that fails after the move leaves the scope off AND recorded off; a tenant grant is still refused', async () => {
    const counting = countingScopes(env.SCOPE);
    const host = new CloudflareScopeHost({
      scope: counting.ns,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `kept-${t.slice(-10).toLowerCase()}`, name: 'Kept' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    const node = { tenantId: t, scopeId: s };

    counting.failClaimReads = true;
    await expect(host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'incident' })).rejects.toThrow(
      /hold claims down/,
    );
    counting.failClaimReads = false;

    // The scope did switch, and the record says so.
    expect((await host.admin.systemGrantsStatus(staff, node)).map((e) => [e.schedules, e.recorded])).toEqual([['off', 'off']]);
    const failed = (await host.admin.auditLog(staff, { scopeId: s, action: ['revokeFromSystem'] }))
      .map((e) => e.after as { phase: string; recordKept?: boolean })
      .filter((a) => a.phase === 'failed');
    expect(failed).toEqual([expect.objectContaining({ phase: 'failed', recordKept: true })]);
    // So #1743's refusal still has the record to read.
    const e = await host.admin
      .grantToSystem(staff, { moduleId: SCHED, permission: permissionKey.parse('sched:tick'), node: { tenantId: t, scopeId: null }, grantedBy: staff })
      .then(() => null, (x: unknown) => x);
    expect(errorCodeOf(e)).toBe('conflict');
    await host.close();
  });

  /** A scope switched OFF cleanly, through a host whose scope calls the test can fail. */
  const offScope = async () => {
    const counting = countingScopes(env.SCOPE);
    const host = new CloudflareScopeHost({
      scope: counting.ns,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `on-${t.slice(-10).toLowerCase()}`, name: 'On' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    const node = { tenantId: t, scopeId: s };
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason: 'incident' });
    const failedOn = async () =>
      (await host.admin.auditLog(staff, { scopeId: s, action: ['restoreToSystem'] }))
        .map((e) => e.after as { phase: string; recordKept?: boolean })
        .filter((a) => a.phase === 'failed');
    return { counting, host, node, failedOn };
  };

  it('an ON that throws after the scope moved keeps its record ON, so no re-assert undoes it', async () => {
    const { counting, host, node, failedOn } = await offScope();
    counting.failClaimReads = true;
    await expect(host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'all clear' })).rejects.toThrow(
      /hold claims down/,
    );
    counting.failClaimReads = false;

    // The scope switched on, and the record says so — not flipped back to `off` beside it.
    expect((await host.admin.systemGrantsStatus(staff, node)).map((e) => [e.schedules, e.recorded])).toEqual([['on', 'on']]);
    expect(await failedOn()).toEqual([expect.objectContaining({ phase: 'failed', recordKept: true })]);
    // And the re-assert a wipe or restore runs reads `on`, so it leaves the module on.
    await host.admin.reassertSystemSwitches(staff, node);
    expect((await host.admin.systemGrantsStatus(staff, node)).map((e) => e.schedules)).toEqual(['on']);
    await host.close();
  });

  it('an ON that throws twice keeps its record and is owed: the re-assert settles the scope on it (#2045)', async () => {
    const { counting, host, node, failedOn } = await offScope();
    counting.failClaimReads = true;
    await expect(host.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason: 'all clear' })).rejects.toThrow(
      /hold claims down/,
    );
    counting.failClaimReads = false;

    // The scope did move on, and the record kept the operator's ON under its fence.
    expect((await host.admin.systemGrantsStatus(staff, node)).map((e) => [e.schedules, e.recorded])).toEqual([['on', 'on']]);
    expect(await failedOn()).toEqual([expect.objectContaining({ recordKept: true, reassertOwed: true })]);
    // The re-assert it is owed settles the scope on the record, and finds it there.
    await host.admin.reassertSystemSwitches(staff, node);
    expect((await host.admin.systemGrantsStatus(staff, node)).map((e) => [e.schedules, e.recorded])).toEqual([['on', 'on']]);
    await host.close();
  });
});
