import { SELF, env } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { connectionId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { warmControlPlane } from './do-warmup.js';

/**
 * The Scrive webhook ingress on the control plane (#574 phase 2, #96).
 *
 * For a CP-less dispatch vertical the capability URL terminates on THIS worker: the
 * dispatch ledger the token verifies against lives in the ControlPlaneDO's connector
 * state, out of any pushed script's reach. What these tests pin:
 *
 * - **Uniform fail-closed**: malformed id, unknown dispatch, and a token mismatch all
 *   answer the SAME 404 body — the response is no oracle for probing which instances
 *   exist. And nothing short of a verified token causes provider egress: outbound fetch
 *   is mocked with net-connect disabled and NO interceptor registered for these cases,
 *   so any egress would surface as a 500 instead of the asserted 404.
 * - **Verified token → the reconcile runs**: the provider's truth is re-read (the
 *   callback body is never trusted — it is never even read) and the answer is 200.
 * - **Verified but the provider fails → 500**, so Scrive retries and the poll floor
 *   keeps the guarantee.
 */
describe('scrive webhook ingress (#574 phase 2)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const conn = connectionId.parse(ulid());
  const TOKEN = 'a'.repeat(64);
  // Read from the binding, not hard-coded: the pool loads `wrangler.jsonc`, so the
  // worker's provider base is whatever the deploy config says unless the test env
  // overrides it (vitest.config.ts does). Deriving the intercepted origin from the same
  // value is what stops a production config change from failing this suite with an
  // unrelated 500 — which is exactly what setting SCRIVE_BASE_URL for prod first did.
  const SCRIVE = env.SCRIVE_BASE_URL ?? 'https://api-testbed.scrive.com';

  // The worker's own box (`secretBoxFor`): same key bytes (vitest.config.ts binding),
  // same default key id — so a credential sealed here opens under the worker's key.
  const hostFor = () =>
    new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox(
        'sb1',
        Uint8Array.from(atob(env.SECRET_BOX_KEY!), (ch) => ch.charCodeAt(0)),
      ),
    });

  const dispatchKey = (instanceId: string): string => `scrive:dispatch:${instanceId}`;
  const dispatchRow = (instanceId: string, documentId: string) => ({
    documentId,
    instanceId,
    scopeId: s,
    tenantId: t,
    vertical: 'meridian',
    contentHash: 'h'.repeat(64),
    parties: [{ requestId: 'r1', label: 'Alice', kind: 'external', ref: 'party:alice' }],
    webhookToken: TOKEN,
    dispatchedAt: new Date().toISOString(),
  });

  /**
   * The provider, as this suite answers it: each expected request is queued with its reply and
   * answered once, and any other request throws — net-connect disabled. The worker runs in the
   * test's isolate, so stubbing the global is stubbing its egress.
   */
  const expected: { method: string; url: string; reply: () => Response }[] = [];
  const expectFetch = (method: string, path: string, reply: () => Response) =>
    expected.push({ method, url: `${SCRIVE}${path}`, reply });
  let egress: MockInstance<typeof fetch>;

  beforeAll(async () => {
    egress = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const at = expected.findIndex((e) => e.method === request.method && e.url === request.url);
      if (at < 0) throw new Error(`unexpected egress: ${request.method} ${request.url}`);
      return expected.splice(at, 1)[0]!.reply();
    });

    await warmControlPlane(env.CONTROL_PLANE);
    const host = hostFor();
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'meridian' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.createConnection(staff, {
      id: conn,
      tenantId: t,
      vertical: 'meridian',
      provider: 'scrive',
      label: 'scrive testbed',
      secret: { clientId: 'ci', clientSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
    });
    await host.admin.putConnectorState(conn, dispatchKey('inst-1'), dispatchRow('inst-1', 'doc-1'));
    await host.admin.putConnectorState(conn, dispatchKey('inst-2'), dispatchRow('inst-2', 'doc-2'));
  });

  afterEach(() => expect(expected).toEqual([]));
  // Other test files share this isolate — leave `fetch` as found.
  afterAll(() => egress.mockRestore());

  const post = (path: string) => SELF.fetch(`https://cp.test${path}`, { method: 'POST' });

  it('answers the uniform 404 for a malformed connection id', async () => {
    const res = await post(`/hooks/scrive/not-a-ulid/inst-1/${TOKEN}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('answers the SAME 404 for an unknown connection', async () => {
    const res = await post(`/hooks/scrive/${ulid()}/inst-1/${TOKEN}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('answers the SAME 404 for an unknown instance on a real connection', async () => {
    const res = await post(`/hooks/scrive/${conn}/no-such-instance/${TOKEN}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('answers the SAME 404 on a token mismatch — and never touches the provider', async () => {
    const res = await post(`/hooks/scrive/${conn}/inst-1/${'b'.repeat(64)}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('verifies the token and reconciles against the provider (200, body never read)', async () => {
    expectFetch('GET', '/api/v2/documents/doc-1/get', () =>
      Response.json({
        id: 'doc-1',
        status: 'pending',
        parties: [{ id: 'p1', sign_time: null, fields: [{ type: 'name', value: 'Alice' }] }],
      }),
    );

    const res = await post(`/hooks/scrive/${conn}/inst-1/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Nothing was signed, so the reconcile recorded nothing — the ledger row is untouched.
    const row = (await hostFor().admin.getConnectorState(conn, dispatchKey('inst-1'))) as {
      recordedRequestIds?: string[];
    };
    expect(row.recordedRequestIds).toBeUndefined();
  });

  it('answers 500 when the provider fails after verification, so Scrive retries', async () => {
    expectFetch('GET', '/api/v2/documents/doc-2/get', () => new Response('provider down', { status: 500 }));

    const res = await post(`/hooks/scrive/${conn}/inst-2/${TOKEN}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'reconcile failed' });
  });
});
