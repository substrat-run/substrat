import { createExecutionContext, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import worker, { RelayGateway } from '../src/worker.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * The relay holds a vertical to its own scope once the platform can say who is calling.
 *
 * The relay's platform check says a platform script is calling, not which vertical, so the
 * (tenant, scope) in a relay body was the caller's claim. The
 * egress worker now reaches the relay through `RelayGateway` with the caller the router
 * dispatched; these drive that entrypoint and the worker's real routes against the real
 * directory, with a recording `send_email` binding so "nothing was sent" is observed.
 *
 * Two tenants, each with an install of an email-sending vertical: everything below is about
 * whether A's script can act in B's scope.
 */
describe('the relay holds a proven caller to its own scope', () => {
  const SECRET = 'relay-caller-test-secret';
  const staff = platformActorId.parse(ulid());
  const admin = principalId.parse(ulid());
  const tA = tenantId.parse(ulid());
  const tB = tenantId.parse(ulid());
  const vertical = `relay-caller-${tA.slice(-8).toLowerCase()}`;
  const PROVIDER = 'relay-caller-test-provider'; // no probe registered, so nothing leaves for a provider
  let sA: ScopeId;
  let sB: ScopeId;
  const sent: unknown[] = [];

  const testEnv = (over: Record<string, unknown> = {}) =>
    ({
      ...env,
      PLATFORM_SECRET: SECRET,
      EMAIL: { send: async (m: unknown) => (sent.push(m), { delivered: [], queued: [], permanent_bounces: [] }) },
      ...over,
    }) as never;
  const request = (path: string, body: object, headers: Record<string, string> = {}) =>
    new Request(`https://cp.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-substrat-platform': SECRET, ...headers },
      body: JSON.stringify(body),
    });
  const callerHeader = (t: string, s: string) => ({
    'x-substrat-relay-caller': JSON.stringify({ vertical, tenantId: t, scopeId: s }),
  });
  /** Through the gateway, as the egress worker sends it: the caller is the dispatched one. */
  const viaGateway = (path: string, body: object, caller: Record<string, string>, over = {}) =>
    new RelayGateway(createExecutionContext(), testEnv(over)).fetch(request(path, body, caller));
  /** Off the public origin, as anything else would send it. */
  const direct = (path: string, body: object, headers: Record<string, string> = {}, over = {}) =>
    worker.fetch(request(path, body, headers), testEnv(over));

  const hostFor = () =>
    new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('sb1', Uint8Array.from(atob(env.SECRET_BOX_KEY!), (ch) => ch.charCodeAt(0))),
    });

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    const host = hostFor();
    await host.admin.registerVertical(staff, { slug: vertical, name: 'Relay caller', source: 'cli' });
    await host.admin.setVerticalEmailSender(staff, vertical, true);
    const install = async (t: typeof tA): Promise<ScopeId> => {
      await host.admin.createTenant(staff, { id: t, slug: `rc-${t.toLowerCase()}`, name: 'Relay caller' });
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
      await host.admin.activateScope(staff, t, s);
      return s;
    };
    sA = await install(tA);
    sB = await install(tB);
  });

  const mail = (t: string, s: string) => ({ tenantId: t, scopeId: s, to: 'someone@example.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi' });

  describe('the email relay', () => {
    it('a proven caller sends for its own scope', async () => {
      const before = sent.length;
      const res = await viaGateway('/internal/email/send', mail(tA, sA), callerHeader(tA, sA));
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(before + 1);
    });

    it("a proven caller naming another tenant's scope is refused, and nothing is sent", async () => {
      const before = sent.length;
      const res = await viaGateway('/internal/email/send', mail(tB, sB), callerHeader(tA, sA));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: `relay refused: '${vertical}' may only act for its own scope` });
      expect(sent).toHaveLength(before);
    });

    it('the caller header carries no authority off the public origin', async () => {
      // Claiming B's scope in the header changes nothing: the public fetch never reads it.
      // With the switch on, that makes the call unproven, and it is refused like any other.
      const before = sent.length;
      const res = await direct('/internal/email/send', mail(tB, sB), callerHeader(tB, sB), { RELAY_REQUIRE_CALLER: 'true' });
      expect(res.status).toBe(403);
      expect(sent).toHaveLength(before);
    });

    it('an unproven call still sends while the switch is off — the Durable Object path has no caller yet', async () => {
      const before = sent.length;
      const res = await direct('/internal/email/send', mail(tB, sB));
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(before + 1);
    });

    it('with the switch on, a proven caller still sends', async () => {
      const res = await viaGateway('/internal/email/send', mail(tA, sA), callerHeader(tA, sA), { RELAY_REQUIRE_CALLER: 'true' });
      expect(res.status).toBe(200);
    });

    it('a gateway call with no readable caller is a 400, never an unproven pass', async () => {
      const before = sent.length;
      const missing = await viaGateway('/internal/email/send', mail(tA, sA), {});
      const garbled = await viaGateway('/internal/email/send', mail(tA, sA), { 'x-substrat-relay-caller': '{not json' });
      expect([missing.status, garbled.status]).toEqual([400, 400]);
      expect(sent).toHaveLength(before);
    });
  });

  describe('the connection relays', () => {
    const upsert = (t: string, s: string) => ({
      tenantId: t,
      scopeId: s,
      provider: PROVIDER,
      secret: { apiToken: 'PLANTED' },
      grants: [],
      createdBy: admin,
    });

    it("a proven caller cannot plant a credential on another tenant's install", async () => {
      const res = await viaGateway('/internal/connections/upsert', upsert(tB, sB), callerHeader(tA, sA));
      expect(res.status).toBe(403);
      expect(await hostFor().admin.openConnection(tB, vertical, PROVIDER)).toBeUndefined();
    });

    it('a proven caller stores a credential for its own install', async () => {
      const res = await viaGateway('/internal/connections/upsert', upsert(tA, sA), callerHeader(tA, sA));
      expect(res.status).toBe(200);
      expect((await hostFor().admin.openConnection(tA, vertical, PROVIDER))?.secret).toEqual({ apiToken: 'PLANTED' });
    });

    it("a proven caller cannot list another scope's connect links", async () => {
      const res = await viaGateway('/internal/connections/connect-links/list', { tenantId: tB, scopeId: sB }, callerHeader(tA, sA));
      expect(res.status).toBe(403);
    });

    it('a proven caller cannot start a consent round for another scope', async () => {
      const res = await viaGateway(
        '/internal/connections/connect-url',
        { tenantId: tB, scopeId: sB, provider: 'fortnox', createdBy: admin },
        callerHeader(tA, sA),
      );
      expect(res.status).toBe(403);
    });
  });
});
