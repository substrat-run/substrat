import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid } from '@substrat-run/kernel';

afterEach(() => { vi.restoreAllMocks(); });

describe('SMS verification in the deployed Durable Object', () => {
  it('uses delivered Twilio configuration, enrolls the phone, and rotates the password session', async () => {
    const service = `VA${'b'.repeat(32)}`;
    // Twilio, answering each expected request once; any other egress throws. The Durable
    // Object runs in the test's isolate, so stubbing the global is stubbing its egress.
    const twilio = [
      { url: `https://verify.twilio.com/v2/Services/${service}/Verifications`, body: { status: 'pending' } },
      { url: `https://verify.twilio.com/v2/Services/${service}/VerificationCheck`, body: { status: 'approved' } },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const at = twilio.findIndex((e) => request.method === 'POST' && e.url === request.url);
      if (at < 0) throw new Error(`unexpected egress: ${request.method} ${request.url}`);
      return Response.json(twilio.splice(at, 1)[0]!.body);
    });
    const scope = ulid();
    const stub = env.AUTH.get(env.AUTH.idFromName(scope));
    await runInDurableObject(stub, async (instance) => (instance as unknown as import('../../src/auth-do.js').AuthServerDO).provisionInstance({ tenantId: ulid(), scopeId: scope, slug: 'acme-auth', name: 'Acme Auth' }, [
      { key: 'ADMIN_EMAIL', value: 'admin@example.test' },
      { key: 'ADMIN_PASSWORD', value: 'admin-test-password' },
      { key: 'TWILIO_ACCOUNT_SID', value: `AC${'a'.repeat(32)}` },
      { key: 'TWILIO_AUTH_TOKEN', value: 'test-auth-token' },
      { key: 'TWILIO_VERIFY_SERVICE_SID', value: service },
    ]));
    await runInDurableObject(stub, async (_instance, state) => { state.storage.sql.exec('UPDATE user SET email_verified = 1'); });
    const post = (path: string, body: unknown, cookie = '') => stub.fetch(new Request(`https://auth-server.test/api/auth${path}`, {
      method: 'POST', headers: { origin: 'https://auth-server.test', 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
    }));
    const cookieOf = (res: Response) => (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie().map((c) => c.split(';')[0]).filter((c) => c && !c.endsWith('=')).join('; ');
    const login = await post('/sign-in/email', { email: 'admin@example.test', password: 'admin-test-password' });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    const sent = await post('/phone/send', { phoneNumber: '+46701234567' }, cookie);
    expect(sent.status, await sent.text()).toBe(200);
    expect((await post('/phone/send', { phoneNumber: '+46701234567' }, cookie)).status).toBe(429);
    const verified = await post('/phone/verify', { code: '123456' }, cookie);
    expect(verified.status).toBe(200);
    expect(cookieOf(verified)).not.toBe(cookie);
    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      user: [...state.storage.sql.exec('SELECT phone_number FROM user')],
      sessions: [...state.storage.sql.exec('SELECT sign_in_provider FROM session')],
    }));
    expect(stored.user).toEqual([{ phone_number: '+46701234567' }]);
    expect(stored.sessions).toContainEqual({ sign_in_provider: 'password-sms' });
    // Provisioning can leave a bootstrap session; check the actual login cookie's
    // revocation rather than assuming this is the account's only session.
    const oldSession = await stub.fetch(new Request('https://auth-server.test/api/auth/get-session', { headers: { cookie } }));
    expect(await oldSession.json()).toBeNull();
    expect(twilio).toEqual([]);
  });
});
