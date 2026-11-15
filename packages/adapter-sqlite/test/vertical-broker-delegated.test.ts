/**
 * The local broker carrying a call made for a PERSON (#3161): the target's harness says who the
 * token is (its `delegated` hook, the person contract's door), and the call runs on the target as
 * that person with the token's scope as a ceiling. Not the peer door's allowlist: the plugin
 * declares the master as a peer allowlisted for nothing, so a call as the master itself would be
 * refused. The peer's admission still applies: declared, and switched on.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PEER_CLIENT_OPERATION,
  errorCodeOf,
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ScopeId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { PEER_CALLER, delegationCeilingMod, peerMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';
import { createLocalVerticalBroker, type LocalDelegatedAnswer, type LocalVerticalTargetHooks } from '../src/vertical-broker.js';

const PLUGIN = 'acme/plugin';
/** Takes peer calls from the master (`peerMod` declares it), and no call made for a person. */
const BARE = 'acme/bare';
const MASTER = PEER_CALLER;
/** Another app of the tenant, which the plugin does not declare as a peer. */
const STRANGER = 'acme/stranger';
const A = permissionKey.parse('ceiling:a');
const B = permissionKey.parse('ceiling:b');
const PEER_KEY = permissionKey.parse('ceiling:peer');
const TOKEN = 'a-delegated-token-that-must-never-be-echoed';

