import { describe, it, expect } from 'vitest';
import { platformActorId, connectionId, scopeId, tenantId } from '@substrat-run/contracts';
import type { MigrationFailure, MigrationStraggler, Scope, Tenant } from '@substrat-run/contracts';
import {
  isPrimaryScope,
  PROVISION_RECONCILE_BATCH,
  PROVISION_RECONCILE_REPORTED_IDS,
  registryImportCandidates,
  runCrossVerticalFrom,
  runningVersionOf,
  runPlatformSweep,
  startPlatformSweeper,
} from '../src/platform-sweep.js';
import type { ConnectorSweeper, CrossVerticalReach, PlatformSweepOptions } from '../src/platform-sweep.js';
import type { FetchLike, MigrateScopeOutcome, ScopeHost } from '../src/scope-host.js';

/**
 * The orchestration, with fakes — that the pass enumerates, drains, dispatches by
 * provider, isolates failures, and bounds concurrency. The REAL chain (a sweep
 * that actually completes a signature) is proven end-to-end against the SQLite
 * adapter in the connector package; here we hold the driver itself to its
 * contract without a provider or a database in the way.
 */

const ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
const FETCH = (() => Promise.reject(new Error('fetch is not used by these fakes'))) as unknown as FetchLike;

// ULID-shaped ids from a counter — digits are all valid Crockford base32, so no
// risk of the I/L/O/U the alphabet excludes. Unique and deterministic.
let idCounter = 0;
const genId = () => '01J' + String(++idCounter).padStart(23, '0');
const sid = () => scopeId.parse(genId());
const cid = () => connectionId.parse(genId());
const T = tenantId.parse(genId());

/** A ScopeHost with only the three methods the driver touches; the rest throws if reached. */
function fakeHost(opts: {
  scopes?: { id: ReturnType<typeof sid>; tenantId: typeof T }[];
  connections?: { id: ReturnType<typeof cid>; provider: string; revokedAt: string | null }[];
  drainDue?: ScopeHost['drainDue'];
}): ScopeHost {
  const admin = {
    listScopes: async () => (opts.scopes ?? []).map((s) => ({ ...s, status: 'active' })),
    listConnections: async () => opts.connections ?? [],
  };
  return {
    admin,
    drainDue:
      opts.drainDue ??
      (async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 })),
  } as unknown as ScopeHost;
}

/**
 * The #1172 phase, with fakes.
 *
 * A vertical's `onProvision` runs once per scope, at install — so a scope serving code
 * whose provision hook never ran against it is missing whatever that hook mints, and no
 * other path delivers it. The phase compares the two versions and re-runs the provision;
 * these hold it to the four things that make it a backstop rather than a nuisance: it
 * acts only on scopes that are behind, it records a receipt, a failure stays unmarked so
 * the next pass retries, and it leaves forks alone.
 */
/** The #1172 report with the #1653 fields at their quiet defaults, unless given. */
function tally(r: {
  behind: number;
  reconciled: number;
  failed: number;
  deferred?: number;
  unsupported?: { count: number; scopeIds: string[] };
}) {
  return { deferred: 0, unsupported: { count: 0, scopeIds: [] }, ...r };
}

