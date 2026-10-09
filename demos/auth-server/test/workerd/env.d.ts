// The bindings `cloudflare:test`'s `env` carries in `vitest.workers.config.ts`: the one
// `substrat push` derives from wrangler.jsonc, plus the suite's own vars.
declare namespace Cloudflare {
  interface Env {
    AUTH: DurableObjectNamespace;
    PLATFORM_SECRET: string;
    ROUTER_SECRET: string;
  }
}
