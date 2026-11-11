import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ulid } from '@substrat-run/kernel';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** A provisioned instance with Twilio stubbed to answer `replies` in order, and an admin signed in. */
async function signedIn(replies: Array<'pending' | 'approved'>) {
  const service = `VA${'b'.repeat(32)}`;
  // Twilio, answering each expected request once; any other egress throws. The Durable
  // Object runs in the test's isolate, so stubbing the global is stubbing its egress.
  const twilio = replies.map((status) => ({
    url: `https://verify.twilio.com/v2/Services/${service}/${status === 'pending' ? 'Verifications' : 'VerificationCheck'}`, body: { status },
  }));
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
  return { stub, post, cookieOf, cookie: cookieOf(login), twilio };
}

describe('SMS verification in the deployed Durable Object', () => {
  it('uses delivered Twilio configuration, enrolls the phone, and rotates the password session', async () => {
    // Pinned across a minute boundary: the second send is 200 ms after the first, a calendar
    // minute later, and the cooldown still refuses it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T09:43:59.900Z'));
    const { stub, post, cookieOf, cookie, twilio } = await signedIn(['pending', 'approved']);
    const sent = await post('/phone/send', { phoneNumber: '+46701234567' }, cookie);
    expect(sent.status, await sent.text()).toBe(200);
    vi.setSystemTime(new Date('2026-10-30T09:44:00.100Z'));
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

  it('sends again once the minute has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T09:43:30.000Z'));
    const { post, cookie, twilio } = await signedIn(['pending', 'pending']);
    expect((await post('/phone/send', { phoneNumber: '+46701234567' }, cookie)).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-30T09:44:30.100Z'));
    expect((await post('/phone/send', { phoneNumber: '+46701234567' }, cookie)).status).toBe(200);
    expect(twilio).toEqual([]);
  });
});

