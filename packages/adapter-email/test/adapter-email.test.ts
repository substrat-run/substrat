import { describe, expect, it } from 'vitest';
import {
  CloudflareEmailTransport,
  EmailError,
  MockEmailTransport,
  PlatformRelayEmailTransport,
  type EmailMessage,
  type PlatformRelayOptions,
  type SendEmailBinding,
} from '../src/index.js';

const invite = (over: Partial<EmailMessage> = {}): EmailMessage => ({
  to: 'invitee@example.com',
  from: { email: 'no-reply@substrat.run', name: 'Substrat' },
  subject: 'You have been invited to Acme',
  html: '<p>Join Acme: <a href="https://substrat.run/accept/abc">accept</a></p>',
  text: 'Join Acme: https://substrat.run/accept/abc',
  ...over,
});

describe('the transport port', () => {
  it('records a well-formed message and reports it delivered', async () => {
    const mail = new MockEmailTransport();
    const result = await mail.send(invite());

    expect(result).toEqual({ delivered: ['invitee@example.com'], queued: [], bounced: [] });
    expect(mail.sent).toHaveLength(1);
    expect(mail.last?.subject).toBe('You have been invited to Acme');
    expect(mail.last?.to).toEqual([{ email: 'invitee@example.com' }]);
    expect(mail.last?.from).toEqual({ email: 'no-reply@substrat.run', name: 'Substrat' });
  });

  it('enforces both an html and a text part (a deliverability invariant)', async () => {
    const mail = new MockEmailTransport();
    await expect(mail.send(invite({ text: '' }))).rejects.toThrow(EmailError);
    await expect(mail.send(invite({ html: '   ' }))).rejects.toThrow(/no html body/);
    expect(mail.sent).toHaveLength(0); // nothing recorded when it never validated
  });

  it('rejects an empty subject, no recipient, and a non-address', async () => {
    const mail = new MockEmailTransport();
    await expect(mail.send(invite({ subject: '  ' }))).rejects.toThrow(/no subject/);
    await expect(mail.send(invite({ to: [] }))).rejects.toThrow(/no recipient/);
    await expect(mail.send(invite({ to: 'not-an-email' }))).rejects.toThrow(/invalid email/);
  });

  it('coerces a bare string and an array of recipients', async () => {
    const mail = new MockEmailTransport();
    await mail.send(invite({ to: ['a@example.com', { email: 'b@example.com', name: 'B' }] }));
    expect(mail.last?.to).toEqual([{ email: 'a@example.com' }, { email: 'b@example.com', name: 'B' }]);
  });
});

describe('MockEmailTransport failure paths', () => {
  it('returns a suppressed address as bounced, never delivered', async () => {
    const mail = new MockEmailTransport({ suppress: ['Bounced@Example.com'] });
    const result = await mail.send(invite({ to: ['ok@example.com', 'bounced@example.com'] }));
    expect(result.delivered).toEqual(['ok@example.com']);
    expect(result.bounced).toEqual(['bounced@example.com']); // case-insensitive match
  });

  it('throws on a simulated transport outage', async () => {
    const mail = new MockEmailTransport({ failWith: 'upstream 503' });
    await expect(mail.send(invite())).rejects.toThrow(/upstream 503/);
  });
});

