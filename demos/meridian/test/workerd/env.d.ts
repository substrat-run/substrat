// The bindings `cloudflare:test`'s `env` carries in `vitest.workers.config.ts`: the ones
// `substrat push` derives from wrangler.jsonc, plus the suite's own vars.
declare namespace Cloudflare {
  interface Env {
    SCOPE: DurableObjectNamespace;
    AUTH: DurableObjectNamespace<import('@substrat-run/vertical-auth').IdentityDO>;
    SWEEPER: DurableObjectNamespace;
    PLATFORM_SECRET: string;
    ROUTER_SECRET: string;
    SUBSTRAT_VERSION_ID: string;
    /** JSON: the entitlements a dashboard install projects into a scope. */
    TEST_INSTALL_ENTITLEMENTS: string;
    /** JSON: the tenants whose `ATTACHMENTS__<tenant>` r2_bucket the config binds (#1995). */
    TEST_ATTACHMENT_TENANTS: string;
  }
}
