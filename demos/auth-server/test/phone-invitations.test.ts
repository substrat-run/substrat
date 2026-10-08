import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { assertSignInPolicy, policyAdmits, sanitizeSignInPolicy, type SignInPolicy } from '../src/sign-in-policy.js';
import { twilioFrom } from '../src/twilio.js';
import type { BankIdTransport } from '../src/bankid.js';

const ORIGIN = 'http://localhost:8877';
const PHONE = '+46701234567';
const EMAIL = 'invitee@example.test';
const PASSWORD = 'invited-user-password';
const PNR = '198001019876';
const POLICY = { providers: ['bankid'], password: true, passwordSecondFactor: 'sms' } satisfies SignInPolicy;
let db: Database.Database;
let auth: Auth;
let mail: MockEmailTransport;
let adminCookie: string;
let clientId: string;
let orderId = 0;
const send = vi.fn(async (_phone: string) => {});
const check = vi.fn(async (_phone: string, code: string) => code === '123456');
const bankid: BankIdTransport = async (url, body) => ({ status: 200, body: url.endsWith('/auth')
  ? { orderRef: `order-${++orderId}`, autoStartToken: 'start', qrStartToken: 'qr', qrStartSecret: 'secret' }
  : { orderRef: (body as { orderRef: string }).orderRef, status: 'complete', completionData: { user: { personalNumber: PNR, name: 'Test Person', givenName: 'Test', surname: 'Person' }, device: { ipAddress: '192.0.2.1' }, signature: 'signature', ocspResponse: 'ocsp' } } });

