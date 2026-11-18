import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { workerdTestTimeout } from '../../tools/vitest/timeout-policy.mjs';

/**
 * The connector-script suite's world (`test/connector-script.test.ts`, docs/rfc/connector-scripts.md):
 * three auxiliary workers, each the code that ships, bundled the way a deploy bundles it — the
 * router's `ConnectorCalls` (`fixtures/connector-script-router.ts`, the dispatch namespace stood in),
 * the Bolagsverket connector script, and the egress worker in front of the script's subrequests.
 * Behind the egress worker the provider is `provider`, below. `harness` is node-side state the
 * suite reads through the `CONNECTOR_HARNESS` binding: what the router dispatched, under which
 * outbound policy, and every call the provider received.
 */
const bundle = async (entry: string) =>
  (
    await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url).href)],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'import'],
      mainFields: ['module', 'main'],
      external: ['cloudflare:*', 'node:*'],
      write: false,
    })
  ).outputFiles[0]!.text;

const CONNECTOR_SCRIPT = 'substrat-connector-bolagsverket';
const harness = {
  deployed: true,
  dispatches: [] as { name: string; outbound: unknown }[],
  provider: [] as { host: string; path: string; clientId: string | null; authorization: string | null }[],
};
const harnessBinding = async (request: Request): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (pathname === '/dispatch') {
    harness.dispatches.push((await request.json()) as (typeof harness.dispatches)[number]);
    return new Response(harness.deployed ? 'deployed' : 'missing');
  }
  if (pathname === '/undeploy') harness.deployed = false;
  if (pathname === '/reset') Object.assign(harness, { deployed: true, dispatches: [], provider: [] });
  return Response.json(harness);
};
/**
 * Bolagsverket, as this suite answers it: a token per client id (`refused-client` is turned away,
 * `long-refusal-client` too with a 700-character description, `ping-only-client` is granted the
 * ping scope alone) and a health ping.
 */
const provider = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const body = request.method === 'POST' ? new URLSearchParams(await request.text()) : null;
  const clientId = body?.get('client_id') ?? null;
  harness.provider.push({ host: url.hostname, path: url.pathname, clientId, authorization: request.headers.get('authorization') });
  if (url.pathname.endsWith('/oauth2/token')) {
    if (clientId === 'refused-client') return Response.json({ error: 'invalid_client' }, { status: 401 });
    // A refusal whose description runs past what a probe may display (600 characters).
    if (clientId === 'long-refusal-client') return Response.json({ error: 'invalid_client', error_description: `client unknown: ${'x'.repeat(700)}` }, { status: 401 });
    const scope = clientId === 'ping-only-client' ? 'vardefulla-datamangder:ping' : 'vardefulla-datamangder:read vardefulla-datamangder:ping';
    return Response.json({ access_token: `token-for-${clientId}`, token_type: 'Bearer', expires_in: 3600, scope });
  }
  if (url.pathname.endsWith('/isalive')) return new Response('', { status: 200 });
  return new Response('not a Bolagsverket route', { status: 404 });
};

