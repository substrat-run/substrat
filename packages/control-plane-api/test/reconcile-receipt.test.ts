import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { runPlatformSweep, ulid } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth, type VerticalClient } from '../src/index.js';

/**
 * The console's "Re-run provisioning" and the sweep's #1172 phase write ONE receipt, and
 * since #1653 it names the version the hook ran AS — for a scope on its vertical's serving
 * script, the served version, not the scope's pointer.
 *
 * If the two disagreed, pressing the button on a listed install (pointer v1, script serving
 * v2) would record v1, and the next sweep would find it behind and reconcile it again: the
 * button would mean nothing to the thing that watches. This holds them to the same answer,
 * through the real route, against a real directory.
 */
describe('scope reconcile receipt (#1653)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const T = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const SLUG = 'acme-listed';
  const REF = 'acme-listed-serving';
  let v1: string;
  let v2: string;
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };

  const reconciledBy = new Map<string, string>();
  const clientFor = (label: string) =>
    ({
      reconcileInstance: async (input: { scopeId: string }) => {
        reconciledBy.set(input.scopeId, label);
        return { tenantId: T, scopeId: input.scopeId, owner };
      },
    }) as unknown as VerticalClient;

  const appOf = () =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      // The serving script, reached by its ref — where a scope with `servingRef` lives.
      resolveVerticalRef: async (ref) => (ref === REF ? clientFor('serving') : undefined),
      // And the slug's own deployment, for a scope still on per-version dispatch.
      verticals: { [SLUG]: clientFor('by-slug') },
    });

  /** An active scope of the vertical, bound to v1, optionally on the serving script. */
  const scopeOn = async (servingRef: string | null): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: T, scopeId: s, vertical: SLUG });
    await host.admin.activateScope(staff, T, s);
    await host.admin.setScopeServingRef(staff, T, s, servingRef);
    await host.admin.bindScopeVersion(staff, T, s, v1);
    return s;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-receipt-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: T, slug: 'acme', name: 'Acme' });
    await host.admin.registerVertical(staff, { slug: SLUG, name: 'Acme listed', source: 'cli', ownerTenant: null });
    const pub = async (version: string): Promise<string> => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id,
        verticalSlug: SLUG,
        version,
        manifestDigest: `m-${version}`,
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: `${SLUG}-${version}`,
      });
      await host.admin.admitVersion(staff, id);
      return id;
    };
    v1 = await pub('1.0.0');
    v2 = await pub('2.0.0');
    // The promote's in-place serve: the script now runs v2. No install's pointer moved.
    await host.admin.setVerticalServing(staff, SLUG, { ref: REF, versionId: v2, doClasses: ['ScopeDO'], migrationTag: 'v1' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the served version for an install on the serving script, and the sweep then agrees nothing is behind', async () => {
    const s = await scopeOn(REF);

    const res = await appOf().request(`/tenants/${T}/scopes/${s}/provision`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect(reconciledBy.get(s)).toBe('serving');

    const record = await host.admin.getScopeRecord(staff, T, s);
    expect(record?.provisionedVersionId).toBe(v2);
    // The tenant's pointer is untouched: Update is still theirs to press.
    expect(record?.verticalVersionId).toBe(v1);

    const report = await runPlatformSweep(host, {
      actor: staff,
      fetch: (() => Promise.reject(new Error('unused'))) as never,
      sweepers: {},
      drainRetries: false,
      runSchedules: false,
      reconcileMigrations: false,
      gcSnapshots: false,
      reconcileScopeFn: async (_t, id) => {
        if (id === s) throw new Error('the button already reconciled this scope against what it runs');
      },
    });
    expect(report.errors.filter((e) => e.id === s)).toEqual([]);
    expect(report.provisionReconcile?.behind).toBe(0);
  });

  it('records the bound version for a scope still on per-version dispatch — its own script is what runs', async () => {
    const s = await scopeOn(null);

    const res = await appOf().request(`/tenants/${T}/scopes/${s}/provision`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect(reconciledBy.get(s)).toBe('by-slug');
    expect((await host.admin.getScopeRecord(staff, T, s))?.provisionedVersionId).toBe(v1);
  });
});