describe('runPlatformSweep · provision reconcile (#1172)', () => {
  type FakeScope = {
    id: ReturnType<typeof sid>;
    tenantId: typeof T;
    verticalVersionId: string | null;
    provisionedVersionId: string | null;
    forkedFrom?: string | null;
    kind?: string;
    vertical?: string | null;
    servingRef?: string | null;
  };

  function hostWithScopes(
    scopes: FakeScope[],
    verticals: { slug: string; servingRef?: string; servingVersionId?: string }[] = [],
  ) {
    const marked: { id: string; versionId: string }[] = [];
    const admin = {
      listScopes: async () => scopes.map((s) => ({ ...s, status: 'active' })),
      listVerticals: async () => verticals,
      listConnections: async () => [],
      markScopeProvisioned: async (
        _a: unknown,
        _t: unknown,
        scope: string,
        versionId: string,
      ) => {
        marked.push({ id: scope, versionId });
        const row = scopes.find((s) => s.id === scope);
        if (row) row.provisionedVersionId = versionId;
      },
    };
    const host = {
      admin,
      drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }),
    } as unknown as ScopeHost;
    return { host, marked };
  }

  const sweep = (
    host: ScopeHost,
    fn: (t: unknown, s: unknown, expected?: unknown) => Promise<void | 'unsupported'>,
    extra: Pick<PlatformSweepOptions, 'provisionReconcileBatch' | 'provisionReconcileRng' | 'concurrency'> = {},
  ) =>
    runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      reconcileScopeFn: fn as never,
      ...extra,
    });

  it('reconciles a scope whose bound version is ahead of its provisioned one, then marks it', async () => {
    const behind: FakeScope = {
      id: sid(),
      tenantId: T,
      verticalVersionId: 'v2',
      provisionedVersionId: 'v1',
    };
    const { host, marked } = hostWithScopes([behind]);
    const seen: string[] = [];

    const report = await sweep(host, async (_t, s) => {
      seen.push(s as string);
    });

    expect(seen).toEqual([behind.id]);
    expect(report.provisionReconcile).toEqual(tally({ behind: 1, reconciled: 1, failed: 0 }));
    // The receipt names the version it reconciled AGAINST, which is what makes the next
    // pass a no-op rather than a second attempt.
    expect(marked).toEqual([{ id: behind.id, versionId: 'v2' }]);

    // And the second pass does nothing, which is the whole difference between a backstop
    // and a scope re-provisioned every quarter of an hour forever.
    const again = await sweep(host, async () => {
      throw new Error('a scope already provisioned against its version must not be touched');
    });
    expect(again.provisionReconcile).toEqual(tally({ behind: 0, reconciled: 0, failed: 0 }));
  });

  /**
   * A null receipt is "unknown", not "up to date". Every scope that existed before the
   * platform recorded this has one, including the broken installs the phase exists to
   * heal — assuming the optimistic answer would skip exactly them.
   */
  it('treats a scope with no receipt at all as behind', async () => {
    const { host, marked } = hostWithScopes([
      { id: sid(), tenantId: T, verticalVersionId: 'v1', provisionedVersionId: null },
    ]);
    const report = await sweep(host, async () => {});
    expect(report.provisionReconcile?.reconciled).toBe(1);
    expect(marked).toHaveLength(1);
  });

  it('leaves a scope alone when its provision already ran against the version it serves', async () => {
    const { host, marked } = hostWithScopes([
      { id: sid(), tenantId: T, verticalVersionId: 'v3', provisionedVersionId: 'v3' },
    ]);
    const report = await sweep(host, async () => {
      throw new Error('must not reconcile a scope that is up to date');
    });
    expect(report.provisionReconcile).toEqual(tally({ behind: 0, reconciled: 0, failed: 0 }));
    expect(marked).toEqual([]);
  });

  it('does not reconcile a scope bound to no version — there is nothing to reconcile against', async () => {
    const { host } = hostWithScopes([
      { id: sid(), tenantId: T, verticalVersionId: null, provisionedVersionId: null },
    ]);
    const report = await sweep(host, async () => {
      throw new Error('must not reconcile a scope with no bound version');
    });
    expect(report.provisionReconcile).toEqual(tally({ behind: 0, reconciled: 0, failed: 0 }));
  });

  /**
   * A fork is a preview or an archive of somebody else's data. Re-provisioning one runs
   * the vertical's hook against a COPY — minting a second set of whatever it mints.
   */
  it('skips forks', async () => {
    const { host } = hostWithScopes([
      {
        id: sid(),
        tenantId: T,
        verticalVersionId: 'v2',
        provisionedVersionId: 'v1',
        forkedFrom: sid(),
      },
    ]);
    const report = await sweep(host, async () => {
      throw new Error('must not reconcile a fork');
    });
    expect(report.provisionReconcile).toEqual(tally({ behind: 0, reconciled: 0, failed: 0 }));
  });

  /**
   * A CLEAN-ROOM preview (#509) is an empty scope with no source to copy, so it has
   * `kind: 'preview'` and NO `forkedFrom` — the reap sweep keys on `kind` for the same
   * reason. Filtering on lineage alone would let precisely these through, and a preview
   * is the one place a vertical's install-side hook is least wanted.
   */
  it('skips a clean-room preview, which has no lineage to filter on', async () => {
    const { host } = hostWithScopes([
      {
        id: sid(),
        tenantId: T,
        verticalVersionId: 'v2',
        provisionedVersionId: 'v1',
        kind: 'preview',
      },
    ]);
    const report = await sweep(host, async () => {
      throw new Error('must not reconcile a clean-room preview');
    });
    expect(report.provisionReconcile).toEqual(tally({ behind: 0, reconciled: 0, failed: 0 }));
  });

  /**
   * The case that separates a backstop from a one-shot: a reconcile that threw leaves the
   * scope UNMARKED, so the next pass tries again rather than recording a repair that
   * never happened.
   */
  it('leaves a failed reconcile unmarked, and reports it', async () => {
    const stubborn: FakeScope = {
      id: sid(),
      tenantId: T,
      verticalVersionId: 'v2',
      provisionedVersionId: 'v1',
    };
    const { host, marked } = hostWithScopes([stubborn]);

    const report = await sweep(host, async () => {
      throw new Error('the vertical refused');
    });

    expect(report.provisionReconcile).toEqual(tally({ behind: 1, reconciled: 0, failed: 1 }));
    expect(marked).toEqual([]);
    expect(report.errors).toContainEqual({
      kind: 'provision-reconcile',
      id: stubborn.id,
      error: 'the vertical refused',
    });

    // Still behind on the next pass.
    let retried = 0;
    const after = await sweep(host, async () => {
      retried += 1;
    });
    expect(retried).toBe(1);
    expect(after.provisionReconcile?.reconciled).toBe(1);
  });

  it('reports null when no reconcile fn is supplied — nobody looked is not nothing to do', async () => {
    const { host } = hostWithScopes([
      { id: sid(), tenantId: T, verticalVersionId: 'v2', provisionedVersionId: 'v1' },
    ]);
    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {} });
    expect(report.provisionReconcile).toBeNull();
  });

  /**
   * #1653. A LISTED vertical's promote re-uploads its serving script in place, so every
   * install of it runs the new code at once — but it moves none of their version pointers
   * (those are each tenant's, and move on their Update). Compared against the pointer, the
   * phase never saw those installs, and whatever the new version's `onProvision` sets up
   * never reached them. The phase now compares against the version that RUNS.
   */
  describe("a listed vertical's promote (#1653)", () => {
    const SLUG = 'acme/listed';
    const REF = 'acme-listed';
    /** The vertical after its promote: the serving script now runs v2. */
    const PROMOTED = [{ slug: SLUG, servingRef: REF, servingVersionId: 'v2' }];
    /** Another tenant's install, born on the serving script at v1 and never updated. */
    const install = (over: Partial<FakeScope> = {}): FakeScope => ({
      id: sid(),
      tenantId: tenantId.parse(genId()),
      vertical: SLUG,
      servingRef: REF,
      verticalVersionId: 'v1',
      provisionedVersionId: 'v1',
      ...over,
    });

    it('reconciles an install whose serving script moved on though its pointer did not, and marks what it runs', async () => {
      const a = install();
      const { host, marked } = hostWithScopes([a], PROMOTED);
      const seen: string[] = [];

      const report = await sweep(host, async (_t, s) => {
        seen.push(s as string);
      });

      expect(seen).toEqual([a.id]);
      expect(report.provisionReconcile).toEqual(tally({ behind: 1, reconciled: 1, failed: 0 }));
      // The receipt is the version the hook ran as — the served one — and the tenant's
      // pointer is left exactly where the tenant left it: Update is still theirs to press.
      expect(marked).toEqual([{ id: a.id, versionId: 'v2' }]);
      expect(a.verticalVersionId).toBe('v1');

      // Idempotent: the receipt now matches what runs, so the next pass does nothing.
      const again = await sweep(host, async () => {
        throw new Error('an install already provisioned against what it runs must not be touched');
      });
      expect(again.provisionReconcile).toEqual(tally({ behind: 0, reconciled: 0, failed: 0 }));
    });

    /**
     * The constraint that matters most. A PR preview is a restored copy of production
     * data, and since #1656 a reconcile puts a scope on its deployment's sweeper — reap,
     * round-robin and escalation, run against a copy. The directory is the only oracle,
     * so both shapes sit here beside the install they copy, on the same serving script
     * and the same versions: the ONLY thing that tells them apart is the predicate.
     */
    it('never reconciles a fork or a clean-room preview of that install, and does reconcile the install', async () => {
      const real = install();
      const fork = install({ forkedFrom: real.id });
      const cleanRoom = install({ kind: 'preview' });
      const { host, marked } = hostWithScopes([real, fork, cleanRoom], PROMOTED);
      const seen: string[] = [];

      const report = await sweep(host, async (_t, s) => {
        seen.push(s as string);
      });

      expect(seen).toEqual([real.id]);
      expect(marked).toEqual([{ id: real.id, versionId: 'v2' }]);
      expect(report.provisionReconcile).toEqual(tally({ behind: 1, reconciled: 1, failed: 0 }));
    });

    /**
     * The fn is told which version will be recorded, so a caller whose deployment for the
     * scope runs something else can refuse rather than let a receipt name a hook that never
     * ran (#1661 review). For a listed install that is the SERVED version; for a scope on
     * per-version dispatch it is the bound one.
     */
    it('tells the fn the version it will record — the one that runs', async () => {
      const listed = install();
      const legacy = install({ servingRef: null, verticalVersionId: 'v3', provisionedVersionId: 'v1' });
      const { host } = hostWithScopes([listed, legacy], PROMOTED);
      const told = new Map<string, unknown>();

      await sweep(host, async (_t, s, expected?: unknown) => {
        told.set(s as string, expected);
      });

      expect(told.get(listed.id)).toBe('v2');
      expect(told.get(legacy.id)).toBe('v3');
    });

    it('shares its fork test with every caller, and it takes both halves', () => {
      expect(isPrimaryScope({ forkedFrom: null, kind: 'app' })).toBe(true);
      expect(isPrimaryScope({ forkedFrom: sid(), kind: 'app' })).toBe(false);
      expect(isPrimaryScope({ forkedFrom: null, kind: 'preview' })).toBe(false);
    });

    /**
     * A private vertical's promote already moves its scopes' pointers to the served
     * version (`adoptAndRebindOwnedScopes`), so bound and running agree and nothing about
     * those scopes changes here — which is the point of this case.
     */
    it("leaves a private vertical's scopes as #1172 left them", async () => {
      const PRIV = [{ slug: 'own/app', servingRef: 'own-app', servingVersionId: 'p5' }];
      const current = install({ vertical: 'own/app', servingRef: 'own-app', verticalVersionId: 'p5', provisionedVersionId: 'p5' });
      const pushed = install({ vertical: 'own/app', servingRef: 'own-app', verticalVersionId: 'p5', provisionedVersionId: 'p4' });
      const { host, marked } = hostWithScopes([current, pushed], PRIV);

      const report = await sweep(host, async () => {});

      expect(report.provisionReconcile).toEqual(tally({ behind: 1, reconciled: 1, failed: 0 }));
      expect(marked).toEqual([{ id: pushed.id, versionId: 'p5' }]);
    });

    /**
     * An unknown never manufactures a reconcile: wherever the serving script cannot be
     * named, the phase answers exactly what it answered before #1653.
     */
    it('falls back to the bound version wherever the serving script cannot be named', async () => {
      // Legacy per-version dispatch: its own version's script is what runs.
      const legacy = install({ servingRef: null });
      // A serving ref that is not the vertical's current one.
      const stale = install({ servingRef: 'some-older-script' });
      // A vertical with nothing served in place yet.
      const unserved = install({ vertical: 'never/served' });
      const { host } = hostWithScopes([legacy, stale, unserved], [...PROMOTED, { slug: 'never/served' }]);

      const report = await sweep(host, async () => {
        throw new Error('bound = provisioned on all three: nothing to reconcile');
      });

      expect(report.provisionReconcile).toEqual(tally({ behind: 0, reconciled: 0, failed: 0 }));
      expect(runningVersionOf({ verticalVersionId: 'v1', servingRef: REF }, null)).toBe('v1');
      expect(runningVersionOf({ verticalVersionId: 'v1', servingRef: REF }, { ref: REF, versionId: 'v2' })).toBe('v2');
    });

    it('reads the serving pointers once per pass, and not at all when nothing is served in place', async () => {
      const { host } = hostWithScopes([install(), install(), install()], PROMOTED);
      const admin = (host as unknown as { admin: { listVerticals: () => Promise<unknown[]> } }).admin;
      const read = admin.listVerticals;
      let reads = 0;
      admin.listVerticals = async () => {
        reads += 1;
        return read();
      };
      await sweep(host, async () => {});
      expect(reads).toBe(1);

      const legacyOnly = hostWithScopes([install({ servingRef: null, provisionedVersionId: null })]).host;
      (legacyOnly as unknown as { admin: { listVerticals: () => never } }).admin.listVerticals = () => {
        throw new Error('no scope is on a serving script — there is nothing to look up');
      };
      const report = await sweep(legacyOnly, async () => {});
      expect(report.provisionReconcile?.reconciled).toBe(1);
    });

    /**
     * A popular listed vertical has thousands of installs, all behind at once. The pass
     * takes a bounded window and the rest wait — never one unbounded fan-out.
     */
    it('reconciles at most the batch per pass, the rest on the passes after, and each install once', async () => {
      const installs = Array.from({ length: 120 }, () => install());
      const { host, marked } = hostWithScopes(installs, PROMOTED);
      const calls = new Map<string, number>();
      const fn = async (_t: unknown, s: unknown) => {
        calls.set(s as string, (calls.get(s as string) ?? 0) + 1);
      };

      const first = await sweep(host, fn); // the default batch
      expect(first.provisionReconcile).toEqual(tally({ behind: 120, reconciled: 50, failed: 0, deferred: 70 }));
      expect(calls.size).toBe(PROVISION_RECONCILE_BATCH);

      const second = await sweep(host, fn);
      expect(second.provisionReconcile).toEqual(tally({ behind: 70, reconciled: 50, failed: 0, deferred: 20 }));
      const third = await sweep(host, fn);
      expect(third.provisionReconcile).toEqual(tally({ behind: 20, reconciled: 20, failed: 0, deferred: 0 }));
      const fourth = await sweep(host, fn);
      expect(fourth.provisionReconcile).toEqual(tally({ behind: 0, reconciled: 0, failed: 0 }));

      // Every install reached, none twice: ceil(120 / 50) = 3 passes, then silence.
      expect(calls.size).toBe(120);
      expect([...calls.values()].every((n) => n === 1)).toBe(true);
      expect(new Set(marked.map((m) => m.id)).size).toBe(120);
    });

    it('a batch of 0 reconciles nothing and still says who is behind', async () => {
      const { host, marked } = hostWithScopes([install(), install()], PROMOTED);
      const report = await sweep(
        host,
        async () => {
          throw new Error('paused: nothing may be reconciled');
        },
        { provisionReconcileBatch: 0 },
      );
      expect(report.provisionReconcile).toEqual(tally({ behind: 2, reconciled: 0, failed: 0, deferred: 2 }));
      expect(marked).toEqual([]);
    });

    it('one install failing does not stop the rest of its window', async () => {
      const installs = Array.from({ length: 5 }, () => install());
      const broken = installs[2]!;
      const { host, marked } = hostWithScopes(installs, PROMOTED);

      const report = await sweep(host, async (_t, s) => {
        if (s === broken.id) throw new Error('this one refused');
      });

      expect(report.provisionReconcile).toEqual(tally({ behind: 5, reconciled: 4, failed: 1 }));
      expect(marked.map((m) => m.id).sort()).toEqual(installs.filter((i) => i !== broken).map((i) => i.id).sort());
      expect(report.errors).toEqual([{ kind: 'provision-reconcile', id: broken.id, error: 'this one refused' }]);
    });

    /**
     * Installs that fail on every pass must not hold the window forever. 60 of them sort
     * ahead of one healthy install; the batch is 10.
     */
    it('a random window start keeps persistently failing installs from starving a healthy one', async () => {
      const failing = Array.from({ length: 60 }, () => install());
      const healthy = install(); // generated last, so it sorts last
      const run = async (rng: () => number, passes: number) => {
        const { host, marked } = hostWithScopes([...failing.map((f) => ({ ...f })), { ...healthy }], PROMOTED);
        for (let i = 0; i < passes; i++) {
          await sweep(
            host,
            async (_t, s) => {
              if (s !== healthy.id) throw new Error('fails every pass');
            },
            { provisionReconcileBatch: 10, provisionReconcileRng: rng },
          );
        }
        return marked.some((m) => m.id === healthy.id);
      };

      // The negative twin: a FIXED start is what starvation looks like. However many
      // passes run, the same ten failures take the same ten slots.
      expect(await run(() => 0, 20)).toBe(false);

      // Over every possible start, the healthy install is inside the window for exactly
      // `batch` of them — a chance of batch/behind (10/61) on each pass, whatever the
      // other sixty do.
      let reached = 0;
      for (let k = 0; k < 61; k++) if (await run(() => k / 61, 1)) reached += 1;
      expect(reached).toBe(10);
    });

    /**
     * A vertical with no `/internal/reconcile` (it answers 501) is not failing — it
     * answered exactly. Counted apart, no receipt (nothing ran), and not an error, so it
     * cannot bury the refusals somebody has to read.
     */
    it('counts a vertical with no reconcile as unsupported, not failed, and leaves it unmarked', async () => {
      const a = install();
      const { host, marked } = hostWithScopes([a], PROMOTED);

      const report = await sweep(host, async () => 'unsupported');

      expect(report.provisionReconcile).toEqual(
        tally({ behind: 1, reconciled: 0, failed: 0, unsupported: { count: 1, scopeIds: [a.id] } }),
      );
      expect(report.errors).toEqual([]);
      expect(marked).toEqual([]);

      // Still behind, and asked again: a later version that adds the route is reconciled.
      const later = await sweep(host, async () => {});
      expect(later.provisionReconcile).toEqual(tally({ behind: 1, reconciled: 1, failed: 0 }));
    });

    it('caps the unsupported ids it reports and keeps the count exact', async () => {
      const installs = Array.from({ length: 60 }, () => install());
      const { host } = hostWithScopes(installs, PROMOTED);
      const report = await sweep(host, async () => 'unsupported', { provisionReconcileBatch: 100 });
      expect(report.provisionReconcile?.unsupported.count).toBe(60);
      expect(report.provisionReconcile?.unsupported.scopeIds).toHaveLength(PROVISION_RECONCILE_REPORTED_IDS);
    });
  });
});

