/**
 * The test Worker entry. It bundles the contract-test module set into a ScopeDO
 * (a Durable Object cannot receive handler closures over RPC, so the modules are
 * code-time), exports the two DO classes wrangler binds, and a no-op fetch
 * handler so the Worker is valid. The contract tests drive everything through
 * the exported bindings via `CloudflareScopeHost` — see contract.test.ts.
 */
import { platformActorId } from '@substrat-run/contracts';
import { runPlatformSweep, webCryptoSecretBox, type FetchLike, type PlatformSweepReport } from '@substrat-run/kernel';
import { brokenMod, contractTestModules, contractTestBareOps, scheduleMod } from '@substrat-run/contract-tests';
import { defineScopeDO } from '../src/scope-do.js';
import { CloudflareScopeHost } from '../src/host.js';
import { definePlatformSweeperDO } from '../src/platform-sweeper-do.js';
import { defineScopeSweeperDO } from '../src/scope-sweeper-do.js';

export const ScopeDO = defineScopeDO(contractTestModules, contractTestBareOps);

/**
 * A second scope-DO class carrying ONLY the module whose migration cannot apply.
 * It needs its own class because a DO closes over a code-time module set — putting
 * `brokenMod` in `ScopeDO` would fail every scope in every suite. Bound as
 * BROKEN_SCOPE so migration-failure.test.ts can point a host at it.
 */
export const BrokenScopeDO = defineScopeDO([brokenMod], {});

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
  host: (env) => {
    const host = new CloudflareScopeHost({
      scope: env.LOCAL_SWEEP_SCOPE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    host.registerModule(scheduleMod);
    return host;
  },
});

export default {
  fetch(): Response {
    return new Response('substrat adapter-cloudflare test worker', { status: 200 });
  },
};
