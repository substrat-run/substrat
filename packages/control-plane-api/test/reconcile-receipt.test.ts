import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { runPlatformSweep, ulid } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  reconcileOutcomeOf,
  UNSAFE_devPlatformActorAuth,
  versionReachedAt,
  type VerticalClient,
} from '../src/index.js';

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

  /**
   * Copilot's finding on #1661. `verticalForScope` falls back from the serving ref to the
   * bound version's deployment when the ref does not resolve. The receipt used to be read
   * from the serving pointer on the side, so this reconcile — which ran v1's hook — was
   * recorded as v2, and the scope looked repaired while v2's hook never ran. It now names
   * the version of the deployment the ladder actually chose.
   */
  describe('when the serving ref does not resolve', () => {
    const fellBackApp = (refResolves: boolean) =>
      createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        resolveVerticalRef: async (ref) => (refResolves && ref === REF ? clientFor('serving') : undefined),
        // The bound version's own deployment — the rung a missed serving ref falls to.
        resolveVerticalVersion: async (_slug, versionId) => clientFor(`bound:${versionId}`),
      });

    const sweepReaches = async (): Promise<Map<string, string>> => {
      const reached = new Map<string, string>();
      await runPlatformSweep(host, {
        actor: staff,
        fetch: (() => Promise.reject(new Error('unused'))) as never,
        sweepers: {},
        drainRetries: false,
        runSchedules: false,
        reconcileMigrations: false,
        gcSnapshots: false,
        reconcileScopeFn: async (_t, id, expected) => {
          reached.set(id, expected);
          return 'unsupported'; // records nothing: this only asks who is behind
        },
      });
      return reached;
    };

    it('reconciles through the bound deployment, records the BOUND version, and the scope stays behind', async () => {
      const s = await scopeOn(REF);

      const res = await fellBackApp(false).request(`/tenants/${T}/scopes/${s}/provision`, { method: 'POST', headers: auth });
      expect(res.status).toBe(200);
      expect(reconciledBy.get(s)).toBe(`bound:${v1}`);
      // What ran was v1's hook, so that is what the receipt says…
      expect((await host.admin.getScopeRecord(staff, T, s))?.provisionedVersionId).toBe(v1);
      // …and the scope, which runs v2, is still behind: the next pass asks again for v2.
      expect((await sweepReaches()).get(s)).toBe(v2);
    });

    it('the twin: when the serving ref resolves, it records the served version and nothing is left behind', async () => {
      const s = await scopeOn(REF);

      const res = await fellBackApp(true).request(`/tenants/${T}/scopes/${s}/provision`, { method: 'POST', headers: auth });
      expect(res.status).toBe(200);
      expect(reconciledBy.get(s)).toBe('serving');
      expect((await host.admin.getScopeRecord(staff, T, s))?.provisionedVersionId).toBe(v2);
      expect((await sweepReaches()).has(s)).toBe(false);
    });
  });

  it('names the version by the rung that chose the deployment', () => {
    const scope = { verticalVersionId: 'v1', servingRef: REF };
    const served = { ref: REF, versionId: 'v2' };
    expect(versionReachedAt('serving-script', scope, served)).toBe('v2');
    // A serving ref that missed fell to one of these — whose code is the bound version's.
    expect(versionReachedAt('bound-version', scope, served)).toBe('v1');
    expect(versionReachedAt('slug', scope, served)).toBe('v1');
    // The serving script, but a pointer naming another script, or none read: the bound one.
    expect(versionReachedAt('serving-script', scope, { ref: 'elsewhere', versionId: 'v2' })).toBe('v1');
    expect(versionReachedAt('serving-script', scope, null)).toBe('v1');
  });

  it('records the bound version for a scope still on per-version dispatch — its own script is what runs', async () => {
    const s = await scopeOn(null);

    const res = await appOf().request(`/tenants/${T}/scopes/${s}/provision`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect(reconciledBy.get(s)).toBe('by-slug');
    expect((await host.admin.getScopeRecord(staff, T, s))?.provisionedVersionId).toBe(v1);
  });
});

/**
 * #2185: the receipt now carries whether the reconcile FINISHED the version's retirements, and
 * the gate judges an install from that. Before, the reconcile's answer about its retirements
 * never reached the control plane at all, so a retirement left open was recorded as done and
 * never run again. Through the real routes, against a real directory.
 */
