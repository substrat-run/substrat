/**
 * The half of K-42's time box the contract suite cannot express (#868).
 *
 * `impersonationContractSuite` proves the session is re-read on every invoke, by
 * ending one under a live stub. It cannot prove the same for EXPIRY, because a
 * session's floor is one minute and the DO adapter reads the wall clock — so a
 * cross-adapter test would either sleep for a minute or assert nothing.
 *
 * The pure adapter takes a `clock`, which is exactly what that seam is for
 * (#812): time passes when this test says so. Here, not in the shared suite,
 * because it is a fact about a host that can be handed a clock rather than a
 * fact about the contract — and a suite that quietly skipped it on one adapter
 * would read as coverage it does not have.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  IMPERSONATION_DEFAULT_MINUTES,
  type PrincipalId,
} from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock } from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

describe('an impersonation session expires on its own (K-42)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let clock: ManualClock;
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const anna: PrincipalId = principalId.parse(ulid());
  const staff = platformActorId.parse(ulid());

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-imp-expiry-'));
    clock = manualClock('2026-08-26T09:00:00.000Z');
    host = new SqliteScopeHost({ dir, clock: clock.read });
    host.registerModule(permMod);
    await host.admin.createTenant(staff, { id: t1, slug: 'exp-tenant', name: 'Exp' });
    await host.admin.grantEntitlement(staff, t1, 'perm');
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'imp-vertical' });
    await host.admin.activateScope(staff, t1, s1);
    await host.admin.defineRole(staff, t1, {
      key: 'exp-user',
      permissions: [permissionKey.parse('perm:use')],
      source: 'vertical',
    });
    await host.admin.assignRole(staff, {
      principalId: anna,
      roleKey: 'exp-user',
      node: { tenantId: t1, scopeId: null },
    });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops answering through a stub that was minted while it was live', async () => {
    const session = await host.admin.beginImpersonation(staff, {
      tenantId: t1,
      scopeId: s1,
      principal: anna,
      reason: 'ticket #4182 — reproduce the empty screen',
    });
    const stub = await host.getImpersonatedScope(session.id, t1, s1);
    await expect(stub.invoke('perm/whoami')).resolves.toBe(anna);

    // One minute past the default window. Nothing took the stub away — the only
    // thing that changed is what time it is, and that has to be enough.
    clock.advance((IMPERSONATION_DEFAULT_MINUTES + 1) * 60_000);
    await expect(stub.invoke('perm/whoami')).rejects.toThrow(/expired at/);
  });

  it('refuses to mint a new stub once it has expired', async () => {
    const session = await host.admin.beginImpersonation(staff, {
      tenantId: t1,
      scopeId: s1,
      principal: anna,
      reason: 'ticket #4182 — reproduce the empty screen',
      minutes: 5,
    });
    clock.advance(6 * 60_000);
    await expect(host.getImpersonatedScope(session.id, t1, s1)).rejects.toThrow(/expired at/);
  });

  it('drops out of the active list without anything having to sweep it', async () => {
    const session = await host.admin.beginImpersonation(staff, {
      tenantId: t1,
      scopeId: s1,
      principal: anna,
      reason: 'ticket #4182 — reproduce the empty screen',
      minutes: 5,
    });
    expect(
      (await host.admin.listImpersonations(staff, { active: true })).map((s) => s.id),
    ).toEqual([session.id]);
    clock.advance(6 * 60_000);
    expect(await host.admin.listImpersonations(staff, { active: true })).toEqual([]);
    // Still THERE, and still not ended: expiring is not the same fact as somebody
    // having stopped it, and the row keeps both answers.
    const [expired] = await host.admin.listImpersonations(staff, { active: false });
    expect(expired!.id).toBe(session.id);
    expect(expired!.endedAt).toBeNull();
  });
});
