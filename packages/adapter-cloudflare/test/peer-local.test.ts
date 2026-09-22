import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorCodeOf, permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { PEER_CALLER, PEER_LISTENER, peerMod } from '@substrat-run/contract-tests';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

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
  type Call = { tenantId: string; scopeId: string; vertical: string; to: 'on' | 'off' };

  const setup = async (
    answer: (call: Call) => { held: boolean; changed: boolean; permissions: string[] },
    /** `null` provisions a scope bound to no vertical. */
    vertical: string | null = 'peer-vertical',
    /** The halfway-upgraded control plane: served elsewhere, no peer delegation. */
    options: { delegate?: boolean } = {},
  ) => {
    const calls: Call[] = [];
    const delegate = options.delegate ?? true;
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      ...(delegate
        ? {
            peerSwitchDelegation: {
              switch: async (a) => {
                calls.push({ ...a });
                const out = answer(a);
                return { ...out, permissions: out.permissions.map((p) => permissionKey.parse(p)) };
              },
            },
          }
        : {
            // Another delegation, so the host still knows it serves scopes elsewhere — a
            // control plane upgraded for the schedule switch and not yet for this one.
            systemSwitchDelegation: {
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
    return { host, t, s, calls, audit, placeholder };
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
    expect(calls).toEqual([{ tenantId: t, scopeId: s, vertical: PEER_CALLER, to: 'off' }]);
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
    expect(calls.at(-1)).toEqual({ tenantId: t, scopeId: s, vertical: PEER_CALLER, to: 'on' });
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
    expect(calls).toEqual([{ tenantId: t, scopeId: s, vertical: PEER_CALLER, to: 'off' }]);
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
