// The bindings the workerd test reaches through `cloudflare:test`'s `env`, plus
// the dev-actor flag miniflare injects (vitest.config.ts).
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    SCOPE: DurableObjectNamespace;
    CONTROL_PLANE: DurableObjectNamespace;
    /** Better Auth's store, and the staff roster (#42). Bound in wrangler.jsonc. */
    AUTH_DB: D1Database;
    ALLOW_DEV_ACTOR?: string;
    /** Signs sessions/flow — bound in vitest.config.ts so the CLI-broker test can mint them. */
    SESSION_SECRET?: string;
    /**
     * The connection-secret seal key — bound in vitest.config.ts so the ingress test can
     * seed a connection the worker's own box (`secretBoxFor`) can open.
     */
    SECRET_BOX_KEY?: string;
    /**
     * Which Scrive the worker talks to. A `vars` entry in `wrangler.jsonc` (production
     * points at the real one), overridden in vitest.config.ts — and read back by the
     * ingress test so its `fetchMock` intercepts whatever the config actually set,
     * rather than a constant that can silently disagree with it.
     */
    SCRIVE_BASE_URL?: string;
  }
}
