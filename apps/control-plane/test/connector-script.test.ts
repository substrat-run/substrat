import { env } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { connectionId, platformActorId, tenantId, type Connection } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type ScopeHost } from '@substrat-run/kernel';
import { connectionInspectorsFor, type ConnectorEnv } from '../src/connectors.js';
import scriptConfig from '../../../connectors/bolagsverket/wrangler.jsonc?raw';
import { warmControlPlane } from './do-warmup.js';

declare const __PROBE_CONNECTOR_HOP__: boolean;

/**
 * A connector run as its own script (docs/rfc/connector-scripts.md, phase 1), driven from the
 * control plane's own registry with a real scope host.
 *
 * The path is the one the test environment would run: the control plane → the router's
 * `ConnectorCalls.callScript` (the production function; the dispatch namespace stood in, see
 * `fixtures/connector-script-router.ts`) → the Bolagsverket script as its bundle → the egress worker → the
 * provider, stubbed behind it (vitest.config.ts). What it holds: the call round-trips over the
 * contract under the connector's own egress; refusals keep their meaning across the hop; the script
 * keeps nothing between calls; and with the flag off nothing of this runs.
 */
const harnessBinding = (env as unknown as { CONNECTOR_HARNESS: Fetcher }).CONNECTOR_HARNESS;
type Harness = {
  dispatches: { name: string; outbound: { OUTBOUND_POLICY: Record<string, unknown> } | null }[];
  provider: { host: string; path: string; clientId: string | null; authorization: string | null }[];
};
const harness = async (path = '/state'): Promise<Harness> => (await harnessBinding.fetch(`https://harness${path}`, { method: 'POST' })).json();

const PROD_HOSTS = ['portal.api.bolagsverket.se', 'gw.api.bolagsverket.se'];
const staff = platformActorId.parse(ulid());
const t = tenantId.parse(ulid());
const conn = connectionId.parse(ulid());
const STORED = { clientId: 'stored-client', clientSecret: 'stored-secret-never-echoed' };

const host = () =>
  new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('sb1', Uint8Array.from(atob(env.SECRET_BOX_KEY!), (ch) => ch.charCodeAt(0))),
  });
const bolagsverket = (over: Partial<ConnectorEnv>) => connectionInspectorsFor({ ...(env as unknown as ConnectorEnv), ...over })['bolagsverket']!;
const REMOTE = { REMOTE_CONNECTORS: 'bolagsverket' };
const candidate = (clientId: string) => ({ clientId, clientSecret: `${clientId}-secret` });
const connection = async (): Promise<Connection> => (await host().admin.listConnections(staff, { tenantId: t })).find((c) => c.id === conn)!;

/** The control plane's own egress: a test here must never reach it unless the flag is off. */
let inProcess: MockInstance<typeof fetch>;

beforeAll(async () => {
  await warmControlPlane(env.CONTROL_PLANE);
  const h = host();
  await h.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
  await h.admin.createConnection(staff, { id: conn, tenantId: t, vertical: 'meridian', provider: 'bolagsverket', label: 'Bolagsverket', secret: STORED });
  inProcess = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith('/oauth2/token')) {
      return Response.json({ access_token: 'in-process', token_type: 'Bearer', expires_in: 3600, scope: 'vardefulla-datamangder:read vardefulla-datamangder:ping' });
    }
    if (request.url.endsWith('/isalive')) return new Response('', { status: 200 });
    throw new Error(`unexpected egress: ${request.method} ${request.url}`);
  });
});
beforeEach(async () => {
  inProcess.mockClear();
  await harness('/reset');
});
// Other test files share this isolate — leave `fetch` as found.
afterAll(() => inProcess.mockRestore());

