import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  importBatch,
  moduleId,
  type ModuleId,
  type ScopeId,
  type TenantId,
  peerGrantsEntry,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { PEER_CALLER, PEER_LISTENER, peerMod, scheduleMod } from '@substrat-run/contract-tests';
import { switchCarryFor } from '@substrat-run/control-plane-api';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';
import { armRewind, holdsStub, landRewind, restartNow } from './pitr-emulation.js';

/**
 * The peer door's FAR END on the hosted shape (#1706): a CP-less host — what a pushed vertical
 * runs, with no directory of its own — provisioned the way the platform provisions it
 * (`provisionScopeLocal`), and reached the way the platform reaches it (`verticalInvokeLocal`,
 * `peerSwitchLocal`). The shared contract suite runs the co-located, CP-full host; this is the
 * path a hosted peer call actually takes, on real DO SQLite.
 */
describe('the peer door on a CP-less deployment (#1706)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const READ = permissionKey.parse('peer:read');
  const WRITE = permissionKey.parse('peer:write');
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const caller = { vertical: PEER_CALLER, scope: scopeId.parse(ulid()) };

  const hostFor = () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE });
    host.registerModule(peerMod);
    return host;
  };
  const refusal = (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => undefined,
      (e: unknown) => e,
    );

  beforeAll(async () => {
    await hostFor().provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ, WRITE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  });

  it('provisioning seats the declared peers’ keys in the projection unit', async () => {
    expect(await hostFor().peerCovers(t, s, PEER_CALLER, [READ, WRITE])).toEqual([
      { permission: READ, held: true },
      { permission: WRITE, held: true },
    ]);
    expect(await hostFor().peerCovers(t, s, PEER_LISTENER, [READ, WRITE])).toEqual([
      { permission: READ, held: true },
      { permission: WRITE, held: false },
    ]);
  });

  it('verticalInvokeLocal runs as the peer, and the spine names { vertical, scope }', async () => {
    const host = hostFor();
    await host.verticalInvokeLocal(caller, t, s, 'peer/note', { id: 'far-1', body: 'hosted' });
    const q = await host.introspectScopeQuery(s, {
      sql: "SELECT actor FROM _substrat_outbox WHERE type = 'peer.noted' AND entity_id = 'far-1'",
    });
    expect(q.rows).toHaveLength(1);
    expect(JSON.parse(String(q.rows[0]![0]))).toEqual(caller);
  });

  it('an undeclared vertical and an off-list operation are refused at the door', async () => {
    const host = hostFor();
    const stranger = { vertical: 'acme/stranger', scope: caller.scope };
    expect(errorCodeOf(await refusal(host.verticalInvokeLocal(stranger, t, s, 'peer/list')))).toBe('forbidden');
    expect(errorCodeOf(await refusal(host.verticalInvokeLocal(caller, t, s, 'peer/off-list')))).toBe('forbidden');
  });

  it('peerSwitchLocal off refuses the next call and holds nothing; on gives it back', async () => {
    const host = hostFor();
    const off = await host.peerSwitchLocal(s, PEER_CALLER, 'off');
    expect(off).toMatchObject({ held: true, changed: true });
    expect(errorCodeOf(await refusal(host.verticalInvokeLocal(caller, t, s, 'peer/list')))).toBe('forbidden');
    expect((await host.peerCovers(t, s, PEER_CALLER, [READ])).every((c) => !c.held)).toBe(true);
    // A re-provision — the reconcile the platform runs on every promote — does not seat it back.
    await host.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ, WRITE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    expect((await host.peerCovers(t, s, PEER_CALLER, [READ])).every((c) => !c.held)).toBe(true);
    await host.peerSwitchLocal(s, PEER_CALLER, 'on');
    await expect(host.verticalInvokeLocal(caller, t, s, 'peer/list')).resolves.toBeDefined();
  });
});

/**
 * A ScopeDO from before the peer door (#1706) — coordinator/DO version skew, the case the
 * `vertical.honoured` acknowledgement exists for. An old DO drops the trailing `verticalCaller`
 * argument and runs the call as the coordinator's fresh placeholder principal: no admission, no
 * allowlist, no switch. Most calls then fail their own check (the placeholder holds nothing),
 * but one with no check SUCCEEDS — and the coordinator must refuse that success rather than
 * hand back a result no peer rule decided.
 */
describe('a ScopeDO from before the peer door (#1706)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const READ = permissionKey.parse('peer:read');
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const caller = { vertical: PEER_CALLER, scope: scopeId.parse(ulid()) };

  const hostFor = (legacy = false) => {
    const host = new CloudflareScopeHost({
      scope: legacy
        ? ({
            idFromName: (n: string) => env.SCOPE.idFromName(n),
            get: (id: never) => {
              const real = env.SCOPE.get(id);
              // Everything is the live DO except `invoke`, which drops the thirteenth argument
              // — `verticalCaller` — exactly as a DO built before it would.
              return new Proxy(real, {
                get: (target, prop) => {
                  if (prop === 'invoke') {
                    return (...args: unknown[]) =>
                      (target as unknown as { invoke: (...a: unknown[]) => unknown }).invoke(...args.slice(0, 12));
                  }
                  // Every other RPC method is called ON the real stub: workerd refuses a stub method
                  // whose `this` is the proxy ("Illegal invocation"), and `.bind` on an RPC stub is
                  // itself a remote call — so an arrow that calls through the stub, nothing else.
                  const value = Reflect.get(target, prop) as unknown;
                  if (typeof value !== 'function') return value;
                  return (...a: unknown[]) => (target as unknown as Record<PropertyKey, (...x: unknown[]) => unknown>)[prop]!(...a);
                },
              });
            },
          } as unknown as typeof env.SCOPE)
        : env.SCOPE,
    });
    host.registerModule(peerMod);
    return host;
  };

  beforeAll(async () => {
    await hostFor().provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  });

  it('a success the old DO decided without the peer rules is refused as unavailable', async () => {
    // `peer/outbox` checks nothing and is on no allowlist: the old DO runs it for the placeholder.
    const err = await hostFor(true)
      .verticalInvokeLocal(caller, t, s, 'peer/outbox')
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(errorCodeOf(err)).toBe('unavailable');
  });

  it('twin: a current DO refuses that call at the door — off the allowlist', async () => {
    const err = await hostFor()
      .verticalInvokeLocal(caller, t, s, 'peer/outbox')
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(errorCodeOf(err)).toBe('forbidden');
  });
});

/**
 * #1706 part 3 on the SHARED control plane's host: `peerSwitchDelegation` set, as
 * `apps/control-plane` sets it. `SystemSwitchDelegation`'s story with the subject swapped,
 * and it matters for the same reason — a hosted scope's `vertical:<slug>` grants live in its
 * vertical's dispatch deployment, and this host's own `SCOPE` namespace is the placeholder.
 * Switched there, the tenant would be told a peer was cut off while every call it makes kept
 * being admitted, which is the one failure a kill switch must not have.
 *
 * The placeholder is deliberately NOT empty: the scope is provisioned on this host, so its
 * own DO holds the peer's live grants. That is what makes "the placeholder was not switched"
 * observable — `peerCovers` here still answers `held: true` after the delegated revoke.
 */