describe('a person imported with a bcrypt hash, in the deployed Durable Object', () => {
  it('is imported through the admin route and signs in with their old password under their old id', async () => {
    const { default: bcrypt } = await import('bcryptjs');
    const scope = ulid();
    const stub = env.AUTH.get(env.AUTH.idFromName(scope));
    await runInDurableObject(stub, async (instance) => (instance as unknown as import('../../src/auth-do.js').AuthServerDO).provisionInstance({ tenantId: ulid(), scopeId: scope, slug: 'acme-auth', name: 'Acme Auth' }, [
      { key: 'ADMIN_EMAIL', value: 'admin@example.test' },
      { key: 'ADMIN_PASSWORD', value: 'admin-test-password' },
    ]));
    const post = (path: string, body: unknown, cookie = '') => stub.fetch(new Request(`https://auth-server.test${path}`, {
      method: 'POST', headers: { origin: 'https://auth-server.test', 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
    }));
    const cookieOf = (res: Response) => (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie().map((c) => c.split(';')[0]).filter((c) => c && !c.endsWith('=')).join('; ');
    const admin = cookieOf(await post('/api/auth/sign-in/email', { email: 'admin@example.test', password: 'admin-test-password' }));

    const id = 'auth2|6512f0c0a1b2c3d4e5f60718';
    const imported = await post('/__admin/users/import', { users: [{ id, email: 'ada@example.test', emailVerified: true, passwordHash: bcrypt.hashSync('old-password-1', 4) }] }, admin);
    expect(imported.status, await imported.clone().text()).toBe(200);
    expect(((await imported.json()) as { counts: { created: number } }).counts.created).toBe(1);

    expect((await post('/api/auth/sign-in/email', { email: 'ada@example.test', password: 'wrong-password' })).status).toBe(401);
    const ok = await post('/api/auth/sign-in/email', { email: 'ada@example.test', password: 'old-password-1' });
    expect(ok.status).toBe(200);
    const session = await stub.fetch(new Request('https://auth-server.test/api/auth/get-session', { headers: { cookie: cookieOf(ok) } }));
    expect(((await session.json()) as { user: { id: string } }).user.id).toBe(id);
  });
});

describe('the Auth0 Management API subset, in the deployed Durable Object (#3107)', () => {
  it('mints an Auth0-style token for an opted-in machine client and reads a person with it', async () => {
    const scope = ulid();
    const stub = env.AUTH.get(env.AUTH.idFromName(scope));
    await runInDurableObject(stub, async (instance) => (instance as unknown as import('../../src/auth-do.js').AuthServerDO).provisionInstance({ tenantId: ulid(), scopeId: scope, slug: 'acme-auth', name: 'Acme Auth' }, [
      { key: 'ADMIN_EMAIL', value: 'admin@example.test' },
      { key: 'ADMIN_PASSWORD', value: 'admin-test-password' },
      { key: 'MACHINE_SCOPES', value: 'read:users' },
    ]));
    const json = (path: string, body: unknown, cookie = '') => stub.fetch(new Request(`https://auth-server.test${path}`, {
      method: 'POST', headers: { origin: 'https://auth-server.test', 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
    }));
    const cookieOf = (res: Response) => (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie().map((c) => c.split(';')[0]).filter((c) => c && !c.endsWith('=')).join('; ');
    const admin = cookieOf(await json('/api/auth/sign-in/email', { email: 'admin@example.test', password: 'admin-test-password' }));
    // Registered as the console registers it (HTTP Basic), then used as Auth0's SDKs use it.
    const registered = await json('/__admin/clients', { application_type: 'machine', client_name: 'Staff Portal', client_credentials_scopes: ['read:users'] }, admin);
    expect(registered.status, await registered.clone().text()).toBe(201);
    const client = (await registered.json()) as { client_id: string; client_secret: string };

    const minted = await json('/__oauth-token', {
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: client.client_secret,
      audience: 'https://auth-server.test/api/v2/',
    });
    expect(minted.status, await minted.clone().text()).toBe(200);
    const { access_token: token } = (await minted.json()) as { access_token: string };

    const res = await stub.fetch(new Request('https://auth-server.test/api/v2/users-by-email?email=admin%40example.test', {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    // Two: the seeded administrator's sign-up is a sign-in the log records, and so is the one above.
    expect(await res.json()).toEqual([expect.objectContaining({ email: 'admin@example.test', logins_count: 2, last_login: expect.any(String) })]);
  });
});

describe('the SCIM server, in the deployed Durable Object (#2941)', () => {
  it('rolls a dry run back with transactionSync, and provisions a BankID member for real', async () => {
    const scope = ulid();
    const stub = env.AUTH.get(env.AUTH.idFromName(scope));
    await runInDurableObject(stub, async (instance) => (instance as unknown as import('../../src/auth-do.js').AuthServerDO).provisionInstance({ tenantId: ulid(), scopeId: scope, slug: 'acme-auth', name: 'Acme Auth' }, [
      { key: 'ADMIN_EMAIL', value: 'admin@example.test' },
      { key: 'ADMIN_PASSWORD', value: 'admin-test-password' },
      { key: 'MACHINE_SCOPES', value: 'users:provision' },
    ]));
    const send = (path: string, body: unknown, headers: Record<string, string>, method = 'POST') => stub.fetch(new Request(`https://auth-server.test${path}`, {
      method, headers: { origin: 'https://auth-server.test', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    }));
    const cookieOf = (res: Response) => (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie().map((c) => c.split(';')[0]).filter((c) => c && !c.endsWith('=')).join('; ');
    const admin = cookieOf(await send('/api/auth/sign-in/email', { email: 'admin@example.test', password: 'admin-test-password' }, {}));
    const registered = await send('/__admin/clients', { application_type: 'machine', client_name: 'Member Portal', client_credentials_scopes: ['users:provision'] }, { cookie: admin });
    expect(registered.status, await registered.clone().text()).toBe(201);
    const client = (await registered.json()) as { client_id: string; client_secret: string };
    const minted = await send('/__oauth-token', {
      grant_type: 'client_credentials', client_id: client.client_id, client_secret: client.client_secret, audience: 'https://auth-server.test/scim/v2',
    }, {});
    expect(minted.status, await minted.clone().text()).toBe(200);
    const bearer = { authorization: `Bearer ${((await minted.json()) as { access_token: string }).access_token}` };

    const member = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:substrat:params:scim:schemas:extension:bankid:2.0:User'],
      userName: 'member-1',
      'urn:substrat:params:scim:schemas:extension:bankid:2.0:User': { personalNumber: '198001012387' },
    };
    const bulk = (dry: boolean) => send(`/scim/v2/Bulk${dry ? '?dryRun=true' : ''}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
      Operations: [
        { method: 'POST', bulkId: 'm1', path: '/Users', data: member },
        // The same person again: only the first operation's own write makes this a conflict.
        { method: 'POST', bulkId: 'm2', path: '/Users', data: { ...member, userName: 'member-2' } },
      ],
    }, bearer);
    const statuses = async (res: Response) => ((await res.json()) as { Operations: { status: string }[] }).Operations.map((o) => o.status);
    expect(await statuses(await bulk(true))).toEqual(['201', '409']);
    const found = async () => ((await (await stub.fetch(new Request('https://auth-server.test/scim/v2/Users?filter=userName%20eq%20%22member-1%22', { headers: bearer }))).json()) as { totalResults: number }).totalResults;
    expect(await found()).toBe(0);
    expect(await statuses(await bulk(false))).toEqual(['201', '409']);
    expect(await found()).toBe(1);
  });
});