describe('a connector run as its own script (docs/rfc/connector-scripts.md)', () => {
  it("probes a candidate through the router and the script, under the connector's own egress and nothing in-process", async () => {
    const probe = await bolagsverket(REMOTE).probeCandidate!(candidate('candidate-client'));
    expect(probe).toEqual({
      ok: true,
      refused: false,
      accountRef: null,
      accountLabel: null,
      facts: [
        { label: 'Environment', value: 'prod' },
        { label: 'Scopes', value: 'vardefulla-datamangder:read vardefulla-datamangder:ping' },
      ],
      error: null,
    });
    const seen = await harness();
    expect(seen.dispatches).toEqual([
      {
        name: 'substrat-connector-bolagsverket',
        outbound: {
          OUTBOUND_POLICY: { slug: 'substrat-connector-bolagsverket', tenant: '', hosts: PROD_HOSTS, scope: '', calls: [], stores: null, depth: 0, primary: true },
        },
      },
    ]);
    expect(seen.provider.map((p) => `${p.host}${p.path}`)).toEqual([
      'portal.api.bolagsverket.se/oauth2/token',
      'gw.api.bolagsverket.se/vardefulla-datamangder/v1/isalive',
    ]);
    expect(inProcess).not.toHaveBeenCalled();
  });

  it("sends a stored connection's opened credential, records the script's uses against it, and answers no secret", async () => {
    const probe = await bolagsverket(REMOTE).probe!(host(), await connection());
    expect(probe).toMatchObject({ ok: true, refused: false });
    expect(JSON.stringify(probe)).not.toContain(STORED.clientSecret);
    const seen = await harness();
    expect((seen.dispatches[0]!.outbound!.OUTBOUND_POLICY as { tenant: string }).tenant).toBe(t);
    expect(seen.provider[0]!.clientId).toBe(STORED.clientId);
    // The two uses the script reported landed on the connection's health.
    expect((await connection()).lastOkAt).not.toBeNull();
    expect(inProcess).not.toHaveBeenCalled();
  });

  it("keeps a refusal's meaning across the hop: the tenant's credential is refused, the platform's failure is not", async () => {
    expect(await bolagsverket(REMOTE).probeCandidate!(candidate('refused-client'))).toMatchObject({ ok: false, refused: true, error: expect.stringMatching(/invalid_client/) });
    expect(await bolagsverket(REMOTE).probeCandidate!(candidate('ping-only-client'))).toMatchObject({
      ok: false,
      refused: true,
      error: expect.stringMatching(/not granted vardefulla-datamangder:read/),
    });
    await harness('/undeploy');
    expect(await bolagsverket(REMOTE).probeCandidate!(candidate('candidate-client'))).toMatchObject({
      ok: false,
      refused: false,
      error: expect.stringMatching(/answered HTTP 503: .*not deployed/),
    });
    // And a control plane without the route says so, rather than calling anything.
    expect(await bolagsverket({ ...REMOTE, CONNECTOR_CALLS: undefined }).probeCandidate!(candidate('candidate-client'))).toMatchObject({
      ok: false,
      refused: false,
      error: expect.stringMatching(/no route to it/),
    });
  });

  it('keeps no credential and no token between calls, and declares no binding to keep one in', async () => {
    await bolagsverket(REMOTE).probeCandidate!(candidate('candidate-client'));
    // A token cached from the first client would answer the second with its scopes: it is refused instead.
    expect(await bolagsverket(REMOTE).probeCandidate!(candidate('ping-only-client'))).toMatchObject({ ok: false, refused: true });
    const { provider } = await harness();
    expect(provider.filter((p) => p.path.endsWith('/oauth2/token')).map((p) => p.clientId)).toEqual(['candidate-client', 'ping-only-client']);
    expect(provider.filter((p) => p.path.endsWith('/isalive')).map((p) => p.authorization)).toEqual(['Bearer token-for-candidate-client', 'Bearer token-for-ping-only-client']);
    // What the deploy reads: a name, an entry, a date, and nothing it could store a credential in.
    const declared = JSON.parse(scriptConfig.replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;
    expect(Object.keys(declared).sort()).toEqual(['compatibility_date', 'main', 'name', 'observability', 'workers_dev']);
  });

  it('runs in-process, exactly as before, with the flag off', async () => {
    expect(await bolagsverket({}).probeCandidate!(candidate('candidate-client'))).toMatchObject({ ok: true });
    expect(await bolagsverket({ REMOTE_CONNECTORS: 'fortnox' }).probe!(host(), await connection())).toMatchObject({ ok: true });
    expect(inProcess).toHaveBeenCalledTimes(4);
    expect(await harness()).toMatchObject({ dispatches: [], provider: [] });
  });

  it('under the hop probe, answers from where the flag places it and logs one comparison per call', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const probe = { PROBE_CONNECTOR_HOP: 'bolagsverket' };
      expect(await bolagsverket({ ...REMOTE, ...probe }).probeCandidate!(candidate('candidate-client'))).toMatchObject({ ok: true });
      expect(await bolagsverket(probe).probe!(host(), await connection())).toMatchObject({ ok: true });
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((l) => l.connector === 'connector-hop-probe');
      expect(lines).toEqual([
        expect.objectContaining({ role: 'probe-candidate', answeredBy: 'script', agree: true, hopMs: expect.any(Number) }),
        expect.objectContaining({ role: 'probe', answeredBy: 'in-process', agree: true, hopMs: expect.any(Number) }),
      ]);
      expect(JSON.stringify(lines)).not.toMatch(/secret/);
      // Both sides ran each time: two provider calls each way.
      expect(inProcess).toHaveBeenCalledTimes(4);
      expect((await harness()).provider).toHaveLength(4);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps health writes out of both hop samples, whichever side is placed, and records only the placed one', async () => {
    // A recorder this slow would move hopMs by ±2 × WRITE_MS if either sample timed the writes.
    const WRITE_MS = 150;
    const real = host();
    const recorded: unknown[] = [];
    const slow = {
      admin: {
        openConnection: (...a: Parameters<typeof real.admin.openConnection>) => real.admin.openConnection(...a),
        recordConnectionUse: async (_id: unknown, use: unknown) => {
          recorded.push(use);
          await new Promise((resolve) => setTimeout(resolve, WRITE_MS));
        },
      },
    } as unknown as ScopeHost;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const placement of [REMOTE, {}]) {
        recorded.length = 0;
        expect(await bolagsverket({ ...placement, PROBE_CONNECTOR_HOP: 'bolagsverket' }).probe!(slow, await connection())).toMatchObject({ ok: true });
        // The placed side's token mint and ping, once each; the shadow's are never recorded.
        expect(recorded).toEqual([expect.objectContaining({ ok: true, status: 200 }), expect.objectContaining({ ok: true, status: 200 })]);
      }
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { connector?: string; answeredBy: string; hopMs: number }).filter((l) => l.connector === 'connector-hop-probe');
      expect(lines.map((l) => l.answeredBy)).toEqual(['script', 'in-process']);
      for (const { hopMs } of lines) expect(Math.abs(hopMs)).toBeLessThan(WRITE_MS);
    } finally {
      log.mockRestore();
    }
  });
});

