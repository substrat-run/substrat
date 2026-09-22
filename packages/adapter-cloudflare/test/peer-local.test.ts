import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorCodeOf, permissionKey, principalId, scopeId, tenantId } from '@substrat-run/contracts';
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
