/**
 * The host the suites construct. This test worker binds `SUBSTRAT_STORE_GRAPH`
 * (wrangler.jsonc) for every test, and an ambient store has no runner to name its
 * kind, so a host that exports a scope must be told it (#2211) — the way a deployed
 * worker is. Declared here once, for the one store this worker binds; a test that
 * passes its own `scopeStores.kinds` keeps them.
 */
import { CloudflareScopeHost as HostUnderTest, type CloudflareScopeHostOptions } from '../src/host.js';

export * from '../src/host.js';

/** `ScopeStoreCounterDO` (worker.ts) is the store behind GRAPH. */
export const TEST_SCOPE_STORE_DRIVERS = { GRAPH: 'counter' } as const;

export class CloudflareScopeHost extends HostUnderTest {
  constructor(options: CloudflareScopeHostOptions) {
    super({
      ...options,
      scopeStores: {
        runners: [],
        ...options.scopeStores,
        kinds: { ...TEST_SCOPE_STORE_DRIVERS, ...options.scopeStores?.kinds },
      },
    });
  }
}