/**
 * The hop, measured locally (opt-in: SUBSTRAT_PROBE_CONNECTOR_HOP=1). Every call runs both ways, as
 * the hop probe does in an environment, and the summary is the median and p90 of each. Here both
 * the provider and the hop are in-process stand-ins, so this is a floor and a check of the method;
 * the figure that decides anything is the same log line from the test environment.
 */
describe.skipIf(!__PROBE_CONNECTOR_HOP__)('the connector hop, measured (opt in)', () => {
  it('compares in-process and script latency per call', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const probes = { ...REMOTE, PROBE_CONNECTOR_HOP: 'bolagsverket' };
    for (let i = 0; i < 40; i++) await bolagsverket(probes).probeCandidate!(candidate('candidate-client'));
    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { connector?: string; hopMs: number; inProcess: { totalMs: number }; script: { totalMs: number } }).filter((l) => l.connector === 'connector-hop-probe');
    log.mockRestore();
    const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
    const summary = (xs: number[]) => ({ p50: pct(xs, 0.5), p90: pct(xs, 0.9) });
    console.info(
      JSON.stringify({
        calls: lines.length,
        inProcessMs: summary(lines.map((l) => l.inProcess.totalMs)),
        scriptMs: summary(lines.map((l) => l.script.totalMs)),
        hopMs: summary(lines.map((l) => l.hopMs)),
      }),
    );
    expect(lines).toHaveLength(40);
  }, 60_000);
});
