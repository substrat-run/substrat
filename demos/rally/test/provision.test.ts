import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  platformActorId, principalId, scopeId, tenantId, orgId as orgIdSchema, type PermissionKeysOf,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { buildRallyHost, provisionRally } from '../src/index.js';
import { RALLY_PERMISSIONS } from '../src/operations.js';
import { permissions } from '../src/seed.js';

/**
 * What a customer receives (#31 blockers 3 and 4).
 *
 * Seeding used to be fused to provisioning, so instantiating the template handed
 * over a second company and an admin account nobody created. These assert the
 * seam holds — and they are what fails if the story is folded back in.
 */
describe('provisioning one RallyPoint instance', () => {
  const staff = platformActorId.parse(ulid());
  const args = () => ({
    tenantId: tenantId.parse(ulid()),
    scopeId: scopeId.parse(ulid()),
    owner: principalId.parse(ulid()),
    orgId: orgIdSchema.parse(ulid()),
    slug: `acme-${ulid().slice(0, 8).toLowerCase()}`,
    name: 'Acme AB',
  });

  it('creates exactly one tenant and one scope — no cast, no second company', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rally-prov-'));
    const host = buildRallyHost(dir);
    try {
      const a = args();
      await provisionRally(host, a);
      expect((await host.admin.listTenants(staff)).map((t) => t.id)).toEqual([a.tenantId]);
      expect((await host.admin.listScopes(staff, {})).map((s) => s.id)).toEqual([a.scopeId]);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives the owner club-admin and nobody else any role', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rally-prov2-'));
    const host = buildRallyHost(dir);
    try {
      const a = args();
      await provisionRally(host, a);
      // An attacker principal holding an admin role is exactly what used to ship,
      // and it would show up here as a second assignment.
      const assigned = (await host.admin.auditLog(staff, { tenantId: a.tenantId })).filter(
        (e) => e.action === 'assignRole',
      );
      expect(assigned).toHaveLength(1);
      expect(JSON.stringify(assigned[0]!.after)).toContain(a.owner);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — provisioning twice does not double anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rally-prov3-'));
    const host = buildRallyHost(dir);
    try {
      const a = args();
      await provisionRally(host, a);
      await provisionRally(host, a);
      expect((await host.admin.listTenants(staff)).length).toBe(1);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The declared key list reaches `definePermissions` as `keys` (#1208).
 *
 * Its runtime half needs no test of its own: `definePermissions` throws at module load
 * when `keys` and `MODULES` disagree, so every suite in this package that imports the
 * seed is already the check. What nothing else would notice is `keys` being dropped, or
 * the `as const` being lost — the assertion just stops running, and the union
 * `defineOperations` type-checks a `permission:` against silently becomes `never`. Both
 * mistakes are a compile error on the line below.
 *
 * The key named is an ENGINE's, not rally's own: rally composes three engines, and the
 * point of the widened array is that a key a Rally scope declares without rally owning it
 * is nameable too.
 */
describe("RallyPoint's declared permission keys", () => {
  it('survive as a literal union rather than collapsing to `never`', () => {
    const key: PermissionKeysOf<typeof permissions> = 'invites:send';
    expect(RALLY_PERMISSIONS).toContain(key);
  });
});