function cookieOf(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => c && !c.endsWith('=')).join('; ');
}
function post(path: string, body: unknown, cookie = ''): Promise<Response> {
  return auth.handler(new Request(`${ORIGIN}/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie, 'sec-fetch-mode': 'cors' }, body: JSON.stringify(body) }) as never);
}
function userRow() { return db.prepare('SELECT * FROM user WHERE email = ?').get(EMAIL) as { id: string; email_verified: number; phone_number: string | null }; }
async function invitation() {
  const sent = await post('/invitation/create', { email: EMAIL, name: 'Invited User' }, adminCookie);
  expect(sent.status).toBe(200);
  const token = /#token=([a-f0-9-]+)/.exec(mail.last!.text)![1]!;
  return token;
}
async function accepted() {
  const res = await post('/invitation/accept', { token: await invitation() });
  expect(res.status).toBe(200);
  return cookieOf(res);
}
async function passwordSession() {
  const res = await post('/invitation/password', { password: PASSWORD }, await accepted());
  expect(res.status).toBe(200);
  return cookieOf(res);
}
async function authorize(cookie: string, extra: Record<string, string> = {}) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('v'.repeat(43)));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: 'http://localhost:9999/cb', scope: 'openid profile', state: 'state', code_challenge: challenge, code_challenge_method: 'S256', ...extra });
  return auth.handler(new Request(`${ORIGIN}/api/auth/oauth2/authorize?${q}`, { headers: { cookie, 'sec-fetch-mode': 'navigate' } }) as never);
}

beforeEach(async () => {
  vi.clearAllMocks(); check.mockImplementation(async (_phone, code) => code === '123456');
  db = new Database(':memory:');
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
  mail = new MockEmailTransport();
  auth = buildAuth({ database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }), secret: 'test-secret-000000000000000000000000', baseURL: ORIGIN, trustedOrigins: [ORIGIN], transport: mail, sender: { email: 'sender@example.test' }, allowSignup: true, phoneVerifier: { send, check }, bankid: { apiUrl: 'https://bankid.fake', transport: bankid, allowSignup: false, clientIpHeader: 'x-test-ip' }, signInPolicyFor: () => POLICY });
  const admin = await post('/sign-up/email', { email: 'admin@example.test', name: 'Admin', password: 'admin-test-password' });
  expect(admin.status).toBe(200);
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE email = 'admin@example.test'").run();
  adminCookie = cookieOf(admin);
  const client = await auth.api.adminCreateOAuthClient({ headers: new Headers({ cookie: adminCookie }), body: { client_name: 'Publisher', redirect_uris: ['http://localhost:9999/cb'], application_type: 'native', skip_consent: true } }) as { client_id: string };
  clientId = client.client_id;
});
afterEach(() => { db.close(); });

describe('email invitations', () => {
  it('requires an administrator and delivers the token only by email', async () => {
    expect((await post('/invitation/create', { email: EMAIL, name: 'User' })).status).toBe(401);
    const token = await invitation();
    expect(userRow().email_verified).toBe(0);
    const stored = JSON.stringify(db.prepare('SELECT identifier, value FROM verification').all());
    expect(stored).not.toContain(token);
    const res = await post('/invitation/accept', { token });
    expect(res.status).toBe(200); expect(userRow().email_verified).toBe(1);
    expect((await post('/invitation/accept', { token })).status).toBe(400);
    expect((await authorize(cookieOf(res))).headers.get('location')).toContain('/login');
  });
  it('consumes an invitation once under concurrent acceptance', async () => {
    const token = await invitation();
    const responses = await Promise.all([post('/invitation/accept', { token }), post('/invitation/accept', { token })]);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  });
  it('refuses expired tokens and invitations for existing credential accounts', async () => {
    const token = await invitation();
    db.prepare("UPDATE verification SET expires_at = 0 WHERE identifier LIKE 'account-invite:%'").run();
    expect((await post('/invitation/accept', { token })).status).toBe(400);
    await post('/sign-up/email', { email: 'existing@example.test', name: 'Existing', password: PASSWORD });
    expect((await post('/invitation/create', { email: 'existing@example.test', name: 'Existing' }, adminCookie)).status).toBe(409);
  });
  it('invalidates a bounced invitation', async () => {
    mail.suppress(EMAIL);
    expect((await post('/invitation/create', { email: EMAIL, name: 'User' }, adminCookie)).status).toBe(503);
    expect(db.prepare("SELECT COUNT(*) AS n FROM verification WHERE identifier LIKE 'account-invite:%'").get()).toEqual({ n: 0 });
  });
  it('does not allow invitation sessions to bypass password setup', async () => {
    const cookie = await accepted();
    expect((await post('/phone/send', { phoneNumber: PHONE }, cookie)).status).toBe(403);
    expect((await post('/invitation/password', { password: PASSWORD }, adminCookie)).status).toBe(403);
  });
});

describe('password plus SMS', () => {
  it('enrolls only after proof, rotates the session, and enforces the factor at authorize', async () => {
    const cookie = await passwordSession();
    expect((await authorize(cookie)).headers.get('location')).toContain('/login');
    expect((await post('/phone/verify', { code: '123456' }, cookie)).status).toBe(400);
    expect((await post('/phone/send', { phoneNumber: PHONE }, cookie)).status).toBe(200);
    expect(userRow().phone_number).toBeNull();
    expect((await post('/phone/verify', { code: '999999' }, cookie)).status).toBe(400);
    const verified = await post('/phone/verify', { code: '123456' }, cookie);
    expect(verified.status).toBe(200); expect(userRow().phone_number).toBe(PHONE);
    const completedCookie = cookieOf(verified);
    expect(completedCookie).not.toBe(cookie);
    expect((await authorize(completedCookie)).headers.get('location')).toContain('code=');
    expect((await authorize(cookie)).headers.get('location')).toContain('/login');
    expect((await post('/phone/verify', { code: '123456' }, completedCookie)).status).toBe(400);
    expect(check).toHaveBeenCalledWith(PHONE, '123456');
    // Every new password login starts without the second-factor stamp, even with an enrolled phone.
    const login = await post('/sign-in/email', { email: EMAIL, password: PASSWORD });
    expect((await authorize(cookieOf(login), { prompt: 'none' })).headers.get('location')).toContain('login_required');
  });
  it('resumes the signed OIDC query after SMS verification', async () => {
    const cookie = await passwordSession();
    const redirect = (await authorize(cookie)).headers.get('location')!;
    const query = new URL(redirect, ORIGIN).search.slice(1);
    expect((await post('/phone/send', { phoneNumber: PHONE }, cookie)).status).toBe(200);
    const result = await post('/phone/verify', { code: '123456', oauth_query: query }, cookie);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ redirect: true, url: expect.stringContaining('code=') });
  });
  it('keeps the registered factor after resetting the password', async () => {
    const cookie = await passwordSession();
    await post('/phone/send', { phoneNumber: PHONE }, cookie);
    expect((await post('/phone/verify', { code: '123456' }, cookie)).status).toBe(200);
    expect((await post('/request-password-reset', { email: EMAIL, redirectTo: '/reset-password' })).status).toBe(200);
    const reset = db.prepare("SELECT identifier FROM verification WHERE identifier LIKE 'reset-password:%'").get() as { identifier: string };
    expect((await post('/reset-password', { token: reset.identifier.slice('reset-password:'.length), newPassword: 'replacement-password' })).status).toBe(200);
    expect(userRow().phone_number).toBe(PHONE);
    const login = await post('/sign-in/email', { email: EMAIL, password: 'replacement-password' });
    expect(login.status).toBe(200);
    expect((await authorize(cookieOf(login))).headers.get('location')).toContain('/login');
  });
  it('limits SMS sends and verification attempts across sessions', async () => {
    const cookie = await passwordSession();
    expect((await post('/phone/send', { phoneNumber: PHONE }, cookie)).status).toBe(200);
    expect((await post('/phone/send', { phoneNumber: PHONE }, cookie)).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await post('/phone/verify', { code: '000000' }, cookie)).status).toBe(400);
    expect((await post('/phone/verify', { code: '123456' }, cookie)).status).toBe(429);
    expect(check).toHaveBeenCalledTimes(5);
  });
  it('rejects phone replacement, forged input fields, stale and unverified enrollment', async () => {
    const signup = await post('/sign-up/email', { email: 'unverified@example.test', name: 'New', password: PASSWORD });
    expect(signup.status).toBe(200);
    expect((await post('/phone/send', { phoneNumber: PHONE }, cookieOf(signup))).status).toBe(403);
    const cookie = await passwordSession();
    const update = await post('/update-user', { phoneNumber: PHONE }, cookie);
    expect(update.status).toBeLessThan(500); expect(userRow().phone_number).toBeNull();
    db.prepare('UPDATE user SET phone_number = ? WHERE email = ?').run(PHONE, EMAIL);
    expect((await post('/phone/send', { phoneNumber: '+46709876543' }, cookie)).status).toBe(403);
    db.prepare('UPDATE session SET created_at = 0 WHERE user_id = ?').run(userRow().id);
    expect((await post('/phone/send', {}, cookie)).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses expired challenges', async () => {
    const cookie = await passwordSession();
    await post('/phone/send', { phoneNumber: PHONE }, cookie);
    db.prepare("UPDATE verification SET expires_at = 0 WHERE identifier LIKE 'phone-challenge:%'").run();
    expect((await post('/phone/verify', { code: '123456' }, cookie)).status).toBe(400);
    expect(check).not.toHaveBeenCalled();
  });
  it('fails closed when Twilio is unavailable and when the user is banned', async () => {
    const cookie = await passwordSession();
    await post('/phone/send', { phoneNumber: PHONE }, cookie);
    check.mockRejectedValueOnce(new Error('upstream secret details'));
    const failure = await post('/phone/verify', { code: '123456' }, cookie);
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('secret details');
    expect(userRow().phone_number).toBeNull();
    db.prepare('UPDATE user SET banned = 1 WHERE email = ?').run(EMAIL);
    expect((await post('/phone/verify', { code: '123456' }, cookie)).status).toBe(403);
    expect((await authorize(cookie)).headers.get('location')).not.toContain('code=');
  });
});

describe('BankID invitation linking', () => {
  it('links the verified personnummer to the invited email and admits BankID without SMS', async () => {
    const cookie = await accepted();
    const started = await post('/bankid/start', { link: true }, cookie);
    expect(started.status).toBe(200);
    const { orderRef } = await started.json() as { orderRef: string };
    const complete = await post('/bankid/collect', { orderRef }, cookie);
    expect(complete.status).toBe(200);
    expect(db.prepare("SELECT user_id, account_id FROM account WHERE provider_id = 'bankid'").get()).toEqual({ user_id: userRow().id, account_id: PNR });
    expect(db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 2 });
    expect((await authorize(cookieOf(complete))).headers.get('location')).toContain('code=');
    expect(send).not.toHaveBeenCalled();
  });
  it('binds linking to the exact setup session and refuses identity reassignment', async () => {
    const cookie = await accepted();
    const { orderRef } = await (await post('/bankid/start', { link: true }, cookie)).json() as { orderRef: string };
    expect((await post('/bankid/collect', { orderRef }, adminCookie)).status).toBe(403);
    const admin = db.prepare("SELECT id FROM user WHERE email = 'admin@example.test'").get() as { id: string };
    const adapter = (await auth.$context).internalAdapter;
    await adapter.linkAccount({ userId: admin.id, providerId: 'bankid', accountId: PNR });
    expect((await post('/bankid/collect', { orderRef }, cookie)).status).toBe(409);
    expect(db.prepare("SELECT user_id FROM account WHERE provider_id = 'bankid'").get()).toEqual({ user_id: admin.id });
  });
  it('does not let a password-only session bypass an enrolled SMS factor by linking BankID', async () => {
    const cookie = await passwordSession();
    db.prepare('UPDATE user SET phone_number = ? WHERE email = ?').run(PHONE, EMAIL);
    expect((await post('/bankid/start', { link: true }, cookie)).status).toBe(403);
  });
});

describe('the SMS policy vocabulary', () => {
  it('fails closed for malformed requirements and admits exactly the two alternatives', () => {
    expect(assertSignInPolicy(POLICY)).toEqual(POLICY);
    expect(policyAdmits(POLICY, 'password')).toBe(false);
    expect(policyAdmits(POLICY, 'password-sms')).toBe(true);
    expect(policyAdmits(POLICY, 'bankid')).toBe(true);
    expect(policyAdmits(POLICY, 'microsoft')).toBe(false);
    expect(policyAdmits(sanitizeSignInPolicy({ passwordSecondFactor: 'typo' }), 'password')).toBe(false);
    expect(() => assertSignInPolicy({ passwordSecondFactor: 'typo' })).toThrow();
  });
});

describe('Twilio Verify wire contract', () => {
  const cfg = { TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'secret', TWILIO_VERIFY_SERVICE_SID: `VA${'b'.repeat(32)}` };
  it('sends SMS and accepts only an approved verification result', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ status: 'pending' })).mockResolvedValueOnce(Response.json({ status: 'pending' })).mockResolvedValueOnce(Response.json({ status: 'approved' }));
    const verifier = twilioFrom(cfg, fetcher)!;
    await verifier.send(PHONE);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://verify.twilio.com/v2/Services/${cfg.TWILIO_VERIFY_SERVICE_SID}/Verifications`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'manual', body: new URLSearchParams({ To: PHONE, Channel: 'sms' }).toString() });
    expect(await verifier.check(PHONE, '000000')).toBe(false);
    expect(await verifier.check(PHONE, '123456')).toBe(true);
  });
  it('refuses incomplete config, expired codes, and transport failures without exposing secrets', async () => {
    expect(twilioFrom({ TWILIO_ACCOUNT_SID: cfg.TWILIO_ACCOUNT_SID })).toBeUndefined();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(Response.json({ message: 'secret internal details' }, { status: 500 }));
    const verifier = twilioFrom(cfg, fetcher)!;
    expect(await verifier.check(PHONE, '123456')).toBe(false);
    await expect(verifier.send(PHONE)).rejects.toThrow('Phone verification is unavailable');
  });
});
