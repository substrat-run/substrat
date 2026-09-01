/**
 * The half of grant expiry that no suite could reach before (#956).
 *
 * A tuple stops granting once `expires_at` has passed — a rule the checker has
 * always carried and nothing could assert, because the evaluator read the wall
 * clock: the only way to watch a grant lapse was to write one with a second's life
 * and sleep through it, which tests a shortened window rather than expiry.
 *
 * The host takes a `clock` (#812) and now hands it to the checker, so the grant
 * here gets a realistic window and time moves because this test says so. Same
 * reasoning as `impersonation-expiry.test.ts`, and it lives beside it for the same
 * reason: it is a fact about a host that can be handed a clock, not a fact about
 * the contract — the DO adapter has no clock option yet, so a shared suite would
 * be red rather than covering.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  instant,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type Decision,
  type PrincipalId,
} from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock } from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

describe('a grant stops granting when its expiry passes (#956)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let clock: ManualClock;
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const anna: PrincipalId = principalId.parse(ulid());
  const admin: PrincipalId = principalId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const PERM_USE = permissionKey.parse('perm:use');

  /** `perm/probe` returns the Decision itself, so a denial is a value, not a throw. */
  const allowed = async (): Promise<boolean> => {
    const stub = await host.getScope(anna, t1, s1);
    const decision = (await stub.invoke('perm/probe', { permission: PERM_USE })) as Decision;
    return decision.allowed;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-grant-expiry-'));
    clock = manualClock('2026-08-26T09:00:00.000Z');
    host = new SqliteScopeHost({ dir, clock: clock.read });
    host.registerModule(permMod);
    await host.admin.createTenant(staff, { id: t1, slug: 'grant-tenant', name: 'Grant' });
    await host.admin.grantEntitlement(staff, t1, 'perm');
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'grant-vertical' });
    await host.admin.activateScope(staff, t1, s1);
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers while the grant is live and denies once the clock passes it', async () => {
    // A day of access, granted at the scope. Nothing takes it away — the only
    // thing that changes between the two assertions is what time it is.
    await host.admin.grant(staff, {
      principalId: anna,
      permission: PERM_USE,
      node: { tenantId: t1, scopeId: s1 },
      expiresAt: instant.parse('2026-08-27T09:00:00.000Z'),
      grantedBy: admin,
    });
    expect(await allowed()).toBe(true);

    clock.advance(25 * 60 * 60_000);
    expect(await allowed()).toBe(false);
  });

  it('is judged at the boundary, not rounded: the expiry instant is already past', async () => {
    // `expires_at > now` — at the expiry instant itself the grant is gone. Worth
    // pinning because a `>=` here would silently widen every grant on the host.
    await host.admin.grant(staff, {
      principalId: anna,
      permission: PERM_USE,
      node: { tenantId: t1, scopeId: s1 },
      expiresAt: instant.parse('2026-08-26T10:00:00.000Z'),
      grantedBy: admin,
    });
    clock.set('2026-08-26T09:59:59.999Z');
    expect(await allowed()).toBe(true);
    clock.set('2026-08-26T10:00:00.000Z');
    expect(await allowed()).toBe(false);
  });

  it('leaves a grant with no expiry alone however far the clock runs', async () => {
    await host.admin.grant(staff, {
      principalId: anna,
      permission: PERM_USE,
      node: { tenantId: t1, scopeId: s1 },
      grantedBy: admin,
    });
    clock.advance(365 * 24 * 60 * 60_000);
    expect(await allowed()).toBe(true);
  });

  it('expires an entitlement on the same clock, so the scope fails closed', async () => {
    // The other half the clock now reaches (#33): the entitlement gate. A trial that
    // runs out has to stop the vertical, and until now nothing could assert that
    // without back-dating the expiry to a date already in the past.
    await host.admin.grant(staff, {
      principalId: anna,
      permission: PERM_USE,
      node: { tenantId: t1, scopeId: s1 },
      grantedBy: admin,
    });
    await host.admin.grantEntitlement(staff, t1, 'perm', {
      expiresAt: instant.parse('2026-08-26T12:00:00.000Z'),
    });
    expect(await allowed()).toBe(true);

    // The gate is per-invoke, so the stub still mints — the operation is what
    // becomes unavailable, and it says which keys the tenant holds and that this
    // one expired.
    clock.advance(4 * 60 * 60_000);
    const stub = await host.getScope(anna, t1, s1);
    await expect(stub.invoke('perm/probe', { permission: PERM_USE })).rejects.toThrow(/perm/);
  });
});