describe('runPlatformSweep', () => {
  it('drains active scopes and sweeps live connections, summing drain totals', async () => {
    const scopes = [{ id: sid(), tenantId: T }, { id: sid(), tenantId: T }];
    const conns = [
      { id: cid(), provider: 'scrive', revokedAt: null },
      { id: cid(), provider: 'scrive', revokedAt: null },
    ];
    const drained: string[] = [];
    const swept: string[] = [];
    const host = fakeHost({
      scopes,
      connections: conns,
      drainDue: async (_t, s) => {
        drained.push(s);
        return { attempted: 2, delivered: 1, retrying: 1, deadLettered: 0 };
      },
    });
    const sweeper: ConnectorSweeper = async (_h, id) => {
      swept.push(id);
    };

    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: { scrive: sweeper } });

    expect(drained.sort()).toEqual(scopes.map((s) => s.id).sort());
    expect(swept.sort()).toEqual(conns.map((c) => c.id).sort());
    expect(report.scopesDrained).toBe(2);
    expect(report.connectionsSwept).toBe(2);
    expect(report.drainTotals).toEqual({ attempted: 4, delivered: 2, retrying: 2, deadLettered: 0 });
    expect(report.errors).toEqual([]);
  });

  it('drains platform intents for active scopes when a drain fn is supplied, summing totals', async () => {
    const scopes = [{ id: sid(), tenantId: T }, { id: sid(), tenantId: T }];
    const drained: string[] = [];
    const report = await runPlatformSweep(fakeHost({ scopes }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      drainPlatformRequestsFn: async (_t, s) => {
        drained.push(s);
        return { drained: 2, done: 1, failed: 0, pending: 1 };
      },
    });
    expect(drained.sort()).toEqual(scopes.map((s) => s.id).sort());
    expect(report.platformRequestTotals).toEqual({ scopes: 2, drained: 4, done: 2, failed: 0, pending: 2 });
  });

  it('skips the platform-intent phase entirely when no drain fn is supplied', async () => {
    const report = await runPlatformSweep(fakeHost({ scopes: [{ id: sid(), tenantId: T }] }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
    });
    expect(report.platformRequestTotals).toEqual({ scopes: 0, drained: 0, done: 0, failed: 0, pending: 0 });
  });

  it('records a platform-intent drain failure per-scope and steps over it', async () => {
    const scopes = [{ id: sid(), tenantId: T }, { id: sid(), tenantId: T }];
    let calls = 0;
    const report = await runPlatformSweep(fakeHost({ scopes }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      drainPlatformRequestsFn: async () => {
        calls++;
        if (calls === 1) throw new Error('vertical down');
        return { drained: 1, done: 1, failed: 0, pending: 0 };
      },
    });
    expect(report.errors.some((e) => e.kind === 'platform-request')).toBe(true);
    expect(report.platformRequestTotals.done).toBe(1); // the other scope still drained
  });

  it('skips revoked connections and providers with no sweeper', async () => {
    const live = cid();
    const conns = [
      { id: live, provider: 'scrive', revokedAt: null },
      { id: cid(), provider: 'scrive', revokedAt: '2026-01-01T00:00:00.000Z' }, // revoked
      { id: cid(), provider: 'fortnox', revokedAt: null }, // no sweeper registered
    ];
    const swept: string[] = [];
    const host = fakeHost({ connections: conns });
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: async (_h, id) => void swept.push(id) },
    });
    expect(swept).toEqual([live]);
    expect(report.connectionsSwept).toBe(1);
    expect(report.connectionsSkipped).toBe(2);
  });

  it('records each unit outcome through the sweep-run seam - and an unset seam changes nothing (#1232)', async () => {
    const live = cid();
    const broken = cid();
    const orphan = cid();
    const conns = [
      { id: live, provider: 'scrive', revokedAt: null, tenantId: T, vertical: 'acme/crm' },
      { id: broken, provider: 'scrive', revokedAt: null, tenantId: T, vertical: 'acme/crm' },
      // No sweeper registered: recorded as 'skipped' - "bound but never swept" is
      // the declared-vs-observed finding, not noise.
      { id: orphan, provider: 'fortnox', revokedAt: null, tenantId: T, vertical: 'acme/books' },
      // Revoked: deliberately NOT recorded - not waiting to be swept.
      { id: cid(), provider: 'scrive', revokedAt: '2026-01-01T00:00:00.000Z', tenantId: T, vertical: 'acme/crm' },
    ];
    const recorded: import('../src/scope-host.js').SweepRunInput[] = [];
    const sweeper: ConnectorSweeper = async (_h, id) => {
      if (id === broken) throw new Error('provider 500');
    };
    await runPlatformSweep(fakeHost({ connections: conns }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: sweeper },
      recordSweepRun: (e) => void recorded.push(e),
    });
    const byUnit = new Map(recorded.map((e) => [e.unit, e]));
    expect(byUnit.get(live)).toMatchObject({
      kind: 'connector',
      outcome: 'ok',
      tenantId: T,
      vertical: 'acme/crm',
      operation: 'sweep.connector:scrive',
      connectionId: live,
    });
    expect(byUnit.get(live)!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(byUnit.get(broken)).toMatchObject({ outcome: 'failed', error: 'provider 500' });
    expect(byUnit.get(orphan)).toMatchObject({ outcome: 'skipped', operation: 'sweep.connector:fortnox' });
    expect(recorded.length).toBe(3); // the revoked connection wrote no row

    // The null-vs-zero discipline: an unset seam records nothing and changes nothing.
    const bare = await runPlatformSweep(fakeHost({ connections: conns }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: sweeper },
    });
    expect(bare.connectionsSwept).toBe(1);
  });

  it('records a failure on one unit and steps over it — the batch is not sunk', async () => {
    const bad = cid();
    const good = cid();
    const host = fakeHost({
      scopes: [{ id: sid(), tenantId: T }],
      connections: [
        { id: bad, provider: 'scrive', revokedAt: null },
        { id: good, provider: 'scrive', revokedAt: null },
      ],
      drainDue: async () => {
        throw new Error('scope DO unreachable');
      },
    });
    const swept: string[] = [];
    const sweeper: ConnectorSweeper = async (_h, id) => {
      if (id === bad) throw new Error('provider 500');
      swept.push(id);
    };
    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: { scrive: sweeper } });

    expect(swept).toEqual([good]); // the good one still ran
    expect(report.connectionsSwept).toBe(1);
    expect(report.errors).toContainEqual({ kind: 'sweep', id: bad, error: 'provider 500' });
    expect(report.errors.some((e) => e.kind === 'drain' && e.error === 'scope DO unreachable')).toBe(true);
  });

  it('bounds concurrency', async () => {
    const conns = Array.from({ length: 20 }, () => ({ id: cid(), provider: 'scrive', revokedAt: null }));
    let inFlight = 0;
    let peak = 0;
    const sweeper: ConnectorSweeper = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
    };
    const report = await runPlatformSweep(fakeHost({ connections: conns }), {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: sweeper },
      concurrency: 4,
      drainRetries: false,
    });
    expect(report.connectionsSwept).toBe(20);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // it did run in parallel, not serially
  });

  it('drainRetries: false sweeps only connectors', async () => {
    let drainCalled = false;
    const host = fakeHost({
      scopes: [{ id: sid(), tenantId: T }],
      connections: [{ id: cid(), provider: 'scrive', revokedAt: null }],
      drainDue: async () => {
        drainCalled = true;
        return { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 };
      },
    });
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: async () => {} },
      drainRetries: false,
    });
    expect(drainCalled).toBe(false);
    expect(report.scopesDrained).toBe(0);
    expect(report.connectionsSwept).toBe(1);
  });
});

