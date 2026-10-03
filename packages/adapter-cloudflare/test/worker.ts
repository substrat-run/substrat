/**
 * The test Worker entry. It bundles the contract-test module set into a ScopeDO
 * (a Durable Object cannot receive handler closures over RPC, so the modules are
 * code-time), exports the two DO classes wrangler binds, and a no-op fetch
 * handler so the Worker is valid. The contract tests drive everything through
 * the exported bindings via `CloudflareScopeHost` — see contract.test.ts.
 */
import { platformActorId } from '@substrat-run/contracts';
import { runCrossVerticalFrom, runPlatformSweep, ulid, webCryptoSecretBox, type FetchLike, type PlatformSweepReport } from '@substrat-run/kernel';
import {
  boardImportMod,
  brokenMod,
  contractTestModules,
  contractTestBareOps,
  crmExportMod,
  freshnessMod,
  liveMod,
  ownParentMod,
  scheduleMod,
  spineParentMod,
} from '@substrat-run/contract-tests';
import { defineScopeDO, type ScopeDoEnv } from '../src/scope-do.js';
import { CloudflareScopeHost } from '../src/host.js';
import { definePlatformSweeperDO } from '../src/platform-sweeper-do.js';
import { defineScopeSweeperDO } from '../src/scope-sweeper-do.js';
import { defineKickCoalescerDO } from '../src/kick-coalescer-do.js';
import { ControlPlaneDO } from '../src/control-plane-do.js';
import { DurableObject } from 'cloudflare:workers';

export const ScopeDO = defineScopeDO(contractTestModules, contractTestBareOps);

/**
 * #1899: a scope class that reads its harness's directory, not the worker's. A ScopeDO reads
 * tenant tuples and roles through its own `env.CONTROL_PLANE` (the host does not project a
 * scope unless `scopeLocalPermissions` is on), and env is script-wide here — so a harness
 * with a directory of its own needs its scopes to see THAT one as `CONTROL_PLANE`, the way a
 * hosted scope's binding names the directory its host writes. Otherwise its permission reads
 * go to the shared directory, where its tenant does not exist.
 */
type ScopeDOClass = ReturnType<typeof defineScopeDO>;
function onDirectory(Base: ScopeDOClass, directory: string): ScopeDOClass {
  return class extends Base {
    constructor(ctx: DurableObjectState, env: ScopeDoEnv) {
      const own = (env as unknown as Record<string, DurableObjectNamespace | undefined>)[directory];
      if (!own) throw new Error(`test worker: no directory binding ${directory}`);
      super(ctx, { ...env, CONTROL_PLANE: own });
    }
  };
}

/**
 * #1722: a write on a scope that is serving, the way a module operation leaves one: a row in
 * the vertical's table and the event announcing it in the outbox. The preview classes carry no
 * modules, so the carry suite writes through this instead of an `invoke`.
 */
