import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // When the pool reloads the shared worker between test files, the first in-flight
    // Durable Object fetch can fail with "…invalidating this Durable Object. Please
    // retry" — a transient the runtime explicitly tells you to retry. One retry absorbs
    // it; a genuine failure still fails on the retry.
    retry: 2,
    poolOptions: {
      workers: {
        // The directory persists across requests within a run — a tenant written
        // by one request must be readable by the next, which is the durability
        // this slice exists to prove. Do NOT roll storage back per test.
        isolatedStorage: false,
        singleWorker: true,
        miniflare: {
          // Enables the UNSAFE dev-actor stub for the test only (never in
          // wrangler.jsonc, so a real deploy stays fail-closed — see src/worker.ts).
          // SESSION_SECRET lets the CLI-broker test mint sessions the worker accepts.
          bindings: {
            ALLOW_DEV_ACTOR: 'true',
            SESSION_SECRET: 'test-session-secret-32-bytes-min-xxxxx',
            // Lets the identity-tenants test call the studio's membership lookup the
            // way the builder worker does (service-token gated, never bypassed).
            SERVICE_TOKEN: 'test-service-token',
            // 32 fixed bytes, base64 — lets the scrive-ingress test seed a sealed
            // connection credential the worker's `secretBoxFor` can open.
            SECRET_BOX_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
            // The pool loads `wrangler.jsonc`, so its `vars` ARE this suite's environment.
            // Pin the provider base here rather than inheriting whichever Scrive production
            // happens to point at: `fetchMock` intercepts one host with net-connect
            // disabled, so a config change on the deploy side would otherwise turn every
            // ingress assertion into an unrelated 500. A test names its own world.
            SCRIVE_BASE_URL: 'https://api-testbed.scrive.com',
          },
          // The vertical service binding names a SEPARATELY deployed worker
          // (`substrat-fsm`), which does not exist in the test runtime — without a
          // stub, workerd refuses to start at all. It answers 501 so a test that
          // reaches it fails loudly rather than silently provisioning nothing.
          serviceBindings: {
            VERTICAL_FSM: () =>
              new Response(JSON.stringify({ error: 'vertical not available in tests' }), {
                status: 501,
                headers: { 'content-type': 'application/json' },
              }),
          },
        },
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