describe('runPlatformSweep — migration reconciliation (§5.3, #49)', () => {
  /** A directory row with just the fields the phase reads, ULID-shaped ids. */
  function row(over: Partial<Scope>): Scope {
    const id = scopeId.parse(genId());
    return {
      id,
      tenantId: T,
      slug: `s-${id.toLowerCase()}`,
      status: 'active',
      vertical: null,
      schemaVersion: '0',
      migrationFailure: null,
      forkedFrom: null,
      ...over,
    } as Scope;
  }

  const failed = (attempts: number, lastAttemptAt: string): MigrationFailure =>
    ({ version: '@v/m@0002-broken', error: 'boom', attempts, lastAttemptAt }) as MigrationFailure;

  const LONG_AGO = '2020-01-01T00:00:00.000Z';

  /** A host with the migration affordances; drain/connection surfaces are inert unless given. */
  function migHost(opts: {
    frontier: number;
    scopes: Scope[];
    migrateScope?: (t: string, s: string) => Promise<MigrateScopeOutcome>;
    drainDue?: (t: string, s: string) => Promise<{ attempted: number; delivered: number; retrying: number; deadLettered: number }>;
  }): ScopeHost {
    return {
      admin: {
        listScopes: async () => opts.scopes,
        listConnections: async () => [],
      },
      migrationFrontier: () => ({ total: opts.frontier }),
      migrateScope: opts.migrateScope ?? (async () => ({ status: 'noop' }) as const),
      drainDue:
        opts.drainDue ??
        (async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 })),
    } as unknown as ScopeHost;
  }

  const run = (host: ScopeHost, extra: object = {}) =>
    runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      migrationBackoff: { baseDelayMs: 0 }, // deterministic: every failed scope is due
      ...extra,
    });

  it('walks the directory and wakes exactly the stragglers, reporting §5.3 numbers', async () => {
    const current = [row({ schemaVersion: '3' }), row({ schemaVersion: '4' })];
    const pending = row({ schemaVersion: '1' }); // behind, never failed — never woken
    const broken = row({ schemaVersion: '2', migrationFailure: failed(1, LONG_AGO) });
    const attempted: string[] = [];
    const host = migHost({
      frontier: 3,
      scopes: [...current, pending, broken],
      migrateScope: async (_t, s) => {
        attempted.push(s);
        if (s === broken.id) return { status: 'failed', failure: { version: '@v/m@0002-broken', error: 'still boom' } };
        return { status: 'migrated', schemaVersion: '3' };
      },
    });

    const report = await run(host);

    expect(attempted.sort()).toEqual([pending.id, broken.id].sort()); // up-to-date scopes untouched
    expect(report.migrations).toMatchObject({
      release: '3',
      total: 4,
      migrated: 3, // 2 already there + the repaired straggler
      pending: 0,
      failed: 1,
      complete: false,
      attempted: 2,
      repaired: 1,
      deferred: 0,
      noops: 0,
    });
    expect(report.migrations?.summary).toBe('release 3: 3/4 migrated, 0 pending, 1 failed');
    expect(report.errors).toEqual([]);
  });

  it('failure is per-scope: one refusing scope neither sinks the pass nor blocks the rest', async () => {
    const unreachable = row({ schemaVersion: '0' });
    const fine = row({ schemaVersion: '0' });
    const host = migHost({
      frontier: 1,
      scopes: [unreachable, fine],
      migrateScope: async (_t, s) => {
        if (s === unreachable.id) throw new Error('scope DO unreachable');
        return { status: 'migrated', schemaVersion: '1' };
      },
    });
    const report = await run(host);
    expect(report.errors).toContainEqual({
      kind: 'migrate',
      id: unreachable.id,
      error: 'scope DO unreachable',
    });
    expect(report.migrations?.repaired).toBe(1);
    // The scope that threw keeps its directory classification — pending, not failed.
    expect(report.migrations?.pending).toBe(1);
  });

  it('a scope this pass left failed is skipped by the drain phase — it fails closed anyway', async () => {
    const broken = row({ schemaVersion: '0', migrationFailure: failed(1, LONG_AGO) });
    const healthy = row({ schemaVersion: '1' });
    const drained: string[] = [];
    const host = migHost({
      frontier: 1,
      scopes: [broken, healthy],
      migrateScope: async () => ({
        status: 'failed',
        failure: { version: '@v/m@0002-broken', error: 'boom' },
      }),
      drainDue: async (_t, s) => {
        drained.push(s);
        return { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 };
      },
    });
    await run(host);
    expect(drained).toEqual([healthy.id]);
  });

  it('backs off: a freshly-failed scope is deferred until its window elapses', async () => {
    const justFailed = row({
      schemaVersion: '0',
      migrationFailure: failed(1, new Date().toISOString()),
    });
    let calls = 0;
    const host = migHost({
      frontier: 1,
      scopes: [justFailed],
      migrateScope: async () => {
        calls += 1;
        return { status: 'migrated', schemaVersion: '1' };
      },
    });
    const report = await run(host, { migrationBackoff: { baseDelayMs: 60_000 } });
    expect(calls).toBe(0);
    expect(report.migrations).toMatchObject({ attempted: 0, deferred: 1, failed: 1 });
    // The same scope with its window long past IS retried.
    const again = await run(
      migHost({
        frontier: 1,
        scopes: [row({ schemaVersion: '0', migrationFailure: failed(1, LONG_AGO) })],
        migrateScope: async () => {
          return { status: 'migrated', schemaVersion: '1' };
        },
      }),
      { migrationBackoff: { baseDelayMs: 60_000 } },
    );
    expect(again.migrations).toMatchObject({ attempted: 1, repaired: 1, deferred: 0 });
  });

  it('flags past the threshold and pages through onMigrationsFlagged', async () => {
    // Two prior failures; this pass's third crosses the default threshold (3).
    const chronic = row({ schemaVersion: '0', migrationFailure: failed(2, LONG_AGO) });
    const fresh = row({ schemaVersion: '0' }); // fails for the first time — not flagged
    const paged: MigrationStraggler[][] = [];
    const host = migHost({
      frontier: 1,
      scopes: [chronic, fresh],
      migrateScope: async () => ({
        status: 'failed',
        failure: { version: '@v/m@0002-broken', error: 'boom' },
      }),
    });
    const report = await run(host, { onMigrationsFlagged: (f: MigrationStraggler[]) => void paged.push(f) });
    expect(paged).toHaveLength(1);
    expect(paged[0]!.map((s) => s.scopeId)).toEqual([chronic.id]);
    const flaggedRow = report.migrations?.stragglers.find((s) => s.scopeId === chronic.id);
    expect(flaggedRow).toMatchObject({ state: 'failed', flagged: true });
    expect(flaggedRow?.failure?.attempts).toBe(3);
    expect(report.migrations?.stragglers.find((s) => s.scopeId === fresh.id)?.flagged).toBe(false);
  });

  it('a throwing pager is recorded, never sinks the pass', async () => {
    const chronic = row({ schemaVersion: '0', migrationFailure: failed(5, LONG_AGO) });
    const host = migHost({
      frontier: 1,
      scopes: [chronic],
      migrateScope: async () => ({
        status: 'failed',
        failure: { version: '@v/m@0002-broken', error: 'boom' },
      }),
    });
    const report = await run(host, {
      onMigrationsFlagged: () => {
        throw new Error('pager down');
      },
    });
    expect(report.migrations?.failed).toBe(1);
    expect(report.errors).toContainEqual({
      kind: 'migrate',
      id: 'onMigrationsFlagged',
      error: 'pager down',
    });
  });

  it('a noop outcome leaves the classification alone — a foreign host repairs nothing', async () => {
    // The control plane sweeping a fleet whose modules run in vertical
    // deployments: everything is "behind" its OWN frontier, nothing is this
    // host's to migrate, and above all nothing gets cleared.
    const foreign = row({ schemaVersion: '0', migrationFailure: failed(1, LONG_AGO) });
    const host = migHost({ frontier: 1, scopes: [foreign] }); // default migrateScope → noop
    const report = await run(host);
    expect(report.migrations).toMatchObject({ attempted: 1, noops: 1, repaired: 0, failed: 1 });
  });

  it('forks and non-live scopes are not fleet: never woken, never counted', async () => {
    const primary = row({ schemaVersion: '2' });
    const fork = row({ schemaVersion: '0', forkedFrom: primary.id });
    const suspended = row({ schemaVersion: '0', status: 'suspended' });
    const attempted: string[] = [];
    const host = migHost({
      frontier: 2,
      scopes: [primary, fork, suspended],
      migrateScope: async (_t, s) => {
        attempted.push(s);
        return { status: 'migrated', schemaVersion: '2' };
      },
    });
    const report = await run(host);
    expect(attempted).toEqual([]);
    expect(report.migrations).toMatchObject({ total: 1, migrated: 1, complete: true });
    expect(report.migrations?.summary).toBe('release 2: 1/1 migrated, 0 pending, 0 failed');
  });

  it('reconcileMigrations: false and a pre-#49 host both yield migrations: null', async () => {
    const off = await run(migHost({ frontier: 1, scopes: [row({})] }), {
      reconcileMigrations: false,
    });
    expect(off.migrations).toBeNull();
    // The original fake host has no migrateScope — the phase steps aside.
    const legacy = await runPlatformSweep(fakeHost({}), { actor: ACTOR, fetch: FETCH, sweepers: {} });
    expect(legacy.migrations).toBeNull();
  });
});