describe('#1706 — the peer switch is moved in the serving deployment, and audited here', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());
  const READ = permissionKey.parse('peer:read');
  const WRITE = permissionKey.parse('peer:write');
  type Call = { tenantId: string; scopeId: string; vertical: string; to: 'on' | 'off'; fence?: string };

  const setup = async (
    answer: (call: Call) => { held: boolean; changed: boolean; permissions: string[] },
    /** `null` provisions a scope bound to no vertical. */
    vertical: string | null = 'peer-vertical',
    /** The halfway-upgraded control plane: served elsewhere, no peer delegation. */
    options: { delegate?: boolean; positions?: () => { vertical: string; calls: 'on' | 'off' | 'ungranted' }[] } = {},
  ) => {
    const calls: Call[] = [];
    const reads: { tenantId: string; scopeId: string }[] = [];
    const delegate = options.delegate ?? true;
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      ...(delegate
        ? {
            peerSwitchDelegation: {
              // #2045 (Codex r3): a deployment built with the switch fence.
              fenceSupported: async () => true,
              switch: async (a) => {
                calls.push({ ...a });
                const out = answer(a);
                // #2045: a current deployment honours the fence, and says so.
                return {
                  ...out,
                  permissions: out.permissions.map((p) => permissionKey.parse(p)),
                  ...(a.fence !== undefined ? { fenced: true as const } : {}),
                };
              },
              status: async (a) => {
                reads.push({ ...a });
                return (options.positions ?? (() => []))().map((p) => peerGrantsEntry.parse(p));
              },
            },
          }
        : {
            // Another delegation, so the host still knows it serves scopes elsewhere — a
            // control plane upgraded for the schedule switch and not yet for this one.
            systemSwitchDelegation: {
              // #2045 (Codex r3): a deployment built with the switch fence.
              fenceSupported: async () => true,
              switch: async () => {
                throw new Error('the schedule switch must not be reached by a peer switch');
              },
              status: async () => {
                throw new Error('not exercised by this fixture');
              },
            },
          }),
    });
    host.registerModule(peerMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `peers-${t.slice(-10).toLowerCase()}`, name: 'Peers' });
    await host.admin.grantEntitlement(staff, t, 'peer');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, ...(vertical ? { vertical } : {}) });
    await host.admin.activateScope(staff, t, s);
    const audit = () =>
      host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['revokeFromPeer', 'restoreToPeer'] });
    /**
     * A host over the SAME namespace with no delegation at all — so `peerScopeGate` lets it
     * through to the placeholder DO and it can be asked what that DO actually holds. The
     * gated host cannot answer this: with a delegation set it refuses to read a scope it
     * knows is served elsewhere, which is the behaviour, not a limitation of the fixture.
     */
    const placeholder = () => {
      const plain = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
      plain.registerModule(peerMod);
      return plain;
    };
    return { host, t, s, calls, reads, audit, placeholder };
  };

  const rows = async (
    audit: () => Promise<{ action: string; vertical: string | null; after: unknown }[]>,
  ): Promise<Record<string, unknown>[]> =>
    (await audit()).map((e) => ({ action: e.action, vertical: e.vertical, ...(e.after as Record<string, unknown>) }));

  it('delegates the write, leaves the placeholder alone, and audits intent then outcome here, with the reason', async () => {
    const { host, t, s, calls, audit, placeholder } = await setup(() => ({
      held: true,
      changed: true,
      permissions: ['peer:read', 'peer:write'],
    }));
    const result = await host.admin.revokeFromPeer(staff, {
      vertical: PEER_CALLER,
      node: { tenantId: t, scopeId: s },
      reason: 'the CRM is leaking',
    });
    expect(result).toEqual({
      operationId: expect.any(String),
      vertical: PEER_CALLER,
      calls: 'off',
      changed: true,
      permissions: [READ, WRITE],
    });
    expect(calls).toEqual([{ tenantId: t, scopeId: s, vertical: PEER_CALLER, to: 'off', tenantHeld: false, fence: result.operationId }]);
    // The placeholder DO still holds the peer's live grants: nothing was written here.
    expect(await placeholder().peerCovers(t, s, PEER_CALLER, [READ, WRITE])).toEqual([
      { permission: READ, held: true },
      { permission: WRITE, held: true },
    ]);
    // Two different verticals are in play and both are recorded: the admin ROW's `vertical`
    // column is the scope's own vertical (whose data was reached), and the payload's
    // `vertical` is the PEER that was switched. A flattened view collapses them, so they are
    // asserted apart — an audit that named only one of the two would not say who did what to
    // whom.
    expect((await audit()).map((e) => e.vertical)).toEqual(['peer-vertical', 'peer-vertical']);
    const common = { action: 'revokeFromPeer', operationId: result.operationId, vertical: PEER_CALLER, calls: 'off' };
    expect(await rows(audit)).toEqual([
      { ...common, phase: 'intent', reason: 'the CRM is leaking' },
      { ...common, phase: 'applied', changed: true, permissions: [READ, WRITE] },
    ]);

    await host.admin.restoreToPeer(staff, { vertical: PEER_CALLER, node: { tenantId: t, scopeId: s }, reason: 'ok' });
    expect(calls.at(-1)).toEqual({ tenantId: t, scopeId: s, vertical: PEER_CALLER, to: 'on', tenantHeld: false, fence: expect.any(String) });
    expect((await rows(audit)).map((r) => [r.action, r.phase])).toEqual([
      ['revokeFromPeer', 'intent'],
      ['revokeFromPeer', 'applied'],
      ['restoreToPeer', 'intent'],
      ['restoreToPeer', 'applied'],
    ]);
  });

  it('a far end that holds nothing is a 404 audited as refused, and a no-op is still audited', async () => {
    let held = false;
    const { host, t, s, audit } = await setup(() => ({ held, changed: false, permissions: [] }));
    const input = { vertical: PEER_CALLER, node: { tenantId: t, scopeId: s }, reason: 'r' };
    const refused = await host.admin.revokeFromPeer(staff, input).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorCodeOf(refused)).toBe('not_found');
    held = true;
    expect(await host.admin.revokeFromPeer(staff, input)).toMatchObject({ changed: false });
    expect((await rows(audit)).map((r) => [r.phase, r.changed])).toEqual([
      ['intent', undefined],
      ['refused', false],
      ['intent', undefined],
      ['applied', false],
    ]);
  });

  it('a far end that fails fails the verb, and the audit shows the intent and the failure', async () => {
    const { host, t, s, audit } = await setup(() => {
      throw new Error('vertical unreachable during peer-switch: Durable Object reset');
    });
    await expect(
      host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node: { tenantId: t, scopeId: s }, reason: 'r' }),
    ).rejects.toThrow(/unreachable/);
    const log = await rows(audit);
    expect(log.map((r) => r.phase)).toEqual(['intent', 'failed']);
    expect(log[1]).toMatchObject({ operationId: log[0]!.operationId, error: expect.stringMatching(/unreachable/) });
  });

  it('a scope bound to no vertical is switched locally, never through the delegation', async () => {
    const { host, t, s, calls } = await setup(() => {
      throw new Error('no deployment serving scope (the delegation must not be reached)');
    }, null);
    const node = { tenantId: t, scopeId: s };
    expect(await host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason: 'r' })).toMatchObject({
      calls: 'off',
      changed: true,
    });
    // Switched HERE, which is where this scope's store is: the peer now holds nothing.
    expect((await host.peerCovers(t, s, PEER_CALLER, [READ, WRITE])).every((c) => !c.held)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('twin: a scope WITH a vertical and no serving deployment still reaches the delegation, and fails loudly', async () => {
    const { host, t, s, calls, audit } = await setup(() => {
      throw new Error(`no deployment serving scope (vertical 'peer-vertical') — cannot switch peer off`);
    });
    await expect(
      host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node: { tenantId: t, scopeId: s }, reason: 'r' }),
    ).rejects.toThrow(/no deployment serving scope/);
    // #2045: the move and its one retry, under the same fence.
    const call = { tenantId: t, scopeId: s, vertical: PEER_CALLER, to: 'off', tenantHeld: false, fence: expect.any(String) };
    expect(calls).toEqual([call, call]);
    expect((await rows(audit)).map((r) => r.phase)).toEqual(['intent', 'failed']);
  });

  it('a control plane with no peer delegation still refuses a scope served elsewhere, rather than switching the placeholder', async () => {
    const { host, t, s, placeholder } = await setup(() => ({ held: true, changed: true, permissions: [] }), 'peer-vertical', {
      delegate: false,
    });
    const refused = await host.admin
      .revokeFromPeer(staff, { vertical: PEER_CALLER, node: { tenantId: t, scopeId: s }, reason: 'r' })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(errorCodeOf(refused)).toBe('unavailable');
    // And the placeholder was not touched: the peer still holds what it held.
    expect(await placeholder().peerCovers(t, s, PEER_CALLER, [READ])).toEqual([{ permission: READ, held: true }]);
  });

  it('the status read is delegated too, and the admin log explains each OFF peer here', async () => {
    const { host, t, s, reads, audit } = await setup(
      () => ({ held: true, changed: true, permissions: ['peer:read'] }),
      'peer-vertical',
      {
        positions: () => [
          { vertical: PEER_CALLER, calls: 'off' },
          { vertical: PEER_LISTENER, calls: 'on' },
        ],
      },
    );
    await host.admin.revokeFromPeer(staff, {
      vertical: PEER_CALLER,
      node: { tenantId: t, scopeId: s },
      reason: 'incident 7',
    });
    const status = await host.admin.peerGrantsStatus(staff, { tenantId: t, scopeId: s });
    // The POSITION came from the deployment; the EXPLANATION came from the admin log here.
    expect(reads).toEqual([{ tenantId: t, scopeId: s }]);
    expect(status).toEqual([
      {
        vertical: PEER_CALLER,
        calls: 'off',
        switchedOff: { actor: staff, reason: 'incident 7', at: expect.any(String) },
      },
      { vertical: PEER_LISTENER, calls: 'on', switchedOff: null },
    ]);
    // And the explanation is the one still in force: a FAILED attempt never explains a peer.
    expect((await audit()).length).toBe(2);
  });

  it('a hosted scope with no peer delegation refuses the read rather than answering the placeholder', async () => {
    const { host, t, s } = await setup(() => ({ held: true, changed: true, permissions: [] }), 'peer-vertical', {
      delegate: false,
    });
    const refused = await host.admin.peerGrantsStatus(staff, { tenantId: t, scopeId: s }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorCodeOf(refused)).toBe('unavailable');
    expect(String(refused)).toMatch(/no delegation configured/);
  });

  it('a scope bound to no vertical is read locally, and sees what provisioning seated', async () => {
    const { host, t, s, reads } = await setup(() => ({ held: true, changed: true, permissions: [] }), null);
    expect(await host.admin.peerGrantsStatus(staff, { tenantId: t, scopeId: s })).toEqual([
      { vertical: PEER_CALLER, calls: 'on', switchedOff: null },
      { vertical: PEER_LISTENER, calls: 'on', switchedOff: null },
    ]);
    expect(reads).toEqual([]);
  });

  /**
   * #2029: the switch is recorded in the directory before the far end moves, as the module
   * switch is (#1674), so every carry's re-assert can put it back; and (#2030) the directory's
   * tenant-level grant rides to the far end as `tenantHeld`.
   */
  it('#2029: OFF is recorded, carried, and re-asserted through the delegation; ON clears the record', async () => {
    const { host, t, s, calls } = await setup(() => ({ held: true, changed: true, permissions: [] }));
    const node = { tenantId: t, scopeId: s };
    const off = await host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason: 'r' });
    expect(await host.admin.peerSwitchCarry(staff, node)).toEqual({
      switchedOffPeers: [PEER_CALLER],
      tenantHeldPeers: [],
      fences: { [PEER_CALLER]: off.operationId },
    });
    expect(await host.admin.reassertSystemSwitches(staff, node)).toEqual([
      { vertical: PEER_CALLER, held: true, changed: true },
    ]);
    expect(calls.at(-1)).toEqual({ tenantId: t, scopeId: s, vertical: PEER_CALLER, to: 'off', tenantHeld: false, fence: off.operationId });
    const reasserted = await host.admin.auditLog(staff, { tenantId: t, scopeId: s, action: ['reassertPeerSwitch'] });
    expect(reasserted.map((e) => e.after)).toEqual([
      expect.objectContaining({ vertical: PEER_CALLER, calls: 'off', phase: 'applied', changed: true }),
    ]);
    await host.admin.restoreToPeer(staff, { vertical: PEER_CALLER, node, reason: 'ok' });
    expect(await host.admin.peerSwitchCarry(staff, node)).toEqual({ switchedOffPeers: [], tenantHeldPeers: [], fences: {} });
    const before = calls.length;
    expect(await host.admin.reassertSystemSwitches(staff, node)).toEqual([]);
    expect(calls.length).toBe(before);
  });

  /** A tenant-level `vertical:` grant in the directory, as no platform verb writes one yet (#2030). */
  const seatTenantGrant = async (host: CloudflareScopeHost, t: string, vertical: string) => {
    const cp = (host as unknown as { cp: { writeTenantTuple(...a: unknown[]): Promise<unknown> } }).cp;
    await cp.writeTenantTuple(t, `vertical:${vertical}`, 'granted:peer:read', `tenant:${t}`, null);
  };

  it('#2030: a deployment built before tenantHeld answers held:false for a tenant-only peer — not_found, nothing recorded', async () => {
    // What an older deployment does: it strips `tenantHeld`, and finds nothing on the scope.
    const { host, t, s, calls } = await setup(() => ({ held: false, changed: false, permissions: [] }));
    await seatTenantGrant(host, t, PEER_CALLER);
    const node = { tenantId: t, scopeId: s };
    const refused = await host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason: 'r' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorCodeOf(refused)).toBe('not_found');
    // The platform did ask with the directory's answer; the far end could not use it.
    expect(calls).toEqual([{ tenantId: t, scopeId: s, vertical: PEER_CALLER, to: 'off', tenantHeld: true, fence: expect.any(String) }]);
    expect(await host.admin.peerSwitchCarry(staff, node)).toEqual({ switchedOffPeers: [], tenantHeldPeers: [], fences: {} });
  });

  it('#2030 twin: a current deployment holds it — recorded, and carried as tenant-held', async () => {
    const { host, t, s, calls } = await setup(() => ({ held: true, changed: true, permissions: [] }));
    await seatTenantGrant(host, t, PEER_CALLER);
    const node = { tenantId: t, scopeId: s };
    await expect(host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason: 'r' })).resolves.toMatchObject({
      calls: 'off',
    });
    expect(calls.at(-1)).toMatchObject({ tenantHeld: true });
    expect(await host.admin.peerSwitchCarry(staff, node)).toEqual({
      switchedOffPeers: [PEER_CALLER],
      tenantHeldPeers: [PEER_CALLER],
      fences: { [PEER_CALLER]: expect.any(String) },
    });
  });

  it('#2045: a move that throws once and lands on its retry succeeds, under the same fence', async () => {
    let throws = 1;
    const { host, t, s, calls } = await setup(() => {
      if (throws-- > 0) throw new Error('connection reset');
      return { held: true, changed: true, permissions: [] };
    });
    const node = { tenantId: t, scopeId: s };
    await expect(host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason: 'r' })).resolves.toMatchObject({
      calls: 'off',
    });
    expect(calls.map((c) => [c.to, (c as { fence?: string }).fence])).toEqual([
      ['off', (calls[0] as { fence?: string }).fence],
      ['off', (calls[0] as { fence?: string }).fence],
    ]);
  });

  it('#2045: an OFF whose move throws twice keeps its record and is owed a re-assert', async () => {
    const { host, t, s, audit } = await setup(() => {
      throw new Error('unreachable');
    });
    const node = { tenantId: t, scopeId: s };
    await expect(host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason: 'r' })).rejects.toThrow(/unreachable/);
    expect(await host.admin.peerSwitchCarry(staff, node)).toEqual({
      switchedOffPeers: [PEER_CALLER],
      tenantHeldPeers: [],
      fences: { [PEER_CALLER]: expect.any(String) },
    });
    expect((await rows(audit)).at(-1)).toMatchObject({ phase: 'failed', recordKept: true, reassertOwed: true });
  });

  it('#2045: an ON whose move throws twice keeps its record, and the re-assert it is owed moves the scope ON', async () => {
    let fail = false;
    const position = { calls: 'on' as 'on' | 'off' };
    const { host, t, s, calls } = await setup(
      (a) => {
        if (fail) throw new Error('unreachable');
        position.calls = a.to;
        return { held: true, changed: true, permissions: [] };
      },
      'peer-vertical',
      { positions: () => [{ vertical: PEER_CALLER, calls: position.calls }] },
    );
    const node = { tenantId: t, scopeId: s };
    await host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason: 'r' });
    fail = true;
    const on = await host.admin
      .restoreToPeer(staff, { vertical: PEER_CALLER, node, reason: 'ok' })
      .then(() => null, (e: unknown) => e);
    expect(String(on)).toMatch(/unreachable/);
    expect(position.calls).toBe('off');
    expect(await host.admin.peerSwitchCarry(staff, node)).toEqual({ switchedOffPeers: [], tenantHeldPeers: [], fences: {} });
    fail = false;
    await host.admin.reassertSystemSwitches(staff, node);
    expect(position.calls).toBe('on');
    const onFence = (calls.at(-2) as { fence?: string }).fence; // the failed ON's own fence
    expect(calls.at(-1)).toMatchObject({ to: 'on', fence: onFence });
  });

  it('refuses a scope the directory does not have before reaching anything', async () => {
    const { host, t, calls } = await setup(() => ({ held: true, changed: true, permissions: [] }));
    const refused = await host.admin
      .revokeFromPeer(staff, { vertical: PEER_CALLER, node: { tenantId: t, scopeId: scopeId.parse(ulid()) }, reason: 'r' })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(errorCodeOf(refused)).toBe('not_found');
    expect(calls).toEqual([]);
  });
});

