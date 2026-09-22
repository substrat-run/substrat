/**
 * The local peer broker (#1706): two verticals side by side on the pure host, one `SqliteScopeHost`
 * each, under the same model as the hosted path — the caller is a live primary instance of its
 * vertical, the target is resolved by slug in the caller's own tenant, and the call goes through
 * the target's peer door. Each "safe because" is paired with its twin:
 *
 * - **Revocation on uninstall/suspend.** The caller's liveness is re-read from the directory on
 *   EVERY call: suspend or archive the calling instance and its next call is refused, in every
 *   target; bring it back and it calls again. No token to revoke, no fan-out.
 * - **Tenant confinement.** The target is searched in the caller's tenant only; an instance in
 *   another tenant is never reached, and a caller cannot claim a scope of another tenant.
 * - **No preview crosses.** A preview caller is refused; a preview target is never resolved.
 * - **No person crosses.** A client speaks as one scope of one vertical and has no parameter for a
 *   principal; the target's spine names the calling instance.
 *
 * And the broker cannot be shipped: its subpath does not resolve under the Workers conditions.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { PEER_CALLER, peerMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';
import { createLocalVerticalBroker, type LocalVerticalBroker } from '../src/vertical-broker.js';

const TARGET = 'acme/crm';
const READ = permissionKey.parse('peer:read');
const WRITE = permissionKey.parse('peer:write');

const refusal = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('the local peer broker (#1706)', () => {
  const dirs: string[] = [];
  const hostIn = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return new SqliteScopeHost({ dir });
  };
  const target = hostIn('substrat-peer-target-');
  const callers = hostIn('substrat-peer-caller-');
  const broker: LocalVerticalBroker = createLocalVerticalBroker({ [TARGET]: target, [PEER_CALLER]: callers });

  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const alice: PrincipalId = principalId.parse(ulid());

  /** A scope on `host`, bound to `vertical`, active unless told otherwise. */
  const scopeOn = async (
    host: SqliteScopeHost,
    tenant: TenantId,
    vertical: string,
    extra: Record<string, unknown> = {},
  ): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical, ...extra });
    await host.admin.activateScope(staff, tenant, s);
    return s;
  };

  let crm: ScopeId; // the target instance in t
  let crmElsewhere: ScopeId; // an instance of the same vertical in `other`
  let caller: ScopeId; // the calling instance in t

  const call = (from: ScopeId, tenant: TenantId = t, id = ulid()) =>
    broker.clientFor({ vertical: PEER_CALLER, tenantId: tenant, scopeId: from }).invoke(TARGET, 'peer/note', {
      id,
      body: 'from the board room',
    });
  const outbox = async (tenant: TenantId, scope: ScopeId) =>
    (await target.getScope(alice, tenant, scope)).invoke<{ actor: string; entity_id: string }[]>('peer/outbox');

  beforeAll(async () => {
    target.registerModule(peerMod);
    // Each host holds its own directory, so each tenant exists on each — as one tenant does
    // on the platform, whichever deployment serves which of its instances.
    for (const host of [target, callers]) {
      for (const tenant of [t, other]) {
        await host.admin.createTenant(staff, {
          id: tenant,
          slug: `broker-${tenant.slice(-10).toLowerCase()}`,
          name: 'Broker',
        });
      }
    }
    for (const tenant of [t, other]) {
      await target.admin.grantEntitlement(staff, tenant, 'peer');
      await target.admin.defineRole(staff, tenant, { key: 'owner', permissions: [READ, WRITE], source: 'vertical' });
      await target.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: tenant, scopeId: null } });
    }
    crm = await scopeOn(target, t, TARGET);
    crmElsewhere = await scopeOn(target, other, TARGET);
    caller = await scopeOn(callers, t, PEER_CALLER);
  });

  afterAll(async () => {
    await target.close();
    await callers.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('a live primary instance calls the target in its own tenant, as { vertical, scope }', async () => {
    const id = ulid();
    await expect(call(caller, t, id)).resolves.toEqual({ id });
    const row = (await outbox(t, crm)).find((r) => r.entity_id === id)!;
    expect(JSON.parse(row.actor)).toEqual({ vertical: PEER_CALLER, scope: caller });
    // Tenant confinement: nothing landed in the other tenant's instance of the same vertical.
    expect((await outbox(other, crmElsewhere)).some((r) => r.entity_id === id)).toBe(false);
  });

  describe('revocation on suspend and uninstall: the caller is re-read on every call', () => {
    it('a suspended caller is refused on its next call', async () => {
      await callers.admin.suspendScope(staff, t, caller);
      expect(errorCodeOf(await refusal(call(caller)))).toBe('forbidden');
    });

    it('twin: unsuspended, it calls again — nothing was minted to re-issue', async () => {
      await callers.admin.unsuspendScope(staff, t, caller);
      await expect(call(caller)).resolves.toBeDefined();
    });

    it('an archived (uninstalled) caller is refused, in every target', async () => {
      const gone = await scopeOn(callers, t, PEER_CALLER);
      await expect(call(gone)).resolves.toBeDefined();
      await callers.admin.archiveScope(staff, t, gone);
      expect(errorCodeOf(await refusal(call(gone)))).toBe('forbidden');
    });
  });

  describe('tenant confinement', () => {
    it('a caller whose tenant has no instance of the target reaches nothing — not the other tenant’s', async () => {
      const lonelyTenant = tenantId.parse(ulid());
      for (const host of [target, callers]) {
        await host.admin.createTenant(staff, {
          id: lonelyTenant,
          slug: `lonely-${lonelyTenant.slice(-10).toLowerCase()}`,
          name: 'Lonely',
        });
      }
      const lonely = await scopeOn(callers, lonelyTenant, PEER_CALLER);
      expect(errorCodeOf(await refusal(call(lonely, lonelyTenant)))).toBe('not_found');
    });

    it('a caller cannot claim a scope under a tenant it is not in', async () => {
      expect(errorCodeOf(await refusal(call(caller, other)))).toBe('forbidden');
    });

    it('twin: an instance in the other tenant calls THAT tenant’s target', async () => {
      const there = await scopeOn(callers, other, PEER_CALLER);
      const id = ulid();
      await call(there, other, id);
      expect((await outbox(other, crmElsewhere)).some((r) => r.entity_id === id)).toBe(true);
      expect((await outbox(t, crm)).some((r) => r.entity_id === id)).toBe(false);
    });
  });

  describe('identity is the directory’s, not the harness’s word', () => {
    it('a scope of ANOTHER vertical cannot speak as the caller', async () => {
      const notACaller = await scopeOn(callers, t, 'acme/something-else');
      expect(errorCodeOf(await refusal(call(notACaller)))).toBe('forbidden');
    });

    it('a preview of the caller is refused', async () => {
      const preview = await scopeOn(callers, t, PEER_CALLER, { kind: 'preview' });
      expect(errorCodeOf(await refusal(call(preview)))).toBe('forbidden');
    });

    it('twin: the primary it previews calls', async () => {
      await expect(call(caller)).resolves.toBeDefined();
    });

    it('a preview of the target is never the instance a call reaches', async () => {
      await scopeOn(target, t, TARGET, { kind: 'preview' });
      const id = ulid();
      await call(caller, t, id);
      expect((await outbox(t, crm)).some((r) => r.entity_id === id)).toBe(true);
    });
  });

  describe('the target: resolved by slug, or refused', () => {
    it('a vertical the broker does not serve is not installed', async () => {
      const res = broker.clientFor({ vertical: PEER_CALLER, tenantId: t, scopeId: caller }).invoke('acme/absent', 'x');
      expect(errorCodeOf(await refusal(res))).toBe('not_found');
    });

    it('a caller the target never declared is refused at the target’s door', async () => {
      const strangers = hostIn('substrat-peer-stranger-');
      await strangers.admin.createTenant(staff, { id: t, slug: 'stranger-t', name: 'Stranger' });
      const stranger = await scopeOn(strangers, t, 'acme/stranger');
      const withStranger = createLocalVerticalBroker({ [TARGET]: target, 'acme/stranger': strangers });
      const res = withStranger
        .clientFor({ vertical: 'acme/stranger', tenantId: t, scopeId: stranger })
        .invoke(TARGET, 'peer/list');
      expect(errorCodeOf(await refusal(res))).toBe('forbidden');
      await strangers.close();
    });

    it('two live instances of the target in one tenant: a conflict, never a guess', async () => {
      await scopeOn(target, t, TARGET);
      expect(errorCodeOf(await refusal(call(caller)))).toBe('conflict');
    });
  });
});

describe('the broker cannot be bundled into a worker (#1706)', () => {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const resolveWith = (conditions: string[]): string => {
    const script =
      "import('@substrat-run/adapter-sqlite/vertical-broker').then(" +
      "() => console.log('resolved'), (e) => console.log(e.code ?? e.message))";
    return execFileSync(
      process.execPath,
      [...conditions.map((c) => `--conditions=${c}`), '--input-type=module', '-e', script],
      { cwd: pkgDir, encoding: 'utf8' },
    ).trim();
  };

  it.each(['workerd', 'worker', 'browser'])('under the `%s` condition the subpath does not resolve', (condition) => {
    expect(resolveWith([condition])).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('twin: under node it resolves', () => {
    expect(resolveWith([])).toBe('resolved');
  });
});