describe('runPlatformSweep — recurring schedules (#383)', () => {
  const SCHED_MOD = '@test/sched';
  type SchedScope = { id: ReturnType<typeof sid>; forkedFrom: string | null };
  function schedHost(opts: {
    scopes: SchedScope[];
    run: ScopeHost['runDueSchedules'];
    schedules?: { moduleId: string; schedules: { operation: string }[] }[];
  }): ScopeHost {
    return {
      admin: {
        listScopes: async () =>
          opts.scopes.map((s) => ({ ...s, tenantId: T, status: 'active' })),
        listConnections: async () => [],
      },
      drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }),
      registeredSchedules: () =>
        opts.schedules ?? [{ moduleId: SCHED_MOD, schedules: [{ operation: 'sched/tick' }] }],
      runDueSchedules: opts.run,
    } as unknown as ScopeHost;
  }
  const opts = (o?: Partial<Parameters<typeof runPlatformSweep>[1]>) => ({
    actor: ACTOR,
    fetch: FETCH,
    sweepers: {},
    drainRetries: false as const,
    gcSnapshots: false as const,
    reconcileMigrations: false as const,
    ...o,
  });

  it('runs due schedules per live scope and aggregates the report', async () => {
    const host = schedHost({
      scopes: [{ id: sid(), forkedFrom: null }, { id: sid(), forkedFrom: null }],
      run: async () => ({ fired: 1, skipped: 0, failed: 0, errors: [] }),
    });
    const report = await runPlatformSweep(host, opts());
    expect(report.schedules).toEqual({ scopes: 2, fired: 2, skipped: 0, failed: 0 });
    expect(report.errors).toEqual([]);
  });

  it('records one row per schedule outcome - skipped included, since an absence of even skips is the missed-run signal (#1232)', async () => {
    const scope = sid();
    const recorded: import('../src/scope-host.js').SweepRunInput[] = [];
    const host = schedHost({
      scopes: [{ id: scope, forkedFrom: null }],
      run: async () => ({
        fired: 1,
        skipped: 1,
        failed: 1,
        errors: [{ operation: 'sched/broken', error: 'operation threw' }],
        runs: [
          { operation: 'sched/tick', outcome: 'ok' },
          { operation: 'sched/rest', outcome: 'skipped' },
          { operation: 'sched/broken', outcome: 'failed' },
        ],
      }),
    });
    await runPlatformSweep(host, opts({ recordSweepRun: (e) => void recorded.push(e) }));
    const byOp = new Map(recorded.map((e) => [e.operation, e]));
    expect(byOp.get('sched/tick')).toMatchObject({
      kind: 'schedule',
      unit: `${scope}:sched/tick`,
      outcome: 'ok',
      tenantId: T,
      scopeId: scope,
    });
    expect(byOp.get('sched/rest')).toMatchObject({ outcome: 'skipped' });
    expect(byOp.get('sched/broken')).toMatchObject({ outcome: 'failed', error: 'operation threw' });
    // A report from a pre-widening host (no `runs`) records nothing - additive, never a crash.
    recorded.length = 0;
    await runPlatformSweep(
      schedHost({ scopes: [{ id: sid(), forkedFrom: null }], run: async () => ({ fired: 1, skipped: 0, failed: 0, errors: [] }) }),
      opts({ recordSweepRun: (e) => void recorded.push(e) }),
    );
    expect(recorded).toEqual([]);
  });

  it('never fires a schedule on a fork/snapshot (forkedFrom set)', async () => {
    const calls: string[] = [];
    const host = schedHost({
      scopes: [{ id: sid(), forkedFrom: null }, { id: sid(), forkedFrom: 'origin' }],
      run: async (_m, _t, s) => {
        calls.push(s);
        return { fired: 1, skipped: 0, failed: 0, errors: [] };
      },
    });
    const report = await runPlatformSweep(host, opts());
    expect(calls).toHaveLength(1); // the primary only
    expect(report.schedules).toEqual({ scopes: 1, fired: 1, skipped: 0, failed: 0 });
  });

  it('records a per-schedule failure and steps over it, never sinking the pass', async () => {
    const host = schedHost({
      scopes: [{ id: sid(), forkedFrom: null }],
      run: async () => ({
        fired: 0,
        skipped: 0,
        failed: 1,
        errors: [{ operation: 'sched/tick', error: 'boom' }],
      }),
    });
    const report = await runPlatformSweep(host, opts());
    expect(report.schedules).toEqual({ scopes: 1, fired: 0, skipped: 0, failed: 1 });
    expect(report.errors).toEqual([
      { kind: 'schedule', id: expect.stringContaining(':sched/tick'), error: 'boom' },
    ]);
  });

  it('a throw from runDueSchedules is caught, recorded, and does not abort', async () => {
    const host = schedHost({
      scopes: [{ id: sid(), forkedFrom: null }],
      run: async () => {
        throw new Error('DO unreachable');
      },
    });
    const report = await runPlatformSweep(host, opts());
    expect(report.errors).toEqual([
      { kind: 'schedule', id: expect.stringContaining(`:${SCHED_MOD}`), error: 'DO unreachable' },
    ]);
  });

  it('runSchedules: false and a pre-#383 host both yield schedules: null', async () => {
    const host = schedHost({
      scopes: [{ id: sid(), forkedFrom: null }],
      run: async () => ({ fired: 1, skipped: 0, failed: 0, errors: [] }),
    });
    expect((await runPlatformSweep(host, opts({ runSchedules: false }))).schedules).toBeNull();
    // The original fake host has no registeredSchedules — the phase steps aside.
    const legacy = await runPlatformSweep(fakeHost({}), { actor: ACTOR, fetch: FETCH, sweepers: {} });
    expect(legacy.schedules).toBeNull();
  });
});

describe('startPlatformSweeper', () => {
  /** A hand-driven clock: startPlatformSweeper reschedules via these, so a test owns the cadence. */
  function fakeClock() {
    let seq = 0;
    const pending = new Map<number, () => void>();
    return {
      setTimer: (cb: () => void) => {
        const id = ++seq;
        pending.set(id, cb);
        return id;
      },
      clearTimer: (h: unknown) => pending.delete(h as number),
      /** Fire the one scheduled callback and let its async body fully settle. */
      async fire() {
        const [id, cb] = [...pending.entries()][0]!;
        pending.delete(id);
        cb();
        // A real macrotask boundary drains the pass's entire microtask chain
        // (all awaits resolve via microtasks) before returning.
        await new Promise((r) => setTimeout(r, 0));
      },
      count: () => pending.size,
    };
  }

  it('runs a pass per tick, reschedules only after it settles, and stops cleanly', async () => {
    const clock = fakeClock();
    const host = fakeHost({ connections: [{ id: cid(), provider: 'scrive', revokedAt: null }] });
    const passes: number[] = [];
    const handle = startPlatformSweeper(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: { scrive: async () => {} },
      intervalMs: 1000,
      onPass: (o) => passes.push('error' in o ? -1 : o.connectionsSwept),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    // One timer is armed, nothing has run yet.
    expect(clock.count()).toBe(1);
    expect(passes).toEqual([]);

    await clock.fire(); // first pass
    expect(passes).toEqual([1]);
    expect(clock.count()).toBe(1); // rescheduled exactly one, no overlap

    await clock.fire(); // second pass
    expect(passes).toEqual([1, 1]);

    handle.stop();
    expect(clock.count()).toBe(0); // pending timer cancelled
  });

  it('a throwing pass is reported, not fatal, and the loop keeps going', async () => {
    const clock = fakeClock();
    // Make the enumeration itself throw — that is NOT caught inside a pass, so it
    // rejects `runPlatformSweep` and exercises the sweeper's own catch.
    const host = fakeHost({});
    (host.admin as unknown as { listScopes: () => Promise<never> }).listScopes = () => {
      throw new Error('directory unreachable');
    };
    const outcomes: (string | number)[] = [];
    startPlatformSweeper(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      intervalMs: 1000,
      onPass: (o) => outcomes.push('error' in o ? o.error : o.connectionsSwept),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await clock.fire();
    expect(outcomes).toEqual(['directory unreachable']); // reported, not thrown
    expect(clock.count()).toBe(1); // rescheduled despite the failure
  });
});

describe('runPlatformSweep — reap long-archived scopes (§4.4)', () => {
  /** A directory row carrying the two fields the reap phase reads: status + archivedAt. */
  const archivedRow = (archivedAt: string | null): Scope =>
    ({
      id: scopeId.parse(genId()),
      tenantId: T,
      slug: 's',
      status: 'archived',
      vertical: null,
      schemaVersion: '0',
      migrationFailure: null,
      forkedFrom: null,
      archivedAt,
    }) as Scope;

  /** A host exposing listScopes + admin.reapScope; the reaped ids are captured. */
  function reapHost(scopes: Scope[], reaped: string[]): ScopeHost {
    return {
      admin: {
        listScopes: async () => scopes,
        listConnections: async () => [],
        reapScope: async (_a: unknown, _t: unknown, s: string) => {
          reaped.push(s);
        },
      },
      drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }),
    } as unknown as ScopeHost;
  }

  const OLD = '2020-01-01T00:00:00.000Z';
  const base = { actor: ACTOR, fetch: FETCH, sweepers: {}, drainRetries: false } as const;

  it('is opt-in: no retention window ⇒ the phase never runs', async () => {
    const reaped: string[] = [];
    const report = await runPlatformSweep(reapHost([archivedRow(OLD)], reaped), { ...base });
    expect(reaped).toEqual([]);
    expect(report.archivedScopesReaped).toBe(0);
  });

  it('reaps scopes archived past the window, skips recent ones and null archivedAt', async () => {
    const old = archivedRow(OLD);
    const recent = archivedRow(new Date().toISOString());
    const unknownAge = archivedRow(null); // archived before the column shipped — never auto-reaped
    const reaped: string[] = [];
    const report = await runPlatformSweep(reapHost([old, recent, unknownAge], reaped), {
      ...base,
      reapArchivedAfterDays: 30,
    });
    expect(reaped).toEqual([old.id]);
    expect(report.archivedScopesReaped).toBe(1);
  });

  it('a per-scope reap failure is recorded and stepped over, never fatal', async () => {
    const a = archivedRow(OLD);
    const b = archivedRow(OLD);
    const reaped: string[] = [];
    const host = reapHost([a, b], reaped);
    (host.admin as unknown as { reapScope: unknown }).reapScope = async (
      _actor: unknown,
      _t: unknown,
      s: string,
    ) => {
      if (s === a.id) throw new Error('DO unreachable');
      reaped.push(s);
    };
    const report = await runPlatformSweep(host, { ...base, reapArchivedAfterDays: 0 });
    expect(reaped).toEqual([b.id]); // b still reaped despite a failing
    expect(report.archivedScopesReaped).toBe(1);
    expect(report.errors).toEqual([{ kind: 'reap', id: a.id, error: 'DO unreachable' }]);
  });

  it('reapScopeFn overrides the default (the control-plane orchestrated reap)', async () => {
    const old = archivedRow(OLD);
    const viaFn: string[] = [];
    const report = await runPlatformSweep(reapHost([old], []), {
      ...base,
      reapArchivedAfterDays: 30,
      reapScopeFn: async (_t, s) => {
        viaFn.push(s);
      },
    });
    expect(viaFn).toEqual([old.id]);
    expect(report.archivedScopesReaped).toBe(1);
  });
});