function withTestWrite(Base: ScopeDOClass): ScopeDOClass {
  return class extends Base {
    /** Answers the event's id. */
    testWrite(scopeId: string, id: string, body: string): string {
      // Through the object's own handle, as a module operation writes: the one that counts writes.
      const sql = (this as unknown as { sql: SqlStorage }).sql;
      const eventId = ulid();
      sql.exec('INSERT INTO pv_notes (id, body) VALUES (?, ?)', id, body);
      sql.exec(
        `INSERT INTO _substrat_outbox (id, type, schema_version, occurred_at, tenant_id, scope_id, actor, entity_type, entity_id, pii_class)
         VALUES (?, 'pv.noted', 1, ?, 'tenant', ?, 'actor', 'note', ?, 'none')`,
        eventId, new Date().toISOString(), scopeId, id,
      );
      return eventId;
    }

    /**
     * #2005 × #1722 (Codex #2008 r10): a copy made before the marker — its origin row removed through
     * the raw handle, past the write revision, as a store that never had one never moved it.
     */
    testForgetCopyOrigin(): void {
      (this as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec('DELETE FROM _substrat_copy_origin');
    }

    /** The bookkeeping path asked to take any write but the marker insert, which it must refuse
     *  (Codex #2008 r10–r11): a data write, or a clear of the marker. */
    testBookkeepingWrite(query: string, ...bindings: unknown[]): void {
      const self = this as unknown as { revision: { bookkeeping<T>(run: () => T): T }; sql: SqlStorage };
      self.revision.bookkeeping(() => self.sql.exec(query, ...bindings));
    }

    /**
     * #1722's cost probe (write-revision-cost.test.ts): `ops` operations, each its own run and its
     * own transaction of `rows` row inserts, `rows` event inserts and `rows` updates in place,
     * through the object's own handle, with the write revision counted or not.
     */
    async testWriteBatch(scopeId: string, ops: number, rows: number, counted: boolean): Promise<void> {
      const self = this as unknown as { sql: SqlStorage; revisionSuspended: boolean };
      const exists = self.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bench_rows'`).toArray().length > 0;
      if (!exists) self.sql.exec('CREATE TABLE bench_rows (id TEXT PRIMARY KEY, body TEXT, n INTEGER)');
      self.revisionSuspended = !counted;
      try {
        for (let o = 0; o < ops; o++) {
          (this as unknown as { revision: { transactionSync<T>(run: () => T): T } }).revision.transactionSync(() => {
            for (let r = 0; r < rows; r++) {
              const id = ulid();
              self.sql.exec('INSERT INTO bench_rows (id, body, n) VALUES (?, ?, ?)', id, 'x'.repeat(64), r);
              self.sql.exec(
                `INSERT INTO _substrat_outbox (id, type, schema_version, occurred_at, tenant_id, scope_id, actor, entity_type, entity_id, pii_class)
                 VALUES (?, 'bench.wrote', 1, ?, 'tenant', ?, 'actor', 'row', ?, 'none')`,
                ulid(), new Date().toISOString(), scopeId, id,
              );
              self.sql.exec('UPDATE bench_rows SET n = n + 1 WHERE id = ?', id);
            }
          });
          // Each operation its own run, as an invoke is: the bump it queued lands here.
          await Promise.resolve();
        }
      } finally {
        self.revisionSuspended = false;
      }
    }

    /**
     * #1722: in one synchronous run, a transaction that writes and rolls back, then a write that
     * lands. The bump the first write queued must still cover the second.
     */
    testRollbackThenWrite(id: string, body: string): void {
      const sql = (this as unknown as { sql: SqlStorage }).sql;
      try {
        (this as unknown as { revision: { transactionSync<T>(run: () => T): T } }).revision.transactionSync(() => {
          sql.exec('INSERT INTO pv_notes (id, body) VALUES (?, ?)', `${id}-rolled-back`, body);
          throw new Error('roll back');
        });
      } catch {
        // rolled back, as intended
      }
      sql.exec('INSERT INTO pv_notes (id, body) VALUES (?, ?)', id, body);
    }

    /**
     * #1722 (Codex #2008 r4): a write inside `transactionSync`, and the revision read straight
     * after it with no await in between: the bump has to be in the transaction that committed,
     * not in a later microtask. Answers [before, after].
     */
    testSyncTxRevision(id: string): [string | null, string | null] {
      const self = this as unknown as {
        sql: SqlStorage;
        revision: { transactionSync<T>(run: () => T): T };
        loadMarker(): { revision: string | null };
      };
      const before = self.loadMarker().revision;
      self.revision.transactionSync(() => {
        self.sql.exec('INSERT INTO pv_notes (id, body) VALUES (?, ?)', id, 'in a sync transaction');
      });
      return [before, self.loadMarker().revision];
    }

    /** #1722: a write then a marker read in one run, outside any transaction. Answers [before, after]. */
    testSameRunMarker(id: string): [string | null, string | null] {
      const self = this as unknown as { sql: SqlStorage; loadMarker(): { revision: string | null } };
      const before = self.loadMarker().revision;
      self.sql.exec('INSERT INTO pv_notes (id, body) VALUES (?, ?)', id, 'same run');
      return [before, self.loadMarker().revision];
    }

    /**
     * #1722 (Codex #2008 r4): a bump that cannot be written fails the write it was for. The
     * revision's table is moved aside through the raw handle, a write is attempted through the
     * object's own, and the table is put back. Answers whether it threw and whether the row landed.
     */
    testBumpFailure(id: string): { threw: boolean; landed: boolean } {
      const raw = this.ctx.storage.sql;
      const sql = (this as unknown as { sql: SqlStorage }).sql;
      raw.exec('ALTER TABLE _substrat_meta RENAME TO _substrat_meta_aside');
      let threw = false;
      try {
        sql.exec('INSERT INTO pv_notes (id, body) VALUES (?, ?)', id, 'must not land');
      } catch {
        threw = true;
      } finally {
        raw.exec('ALTER TABLE _substrat_meta_aside RENAME TO _substrat_meta');
      }
      const landed = (raw.exec('SELECT COUNT(*) AS n FROM pv_notes WHERE id = ?', id).toArray()[0] as { n: number }).n > 0;
      return { threw, landed };
    }

    /** #1722's cost probe: count the write revision or not, for calls that follow. */
    testCountWrites(counted: boolean): void {
      (this as unknown as { revisionSuspended: boolean }).revisionSuspended = !counted;
    }
  };
}

/** The schedule suite's scopes (contract.test.ts), over `SCHED_CONTROL_PLANE`. */
export const SchedScopeDO = onDirectory(ScopeDO, 'SCHED_CONTROL_PLANE');
/** The platform-sweep trigger's scopes (platform-sweeper.test.ts), over `SWEEP_CONTROL_PLANE`. */
export const SweepScopeDO = onDirectory(ScopeDO, 'SWEEP_CONTROL_PLANE');
/** The preview directory's own scopes (preview-carry, scope-repoint), over `PC_CONTROL_PLANE`. */
export const PcScopeDO = onDirectory(ScopeDO, 'PC_CONTROL_PLANE');

/**
 * A second scope-DO class carrying ONLY the module whose migration cannot apply.
 * It needs its own class because a DO closes over a code-time module set — putting
 * `brokenMod` in `ScopeDO` would fail every scope in every suite. Bound as
 * BROKEN_SCOPE so migration-failure.test.ts can point a host at it.
 */
export const BrokenScopeDO = defineScopeDO([brokenMod], {});

/**
 * The live-read scope class (#938), carrying ONLY `liveMod`.
 *
 * Its own class and its own namespace for the reason `BrokenScopeDO` has one: a DO
 * closes over a code-time module set, and putting `liveMod` in `ScopeDO` would give
 * every contract suite's scope a post-commit fan-out to run on every invoke — changing
 * what those suites exercise in order to test this one.
 */
export const LiveScopeDO = defineScopeDO([liveMod], {});

/**
 * #1705: two verticals, two deployments. A DO closes over a code-time module set, so each
 * vertical of the cross-vertical suite gets its own class, the way each is its own script
 * when hosted. The coordinator that reaches each registers the same one module.
 */
export const CrmScopeDO = onDirectory(defineScopeDO([crmExportMod], {}), 'VE_CONTROL_PLANE');
export const BoardScopeDO = onDirectory(defineScopeDO([boardImportMod], {}), 'VE_CONTROL_PLANE');

/**
 * #1710: three pushed versions of ONE vertical. Hosted, every push is its own script, and a
 * Durable Object namespace belongs to its script. The classes are identical, and that is
 * the point: the only thing that separates them is the namespace, which is the fact a
 * preview's second push used to lose its data to. See preview-carry.test.ts.
 */
export const PreviewV1ScopeDO = withTestWrite(onDirectory(defineScopeDO([], {}), 'PC_CONTROL_PLANE'));
export const PreviewV2ScopeDO = withTestWrite(onDirectory(defineScopeDO([], {}), 'PC_CONTROL_PLANE'));
export const PreviewV3ScopeDO = withTestWrite(onDirectory(defineScopeDO([], {}), 'PC_CONTROL_PLANE'));

/**
 * #1898: a module whose migration declares a foreign key to the spine, and its twin whose
 * foreign key names its own table. One class each, for the reason `BrokenScopeDO` has one.
 * See spine-references.test.ts.
 */
export const SpineParentScopeDO = defineScopeDO([spineParentMod], {});
export const OwnParentScopeDO = defineScopeDO([ownParentMod], {});

export { ControlPlaneDO };

/**
 * #1899: a directory per harness that counts. Two bindings to ONE class share one namespace,
 * and every host addresses the directory as `idFromName('control-plane')`, so every binding to
 * `ControlPlaneDO` reached the same object: one file's tenants, scopes, schedules and access
 * rows were in every other file's counts. A class of its own is a namespace of its own — the
 * reason `PreviewV1ScopeDO`…`V3` exist. The classes are identical, and that is the point.
 *
 * A directory of its own is half of it: the harness's scopes read it too, through a scope
 * class built with `onDirectory` above.
 */
export class SweepControlPlaneDO extends ControlPlaneDO {}
export class VeControlPlaneDO extends ControlPlaneDO {}
export class PcControlPlaneDO extends ControlPlaneDO {}
export class SchedControlPlaneDO extends ControlPlaneDO {}

// -- the platform-sweep trigger (platform-sweeper.test.ts) --------------------

interface SweeperEnv {
  // The sweeper tests' OWN namespaces, each its own class (#1899) — see the
  // wrangler.jsonc comment for why they are split.
  SWEEP_SCOPE: DurableObjectNamespace;
  SWEEP_CONTROL_PLANE: DurableObjectNamespace;
}

/** The actor the scheduled pass runs as (a machine pass, not staff). */
const SWEEP_ACTOR = platformActorId.parse('01JZ0000000000000000SWEEP1');

/** Egress stub — no sweeper below ever performs real I/O. */
const noFetch: FetchLike = async () => new Response('unused', { status: 200 });

/**
 * One REAL pass: a per-invocation `CloudflareScopeHost` over the same SCOPE /
 * CONTROL_PLANE bindings the contract tests use, driving the kernel's
 * `runPlatformSweep` (treated as a black box) with two fake connector sweepers:
 * `sweep-test` counts its passes in durable connector state (slowly, so the
 * non-overlap test can force a concurrent kick), `sweep-boom` always throws.
 * Drain/GC phases are off — this worker's storage is shared with the contract
 * suites (isolatedStorage: false), and the trigger tests must not consume their
 * scopes' outbox or reap their forks.
 */
async function sweepPass(env: SweeperEnv): Promise<PlatformSweepReport> {
  const host = new CloudflareScopeHost({
    scope: env.SWEEP_SCOPE,
    controlPlane: env.SWEEP_CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  return runPlatformSweep(host, {
    actor: SWEEP_ACTOR,
    fetch: noFetch,
    drainRetries: false,
    gcSnapshots: false,
    sweepers: {
      'sweep-test': async (h, connectionId) => {
        const prior = ((await h.admin.getConnectorState(connectionId, 'sweeps')) as number | undefined) ?? 0;
        await new Promise((resolve) => setTimeout(resolve, 25));
        await h.admin.putConnectorState(connectionId, 'sweeps', prior + 1);
      },
      'sweep-boom': async () => {
        throw new Error('provider exploded');
      },
    },
  });
}

/** The trigger under test: alarm-driven, self-re-arming, non-overlapping. */
export const SweeperDO = definePlatformSweeperDO<SweeperEnv>({
  intervalMs: 60_000,
  sweep: sweepPass,
});

/** A sweeper whose every pass sinks whole — the loop must survive it re-armed. */
export const BrokenSweeperDO = definePlatformSweeperDO<SweeperEnv>({
  intervalMs: 60_000,
  sweep: async () => {
    throw new Error('the directory is unreachable');
  },
});

// -- the CP-less scope-local sweep trigger (scope-sweeper.test.ts, #461) ------

interface ScopeSweeperEnv {
  /** The scope-sweeper tests' OWN scope namespace (same ScopeDO class) — no directory. */
  LOCAL_SWEEP_SCOPE: DurableObjectNamespace;
}

/**
 * The trigger under test: a roster-keeping singleton over a CP-LESS host (no
 * `controlPlane` option — the null-object stand-in, exactly the hosted-vertical
 * shape). Only `scheduleMod` is registered: the pass's schedule half is what
 * #461 is about, and the drain half is a no-op on a module with no consumers.
 */
export const ScopeSweeperDO = defineScopeSweeperDO<ScopeSweeperEnv>({
  intervalMs: 60_000,
  runJobs: true,
  startJobs: async () => {},
  jobStartIntervalMs: 24 * 60 * 60 * 1000,
  // #1232: what production reads off the injected binding, the harness reads off
  // its wrangler var — the pass reports the version whose code actually ran.
  versionId: (env) => (env as unknown as { SUBSTRAT_VERSION_ID?: string }).SUBSTRAT_VERSION_ID ?? null,
  host: (env) => {
    const host = new CloudflareScopeHost({
      scope: env.LOCAL_SWEEP_SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    host.registerJob(scheduleMod.manifest.id, 'noop', () => ({ done: true }));
    // #1232: a second module expecting scheduleMod's event with a wider window —
    // the batch test asserting ONE freshness entry is the cross-module regression.
    host.registerModule(freshnessMod);
    return host;
  },
});

// -- the cross-vertical kick's global bound (vertical-events.test.ts, #1705 PR 2) ----------

interface KickEnv {
  KICK_LOG: DurableObjectNamespace;
  CRM_SCOPE: DurableObjectNamespace;
  VE_CONTROL_PLANE: DurableObjectNamespace;
}

/** Where the kick tests' passes write what they did, so a test can read it back. */
export class KickLogDO extends DurableObject {
  async record(line: string): Promise<void> {
    const lines = (await this.ctx.storage.get<string[]>('lines')) ?? [];
    await this.ctx.storage.put('lines', [...lines, line]);
  }
  async lines(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('lines')) ?? [];
  }
}

const kickLog = (env: KickEnv) =>
  env.KICK_LOG.get(env.KICK_LOG.idFromName('log')) as unknown as { record(line: string): Promise<void> };

/**
 * A coalescer whose pass only records that it ran, and for whom. A long window, so nothing in a
 * test depends on how fast the machine is: a test that wants the window over moves the recorded
 * start back instead of waiting.
 */
export const KickTestDO = defineKickCoalescerDO<KickEnv>({
  windowMs: 60_000,
  run: async (env, producer) => kickLog(env).record(`pass:${producer.tenantId}:${producer.scopeId}`),
});

/**
 * A coalescer whose pass outlasts its window. A zero window, so ANY kick while the pass runs is
 * past it, and only the single-flight can join it to the pass. The pass holds until the test
 * releases it (a `release:<scope>` line in the log), so nothing depends on timing.
 */
export const KickSlowDO = defineKickCoalescerDO<KickEnv>({
  windowMs: 0,
  run: async (env, producer) => {
    const log = kickLog(env) as unknown as { record(l: string): Promise<void>; lines(): Promise<string[]> };
    await log.record(`start:${producer.scopeId}`);
    for (let i = 0; i < 3000; i += 1) {
      if ((await log.lines()).includes(`release:${producer.scopeId}`)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await log.record(`end:${producer.scopeId}`);
  },
});

/** A coalescer whose every pass throws. The kick must still answer, never throw. */
export const KickThrowDO = defineKickCoalescerDO<KickEnv>({
  windowMs: 60_000,
  run: async () => {
    throw new Error('the pass failed');
  },
  onError: () => undefined,
});

/**
 * A coalescer whose pass is the REAL `runCrossVerticalFrom`, over the cross-vertical suite's
 * directory, with a reach that only records. It shows the object holds no authority: a kick
 * naming a fork (or any scope that is not its vertical's resolved instance) calls nothing.
 */
export const KickRealDO = defineKickCoalescerDO<KickEnv>({
  windowMs: 60_000,
  run: async (env, producer) => {
    const log = kickLog(env);
    await log.record(`pass:${producer.scopeId}`);
    const host = new CloudflareScopeHost({ scope: env.CRM_SCOPE, controlPlane: env.VE_CONTROL_PLANE });
    const refuse = async (): Promise<never> => {
      throw new Error('the recording reach answers nothing');
    };
    await runCrossVerticalFrom(
      host,
      {
        actor: platformActorId.parse('01JZ00000000000000000000KK'),
        crossVertical: {
          reach: {
            candidates: async (scopes, hint) => {
              await log.record(`candidates:${producer.scopeId}:${hint?.from ?? '-'}`);
              return scopes.filter((s) => s.tenantId === producer.tenantId);
            },
            importState: refuse,
            readExports: refuse,
            deliver: refuse,
          },
        },
      },
      producer,
    );
  },
});

export default {
  fetch(): Response {
    return new Response('substrat adapter-cloudflare test worker', { status: 200 });
  },
};