/**
 * #2029: a PITR rewind to a bookmark from before a peer was switched off brings the peer's grants
 * back live and its marker gone. The rewind captures the scope's off PEERS beside its off modules
 * and holds them on the deployment's hold object (#1819's), and every peer door — an invoke, a
 * coverage read, a delivery — reads that hold after the scope's own state, pinned to the instance
 * the state came from (#1834's door). So the peer is refused from the first call after the
 * rewind, before any reconcile has re-asserted the record, until the switch is applied again.
 */
describe('#2029 — a PITR rewind to before a peer switch admits nothing until the switch is back', { timeout: 20_000 }, () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const READ = permissionKey.parse('peer:read');
  const WRITE = permissionKey.parse('peer:write');
  const t = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const roles = [{ key: 'office-admin', permissions: [READ, WRITE], source: 'vertical' as const }];
  const caller = { vertical: PEER_CALLER, scope: scopeId.parse(ulid()) };

  /** A deployment's host, CP-less, as a pushed vertical runs. `peers: false` registers no peer module. */
  const hostFor = (peers = true) => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE });
    if (peers) host.registerModule(peerMod);
    return host;
  };
  const provision = (s: ReturnType<typeof scopeId.parse>, host = hostFor(), extra: Record<string, unknown> = {}) =>
    host.provisionScopeLocal({ tenantId: t, scopeId: s, owner, roles, ownerRoleKey: 'office-admin', ...extra });
  const newScope = async (peers = true) => {
    const s = scopeId.parse(ulid());
    await provision(s, hostFor(peers));
    return s;
  };
  const heldOn = async (s: string) =>
    (await holdsStub(env.SCOPE).switchHoldsAll()).filter((h) => h.scopeId === s).map((h) => h.moduleId);
  const refusal = (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => undefined,
      (e: unknown) => e,
    );
  const invoke = (s: ReturnType<typeof scopeId.parse>) => hostFor().verticalInvokeLocal(caller, t, s, 'peer/list');
  const deliver = (s: ReturnType<typeof scopeId.parse>, vertical: string) =>
    hostFor().deliverToPeer(
      t,
      s,
      importBatch.parse({ source: { vertical, scopeId: caller.scope }, after: null, next: ulid(), events: [], withheld: [] }),
    );

  /** Switch the peer off (or not), then rewind to a bookmark taken before that. */
  const rewoundPastTheSwitch = async (switchOff = true): Promise<ReturnType<typeof scopeId.parse>> => {
    const s = await newScope();
    const atBookmark = await hostFor().exportScopeLocal(s);
    if (switchOff) await hostFor().peerSwitchLocal(s, PEER_CALLER, 'off');
    await armRewind(env.SCOPE, s);
    await hostFor().rewindScopeLocal(s, 'bm-before-switch', { force: true });
    await landRewind(env.SCOPE, s, atBookmark);
    // The rewound storage really has the switch undone: the state the issue is about.
    expect((await hostFor().peerGrantsStatusLocal(s)).find((p) => p.vertical === PEER_CALLER)?.calls).toBe('on');
    return s;
  };

  it('every peer door refuses the rewound peer before any reconcile: invoke, coverage, delivery', async () => {
    const s = await rewoundPastTheSwitch();
    expect(await heldOn(s)).toEqual([`vertical:${PEER_CALLER}`]);
    const err = await refusal(invoke(s));
    expect(errorCodeOf(err)).toBe('forbidden');
    expect(String(err)).toMatch(/held off on this scope/);
    expect(await hostFor().peerCovers(t, s, PEER_CALLER, [READ, WRITE])).toEqual([
      { permission: READ, held: false },
      { permission: WRITE, held: false },
    ]);
    expect((await deliver(s, PEER_CALLER)).paused?.reason).toMatch(/held off on this scope/);
    // Per peer: the one never switched off holds its key and is delivered to.
    expect(await hostFor().peerCovers(t, s, PEER_LISTENER, [READ])).toEqual([{ permission: READ, held: true }]);
    expect((await deliver(s, PEER_LISTENER)).paused).toBeNull();
  });

  it('twin: nothing switched off — the rewind holds nothing, and the peer is admitted', async () => {
    const s = await rewoundPastTheSwitch(false);
    expect(await heldOn(s)).toEqual([]);
    await expect(invoke(s)).resolves.toBeDefined();
    expect((await deliver(s, PEER_CALLER)).paused).toBeNull();
  });

  it('ON releases the hold, and the peer is admitted again', async () => {
    const s = await rewoundPastTheSwitch();
    await hostFor().peerSwitchLocal(s, PEER_CALLER, 'on');
    expect(await heldOn(s)).toEqual([]);
    await expect(invoke(s)).resolves.toBeDefined();
    expect(await hostFor().peerCovers(t, s, PEER_CALLER, [READ])).toEqual([{ permission: READ, held: true }]);
  });

  it('the reconcile carries the record back in, and its re-assert releases the hold onto the marker', async () => {
    const s = await rewoundPastTheSwitch();
    // The platform's reconcile: the record rides in, switched off in the seat's own unit.
    const reconciled = await provision(s, hostFor(), { switchedOffPeers: [PEER_CALLER] });
    expect(reconciled).toEqual({
      switchedOff: [{ vertical: PEER_CALLER, held: true, changed: true, permissions: [READ, WRITE] }],
    });
    // Then its re-assert, the move every carry ends with, lands on the restored storage.
    expect(await hostFor().peerSwitchLocal(s, PEER_CALLER, 'off')).toMatchObject({ held: true, changed: false });
    expect(await heldOn(s)).toEqual([]);
    // Refused by the scope's own marker now, not by the hold.
    const err = await refusal(invoke(s));
    expect(String(err)).toMatch(/switched off on this scope/);
    await hostFor().peerSwitchLocal(s, PEER_CALLER, 'on');
    await expect(invoke(s)).resolves.toBeDefined();
  });

  /**
   * #1834's own case, for the peer door: a stub opened BEFORE the rewind read its gate on the
   * instance the rewind then discards. Its next call lands on the restarted instance, which
   * refuses the stale pin, and the door gates again — on the rewound storage, against the hold.
   */
  it('a peer stub opened before the rewind is refused after it, by the re-gate the pin forces', async () => {
    const s = await newScope();
    // Gated now: on, not held. (Not invoked yet: a stub that has already reached the instance the
    // rewind aborts is broken by the abort itself, which is not what this case is about.)
    const early = await hostFor().getVerticalScope(caller, t, s);
    const atBookmark = await hostFor().exportScopeLocal(s);
    await hostFor().peerSwitchLocal(s, PEER_CALLER, 'off');
    await armRewind(env.SCOPE, s);
    await hostFor().rewindScopeLocal(s, 'bm-before-switch', { force: true });
    await landRewind(env.SCOPE, s, atBookmark);
    expect(String(await refusal(early.invoke('peer/list')))).toMatch(/held off on this scope/);
    // Twin: once the switch is applied again, a door opened now runs. (The early one keeps the
    // hold it read, as #1834's system door does: stale only ever in the refusing direction.)
    await hostFor().peerSwitchLocal(s, PEER_CALLER, 'on');
    await expect(invoke(s)).resolves.toBeDefined();
  });

  /**
   * #2030 × #2029: a peer held on the scope only by a tenant-level grant has no row there, so a
   * rewind to before its switch leaves it `ungranted`, not `on`, while the tenant grant still
   * authorizes it. The door reads the hold for any subject not already off.
   */
  it('a peer with no row on the scope (tenant-held) is held too once rewound', async () => {
    const s = await newScope(false); // provisioned with no peer module: no peer rows at all
    const atBookmark = await hostFor().exportScopeLocal(s);
    expect(await hostFor().peerSwitchLocal(s, PEER_CALLER, 'off', { tenantHeld: true })).toMatchObject({
      held: true,
      changed: true,
      permissions: [],
    });
    await armRewind(env.SCOPE, s);
    await hostFor().rewindScopeLocal(s, 'bm-before-switch', { force: true });
    await landRewind(env.SCOPE, s, atBookmark);
    expect(await hostFor().peerGrantsStatusLocal(s)).toEqual([]);
    expect(await heldOn(s)).toEqual([`vertical:${PEER_CALLER}`]);
    expect(String(await refusal(invoke(s)))).toMatch(/held off on this scope/);
  });

  it('twin: the same scope with nothing switched is not held, and the call meets its own check', async () => {
    const s = await newScope(false);
    expect(await heldOn(s)).toEqual([]);
    expect(errorCodeOf(await refusal(invoke(s)))).toBe('permission_denied');
  });
});