describe('runPlatformSweep — reap deleting tenants (§4.8)', () => {
  const OLD = '2020-01-01T00:00:00.000Z';
  const base = { actor: ACTOR, fetch: FETCH, sweepers: {}, drainRetries: false } as const;

  const tenantRow = (id: string, deletingAt: string | null, status = 'deleting'): Tenant =>
    ({ id, slug: 's', name: 'n', status, createdAt: OLD, deletingAt }) as Tenant;

  /**
   * A host exposing the reads/writes the tenant-reap phase and its default reaper touch:
   * listTenants, listScopes (by tenant), archiveScope, reapScope, reapTenant. Calls are
   * captured so the test can assert the archive-then-reap-then-reapTenant orchestration.
   */
  function reapHost(
    tenants: Tenant[],
    scopesByTenant: Record<string, Scope[]>,
    calls: string[],
  ): ScopeHost {
    return {
      admin: {
        listTenants: async () => tenants,
        listScopes: async (_a: unknown, filter?: { tenantId?: string }) =>
          filter?.tenantId ? (scopesByTenant[filter.tenantId] ?? []) : [],
        listConnections: async () => [],
        archiveScope: async (_a: unknown, _t: unknown, s: string) => {
          calls.push(`archive:${s}`);
        },
        reapScope: async (_a: unknown, _t: unknown, s: string) => {
          calls.push(`reapScope:${s}`);
        },
        reapTenant: async (_a: unknown, t: string) => {
          calls.push(`reapTenant:${t}`);
        },
      },
      drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }),
    } as unknown as ScopeHost;
  }

  const scopeRow = (id: string, tid: string, status: string): Scope =>
    ({
      id,
      tenantId: tid,
      slug: 's',
      status,
      vertical: null,
      schemaVersion: '0',
      migrationFailure: null,
      forkedFrom: null,
      archivedAt: null,
    }) as Scope;

  it('is opt-in: no retention window ⇒ the phase never runs', async () => {
    const calls: string[] = [];
    const report = await runPlatformSweep(reapHost([tenantRow(T, OLD)], {}, calls), { ...base });
    expect(calls).toEqual([]);
    expect(report.tenantsReaped).toBe(0);
  });

  it('reaps deleting tenants past the window; skips recent, null-age, and non-deleting', async () => {
    const due = tenantRow(genId(), OLD);
    const recent = tenantRow(genId(), new Date().toISOString());
    const unknownAge = tenantRow(genId(), null); // deleting before the column shipped
    const active = tenantRow(genId(), null, 'active');
    const calls: string[] = [];
    const report = await runPlatformSweep(
      reapHost([due, recent, unknownAge, active], { [due.id]: [] }, calls),
      { ...base, reapDeletingAfterDays: 30 },
    );
    expect(calls).toEqual([`reapTenant:${due.id}`]);
    expect(report.tenantsReaped).toBe(1);
  });

  it('the default reaper archives-then-reaps each scope, then clears the directory', async () => {
    const due = tenantRow(genId(), OLD);
    const s1 = scopeRow(sid(), due.id, 'active'); // needs archiving first
    const s2 = scopeRow(sid(), due.id, 'archived'); // reap directly
    const s3 = scopeRow(sid(), due.id, 'reaped'); // already done — skipped
    const calls: string[] = [];
    const report = await runPlatformSweep(
      reapHost([due], { [due.id]: [s1, s2, s3] }, calls),
      { ...base, reapDeletingAfterDays: 0 },
    );
    expect(calls).toEqual([
      `archive:${s1.id}`,
      `reapScope:${s1.id}`,
      `reapScope:${s2.id}`, // already archived — no archive call
      `reapTenant:${due.id}`, // directory cleared only after every scope is reaped
    ]);
    expect(report.tenantsReaped).toBe(1);
  });

  it('the default reaper routes per-scope reaps through reapScopeFn (CP orchestration)', async () => {
    const due = tenantRow(genId(), OLD);
    const s1 = scopeRow(sid(), due.id, 'archived');
    const calls: string[] = [];
    const viaFn: string[] = [];
    await runPlatformSweep(reapHost([due], { [due.id]: [s1] }, calls), {
      ...base,
      reapDeletingAfterDays: 0,
      reapScopeFn: async (_t, s) => {
        viaFn.push(s);
      },
    });
    expect(viaFn).toEqual([s1.id]); // the vertical-orchestrated wipe, not host.admin.reapScope
    expect(calls).toEqual([`reapTenant:${due.id}`]); // reapScope did NOT go through the host
  });

  it('reapTenantFn fully overrides the default tenant reaper', async () => {
    const due = tenantRow(genId(), OLD);
    const viaFn: string[] = [];
    const report = await runPlatformSweep(reapHost([due], { [due.id]: [] }, []), {
      ...base,
      reapDeletingAfterDays: 30,
      reapTenantFn: async (t) => {
        viaFn.push(t);
      },
    });
    expect(viaFn).toEqual([due.id]);
    expect(report.tenantsReaped).toBe(1);
  });

  it('a per-tenant reap failure is recorded under reap-tenant and stepped over', async () => {
    const a = tenantRow(genId(), OLD);
    const b = tenantRow(genId(), OLD);
    const done: string[] = [];
    const report = await runPlatformSweep(reapHost([a, b], { [a.id]: [], [b.id]: [] }, []), {
      ...base,
      reapDeletingAfterDays: 0,
      reapTenantFn: async (t) => {
        if (t === a.id) throw new Error('directory offline');
        done.push(t);
      },
    });
    expect(done).toEqual([b.id]); // b still reaped despite a failing
    expect(report.tenantsReaped).toBe(1);
    expect(report.errors).toEqual([{ kind: 'reap-tenant', id: a.id, error: 'directory offline' }]);
  });
  // -- the access-log drain (K-24, control-plane.md §4.4) ---------------------
  // What matters here is the ORDER: ship, confirm, stamp, prune. Anything that
  // stamps before a confirmed shipment turns one failed upload into permanently
  // deleted evidence, so these hold the driver to that sequence.

  /** A host whose access log is a list, with the three admin calls the drain uses. */
  function drainHost(rows: { id: string; drained: boolean }[]) {
    const calls: string[] = [];
    const admin = {
      listScopes: async () => [],
      listConnections: async () => [],
      accessLog: async (_a: unknown, filter?: { drained?: boolean; limit?: number }) => {
        calls.push('read');
        const match = rows.filter((r) => filter?.drained === undefined || r.drained === filter.drained);
        return match.slice(0, filter?.limit ?? match.length).map((r) => ({ id: r.id, at: r.id }));
      },
      markAccessLogDrained: async (_a: unknown, upToId: string) => {
        calls.push('stamp');
        const hit = rows.filter((r) => !r.drained && r.id <= upToId);
        for (const r of hit) r.drained = true;
        return hit.length;
      },
      pruneAccessLog: async (_a: unknown, limit: number) => {
        calls.push('prune');
        const doomed = rows.filter((r) => r.drained).slice(0, limit);
        for (const d of doomed) rows.splice(rows.indexOf(d), 1);
        return doomed.length;
      },
    };
    return { host: { admin, drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }) } as unknown as ScopeHost, calls };
  }

  it('skips the phase entirely when no sink is configured', async () => {
    const { host, calls } = drainHost([{ id: genId(), drained: false }]);
    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {} });
    // Null, not zeros: "this deployment ships nothing and its log grows by design"
    // is a different fact from "shipped, nothing was waiting".
    expect(report.accessLog).toBeNull();
    expect(calls).toEqual([]); // nothing read, and above all nothing pruned
  });

  it('ships, stamps, then prunes — in that order', async () => {
    const rows = [
      { id: genId(), drained: false },
      { id: genId(), drained: false },
    ];
    const { host, calls } = drainHost(rows);
    const shipped: unknown[][] = [];
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      accessLogSink: {
        ship: async (entries) => {
          // The stamp must not have happened yet — the sink is what makes it legal.
          expect(calls).toEqual(['read']);
          shipped.push(entries);
          return { ref: 'access-log/batch.ndjson' };
        },
      },
    });

    expect(calls).toEqual(['read', 'stamp', 'prune']);
    expect(shipped[0]).toHaveLength(2);
    expect(report.accessLog).toEqual({ shipped: 2, marked: 2, pruned: 2, ref: 'access-log/batch.ndjson' });
    expect(rows).toHaveLength(0);
  });

  it('stamps and prunes NOTHING when the sink fails', async () => {
    const rows = [{ id: genId(), drained: false }];
    const { host, calls } = drainHost(rows);
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      accessLogSink: {
        ship: async () => {
          throw new Error('R2 unreachable');
        },
      },
    });

    // A failed upload leaves the rows exactly where they were. The window does not
    // close this pass — which is the correct outcome, and it is visible.
    expect(calls).toEqual(['read']);
    expect(rows).toEqual([{ id: rows[0]!.id, drained: false }]);
    expect(report.accessLog).toEqual({ shipped: 0, marked: 0, pruned: 0, ref: null });
    expect(report.errors).toEqual([
      { kind: 'access-log', id: 'access-log', error: 'R2 unreachable' },
    ]);
  });

  it('prunes rows a previous pass stamped, even when nothing new ships', async () => {
    // Self-healing: a tick that shipped and stamped but died before pruning leaves
    // drained rows behind, and they are exactly as eligible on the next pass.
    const rows = [{ id: genId(), drained: true }];
    const { host, calls } = drainHost(rows);
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      accessLogSink: { ship: async () => ({ ref: 'unused' }) },
    });

    expect(calls).toEqual(['read', 'prune']); // nothing undrained to ship
    expect(report.accessLog).toMatchObject({ shipped: 0, marked: 0, pruned: 1, ref: null });
    expect(rows).toHaveLength(0);
  });
});

