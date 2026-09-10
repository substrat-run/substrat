import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  platformActorId, principalId, scopeId, tenantId, type PermissionKeysOf,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { buildDemoHost, provisionCallout } from '../src/index.js';
import { CALLOUT_PERMISSIONS } from '../src/operations.js';
import { permissions } from '../src/provision.js';

/**
 * What a customer receives (#31 blockers 3 and 4).
 *
 * The demo seed and the provisioning path used to be one function, so
 * instantiating the template handed over a second company and an admin account
 * nobody created. These assert the seam holds — and they are the tests that fail
 * if someone folds the story back into provisioning.
 */
describe('provisioning one Callout instance', () => {
  it('creates exactly one tenant and one scope — no cast, no second company', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'callout-prov-'));
    const host = buildDemoHost(dir);
    const staff = platformActorId.parse(ulid());
    try {
      const t = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      const owner = principalId.parse(ulid());
      await provisionCallout(host, { tenantId: t, scopeId: s, owner, slug: 'acme-el', name: 'Acme El AB' });

      const tenants = await host.admin.listTenants(staff);
      expect(tenants.map((x) => x.id)).toEqual([t]);
      const scopes = await host.admin.listScopes(staff, {});
      expect(scopes.map((x) => x.id)).toEqual([s]);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives the owner office-admin and nobody else any role', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'callout-prov2-'));
    const host = buildDemoHost(dir);
    const staff = platformActorId.parse(ulid());
    try {
      const t = tenantId.parse(ulid());
      const owner = principalId.parse(ulid());
      await provisionCallout(host, {
        tenantId: t, scopeId: scopeId.parse(ulid()), owner, slug: 'acme2', name: 'Acme Two',
      });
      // The roles are DEFINED (a vertical ships its vocabulary) but only the owner
      // holds one. An attacker principal with office-admin is exactly what used to
      // ship, and it would show up here.
      const log = await host.admin.auditLog(staff, { tenantId: t });
      const assigned = log.filter((e) => e.action === 'assignRole');
      expect(assigned).toHaveLength(1);
      expect(JSON.stringify(assigned[0]!.after)).toContain(owner);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — provisioning twice does not double anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'callout-prov3-'));
    const host = buildDemoHost(dir);
    const staff = platformActorId.parse(ulid());
    try {
      const args = {
        tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()),
        owner: principalId.parse(ulid()), slug: 'acme3', name: 'Acme Three',
      };
      await provisionCallout(host, args);
      await provisionCallout(host, args);
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
 */
describe("Callout's declared permission keys", () => {
  it('survive as a literal union rather than collapsing to `never`', () => {
    const key: PermissionKeysOf<typeof permissions> = 'customer:manage';
    expect(CALLOUT_PERMISSIONS).toContain(key);
  });
});