const refusal = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe('the local broker: a call made for a person (#3161)', () => {
  const dirs: string[] = [];
  const hostIn = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return new SqliteScopeHost({ dir });
  };
  const plugin = hostIn('substrat-delegated-plugin-');
  const bare = hostIn('substrat-delegated-bare-');
  const master = hostIn('substrat-delegated-master-');
  const stranger = hostIn('substrat-delegated-stranger-');

  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  /** Holds A and B. */
  const alice = principalId.parse(ulid());
  /** Holds B only. */
  const bob = principalId.parse(ulid());

  /** What the plugin's door answers, by token; and every call it was asked. */
  let answer: LocalDelegatedAnswer;
  const asked: Parameters<NonNullable<LocalVerticalTargetHooks['delegated']>>[0][] = [];
  const broker = createLocalVerticalBroker(
    { [PLUGIN]: plugin, [BARE]: bare, [MASTER]: master, [STRANGER]: stranger },
    {
      [PLUGIN]: {
        clientId: 'plugin-client',
        delegated: async (call) => {
          asked.push(call);
          return answer;
        },
      },
    },
  );

  let pluginScope: ScopeId;
  let callerScope: ScopeId;
  let strangerScope: ScopeId;
  const client = () => broker.clientFor({ vertical: MASTER, tenantId: t, scopeId: callerScope });
  const forPerson = (operation: string, target = PLUGIN) => client().invoke(target, operation, undefined, { onBehalf: { token: TOKEN } });

  const scopeOn = async (host: SqliteScopeHost, vertical: string): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
    await host.admin.activateScope(staff, t, s);
    return s;
  };

  beforeAll(async () => {
    // The ceiling fixture with the master declared as its peer, allowlisted for nothing.
    plugin.registerModule({
      ...delegationCeilingMod,
      manifest: moduleManifest.parse({ ...delegationCeilingMod.manifest, peers: [{ vertical: MASTER, operations: [], permissions: [PEER_KEY] }] }),
    });
    bare.registerModule(peerMod);
    for (const host of [plugin, bare, master, stranger]) {
      await host.admin.createTenant(staff, { id: t, slug: `delegated-${t.slice(-10).toLowerCase()}`, name: 'Delegated' });
    }
    await plugin.admin.grantEntitlement(staff, t, 'delegation-ceiling');
    await bare.admin.grantEntitlement(staff, t, 'peer');
    await plugin.admin.defineRole(staff, t, { key: 'both', permissions: [A, B], source: 'vertical' });
    await plugin.admin.defineRole(staff, t, { key: 'only-b', permissions: [B], source: 'vertical' });
    await plugin.admin.assignRole(staff, { principalId: alice, roleKey: 'both', node: { tenantId: t, scopeId: null } });
    await plugin.admin.assignRole(staff, { principalId: bob, roleKey: 'only-b', node: { tenantId: t, scopeId: null } });
    pluginScope = await scopeOn(plugin, PLUGIN);
    await scopeOn(bare, BARE);
    callerScope = await scopeOn(master, MASTER);
    strangerScope = await scopeOn(stranger, STRANGER);
  });

  afterAll(async () => {
    for (const host of [plugin, bare, master, stranger]) await host.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('answers which client the target is, to a caller its `peers` never names, and null for a target with none', async () => {
    await expect(client().invoke(PLUGIN, PEER_CLIENT_OPERATION)).resolves.toEqual({ clientId: 'plugin-client' });
    await expect(client().invoke(BARE, PEER_CLIENT_OPERATION)).resolves.toEqual({ clientId: null });
    // Only to a caller the broker lets reach the target at all.
    await master.admin.suspendScope(staff, t, callerScope);
    try {
      expect(errorCodeOf(await refusal(client().invoke(PLUGIN, PEER_CLIENT_OPERATION)))).toBe('forbidden');
    } finally {
      await master.admin.unsuspendScope(staff, t, callerScope);
    }
  });

  it('refuses a call made for a person to a target that takes none, though its peer door admits the caller', async () => {
    await expect(client().invoke(BARE, 'peer/list')).resolves.toBeDefined();
    const e = await refusal(forPerson('peer/list', BARE));
    expect(errorCodeOf(e)).toBe('forbidden');
    expect((e as Error).message).toBe('this app does not take calls for a person');
  });

  it('a token the target’s door refuses is forbidden in the hosted door’s words, the reason on the operator’s line only; a door that could not ask is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      answer = { admitted: false, reason: 'token-refused' };
      const e = await refusal(forPerson('ceiling/a'));
      expect(errorCodeOf(e)).toBe('forbidden');
      expect((e as Error).message).toBe('this call for a person was refused');
      answer = { admitted: false, reason: 'unavailable' };
      const u = await refusal(forPerson('ceiling/a'));
      expect(errorCodeOf(u)).toBe('unavailable');
      expect((u as Error).message).toBe('this call for a person cannot be answered now; retry');
      const lines = warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
      const at = { tenantId: t, scopeId: pluginScope, caller: MASTER };
      expect(lines).toEqual([
        { host: 'peer-on-behalf-refused', ...at, reason: 'token-refused' },
        { host: 'peer-on-behalf-refused', ...at, reason: 'unavailable' },
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  it('the caller must pass the target’s peer admission: switched off there, an admitted token runs nothing; on again, it runs', async () => {
    answer = { admitted: true, principal: alice, scope: [A], actor: 'master-client' };
    const peerSwitch = { vertical: MASTER, node: { tenantId: t, scopeId: pluginScope }, reason: 'incident' };
    await plugin.admin.revokeFromPeer(staff, peerSwitch);
    try {
      const e = await refusal(forPerson('ceiling/a'));
      expect(errorCodeOf(e)).toBe('forbidden');
      expect((e as Error).message).toContain('switched off on this scope');
    } finally {
      await plugin.admin.restoreToPeer(staff, { ...peerSwitch, reason: 'resolved' });
    }
    await expect(forPerson('ceiling/a')).resolves.toEqual({ ok: true });
  });

  it('a target that does not declare the caller as a peer refuses an admitted token', async () => {
    answer = { admitted: true, principal: alice, scope: [A], actor: 'master-client' };
    const other = broker.clientFor({ vertical: STRANGER, tenantId: t, scopeId: strangerScope });
    const e = await refusal(other.invoke(PLUGIN, 'ceiling/a', undefined, { onBehalf: { token: TOKEN } }));
    expect(errorCodeOf(e)).toBe('forbidden');
    expect((e as Error).message).toContain('not a declared peer');
  });

  it('an admitted token runs as the person, under its scope: a held key outside it is refused', async () => {
    asked.length = 0;
    answer = { admitted: true, principal: alice, scope: [A], actor: 'master-client' };
    await expect(forPerson('ceiling/a')).resolves.toEqual({ ok: true });
    expect(errorCodeOf(await refusal(forPerson('ceiling/b')))).toBe('permission_denied');
    expect(asked[0]).toEqual({
      token: TOKEN,
      caller: { vertical: MASTER, tenantId: t, scopeId: callerScope },
      target: { tenantId: t, scopeId: pluginScope },
    });
  });

  it('the person’s own grants decide: a key in the scope they do not hold is refused', async () => {
    answer = { admitted: true, principal: bob, scope: [A, B], actor: 'master-client' };
    expect(errorCodeOf(await refusal(forPerson('ceiling/a')))).toBe('permission_denied');
    await expect(forPerson('ceiling/b')).resolves.toEqual({ ok: true });
  });
});