/**
 * The event drain's report of what a scope's read stepped over (#1636), and the parse it
 * runs itself before anything reaches the lake (#1641).
 *
 * The read skips an outbox row that will not decode — never shipped, never stamped — so the
 * rows behind it still reach the lake. What keeps that from being a SILENT gap is the report:
 * a skip the read declared lands in `eventDrain.skipped`, and a clean read leaves the key
 * absent. And because a hosted scope's events come from whatever adapter version its vertical
 * was pushed with, the sweep parses every event with the published `drainedEvent` itself: an
 * event an old vertical served unvalidated is refused here, never shipped, and counted.
 */
describe('runPlatformSweep · event drain skips (#1636, #1641)', () => {
  type Skipped = { count: number; eventIds: string[] };
  type Read = unknown[] & { skipped?: Skipped };

  /** A DrainedEvent the published schema accepts — what a healthy read returns. */
  const drained = (scope: string, over: Record<string, unknown> = {}) => ({
    id: genId(),
    type: 'test.happened',
    schemaVersion: 1,
    occurredAt: '2026-09-01T00:00:00.000Z',
    tenantId: T,
    scopeId: scope,
    actor: genId(),
    entity: { entityType: 'thing', entityId: 'x1' },
    piiClass: 'none',
    payload: { ok: true },
    operation: null,
    version: null,
    causedBy: null,
    invocationId: null,
    ...over,
  });

  function eventHost(scope: ReturnType<typeof sid>, read: () => Read) {
    const shipped: unknown[][] = [];
    const marked: string[][] = [];
    const admin = {
      listScopes: async () => [{ id: scope, tenantId: T, status: 'active' }],
      listConnections: async () => [],
      readUndrainedEvents: async () => read(),
      markEventsDrained: async (_a: unknown, _t: unknown, _s: unknown, ids: string[]) => {
        marked.push(ids);
        return ids.length;
      },
    };
    const host = {
      admin,
      drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }),
    } as unknown as ScopeHost;
    const eventSink = {
      ship: async (_scope: unknown, events: unknown[]) => {
        shipped.push(events);
        return { ref: 'lake' };
      },
    };
    return { host, eventSink, shipped, marked };
  }
  const sweep = (h: ReturnType<typeof eventHost>) =>
    runPlatformSweep(h.host, { actor: ACTOR, fetch: FETCH, sweepers: {}, eventSink: h.eventSink as never });

  it('ships and stamps only what the read returned, and reports what it skipped', async () => {
    const scope = sid();
    const good = drained(scope);
    const bad = genId();
    const h = eventHost(scope, () => Object.assign([good], { skipped: { count: 1, eventIds: [bad] } }));
    const report = await sweep(h);

    expect(report.eventDrain).toEqual({
      scopes: 1,
      shipped: 1,
      incomplete: 0,
      skipped: [{ tenantId: T, scopeId: scope, count: 1, eventIds: [bad] }],
    });
    // The skipped row reaches neither the sink nor the stamp — it never left.
    expect(h.shipped).toEqual([[good]]);
    expect(h.marked).toEqual([[good.id]]);
    // …and the sink is handed a plain array: the skip is the report's, not the lake's.
    expect(Object.keys(h.shipped[0]!)).toEqual(['0']);
    // Not an error: nothing about the pass failed, and the digest mails every error.
    expect(report.errors).toEqual([]);
  });

  it('reports a skip even when nothing behind it could ship', async () => {
    const scope = sid();
    const bad = genId();
    const h = eventHost(scope, () => Object.assign([], { skipped: { count: 10, eventIds: [bad] } }));
    const report = await sweep(h);
    expect(report.eventDrain).toEqual({
      scopes: 0,
      shipped: 0,
      incomplete: 0,
      skipped: [{ tenantId: T, scopeId: scope, count: 10, eventIds: [bad] }],
    });
    expect(h.shipped).toEqual([]);
    expect(h.marked).toEqual([]);
  });

  it('refuses an event the published schema rejects — an old vertical’s — ships its clean twin, counts it', async () => {
    // A vertical older than #1636 answers with the bare array (no `skipped`) and copies its
    // lifted columns unvalidated: `version: ''` and a `caused_by` that is not an event id both
    // reach this side typed as DrainedEvents. Neither may reach the lake, whatever its version.
    const scope = sid();
    const clean = drained(scope);
    const emptyVersion = drained(scope, { version: '' });
    const badCause = drained(scope, { causedBy: 'not-an-event-id' });
    const h = eventHost(scope, () => [emptyVersion, clean, badCause]);
    const report = await sweep(h);

    expect(h.shipped).toEqual([[clean]]);
    expect(h.marked).toEqual([[clean.id]]);
    expect(report.eventDrain!.skipped).toEqual([
      { tenantId: T, scopeId: scope, count: 2, eventIds: [emptyVersion.id, badCause.id] },
    ]);
  });

  it('folds what it refuses into what the read already skipped — one count', async () => {
    const scope = sid();
    const [a, b] = [genId(), genId()];
    const refused = drained(scope, { operation: '' });
    const h = eventHost(scope, () =>
      Object.assign([drained(scope), refused], { skipped: { count: 2, eventIds: [a, b] } }),
    );
    const report = await sweep(h);
    expect(report.eventDrain!.skipped).toEqual([
      { tenantId: T, scopeId: scope, count: 3, eventIds: [a, b, refused.id] },
    ]);
  });

  it('a clean read leaves `skipped` ABSENT — the positive twin', async () => {
    const scope = sid();
    const h = eventHost(scope, () => [drained(scope)]);
    const report = await sweep(h);
    expect(report.eventDrain).toEqual({ scopes: 1, shipped: 1, incomplete: 0 });
    expect(report.eventDrain).not.toHaveProperty('skipped');
  });
});

/**
 * #1705: what the cross-vertical phase COSTS a fleet-wide cron. Every per-scope call is a Durable
 * Object wake (an `/internal` hop too, when hosted), so the phase must call no scope when nothing
 * imports, must call only candidates, and must cap what one pass visits.
 */
describe('runPlatformSweep · cross-vertical cost (#1705)', () => {
  const scopesOf = (n: number, vertical = 'acme/board') =>
    Array.from({ length: n }, () => ({
      id: sid(),
      tenantId: T,
      status: 'active',
      vertical,
      kind: 'app',
      forkedFrom: null,
    }));
  const hostWith = (scopes: object[], imports?: () => { from: string; type: string; schemaVersion: number }[]) => {
    const calls: string[] = [];
    const host = {
      admin: {
        listScopes: async () => scopes,
        listConnections: async () => [],
        importState: async (_a: unknown, _t: unknown, s: string) => {
          calls.push(s);
          return { consumes: [], cursors: [] };
        },
      },
      ...(imports ? { registeredImports: imports } : {}),
    } as unknown as ScopeHost;
    return { host, calls };
  };
  const quiet: Omit<PlatformSweepOptions, 'crossVertical'> = {
    actor: ACTOR,
    fetch: FETCH,
    sweepers: {},
    drainRetries: false,
    gcSnapshots: false,
    reconcileMigrations: false,
    runSchedules: false,
  };

  it('a host that imports nothing calls no scope at all, however large the fleet', async () => {
    const { host, calls } = hostWith(scopesOf(500), () => []);
    const report = await runPlatformSweep(host, { ...quiet, crossVertical: {} });
    expect(calls).toEqual([]);
    expect(report.crossVertical).toMatchObject({ candidates: 0, deferred: 0, edges: [] });
  });

  it('a host that predates registeredImports is read as importing nothing', async () => {
    const { host, calls } = hostWith(scopesOf(50));
    await runPlatformSweep(host, { ...quiet, crossVertical: {} });
    expect(calls).toEqual([]);
  });

  it('only the candidates a reach names are ever called', async () => {
    const scopes = scopesOf(10);
    const { host, calls } = hostWith(scopes, () => [{ from: 'acme/crm', type: 'crm.a', schemaVersion: 1 }]);
    const chosen = new Set([scopes[2]!.id, scopes[7]!.id]);
    await runPlatformSweep(host, {
      ...quiet,
      crossVertical: {
        reach: {
          candidates: (all) => all.filter((s) => chosen.has(s.id)),
          importState: (t, s) => host.admin.importState(ACTOR, t, s),
          readExports: async () => {
            throw new Error('no edge here');
          },
          deliver: async () => {
            throw new Error('no edge here');
          },
        },
      },
    });
    expect(new Set(calls)).toEqual(chosen);
  });

  it('caps the consumers one pass visits, defers the rest, and rotates where it starts', async () => {
    const { host, calls } = hostWith(scopesOf(5), () => [{ from: 'acme/crm', type: 'crm.a', schemaVersion: 1 }]);
    const first = await runPlatformSweep(host, { ...quiet, crossVertical: { maxConsumers: 2, rng: () => 0 } });
    expect(calls).toHaveLength(2);
    expect(first.crossVertical).toMatchObject({ candidates: 5, deferred: 3 });
    const firstWindow = [...calls];

    calls.length = 0;
    await runPlatformSweep(host, { ...quiet, crossVertical: { maxConsumers: 2, rng: () => 0.6 } });
    expect(calls).toHaveLength(2);
    expect(calls).not.toEqual(firstWindow); // a different start: a stuck consumer holds no slot forever

    calls.length = 0;
    const paused = await runPlatformSweep(host, { ...quiet, crossVertical: { maxConsumers: 0 } });
    expect(calls).toEqual([]); // 0 is the pause switch
    expect(paused.crossVertical).toMatchObject({ candidates: 5, deferred: 5 });
  });
});

