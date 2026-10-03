import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { DEV_ACTOR_HEADER, PREVIEW_CONNECTIONS_REFUSAL } from '@substrat-run/control-plane-api';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import worker, { PREVIEW_EMAIL_REFUSAL } from '../src/worker.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #2005: previews and forks cannot send email or change a tenant's connections. Driven
 * through the control-plane worker's real routes against the real directory Durable Object,
 * for every shape of copy, each beside its twin on the install:
 *
 * - the email relay sends nothing (a recording `send_email` binding stands in for the
 *   transport, so "nothing was sent" is observed, not assumed);
 * - the connection relay writes nothing, and the install's credential is the one stored;
 * - the connect-url relay mints no URL;
 * - the tenant connections route — where a consent round's callback stores its credential —
 *   refuses the copy at write time, which is what stops a round minted before this change.
 *
 * The suite's own environment binds no platform secret, and must not (other files assert the
 * relays fail closed without one), so each call adds that one variable and keeps every other
 * binding real.
 */
describe('previews and forks cannot send email or change connections (#2005)', () => {
  const SECRET = 'preview-relays-test-secret';
  const staff = platformActorId.parse(ulid());
  const admin = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const vertical = `inert-relays-${t.slice(-8).toLowerCase()}`;
  const PROVIDER = 'inert-test-provider'; // no probe registered, so nothing leaves for a provider
  const shapes = ['previewFork', 'cleanRoom', 'fork'] as const;
  const scopes = {} as Record<'install' | (typeof shapes)[number], ScopeId>;
  const sent: unknown[] = [];

  const call = (path: string, body: object, headers: Record<string, string> = { 'x-substrat-platform': SECRET }) =>
    worker.fetch(
      new Request(`https://cp.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      {
        ...env,
        PLATFORM_SECRET: SECRET,
        PLATFORM_CONNECT_URL: 'https://app.substrat.test',
        // The Workers binding answers the send's body directly.
        EMAIL: { send: async (m: unknown) => (sent.push(m), { delivered: [], queued: [], permanent_bounces: [] }) },
      } as never,
    );
  // The worker's own box (vitest.config.ts binds the key), so this reader opens what the
  // relay sealed.
  const hostFor = () =>
    new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('sb1', Uint8Array.from(atob(env.SECRET_BOX_KEY!), (ch) => ch.charCodeAt(0))),
    });
  const connections = async () =>
    hostFor().admin.listConnections(staff, {
      tenantId: t,
      provider: PROVIDER,
    });

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    const host = hostFor();
    await host.admin.createTenant(staff, { id: t, slug: `relays-${t.toLowerCase()}`, name: 'Relays' });
    await host.admin.registerVertical(staff, { slug: vertical, name: 'Relays', source: 'cli' });
    await host.admin.setVerticalEmailSender(staff, vertical, true);
    const provision = async (extra: Record<string, unknown> = {}): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical, ...extra });
      await host.admin.activateScope(staff, t, s);
      return s;
    };
    scopes.install = await provision();
    scopes.previewFork = await provision({ kind: 'preview', forkedFrom: scopes.install, forkedAt: new Date().toISOString() });
    scopes.cleanRoom = await provision({ kind: 'preview' });
    scopes.fork = await provision({ forkedFrom: scopes.install, forkedAt: new Date().toISOString() });
  });

  const mail = (s: ScopeId) => ({ tenantId: t, scopeId: s, to: 'someone@example.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi' });
  const upsert = (s: ScopeId, secret: string) => ({
    tenantId: t,
    scopeId: s,
    provider: PROVIDER,
    secret: { apiToken: secret },
    grants: [],
    createdBy: admin,
  });

  describe('the email relay', () => {
    it('twin: the install sends', async () => {
      const res = await call('/internal/email/send', mail(scopes.install));
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
    });

    for (const shape of shapes) {
      it(`${shape}: refused 403, and nothing is sent`, async () => {
        const before = sent.length;
        const res = await call('/internal/email/send', mail(scopes[shape]));
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: PREVIEW_EMAIL_REFUSAL });
        expect(sent).toHaveLength(before);
      });
    }
  });

  describe('the connection relay', () => {
    it("twin: the install stores the tenant's connection", async () => {
      const res = await call('/internal/connections/upsert', upsert(scopes.install, 'INSTALL'));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ created: true });
    });

    for (const shape of shapes) {
      it(`${shape}: refused 403, and the install's connection is unchanged`, async () => {
        const before = await connections();
        const res = await call('/internal/connections/upsert', upsert(scopes[shape], 'COPY'));
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: PREVIEW_CONNECTIONS_REFUSAL });
        expect(await connections()).toEqual(before);
        expect((await hostFor().admin.openConnection(t, vertical, PROVIDER))?.secret).toEqual({ apiToken: 'INSTALL' });
      });
    }
  });

  describe('the connect-url relay', () => {
    const round = (s: ScopeId) => ({ tenantId: t, scopeId: s, provider: 'fortnox', createdBy: admin });

    it('twin: the install gets a consent URL', async () => {
      const res = await call('/internal/connections/connect-url', round(scopes.install));
      expect(res.status).toBe(200);
      expect((await res.json()) as { url: string }).toMatchObject({ url: expect.stringMatching(/^https:\/\/app\.substrat\.test\//) });
    });

    for (const shape of shapes) {
      it(`${shape}: refused 403, and no URL is minted`, async () => {
        const res = await call('/internal/connections/connect-url', round(scopes[shape]));
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: PREVIEW_CONNECTIONS_REFUSAL });
      });
    }
  });

  describe("the tenant connections route a consent round's callback stores through", () => {
    const authed = { [DEV_ACTOR_HEADER]: ulid() };
    const store = (s: ScopeId, secret: string) => {
      const { tenantId: _t, ...body } = upsert(s, secret);
      return call(`/api/tenants/${t}/connections`, body, authed);
    };

    for (const shape of shapes) {
      it(`${shape}: refused at write time, however the round was minted`, async () => {
        const before = await connections();
        const res = await store(scopes[shape], 'CALLBACK-COPY');
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: PREVIEW_CONNECTIONS_REFUSAL });
        expect(await connections()).toEqual(before);
      });
    }

    it('twin: the install rotates its connection through the same route', async () => {
      const res = await store(scopes.install, 'CALLBACK-INSTALL');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ created: false });
    });
  });
});
