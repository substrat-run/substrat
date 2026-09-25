/**
 * The test Worker entry. It bundles the contract-test module set into a ScopeDO
 * (a Durable Object cannot receive handler closures over RPC, so the modules are
 * code-time), exports the two DO classes wrangler binds, and a no-op fetch
 * handler so the Worker is valid. The contract tests drive everything through
 * the exported bindings via `CloudflareScopeHost` — see contract.test.ts.
 */
import { platformActorId } from '@substrat-run/contracts';
import { runCrossVerticalFrom, runPlatformSweep, webCryptoSecretBox, type FetchLike, type PlatformSweepReport } from '@substrat-run/kernel';
import {
  boardImportMod,
  brokenMod,
  contractTestModules,
  contractTestBareOps,
  crmExportMod,
  freshnessMod,
  liveMod,
  scheduleMod,
} from '@substrat-run/contract-tests';
import { defineScopeDO } from '../src/scope-do.js';
import { CloudflareScopeHost } from '../src/host.js';
import { definePlatformSweeperDO } from '../src/platform-sweeper-do.js';
import { defineScopeSweeperDO } from '../src/scope-sweeper-do.js';
import { defineKickCoalescerDO } from '../src/kick-coalescer-do.js';
import { DurableObject } from 'cloudflare:workers';

export const ScopeDO = defineScopeDO(contractTestModules, contractTestBareOps);

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
export const CrmScopeDO = defineScopeDO([crmExportMod], {});
export const BoardScopeDO = defineScopeDO([boardImportMod], {});

/**
 * #1710: three pushed versions of ONE vertical. Hosted, every push is its own script, and a
 * Durable Object namespace belongs to its script. The classes are identical, and that is
 * the point: the only thing that separates them is the namespace, which is the fact a
 * preview's second push used to lose its data to. See preview-carry.test.ts.
 */
export const PreviewV1ScopeDO = defineScopeDO([], {});
export const PreviewV2ScopeDO = defineScopeDO([], {});
export const PreviewV3ScopeDO = defineScopeDO([], {});

export { ControlPlaneDO } from '../src/control-plane-do.js';

// -- the platform-sweep trigger (platform-sweeper.test.ts) --------------------

interface SweeperEnv {
  // The sweeper tests' OWN namespaces (same DO classes as the contract suites'
  // SCOPE/CONTROL_PLANE — see the wrangler.jsonc comment for why they are split).
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
  // #1232: what production reads off the injected binding, the harness reads off
  // its wrangler var — the pass reports the version whose code actually ran.
  versionId: (env) => (env as unknown as { SUBSTRAT_VERSION_ID?: string }).SUBSTRAT_VERSION_ID ?? null,
  host: (env) => {
    const host = new CloudflareScopeHost({
      scope: env.LOCAL_SWEEP_SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
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
 * A coalescer whose pass only records that it ran, and for whom. A short window, so a test can
 * outlast it and see the trailing pass run.
 */
export const KickTestDO = defineKickCoalescerDO<KickEnv>({
  windowMs: 500,
  run: async (env, producer) => kickLog(env).record(`pass:${producer.tenantId}:${producer.scopeId}`),
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