/**
 * #2045 on workerd: two switch calls on one subject that overlap, through the real hosted path —
 * the shared control plane's host records each call in its directory and moves the scope in the
 * deployment serving it, over the delegations, where a real ScopeDO applies (or refuses) the move.
 * Each delegation can be held, which places the interleavings; the control plane's namespace can be
 * held at the record write, which places the one where the OLDER call writes its record last.
 */
describe('#2045 — overlapping switch calls end with the record and the scope agreeing', { timeout: 20_000 }, () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));
  const staff = platformActorId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  const READ = permissionKey.parse('peer:read');

  /** What the platform carries into a deployment's unit: the record's off subjects and their fences. */
  type Carry = { modules: ModuleId[]; peers: string[]; fences: Record<string, string> };
  const switchCarryOf = async (platform: CloudflareScopeHost, node: { tenantId: TenantId; scopeId: ScopeId }) => {
    const carry = await switchCarryFor(platform.admin, staff, node);
    return { modules: carry.switchedOff ?? [], peers: carry.switchedOffPeers ?? [], fences: carry.switchFences ?? {} };
  };

  /** What a switch call did that matters here: its preflight, its record write and its moves. */
  const effects = (seen: readonly string[], move: string) =>
    seen.filter((m) => m === 'fence-probe' || m.startsWith('recordSwitched') || m.startsWith(move));

  /** Hold the next call matching `match` until `release`; `reached` resolves when it arrives. */
  type Gate = {
    match: (method: string, to?: string) => boolean;
    reached: () => void;
    wait: Promise<void>;
    /** Throw instead of passing — a move that fails before the deployment applies it. */
    throws?: boolean;
  };
  const gate = (match: Gate['match']) => {
    let reached!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((r) => (reached = r));
    const wait = new Promise<void>((r) => (release = r));
    return { gate: { match, reached, wait } as Gate, arrived, release };
  };

  /** `legacy`: the deployment is a build from before the fence — it never sees `fence`, and never answers `fenced`. */
  const setup = async (opts: { legacy?: boolean } = {}) => {
    const gates: Gate[] = [];
    const wire = <T extends { fenced?: true }>(out: T): T => {
      if (!opts.legacy) return out;
      const { fenced: _dropped, ...old } = out;
      return old as T;
    };
    /** Every gated call that reached its far end, in order: the moves, the probes, the record writes. */
    const seen: string[] = [];
    /** Control-plane methods that throw for as long as they are listed — a directory RPC that fails. */
    const failing = new Set<string>();
    /** Run once, right AFTER the named directory read returns — a write landing between two reads. */
    const after = new Map<string, { match: (args: unknown[]) => boolean; run: () => Promise<void> }>();
    const pass = async (method: string, to?: string) => {
      if (failing.has(method)) throw new Error(`directory unreachable during ${method}`);
      seen.push(to ? `${method}:${to}` : method);
      const i = gates.findIndex((g) => g.match(method, to));
      if (i < 0) return;
      const [g] = gates.splice(i, 1);
      g!.reached();
      if (g!.throws) throw new Error('unreachable: the move failed before it applied');
      await g!.wait;
    };
    const deployment = new CloudflareScopeHost({ scope: env.SCOPE });
    deployment.registerModule(peerMod);
    deployment.registerModule(scheduleMod);
    // The control plane's namespace, with its record writes passable through the gates.
    const cpNs = {
      idFromName: (name: string) => env.CONTROL_PLANE.idFromName(name),
      get: (id: DurableObjectId) => {
        const real = env.CONTROL_PLANE.get(id) as unknown as Record<string, (...a: unknown[]) => unknown>;
        return new Proxy(real, {
          get: (target, prop) => {
            const value = target[prop as string];
            if (typeof value !== 'function') return value;
            return async (...a: unknown[]) => {
              await pass(String(prop));
              const out = await target[prop as string]!(...a);
              const hook = after.get(String(prop));
              if (hook?.match(a)) {
                after.delete(String(prop));
                await hook.run();
              }
              return out;
            };
          },
        });
      },
    } as unknown as DurableObjectNamespace;
    const platform = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: cpNs,
      peerSwitchDelegation: {
        switch: async (a) => {
          await pass('peer-move', a.to);
          const fence = opts.legacy ? undefined : a.fence;
          return wire(await deployment.peerSwitchLocal(a.scopeId, a.vertical, a.to, { tenantHeld: a.tenantHeld, fence }));
        },
        status: async (a) => deployment.peerGrantsStatusLocal(a.scopeId),
        // #2045 (Codex r3): the preflight — a build from before the fence has no such route.
        fenceSupported: async () => {
          await pass('fence-probe');
          return !opts.legacy;
        },
      },
      systemSwitchDelegation: {
        switch: async (a) => {
          await pass('system-move', a.to);
          const fence = opts.legacy ? undefined : a.fence;
          return wire(await deployment.systemSwitchLocal(a.scopeId, a.moduleId, a.to, { tenantHeld: a.tenantHeld, fence }));
        },
        status: async (a) => deployment.systemGrantsStatusLocal(a.scopeId),
        fenceSupported: async () => {
          await pass('fence-probe');
          return !opts.legacy;
        },
      },
    });
    platform.registerModule(peerMod);
    platform.registerModule(scheduleMod);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await platform.admin.createTenant(staff, { id: t, slug: `fence-${t.slice(-10).toLowerCase()}`, name: 'Fence' });
    await platform.admin.grantEntitlement(staff, t, 'peer');
    await platform.admin.grantEntitlement(staff, t, 'sched');
    await platform.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'fence-vertical' });
    await platform.admin.activateScope(staff, t, s);
    const provisionInput = {
      tenantId: t,
      scopeId: s,
      owner: principalId.parse(ulid()),
      roles: [{ key: 'office-admin', permissions: [READ], source: 'vertical' as const }],
      ownerRoleKey: 'office-admin',
    };
    await deployment.provisionScopeLocal(provisionInput);
    const node = { tenantId: t, scopeId: s };
    const kinds = {
      peer: {
        move: 'peer-move',
        switch: (to: 'on' | 'off', reason: string = to) =>
          to === 'off'
            ? platform.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason })
            : platform.admin.restoreToPeer(staff, { vertical: PEER_CALLER, node, reason }),
        recorded: async () =>
          (await platform.admin.peerSwitchCarry(staff, node)).switchedOffPeers.includes(PEER_CALLER) ? 'off' : 'on',
        scope: async () => (await deployment.peerGrantsStatusLocal(s)).find((p) => p.vertical === PEER_CALLER)?.calls,
        lose: () => deployment.peerSwitchLocal(s, PEER_CALLER, 'on'),
        /** The deployment's in-unit OFF, from a carry the platform read (`switchCarryFor`'s shape). */
        carry: async (c: Carry) =>
          ((await deployment.provisionScopeLocal({ ...provisionInput, switchedOffPeers: c.peers, switchFences: c.fences }))
            ?.switchedOff ?? []).filter((e) => e.vertical === PEER_CALLER),
        stale: (to: 'on' | 'off') => deployment.peerSwitchLocal(s, PEER_CALLER, to, { fence: '00000000000000000000000000' }),
      },
      system: {
        move: 'system-move',
        switch: (to: 'on' | 'off', reason: string = to) =>
          to === 'off'
            ? platform.admin.revokeFromSystem(staff, { moduleId: SCHED, node, reason })
            : platform.admin.restoreToSystem(staff, { moduleId: SCHED, node, reason }),
        recorded: async () =>
          (await platform.admin.listSystemSwitches(staff, { scopeId: s, moduleId: SCHED }))[0]?.position ?? 'on',
        scope: async () => (await deployment.systemGrantsStatusLocal(s)).find((m) => m.moduleId === SCHED)?.schedules,
        lose: () => deployment.systemSwitchLocal(s, SCHED, 'on'),
        carry: async (c: Carry) =>
          ((await deployment.provisionScopeLocal({ ...provisionInput, switchedOff: c.modules, switchFences: c.fences }))
            ?.switchedOff ?? []).filter((e) => e.moduleId === SCHED),
        stale: (to: 'on' | 'off') => deployment.systemSwitchLocal(s, SCHED, to, { fence: '00000000000000000000000000' }),
      },
    };
    const settle = (p: Promise<unknown>) =>
      p.then(
        () => ({ ok: true as const, error: undefined as unknown }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    /**
     * The scope's reconcile receipt as a sweep would leave it: written, unless the directory still
     * marks a subject on it owed a re-assert (#2045 Codex r3), in which case it stays unwritten.
     */
    const receipt = async () => {
      await platform.admin.markScopeProvisioned(staff, t, s, 'v-receipt');
      return (await platform.admin.getScopeRecord(staff, t, s))?.provisionedVersionId ?? null;
    };
    return { platform, node, kinds, gates, seen, failing, after, receipt, settle, setLegacy: (legacy: boolean) => (opts.legacy = legacy) };
  };

  it('upgrade: a scope created before the fence gains its table on the next wake, and fences from then on', async () => {
    const { node, kinds } = await setup();
    const stub = env.SCOPE.get(env.SCOPE.idFromName(node.scopeId));
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec('DROP TABLE _substrat_switch_fences'); // the storage an older build left
    });
    await restartNow(env.SCOPE, node.scopeId);
    await kinds.peer.switch('off');
    const fresh = env.SCOPE.get(env.SCOPE.idFromName(node.scopeId)); // the old stub went with the abort
    const fences = await runInDurableObject(fresh, (_i, state) =>
      state.storage.sql.exec('SELECT subject FROM _substrat_switch_fences').toArray(),
    );
    expect(fences).toEqual([{ subject: `vertical:${PEER_CALLER}` }]);
    expect(await kinds.peer.stale('on')).toMatchObject({ superseded: true });
  });

  for (const kind of ['peer', 'system'] as const) {
    describe(kind, () => {
      it('A records OFF, B records ON and moves ON, THEN A moves: A is superseded, and both read ON', async () => {
        const { kinds, gates, settle } = await setup();
        const k = kinds[kind];
        const holdA = gate((m, to) => m === k.move && to === 'off');
        gates.push(holdA.gate);
        const a = settle(k.switch('off', 'A'));
        await holdA.arrived; // A's record is written; its move waits here
        expect((await settle(k.switch('on', 'B'))).ok).toBe(true);
        holdA.release();
        const outcomeA = await a;
        expect(errorCodeOf(outcomeA.error)).toBe('conflict');
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
      });

      it('twin, in order: A moves OFF before B moves ON — both succeed, both read ON', async () => {
        const { kinds, gates, settle } = await setup();
        const k = kinds[kind];
        const holdA = gate((m, to) => m === k.move && to === 'off');
        const holdB = gate((m, to) => m === k.move && to === 'on');
        gates.push(holdA.gate, holdB.gate);
        const a = settle(k.switch('off', 'A'));
        await holdA.arrived;
        const b = settle(k.switch('on', 'B'));
        await holdB.arrived;
        holdA.release();
        expect((await a).ok).toBe(true);
        holdB.release();
        expect((await b).ok).toBe(true);
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
      });

      it('the OLDER call writes its record last: refused there, before it moves anything', async () => {
        const { kinds, gates, settle } = await setup();
        const k = kinds[kind];
        await k.switch('off');
        await k.switch('on');
        const holdRecord = gate((m) => m === 'recordSwitchedOff');
        gates.push(holdRecord.gate);
        const a = settle(k.switch('off', 'A')); // its operation id is minted; its record write waits
        await holdRecord.arrived;
        expect((await settle(k.switch('on', 'B'))).ok).toBe(true);
        holdRecord.release();
        expect(errorCodeOf((await a).error)).toBe('conflict');
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
      });

      it('an in-unit carry from a stale list leaves the newer call’s position; under the current fence it applies', async () => {
        const { platform, node, kinds } = await setup();
        const k = kinds[kind];
        await k.switch('off');
        const carry = await switchCarryOf(platform, node); // the list, as the platform read it
        await k.switch('on'); // a newer call lands before the carry does
        expect(await k.carry(carry)).toMatchObject([{ superseded: true, changed: false }]);
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
        // Twin: the same carry, read now, names nothing off; and an OFF read now applies.
        await k.switch('off');
        await k.lose();
        expect(await k.carry(await switchCarryOf(platform, node))).toMatchObject([{ held: true, changed: true }]);
        expect(await k.scope()).toBe('off');
      });

      it('a first-ever ON (no row yet) beats an OLDER OFF that records after it (Codex r2)', async () => {
        const { kinds, gates, settle } = await setup();
        const k = kinds[kind];
        const holdRecord = gate((m) => m === 'recordSwitchedOff');
        gates.push(holdRecord.gate);
        const a = settle(k.switch('off', 'A')); // minted first; its record write waits
        await holdRecord.arrived;
        expect((await settle(k.switch('on', 'B'))).ok).toBe(true); // no row before it: it writes one
        holdRecord.release();
        expect(errorCodeOf((await a).error)).toBe('conflict');
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
      });

      it('a NEWER move that throws before applying, behind an OLDER move: the re-assert it is owed settles both on the newer (Codex r2)', async () => {
        const { platform, node, kinds, gates, settle } = await setup();
        const k = kinds[kind];
        const holdA = gate((m, to) => m === k.move && to === 'off');
        gates.push(holdA.gate);
        const a = settle(k.switch('off', 'A'));
        await holdA.arrived; // A has recorded OFF; its move waits
        // B records ON, then its move throws before applying — and so does its one retry.
        for (let i = 0; i < 2; i++) {
          const failB = gate((m, to) => m === k.move && to === 'on');
          failB.gate.throws = true;
          gates.push(failB.gate);
        }
        expect(String((await settle(k.switch('on', 'B'))).error)).toMatch(/unreachable/);
        holdA.release();
        expect((await a).ok).toBe(true); // nothing at the scope says B ever came
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'off']); // apart — until the owed re-assert
        await platform.admin.reassertSystemSwitches(staff, node);
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
        // Settled: a later re-assert leaves it.
        await platform.admin.reassertSystemSwitches(staff, node);
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
      });

      it('the NEWER move fails twice and the re-assert runs while the OLDER move is still held: the record and the scope end on the newer (Codex r3)', async () => {
        const { platform, node, kinds, gates, settle, receipt } = await setup();
        const k = kinds[kind];
        const holdA = gate((m, to) => m === k.move && to === 'off');
        gates.push(holdA.gate);
        const a = settle(k.switch('off', 'A'));
        await holdA.arrived; // A has recorded OFF; its move waits — through the re-assert below
        for (let i = 0; i < 2; i++) {
          const failB = gate((m, to) => m === k.move && to === 'on');
          failB.gate.throws = true;
          gates.push(failB.gate);
        }
        expect(String((await settle(k.switch('on', 'B'))).error)).toMatch(/unreachable/);
        // The scope still reads ON (A has not landed), and B is owed: no receipt.
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
        expect(await receipt()).toBeNull();
        // The owed ON is sent even though the scope already reads ON: it carries B's fence there.
        await platform.admin.reassertSystemSwitches(staff, node);
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
        expect(await receipt()).toBe('v-receipt');
        holdA.release();
        expect(errorCodeOf((await a).error)).toBe('conflict'); // refused at the scope by B's fence
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
        await platform.admin.reassertSystemSwitches(staff, node);
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
      });

      it('an ON landing right after a re-assert reads the record: the OFF it sends carries the OFF\'s own fence, and the scope refuses it (CodeRabbit)', async () => {
        // Position and fence are one read. Read apart, the ON landing between them paired the OFF
        // position with the ON's fence, which the scope holds, so the stale OFF applied there and
        // left the scope off under a record of on.
        const { platform, node, kinds, after } = await setup();
        const k = kinds[kind];
        await k.switch('off', 'A');
        const landOn = { match: (a: unknown[]) => a[0] === kind, run: async () => void (await k.switch('on', 'B')) };
        for (const read of ['switchRecordStatesOf', 'switchedOffOf']) after.set(read, landOn);
        await platform.admin.reassertSystemSwitches(staff, node);
        expect(after.size).toBe(1); // the ON landed, after the re-assert's first read of the record
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
      });

      it('twin: with no ON in between, the same re-assert keeps the scope off under the OFF\'s fence', async () => {
        const { platform, node, kinds, seen } = await setup();
        const k = kinds[kind];
        await k.switch('off', 'A');
        await k.lose();
        seen.length = 0;
        await platform.admin.reassertSystemSwitches(staff, node);
        expect(seen).toContain(`${k.move}:off`);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
      });

      it('every switch call is owed until the scope confirms it: no receipt while its move is in flight, one once it lands', async () => {
        const { kinds, gates, settle, receipt } = await setup();
        const k = kinds[kind];
        const hold = gate((m, to) => m === k.move && to === 'off');
        gates.push(hold.gate);
        const a = settle(k.switch('off'));
        await hold.arrived;
        expect(await receipt()).toBeNull(); // the mark was written with the record, before the move
        hold.release();
        expect((await a).ok).toBe(true);
        expect(await receipt()).toBe('v-receipt'); // the confirmed move cleared it
      });

      it('a move that throws twice while every later directory call fails is still owed, and the next re-assert repairs it (Codex r3)', async () => {
        const { platform, node, kinds, gates, failing, settle, receipt } = await setup();
        const k = kinds[kind];
        await k.switch('off');
        for (let i = 0; i < 2; i++) {
          const fail = gate((m, to) => m === k.move && to === 'on');
          fail.gate.throws = true;
          // From the first move on, the directory is unreachable: nothing after the record write lands.
          fail.gate.reached = () => {
            failing.add('recordAdmin');
            failing.add('clearSwitchOwed');
            failing.add('markScopeProvisioned');
          };
          gates.push(fail.gate);
        }
        expect(String((await settle(k.switch('on'))).error)).toMatch(/unreachable/);
        failing.clear();
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'off']);
        expect(await receipt()).toBeNull(); // the mark landed with the record, so the sweep reconciles it
        await platform.admin.reassertSystemSwitches(staff, node);
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
        expect(await receipt()).toBe('v-receipt');
      });

      it('a move that lands but whose mark cannot be cleared still succeeds; the mark costs one idempotent re-assert', async () => {
        const { platform, node, kinds, failing, settle, receipt, seen } = await setup();
        const k = kinds[kind];
        failing.add('clearSwitchOwed');
        expect((await settle(k.switch('off'))).ok).toBe(true);
        failing.clear();
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        expect(await receipt()).toBeNull();
        seen.length = 0;
        await platform.admin.reassertSystemSwitches(staff, node);
        expect(seen).toContain(`${k.move}:off`);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        expect(await receipt()).toBe('v-receipt');
      });

      it('a deployment from before the fence is refused at the preflight: nothing is recorded, moved or owed (Codex r3)', async () => {
        const { kinds, setLegacy, settle, seen, receipt } = await setup({ legacy: true });
        const k = kinds[kind];
        expect(await receipt()).toBe('v-receipt');
        const off = await settle(k.switch('off'));
        expect(errorCodeOf(off.error)).toBe('precondition_failed');
        expect(String(off.error)).toMatch(/predates the switch fence.*Nothing was switched\./);
        expect(effects(seen, k.move)).toEqual(['fence-probe']); // no record write, no move
        expect([await k.recorded(), await k.scope()]).toEqual(['on', 'on']);
        expect(await receipt()).toBe('v-receipt'); // no mark, and the receipt was never cleared
        // Twin: the same deployment redeployed with the fence switches.
        setLegacy(false);
        expect((await settle(k.switch('off'))).ok).toBe(true);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        // And an ON on the old build is refused the same way, before it moves.
        setLegacy(true);
        seen.length = 0;
        const on = await settle(k.switch('on'));
        expect(errorCodeOf(on.error)).toBe('precondition_failed');
        expect(effects(seen, k.move)).toEqual(['fence-probe']);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
      });

      it('a rollback between the preflight and the move: refused, no compensating move, the record kept and owed (Codex r3)', async () => {
        const { platform, node, kinds, gates, setLegacy, settle, seen, receipt } = await setup();
        const k = kinds[kind];
        const hold = gate((m, to) => m === k.move && to === 'off');
        gates.push(hold.gate);
        const a = settle(k.switch('off'));
        await hold.arrived; // the preflight passed
        setLegacy(true); // the scope's version rolls back to a build from before the fence
        hold.release();
        const outcome = await a;
        expect(errorCodeOf(outcome.error)).toBe('precondition_failed');
        expect(seen.filter((m) => m.startsWith(k.move))).toEqual([`${k.move}:off`]); // nothing put back
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        expect(await receipt()).toBeNull();
        // Every re-assert refuses until the redeploy, then settles the mark.
        await expect(platform.admin.reassertSystemSwitches(staff, node)).rejects.toThrow(/predates the switch fence/);
        setLegacy(false);
        await platform.admin.reassertSystemSwitches(staff, node);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        expect(await receipt()).toBe('v-receipt');
      });

      it('two overlapping same-direction calls, with a rollback while A’s answer is held: the record and the scope never part, and nothing is admitted (Codex r3)', async () => {
        const { platform, node, kinds, gates, setLegacy, settle, seen, receipt } = await setup();
        const k = kinds[kind];
        const holdA = gate((m, to) => m === k.move && to === 'off');
        const holdB = gate((m, to) => m === k.move && to === 'off');
        gates.push(holdA.gate, holdB.gate);
        const a = settle(k.switch('off', 'A'));
        await holdA.arrived;
        const b = settle(k.switch('off', 'B'));
        await holdB.arrived;
        setLegacy(true); // both passed the preflight; the deployment rolls back under them
        holdB.release();
        expect(errorCodeOf((await b).error)).toBe('precondition_failed');
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        holdA.release(); // A's answer arrives last, as in Codex's interleaving
        expect(errorCodeOf((await a).error)).toBe('precondition_failed');
        // No compensating ON from either call: the scope stays off beside the record.
        expect(seen.filter((m) => m.startsWith(k.move))).toEqual([`${k.move}:off`, `${k.move}:off`]);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        expect(await receipt()).toBeNull();
        setLegacy(false);
        await platform.admin.reassertSystemSwitches(staff, node);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        expect(await receipt()).toBe('v-receipt');
      });

      it('a re-assert against a deployment from before the fence throws, so no receipt is recorded', async () => {
        const { platform, node, kinds, setLegacy } = await setup();
        const k = kinds[kind];
        await k.switch('off');
        setLegacy(true); // the scope's version rolled back to a build from before the fence
        await expect(platform.admin.reassertSystemSwitches(staff, node)).rejects.toThrow(/predates the switch fence/);
        expect(await k.scope()).toBe('off');
      });

      it('a stale move is refused at the scope, and moves nothing', async () => {
        const { kinds } = await setup();
        const k = kinds[kind];
        await k.switch('off');
        expect(await k.stale('on')).toMatchObject({ superseded: true, changed: false });
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
      });

      it('after the race, a scope that lost its marker is re-asserted under the record’s fence', async () => {
        const { platform, node, kinds, gates, settle } = await setup();
        const k = kinds[kind];
        await k.switch('off');
        await k.switch('on');
        const holdA = gate((m, to) => m === k.move && to === 'on');
        gates.push(holdA.gate);
        const a = settle(k.switch('on', 'A'));
        await holdA.arrived;
        expect((await settle(k.switch('off', 'B'))).ok).toBe(true);
        holdA.release();
        expect((await a).ok).toBe(false);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
        await k.lose(); // a move with no fence, as a restore of older storage would leave it
        expect(await k.scope()).toBe('on');
        await platform.admin.reassertSystemSwitches(staff, node);
        expect([await k.recorded(), await k.scope()]).toEqual(['off', 'off']);
      });
    });
  }

  it('the peer carry answers each peer with its own row\'s fence, though an ON lands right after it reads the record (CodeRabbit)', async () => {
    // Read apart, the OFF key and the fence came from two instants: the ON landing between them put
    // its own fence on the carried OFF, which the scope holds, so the carry's in-unit OFF applied.
    const { platform, node, kinds, after } = await setup();
    await kinds.peer.switch('off', 'A');
    const before = await platform.admin.peerSwitchCarry(staff, node);
    expect(before.switchedOffPeers).toEqual([PEER_CALLER]);
    const landOn = { match: (a: unknown[]) => a[0] === 'peer', run: async () => void (await kinds.peer.switch('on', 'B')) };
    for (const read of ['switchRecordStatesOf', 'switchedOffOf']) after.set(read, landOn);
    expect(await platform.admin.peerSwitchCarry(staff, node)).toEqual(before);
    expect(after.size).toBe(1); // the ON landed, after the carry's read of the record
    // Twin: the next carry reads the ON, and carries nothing.
    expect(await platform.admin.peerSwitchCarry(staff, node)).toEqual({ switchedOffPeers: [], tenantHeldPeers: [], fences: {} });
  });
});