/**
 * #1705 PR 2 — the control plane's narrowing. On the hosted path every scope call is a Durable
 * Object wake plus an `/internal` hop, so which scopes the phase calls is decided from the
 * version registry, one read per distinct running version, and never by asking a scope.
 */
describe('registryImportCandidates (#1705 PR 2)', () => {
  const V1 = '01JZ0000000000000000000V01';
  const V2 = '01JZ0000000000000000000V02';
  const manifestImporting = (from: string[]) =>
    JSON.stringify({
      registry: {
        permissions: [],
        roles: [],
        imports: from.map((f) => ({ from: f, type: 'crm.a', schemaVersion: 1, declaredBy: ['@x/board'] })),
      },
    });
  const scopesOn = (n: number, versionId: string, extra: object = {}) =>
    Array.from({ length: n }, () => ({
      id: sid(),
      tenantId: T,
      status: 'active',
      vertical: 'acme/board',
      verticalVersionId: versionId,
      kind: 'app',
      forkedFrom: null,
      ...extra,
    })) as unknown as Scope[];
  /** A directory whose versions carry the given manifests, counting its reads. */
  const registry = (manifests: Record<string, string | null>, verticals: object[] = []) => {
    const reads: string[] = [];
    const admin = {
      listVerticals: async () => {
        reads.push('listVerticals');
        return verticals;
      },
      versionManifest: async (_a: unknown, _slug: string, versionId: string) => {
        reads.push(`versionManifest:${versionId}`);
        return manifests[versionId] ?? null;
      },
    };
    return { admin: admin as never, reads };
  };
  const importsOf = (json: string | null) => {
    if (!json) return [];
    const imports = (JSON.parse(json) as { registry?: { imports?: { from: string }[] } }).registry?.imports;
    return imports ?? [];
  };
  const hostWith = (scopes: Scope[]) => {
    const called: string[] = [];
    const host = { admin: { listScopes: async () => scopes, listConnections: async () => [] } } as unknown as ScopeHost;
    const reachOver = (candidates: CrossVerticalReach['candidates']): CrossVerticalReach => ({
      candidates,
      importState: async (_t, s) => {
        called.push(s);
        return { consumes: [], cursors: [] };
      },
      readExports: async () => {
        throw new Error('no edge here');
      },
      deliver: async () => {
        throw new Error('no edge here');
      },
    });
    return { host, called, reachOver };
  };
  const quiet: Omit<PlatformSweepOptions, 'crossVertical'> = {
    actor: ACTOR,
    fetch: FETCH,
    sweepers: {},
    drainRetries: false,
    gcSnapshots: false,
    reconcileMigrations: false,
    runSchedules: false,
  };

  it('a fleet whose running versions import nothing makes zero scope calls, and one registry read per version', async () => {
    const scopes = [...scopesOn(250, V1), ...scopesOn(250, V2)];
    const { admin, reads } = registry({ [V1]: manifestImporting([]), [V2]: null });
    const { host, called, reachOver } = hostWith(scopes);
    const report = await runPlatformSweep(host, {
      ...quiet,
      crossVertical: { reach: reachOver(registryImportCandidates({ admin, actor: ACTOR, importsOf })) },
    });
    expect(called).toEqual([]);
    expect(report.crossVertical).toMatchObject({ candidates: 0, edges: [] });
    // Cached for the pass: 500 scopes, two versions, two reads. No serving script, no listVerticals.
    expect(reads.sort()).toEqual([`versionManifest:${V1}`, `versionManifest:${V2}`]);
  });

  it('only the scopes whose running version imports are called', async () => {
    const importing = scopesOn(3, V1);
    const scopes = [...importing, ...scopesOn(40, V2)];
    const { admin } = registry({ [V1]: manifestImporting(['acme/crm']), [V2]: manifestImporting([]) });
    const { host, called, reachOver } = hostWith(scopes);
    await runPlatformSweep(host, {
      ...quiet,
      crossVertical: { reach: reachOver(registryImportCandidates({ admin, actor: ACTOR, importsOf })) },
    });
    expect(new Set(called)).toEqual(new Set(importing.map((s) => s.id)));
  });

  it('follows the version a scope RUNS: a serving script that serves an importing version counts', async () => {
    // Bound to V2 (imports nothing), but on the serving script, which now serves V1 (imports).
    const scopes = scopesOn(2, V2, { servingRef: 'serving-board' });
    const { admin, reads } = registry(
      { [V1]: manifestImporting(['acme/crm']), [V2]: manifestImporting([]) },
      [{ slug: 'acme/board', servingRef: 'serving-board', servingVersionId: V1 }],
    );
    const narrow = registryImportCandidates({ admin, actor: ACTOR, importsOf });
    expect(await narrow(scopes)).toHaveLength(2);
    expect(reads).toEqual(['listVerticals', `versionManifest:${V1}`]);
  });

  it('with a `from` hint, a scope that imports only from someone else is dropped', async () => {
    const fromCrm = scopesOn(1, V1);
    const fromOther = scopesOn(1, V2);
    const { admin } = registry({ [V1]: manifestImporting(['acme/crm']), [V2]: manifestImporting(['acme/other']) });
    const narrow = registryImportCandidates({ admin, actor: ACTOR, importsOf });
    expect((await narrow([...fromCrm, ...fromOther], { from: 'acme/crm' })).map((s) => s.id)).toEqual([fromCrm[0]!.id]);
    expect(await narrow([...fromCrm, ...fromOther])).toHaveLength(2);
  });
});

/**
 * #1705 PR 2 — the router kick's half: ONE producer's outgoing edges, now. Narrowed to the
 * producer's tenant, to edges whose producer resolves to the named scope, and to consumers that
 * import from it, under the same cap as the sweep.
 */
describe('runCrossVerticalFrom (#1705 PR 2)', () => {
  const U = tenantId.parse(genId());
  const scope = (vertical: string, extra: object = {}) =>
    ({ id: sid(), tenantId: T, status: 'active', vertical, kind: 'app', forkedFrom: null, ...extra }) as unknown as Scope;
  const crm = scope('acme/crm');
  const other = scope('acme/other');
  const board = scope('acme/board');
  const all = [crm, other, board];
  const setup = (scopes: Scope[]) => {
    const listed: unknown[] = [];
    const reads: string[] = [];
    const host = {
      admin: {
        listScopes: async (_a: unknown, filter: { tenantId?: string }) => {
          listed.push(filter);
          return scopes.filter((s) => !filter.tenantId || s.tenantId === filter.tenantId);
        },
      },
    } as unknown as ScopeHost;
    const reach: CrossVerticalReach = {
      candidates: (s, hint) => {
        reads.push(`candidates:${hint?.from ?? '-'}`);
        return s.filter((x) => x.vertical === 'acme/board');
      },
      importState: async () => ({
        consumes: [
          { from: 'acme/crm', type: 'crm.a', schemaVersion: 1 },
          { from: 'acme/other', type: 'other.a', schemaVersion: 1 },
        ] as never,
        cursors: [],
      }),
      readExports: async (_t, s) => {
        reads.push(`read:${s}`);
        return { events: [], withheld: [], unexported: [], paused: null, next: null, more: false };
      },
      deliver: async () => {
        throw new Error('nothing is new, so nothing is delivered');
      },
    };
    return { host, reach, listed, reads };
  };

  it('runs only the named producer\'s edges, reading only its tenant', async () => {
    const { host, reach, listed, reads } = setup(all);
    const out = await runCrossVerticalFrom(host, { actor: ACTOR, crossVertical: { reach } }, { tenantId: T, scopeId: crm.id });
    expect(listed).toEqual([{ status: 'active', tenantId: T }]);
    // Asked for consumers of acme/crm, and read crm, never acme/other.
    expect(reads).toEqual(['candidates:acme/crm', `read:${crm.id}`]);
    expect(out.crossVertical.edges).toEqual([
      expect.objectContaining({ state: 'idle', producer: { vertical: 'acme/crm', scopeId: crm.id } }),
    ]);
    expect(out.errors).toEqual([]);
  });

  it('a kick naming a scope that is not the producer\'s resolved install runs nothing', async () => {
    const fork = scope('acme/crm', { forkedFrom: crm.id });
    const second = scope('acme/crm');
    const foreign = { ...crm, tenantId: U } as Scope;
    for (const [scopes, named] of [
      [[...all, fork], fork], // a fork is never a producer
      [[...all, second], crm], // two primary installs: ambiguous, refused rather than guessed
      [all, scope('acme/crm')], // not listed (not active, or not in the directory)
      [all, foreign], // the right id under another tenant
    ] as [Scope[], Scope][]) {
      const { host, reach, reads } = setup(scopes);
      const out = await runCrossVerticalFrom(
        host,
        { actor: ACTOR, crossVertical: { reach } },
        { tenantId: named.tenantId, scopeId: named.id },
      );
      expect(reads).toEqual([]);
      expect(out.crossVertical.edges).toEqual([]);
    }
  });

  it('keeps the per-pass consumer cap', async () => {
    const boards = [scope('acme/board'), scope('acme/board'), scope('acme/board')];
    const { host, reach } = setup([crm, ...boards]);
    // Two primary boards would be ambiguous as CONSUMERS, which is the edge's business, not the
    // cap's. The cap is what is asserted: two of three visited, one deferred.
    const out = await runCrossVerticalFrom(
      host,
      { actor: ACTOR, crossVertical: { reach, maxConsumers: 2, rng: () => 0 } },
      { tenantId: T, scopeId: crm.id },
    );
    expect(out.crossVertical).toMatchObject({ candidates: 3, deferred: 1 });
  });
});