describe('the retirements a receipt records as finished (#2185)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const T = tenantId.parse(ulid());
  const owner = principalId.parse(ulid());
  const SLUG = 'acme-retiring';
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const HOLDER = { table: 'bind_records', idColumn: 'id', principalColumn: 'principal' };
  const retires = { entityType: 'contact', permissions: [], retired: ['contact:read-own'], bootstrap: true, holder: HOLDER };
  const keeps = { entityType: 'contact', permissions: ['contact:read-own'], bootstrap: true, holder: HOLDER };
  let retiring: string;
  let plain: string;
  /** What the deployment answers about its retirements, and the shapes it was sent. */
  let answer: { retirementsLeftOpen?: number } = {};
  const sent = new Map<string, unknown>();

  const client = {
    reconcileInstance: async (input: { scopeId: string; entityGrants?: unknown }) => {
      sent.set(input.scopeId, input.entityGrants);
      return { tenantId: T, scopeId: input.scopeId, owner, ...answer };
    },
    provisionInstance: async (input: { scopeId: string }) => ({ tenantId: T, scopeId: input.scopeId, owner }),
    restoreScope: async (_t: string, s: string) => {
      if (restoreFails) {
        // A sweep reconcile lands between the clear before the load and this failure (round 3).
        await host.admin.markScopeProvisioned(staff, T, s as ScopeId, retiring, { retirementsFinished: true });
        throw new Error('the deployment lost the restore after the host loaded it');
      }
      return { tables: 0 };
    },
  } as unknown as VerticalClient;
  let restoreFails = false;
  const app = () => createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), verticals: { [SLUG]: client } });

  const scopeOn = async (version: string): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: T, scopeId: s, vertical: SLUG });
    await host.admin.activateScope(staff, T, s);
    await host.admin.bindScopeVersion(staff, T, s, version);
    return s;
  };
  const finished = async (s: ScopeId) => {
    const r = await host.admin.getScopeRecord(staff, T, s);
    return { provisioned: r?.provisionedVersionId, finished: r?.retirementsFinishedVersionId ?? null };
  };
  const reconcile = async (s: ScopeId, says: { retirementsLeftOpen?: number }) => {
    answer = says;
    const res = await app().request(`/tenants/${T}/scopes/${s}/provision`, { method: 'POST', headers: auth });
    expect({ status: res.status, body: res.status === 200 ? null : await res.text() }).toEqual({ status: 200, body: null });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-retired-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: T, slug: 'acme-r', name: 'Acme' });
    await host.admin.registerVertical(staff, { slug: SLUG, name: 'Acme retiring', source: 'cli', ownerTenant: null });
    const pub = async (version: string, entityGrants: object[]): Promise<string> => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id, verticalSlug: SLUG, version, manifestDigest: `m-${version}`, permissionDigest: `p-${version}`, migrationDigest: 'g',
        deploymentRef: `${SLUG}-${version}`,
        manifestJson: JSON.stringify({
          version,
          entry: 'worker.js',
          compatibilityDate: '2025-01-01',
          digests: { manifest: `m-${version}`, permission: `p-${version}`, migration: 'g' },
          registry: { permissions: [], roles: [], entityGrants },
        }),
      });
      await host.admin.admitVersion(staff, id);
      return id;
    };
    retiring = await pub('2.0.0', [retires]);
    plain = await pub('1.0.0', [keeps]);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the version finished when the deployment answers it left no retirement open', async () => {
    const s = await scopeOn(retiring);
    await reconcile(s, { retirementsLeftOpen: 0 });
    // The reviewed shapes went out, the retirement among them.
    expect(sent.get(s)).toEqual([retires]);
    expect(await finished(s)).toEqual({ provisioned: retiring, finished: retiring });
  });

  it('(a) writes the receipt but not finished when it left a retirement open, so the sweep asks again', async () => {
    const s = await scopeOn(retiring);
    await reconcile(s, { retirementsLeftOpen: 1 });
    expect(await finished(s)).toEqual({ provisioned: retiring, finished: null });
    const behind: string[] = [];
    await runPlatformSweep(host, {
      actor: staff,
      fetch: (() => Promise.reject(new Error('unused'))) as never,
      sweepers: {},
      drainRetries: false,
      runSchedules: false,
      reconcileMigrations: false,
      gcSnapshots: false,
      reconcileScopeFn: async (_t, id) => {
        behind.push(id);
        return 'unsupported';
      },
    });
    expect(behind).toContain(s);
    // The next reconcile finishes it.
    await reconcile(s, { retirementsLeftOpen: 0 });
    expect(await finished(s)).toEqual({ provisioned: retiring, finished: retiring });
  });

  it('counts an answer without the report (a vertical-host that predates it) as not finished, unless the version retires nothing', async () => {
    const old = await scopeOn(retiring);
    await reconcile(old, {});
    expect(await finished(old)).toEqual({ provisioned: retiring, finished: null });
    const nothingToRetire = await scopeOn(plain);
    await reconcile(nothingToRetire, {});
    expect(await finished(nothingToRetire)).toEqual({ provisioned: plain, finished: plain });
  });

  it('a provision of an already-bound scope runs no retirement: finished only when its version retires nothing', async () => {
    for (const [version, expected] of [[retiring, null], [plain, plain]] as const) {
      const s = await scopeOn(version);
      const res = await app().request(`/verticals/${SLUG}/instances`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ tenantId: T, scopeId: s, owner, slug: 'acme-r', name: 'Acme' }),
      });
      expect(res.status).toBe(201);
      expect(await finished(s)).toEqual({ provisioned: version, finished: expected });
    }
  });

  /**
   * Review of #2218, round 1: a governed restore replays a dump that may predate a finished
   * retirement. Its tuples bring the retired key back and its spine has no record the retirement
   * ran, so the directory must stop saying it finished, or a later drop strands the holder. The
   * bare receipt of #2181 had the same gap; the restore now clears it, as the rewind does.
   */
  it('a restore of a pre-retirement dump clears the receipt and the finished version, so the drop waits for the sweep', async () => {
    const binding = { ...keeps, holder: HOLDER, bind: { permission: 'contact:invite' } };
    const pubShaped = async (version: string, entityGrants: object[]) => {
      const id = ulid();
      await host.admin.publishVersion(staff, {
        id, verticalSlug: SLUG, version, manifestDigest: `m-${version}`, permissionDigest: `p-${version}`, migrationDigest: 'g',
        deploymentRef: `${SLUG}-${version}`,
        manifestJson: JSON.stringify({
          version, entry: 'worker.js', compatibilityDate: '2025-01-01',
          digests: { manifest: `m-${version}`, permission: `p-${version}`, migration: 'g' },
          registry: { permissions: [], roles: [], entityGrants },
        }),
      });
      await host.admin.admitVersion(staff, id);
      return id;
    };
    const binds = await pubShaped('3.0.0', [binding]);
    const retiresAll = await pubShaped('3.1.0', [{ ...binding, permissions: [], retired: ['contact:read-own'] }]);
    const dropped = await pubShaped('3.2.0', []);
    const s = await scopeOn(binds);
    // The backup, taken before the retirement.
    const backup = await host.admin.exportScope(staff, T, s);
    await host.admin.bindScopeVersion(staff, T, s, retiresAll);
    await reconcile(s, { retirementsLeftOpen: 0 });
    expect(await finished(s)).toEqual({ provisioned: retiresAll, finished: retiresAll });
    // The tenant restores the backup.
    const res = await app().request(`/tenants/${T}/scopes/${s}/restore`, { method: 'POST', headers: auth, body: JSON.stringify(backup) });
    expect(res.status).toBe(200);
    expect(await finished(s)).toEqual({ provisioned: null, finished: null });
    // So the drop is refused until the install reconciles again…
    const refused = await host.admin.bindScopeVersion(staff, T, s, dropped).then(() => null, (e: unknown) => e as Error);
    expect(refused?.message).toMatch(/drops the shape.*no reconcile receipt/);
    // …and passes once it has, with its retirements finished.
    await reconcile(s, { retirementsLeftOpen: 0 });
    await host.admin.bindScopeVersion(staff, T, s, dropped);
    expect((await host.admin.getScopeRecord(staff, T, s))?.verticalVersionId).toBe(dropped);
  });

  /**
   * Review of #2218, round 2: steps after the load can still throw (the deployment's half of the
   * restore, the switch re-assert), and the route then answers 422 over data that has landed. The
   * receipt is cleared before the load, after it, and on a failure (round 3: a sweep reconcile can
   * write it between the clear before the load and the throw), so such a failure cannot leave it set.
   */
  it('a restore that fails after the data landed still leaves the receipt cleared', async () => {
    const s = await scopeOn(retiring);
    await reconcile(s, { retirementsLeftOpen: 0 });
    expect(await finished(s)).toEqual({ provisioned: retiring, finished: retiring });
    const backup = await host.admin.exportScope(staff, T, s);
    restoreFails = true;
    try {
      const res = await app().request(`/tenants/${T}/scopes/${s}/restore`, { method: 'POST', headers: auth, body: JSON.stringify(backup) });
      expect(res.status).toBe(422);
    } finally {
      restoreFails = false;
    }
    expect(await finished(s)).toEqual({ provisioned: null, finished: null });
  });

  it('reads only a count the deployment actually sent', () => {
    expect(reconcileOutcomeOf([retires as never], { retirementsLeftOpen: 0 })).toEqual({ retirementsFinished: true });
    expect(reconcileOutcomeOf([retires as never], { retirementsLeftOpen: 2 })).toEqual({ retirementsFinished: false });
    expect(reconcileOutcomeOf([retires as never], null)).toEqual({ retirementsFinished: false });
    // A sharing shape's `retired` is never run, so it is nothing to wait for.
    expect(reconcileOutcomeOf([{ entityType: 'list', permissions: [], retired: ['list:read'] } as never], null)).toEqual({ retirementsFinished: true });
    expect(reconcileOutcomeOf(undefined, null)).toEqual({ retirementsFinished: true });
  });
});