export default defineConfig(async () => ({
  define: {
    __PROBE_REDACTION_COST__: JSON.stringify(process.env.SUBSTRAT_PROBE_REDACTION_COST === '1'),
    // The connector hop, measured: in-process against the script, one call after another. Opt-in.
    __PROBE_CONNECTOR_HOP__: JSON.stringify(process.env.SUBSTRAT_PROBE_CONNECTOR_HOP === '1'),
  },
  // The directory persists across requests within a run — a tenant written
  // by one request must be readable by the next, which is the durability
  // this slice exists to prove. Do NOT roll storage back per test.
  plugins: [
    cloudflareTest({
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
          // happens to point at: the suite stubs one host with net-connect
          // disabled, so a config change on the deploy side would otherwise turn every
          // ingress assertion into an unrelated 500. A test names its own world.
          SCRIVE_BASE_URL: 'https://api-testbed.scrive.com',
        },
        // The vertical service binding names a SEPARATELY deployed worker
        // (`substrat-fsm`), which does not exist in the test runtime — without a
        // stub, workerd refuses to start at all. It answers 501 so a test that
        // reaches it fails loudly rather than silently provisioning nothing.
        serviceBindings: {
          SOURCE_BUILDER: () => Response.json({ detail: 'source builder not available in tests' }, { status: 503 }),
          VERTICAL_FSM: () =>
            new Response(JSON.stringify({ error: 'vertical not available in tests' }), {
              status: 501,
              headers: { 'content-type': 'application/json' },
            }),
          // #1544: the social relay is a separately deployed worker too. Same stub, same reason;
          // the reconciler itself is driven in control-plane-api's suite against a fake relay.
          SOCIAL_RELAY: () =>
            new Response(JSON.stringify({ error: 'social relay not available in tests' }), {
              status: 501,
              headers: { 'content-type': 'application/json' },
            }),
          // The router's `ConnectorCalls` entrypoint, likewise separately deployed. Its `call` (the
          // vertical-defined half) answers 501, and the proxy that calls it is driven in
          // control-plane-api's suite against a fake transport; its `callScript` is the real router
          // code, for the connector-script suite (see `bundle` above).
          CONNECTOR_CALLS: { name: 'connector-calls-router', entrypoint: 'ConnectorCalls' },
          CONNECTOR_HARNESS: harnessBinding,
        },
        workers: [
          {
            name: 'connector-calls-router',
            modules: [{ type: 'ESModule', path: 'router.mjs', contents: await bundle('./fixtures/connector-script-router.ts') }],
            compatibilityDate: '2025-01-01',
            serviceBindings: { SCRIPT: CONNECTOR_SCRIPT, HARNESS: harnessBinding },
          },
          {
            // Exactly what `wrangler.jsonc` in the connector declares: no binding of any kind.
            name: CONNECTOR_SCRIPT,
            modules: [{ type: 'ESModule', path: 'script.mjs', contents: await bundle('../../connectors/bolagsverket/src/script.ts') }],
            compatibilityDate: '2025-01-01',
            outboundService: 'connector-egress',
          },
          {
            // The egress worker, under the policy the router hands a Bolagsverket call in production
            // hosts: the suite asserts the router's policy names the same hosts.
            name: 'connector-egress',
            modules: [{ type: 'ESModule', path: 'egress.mjs', contents: await bundle('../vertical-egress/src/worker.ts') }],
            compatibilityDate: '2025-01-01',
            bindings: {
              PLATFORM_BASE_DOMAINS: 'substrat.run',
              PLATFORM_CP_URL: 'https://console-test.substrat.net',
              OUTBOUND_POLICY: {
                slug: CONNECTOR_SCRIPT,
                tenant: '',
                hosts: ['portal.api.bolagsverket.se', 'gw.api.bolagsverket.se'],
                scope: '',
                calls: [],
                stores: null,
                depth: 0,
                primary: true,
              },
            },
            outboundService: provider,
          },
        ],
      },
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    ...workerdTestTimeout,
    // vitest 5.0.4+ turns the module cache on by default, which crashes the workerd pool (WebSocket 1009).
    fsModuleCache: false,
    include: ['test/**/*.test.ts'],
    // When the pool reloads the shared worker between test files, the first in-flight
    // Durable Object fetch can fail with "…invalidating this Durable Object. Please
    // retry" — a transient the runtime explicitly tells you to retry. One retry absorbs
    // it; a genuine failure still fails on the retry.
    retry: 2,
    // One file at a time, as the old pool's `singleWorker` ran them.
    fileParallelism: false,
    // A rejection nobody handles fails its test; one an RPC caller awaited does not (#2131).
    setupFiles: ['../../tools/vitest/workerd-rejections.mjs'],
  },
}));
