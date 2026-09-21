// The bindings `cloudflare:test`'s `env` carries in `vitest.workers.config.ts`: the ones
// `substrat push` derives from wrangler.jsonc, plus the suite's own vars.
import type { IdentityDO } from '@substrat-run/vertical-auth';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    SCOPE: DurableObjectNamespace;
    AUTH: DurableObjectNamespace<IdentityDO>;
    SWEEPER: DurableObjectNamespace;
    PLATFORM_SECRET: string;
    ROUTER_SECRET: string;
    SUBSTRAT_VERSION_ID: string;
    /** JSON: the entitlements a dashboard install projects into a scope. */
    TEST_INSTALL_ENTITLEMENTS: string;
  }
}