describe('CloudflareEmailTransport', () => {
  /** A fake `send_email` binding capturing the last call and returning a canned body. */
  function fakeBinding(response: unknown): SendEmailBinding & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      send(message) {
        calls.push(message);
        return Promise.resolve(response as never);
      },
    };
  }

  it('normalizes the message onto the binding and maps the response', async () => {
    const binding = fakeBinding({ delivered: ['invitee@example.com'], queued: [], permanent_bounces: [] });
    const mail = new CloudflareEmailTransport(binding);

    const result = await mail.send(invite({ replyTo: 'support@substrat.run' }));

    expect(result).toEqual({ delivered: ['invitee@example.com'], queued: [], bounced: [] });
    expect(binding.calls[0]).toMatchObject({
      // A nameless recipient is a bare STRING, not `{ email }` — the workerd
      // EmailAddress runtime rejects an object whose `name` is absent.
      to: ['invitee@example.com'],
      from: { email: 'no-reply@substrat.run', name: 'Substrat' },
      replyTo: 'support@substrat.run',
      subject: 'You have been invited to Acme',
    });
  });

  it('serializes nameless addresses as bare strings and named ones as objects', async () => {
    const binding = fakeBinding({ delivered: [], queued: [], permanent_bounces: [] });
    const mail = new CloudflareEmailTransport(binding);
    await mail.send(invite({ to: ['plain@example.com', { email: 'named@example.com', name: 'Named' }] }));
    expect(binding.calls[0]).toMatchObject({
      to: ['plain@example.com', { email: 'named@example.com', name: 'Named' }],
    });
  });

  it('accepts a REST-style response wrapped in `result` and maps permanent_bounces', async () => {
    const binding = fakeBinding({ result: { delivered: [], queued: ['slow@example.com'], permanent_bounces: ['bad@example.com'] } });
    const mail = new CloudflareEmailTransport(binding);

    const result = await mail.send(invite());
    expect(result).toEqual({ delivered: [], queued: ['slow@example.com'], bounced: ['bad@example.com'] });
  });

  it('validates before ever calling the binding', async () => {
    const binding = fakeBinding({ delivered: [] });
    const mail = new CloudflareEmailTransport(binding);
    await expect(mail.send(invite({ text: '' }))).rejects.toThrow(EmailError);
    expect(binding.calls).toHaveLength(0);
  });
});

describe('the platform email relay transport (#303)', () => {
  const relayInvite = (over: Partial<EmailMessage> = {}): EmailMessage => ({
    to: 'user@example.com',
    from: { email: 'no-reply@send.substrat.net', name: 'Substrat Auth' },
    subject: 'Reset your password',
    html: '<p>Reset: <a href="https://x/reset?token=abc">here</a></p>',
    text: 'Reset: https://x/reset?token=abc',
    ...over,
  });

  /** A `FetchLike` double that records the one call and returns a scripted response. */
  function fakeFetch(res: { ok: boolean; status: number; body: unknown }) {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
    const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      calls.push({ url, init });
      return { ok: res.ok, status: res.status, json: async () => res.body };
    };
    return { calls, fetchImpl };
  }

  const opts = (fetchImpl: PlatformRelayOptions['fetchImpl']): PlatformRelayOptions => ({
    controlPlaneUrl: 'https://console.substrat.net/',
    platformSecret: 'plat-secret',
    tenantId: '01TENANT',
    scopeId: '01SCOPE',
    fetchImpl,
  });

  it('POSTs {tenant, scope, message} to the relay with the platform-secret header', async () => {
    const { calls, fetchImpl } = fakeFetch({ ok: true, status: 200, body: { sent: true, delivered: ['user@example.com'], queued: [], bounced: [] } });
    const mail = new PlatformRelayEmailTransport(opts(fetchImpl));

    const result = await mail.send(relayInvite());

    expect(result).toEqual({ delivered: ['user@example.com'], queued: [], bounced: [] });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call) throw new Error('expected exactly one relay call');
    // Trailing slash on controlPlaneUrl is normalized, endpoint is /internal/email/send.
    expect(call.url).toBe('https://console.substrat.net/internal/email/send');
    expect(call.init.headers['x-substrat-platform']).toBe('plat-secret');
    expect(JSON.parse(call.init.body)).toEqual({
      tenantId: '01TENANT',
      scopeId: '01SCOPE',
      to: 'user@example.com',
      subject: 'Reset your password',
      html: '<p>Reset: <a href="https://x/reset?token=abc">here</a></p>',
      text: 'Reset: https://x/reset?token=abc',
      fromName: 'Substrat Auth',
    });
  });

  it('surfaces the relay refusal (e.g. an ungranted vertical) as an EmailError', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 403, body: { error: "vertical 'auth-server' does not hold the email-sender capability" } });
    const mail = new PlatformRelayEmailTransport(opts(fetchImpl));
    await expect(mail.send(relayInvite())).rejects.toThrow(/relay refused \(403\).*email-sender capability/);
  });

  it('validates the message before calling the relay, and refuses multi-recipient sends', async () => {
    const { calls, fetchImpl } = fakeFetch({ ok: true, status: 200, body: { sent: true } });
    const mail = new PlatformRelayEmailTransport(opts(fetchImpl));
    await expect(mail.send(relayInvite({ text: '' }))).rejects.toThrow(EmailError);
    await expect(mail.send(relayInvite({ to: ['a@example.com', 'b@example.com'] }))).rejects.toThrow(/one recipient at a time/);
    expect(calls).toHaveLength(0);
  });
});
