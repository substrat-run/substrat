import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { MAIL_IN_PROVIDER, connectionId, platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { BINDING_KEY, MESSAGE_PREFIX, SMTP_REFUSALS, addressOf, mintLocalPart, type MailInBinding, type MailInMessageEntry } from '@substrat-run/connector-mail-in';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import worker, { RelayGateway } from '../src/worker.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * Inbound mail's control-plane half (#2611), on the real worker: the `email()` handler Email
 * Routing calls, against the real directory and the bucket `wrangler.jsonc` binds, and the relay a
 * vertical's worker asks for its address through. The connector's own rules — allowlists, dedupe,
 * delivery — are held in `connectors/mail-in`; this holds the wiring.
 */
describe('inbound mail on the control plane', () => {
  const SECRET = 'mail-in-test-secret';
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const vertical = `mail-in-${t.slice(-8).toLowerCase()}`;
  let s: ScopeId;
  let address: string;
  let conn: ReturnType<typeof connectionId.parse>;

  const hostFor = () =>
    new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('sb1', Uint8Array.from(atob(env.SECRET_BOX_KEY!), (ch) => ch.charCodeAt(0))),
    });
  const testEnv = (over: Record<string, unknown> = {}) => ({ ...env, PLATFORM_SECRET: SECRET, ...over }) as never;

  /** A routed message, as Email Routing hands it over, recording what the handler refused with. */
  const routed = (to: string, raw: string) => {
    const bytes = new TextEncoder().encode(raw);
    const seen = { rejected: null as string | null };
    return {
      seen,
      message: {
        from: 'billing@supplier.example',
        to,
        rawSize: bytes.byteLength,
        raw: new Response(bytes).body!,
        headers: new Headers(),
        canBeForwarded: false,
        setReject: (reason: string) => void (seen.rejected = reason),
        forward: async () => ({}),
        reply: async () => ({}),
      } as unknown as ForwardableEmailMessage,
    };
  };
  const raw = (messageId: string) =>
    [
      'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=supplier.example; spf=pass smtp.mailfrom=billing@supplier.example; dmarc=pass header.from=supplier.example',
      'From: Billing <billing@supplier.example>',
      `Message-ID: <${messageId}@supplier.example>`,
      'Subject: Invoice',
      'Content-Type: text/plain',
      '',
      'attached',
      '',
    ].join('\r\n');
  const deliver = async (to: string, body: string, over = {}) => {
    const r = routed(to, body);
    const ctx = createExecutionContext();
    await worker.email(r.message, testEnv(over), ctx);
    await waitOnExecutionContext(ctx);
    return r.seen;
  };

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    const host = hostFor();
    await host.admin.registerVertical(staff, { slug: vertical, name: 'Mail in', source: 'cli' });
    await host.admin.createTenant(staff, { id: t, slug: `mi-${t.toLowerCase()}`, name: 'Mail in' });
    s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical });
    await host.admin.activateScope(staff, t, s);
    // An address as the connector mints one. The vertical has no deployment here, so delivery
    // cannot land: what this file holds is that the message is kept for the sweep to retry.
    const local = mintLocalPart(vertical);
    address = addressOf(local, env.MAIL_IN_DOMAIN!);
    conn = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: conn,
      tenantId: t,
      vertical,
      provider: MAIL_IN_PROVIDER,
      label: address,
      externalAccountRef: local,
      secret: { address },
    });
    const binding: MailInBinding = {
      address,
      tenantId: t,
      scopeId: s,
      vertical,
      operation: 'docs/receive-mail',
      permission: 'docs:receive-mail',
      allowlist: [],
      createdAt: new Date().toISOString(),
      createdBy: principalId.parse(ulid()),
    };
    await host.admin.putConnectorState(conn, BINDING_KEY, binding);
  });

  it('receives on the configured subdomain, and never on the apex', () => {
    expect(env.MAIL_IN_DOMAIN).toBe('in.substrat.run');
  });

  it('refuses an unknown address at SMTP time, and an address of another domain', async () => {
    expect((await deliver(`mail+docs-aaaaaaaaaaaaaaaa@${env.MAIL_IN_DOMAIN}`, raw('u1'))).rejected).toBe(SMTP_REFUSALS.unknown);
    expect((await deliver(address.replace(env.MAIL_IN_DOMAIN!, 'substrat.run'), raw('u2'))).rejected).toBe(SMTP_REFUSALS.unknown);
  });

  it('refuses everything when the deployment has no bucket to keep mail in', async () => {
    expect((await deliver(address, raw('nb'), { MAIL_IN_BUCKET: undefined })).rejected).toBe(SMTP_REFUSALS.unknown);
  });

  it('accepts mail to a live address and keeps it until it is delivered', async () => {
    const seen = await deliver(address, raw('kept'));
    expect(seen.rejected).toBeNull();
    const host = hostFor();
    const rows = (await host.admin.listConnectorState(conn, MESSAGE_PREFIX)).map((r) => r.value as MailInMessageEntry);
    expect(rows).toHaveLength(1);
    // The vertical is not deployed here, so the immediate delivery failed and is due again later.
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await env.MAIL_IN_BUCKET!.get(rows[0]!.objectKey)).not.toBeNull();
    // A redelivery of the same Message-ID is accepted and stored once.
    expect((await deliver(address, raw('kept'))).rejected).toBeNull();
    expect(await host.admin.listConnectorState(conn, MESSAGE_PREFIX)).toHaveLength(1);
  });

  it('refuses a revoked address', async () => {
    const host = hostFor();
    const other = connectionId.parse(ulid());
    const local = mintLocalPart(vertical);
    await host.admin.createConnection(staff, { id: other, tenantId: t, vertical, provider: MAIL_IN_PROVIDER, label: 'x', externalAccountRef: local, secret: { address: 'x' } });
    await host.admin.putConnectorState(other, BINDING_KEY, { address: addressOf(local, env.MAIL_IN_DOMAIN!), scopeId: s, tenantId: t, vertical, operation: 'a/b', permission: 'a:b', allowlist: [], createdAt: new Date().toISOString(), createdBy: 'p' });
    await host.admin.revokeConnection(staff, other);
    expect((await deliver(addressOf(local, env.MAIL_IN_DOMAIN!), raw('rv'))).rejected).toBe(SMTP_REFUSALS.unknown);
  });

  describe('the address relay', () => {
    const request = (body: object, headers: Record<string, string> = {}) =>
      new Request('https://cp.test/internal/mail-in/address', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-substrat-platform': SECRET, ...headers },
        body: JSON.stringify(body),
      });
    const caller = () => ({ 'x-substrat-relay-caller': JSON.stringify({ vertical, tenantId: t, scopeId: s }) });

    it('needs a proven caller, a read included', async () => {
      const res = await worker.fetch(request({ tenantId: t, scopeId: s, action: 'get' }), testEnv());
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain('proven caller');
    });

    it("answers a proven caller's read with its scope's address", async () => {
      const res = await new RelayGateway(createExecutionContext(), testEnv()).fetch(request({ tenantId: t, scopeId: s, action: 'get' }, caller()));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { address: { address: string } }).address.address).toBe(address);
    });

    it('refuses to mint an address for a vertical whose running version declares no landing', async () => {
      const res = await new RelayGateway(createExecutionContext(), testEnv()).fetch(
        request({ tenantId: t, scopeId: s, action: 'rotate', createdBy: principalId.parse(ulid()) }, caller()),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('declares no mail-in landing');
    });

    it('refuses an act with no principal behind it', async () => {
      const res = await new RelayGateway(createExecutionContext(), testEnv()).fetch(request({ tenantId: t, scopeId: s, action: 'request' }, caller()));
      expect(res.status).toBe(400);
    });
  });
});
