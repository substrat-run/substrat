import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, tokenRequestClientId, type Auth } from '../src/auth.js';
import { createAdminApi } from '../src/admin-api.js';
import { MACHINE_SCOPES, machineScopesOf } from '../src/settings.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';
import { publicProvidersFrom, readProviders } from '../src/providers.js';

/**
 * Machine-to-machine clients (`client_credentials`, #2267) — registered from the console,
 * held to the operator's `MACHINE_SCOPES` ceiling, and kept apart from the relying parties a
 * person signs into.
 *
 * Better Auth is rebuilt per request here, as both runtimes do, so changing `cfg` between two
 * calls is exactly an operator changing `MACHINE_SCOPES` between two requests.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const RP_REDIRECT = 'http://localhost:9999/cb';

let db: Database.Database;
let cfg: Record<string, string | undefined>;
let api: ReturnType<typeof createAdminApi>;

function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return {
        columnNames: stmt.columns().map((c) => c.name),
        toArray: () => objects,
        raw: () => (stmt.raw(true).all(...(bindings as [])) as unknown[][]).values(),
      };
    },
  };
}

/** Better Auth as the runtimes build it: from the config in force for THIS request. */
const authNow = (): Auth =>
  buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
    machineScopes: machineScopesOf(cfg[MACHINE_SCOPES]).scopes,
  });

const call = (path: string, init?: RequestInit): Promise<Response> =>
  authNow().handler(new Request(`${ORIGIN}${path}`, init) as never);

async function signIn(): Promise<string> {
  const res = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

const adminCall = (path: string, cookie: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(
    api.request(`http://localhost${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...init?.headers },
    }),
  );

interface WireClient {
  client_id: string;
  application_type?: string;
  redirect_uris: string[];
  client_credentials_scopes: string[];
  client_secret_set?: boolean;
  skip_consent?: boolean;
  scope?: string;
}

const post = (cookie: string, body: Record<string, unknown>) =>
  adminCall('/clients', cookie, { method: 'POST', body: JSON.stringify(body) });

const patch = (cookie: string, clientId: string, body: Record<string, unknown>) =>
  adminCall(`/clients/${clientId}`, cookie, { method: 'PATCH', body: JSON.stringify(body) });

const errorOf = async (res: Response): Promise<string> => ((await res.json()) as { error?: string }).error ?? '';

async function registerMachine(cookie: string, scopes: string[], extra: Record<string, unknown> = {}) {
  const res = await post(cookie, {
    application_type: 'machine',
    client_name: 'Nightly Export',
    client_credentials_scopes: scopes,
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as WireClient & { client_secret: string };
}

/**
 * A `client_credentials` request, authenticated the RFC 6749 default way (HTTP Basic). `posted`
 * also puts a `client_id` in the form, which RFC 6749 allows beside Basic only if it agrees.
 */
function token(clientId: string, secret: string, scope?: string, posted?: string): Promise<Response> {
  return call('/api/auth/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      ...(scope ? { scope } : {}),
      ...(posted ? { client_id: posted } : {}),
    }).toString(),
  });
}

const listClients = async (cookie: string): Promise<WireClient[]> =>
  ((await (await adminCall('/clients', cookie)).json()) as { clients: WireClient[] }).clients;

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  const sql = sqlExecOf(db);
  cfg = { [MACHINE_SCOPES]: 'reports:read billing:write' };
  const created = await authNow().api.signUpEmail({ body: ADMIN });
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
  const session = (headers: Headers): Promise<SessionSubject | null> =>
    authNow()
      .api.getSession({ headers: headers as never })
      .then((s) => {
        const u = s?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
        return u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null;
      });
  api = createAdminApi({
    sql,
    session,
    effectiveCfg: () => cfg,
    auth: () => authNow().api as never,
    offeredProviders: () => publicProvidersFrom(readProviders(sql)),
    transaction: (fn) => fn(),
  });
});

describe('MACHINE_SCOPES, read', () => {
  it('splits on spaces and commas and drops repeats', () => {
    expect(machineScopesOf(' reports:read,billing:write  reports:read ')).toEqual({
      scopes: ['reports:read', 'billing:write'],
    });
  });

  it('is empty when unset or blank — no machine client is the default', () => {
    expect(machineScopesOf(undefined)).toEqual({ scopes: [] });
    expect(machineScopesOf('   ')).toEqual({ scopes: [] });
  });

  it('refuses a sign-in scope whole, rather than keeping the rest of the list', () => {
    const read = machineScopesOf('reports:read openid');
    expect(read.scopes).toEqual([]);
    expect(read.error).toMatch(/openid/);
  });

  it('refuses an entry that is not a scope token', () => {
    const read = machineScopesOf('reports:read "quoted"');
    expect(read.scopes).toEqual([]);
    expect(read.error).toMatch(/"quoted"/);
  });
});

describe('registering a machine client', () => {
  it('returns the secret once, and that secret gets a token carrying no person', async () => {
    const admin = await signIn();
    const client = await registerMachine(admin, ['reports:read']);
    expect(client.application_type).toBe('machine');
    expect(client.client_secret).toBeTruthy();

    const res = await token(client.client_id, client.client_secret);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBeTruthy();
    expect(body.scope).toBe('reports:read');
    // No person signed in, so there is nothing to say who they are or to refresh on their behalf.
    expect(body.id_token).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();
  });

  it('is listed as a machine client with its scopes, and never with its secret', async () => {
    const admin = await signIn();
    const client = await registerMachine(admin, ['reports:read', 'billing:write']);
    const res = await adminCall('/clients', admin);
    const raw = await res.text();
    expect(raw).not.toContain(client.client_secret);
    const listed = (JSON.parse(raw) as { clients: (WireClient & Record<string, unknown>)[] }).clients.find(
      (c) => c.client_id === client.client_id,
    );
    expect(listed).toMatchObject({
      application_type: 'machine',
      client_credentials_scopes: ['reports:read', 'billing:write'],
      redirect_uris: [],
      client_secret_set: true,
    });
    expect(listed).not.toHaveProperty('client_secret');
  });

  it('refuses every sign-in field, one at a time', async () => {
    const admin = await signIn();
    for (const extra of [
      { redirect_uris: [RP_REDIRECT] },
      { post_logout_redirect_uris: [RP_REDIRECT] },
      { skip_consent: true },
      { enable_end_session: true },
      { token_endpoint_auth_method: 'none' },
      { grant_types: ['authorization_code'] },
    ]) {
      const res = await post(admin, {
        application_type: 'machine',
        client_name: 'Overreaching',
        client_credentials_scopes: ['reports:read'],
        ...extra,
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const signIn_ = await post(admin, {
      application_type: 'machine',
      client_name: 'Policed',
      client_credentials_scopes: ['reports:read'],
      metadata: { signIn: { password: true } },
    });
    expect(signIn_.status).toBe(400);
    expect(await listClients(admin)).toHaveLength(0);
  });

  it('refuses a machine client with no scopes', async () => {
    const res = await post(await signIn(), {
      application_type: 'machine',
      client_name: 'Empty',
      client_credentials_scopes: [],
    });
    expect(res.status).toBe(400);
  });

  it('refuses a scope outside MACHINE_SCOPES, and a sign-in scope', async () => {
    const admin = await signIn();
    for (const scope of ['payroll:write', 'openid']) {
      const res = await post(admin, {
        application_type: 'machine',
        client_name: 'Greedy',
        client_credentials_scopes: ['reports:read', scope],
      });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain(scope);
    }
  });

  it('fails closed with MACHINE_SCOPES unset, naming the key', async () => {
    cfg = {};
    const res = await post(await signIn(), {
      application_type: 'machine',
      client_name: 'Too Early',
      client_credentials_scopes: ['reports:read'],
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain(MACHINE_SCOPES);
  });

  it('fails closed on a refused MACHINE_SCOPES, saying why', async () => {
    cfg = { [MACHINE_SCOPES]: 'reports:read profile' };
    const res = await post(await signIn(), {
      application_type: 'machine',
      client_name: 'Misconfigured',
      client_credentials_scopes: ['reports:read'],
    });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatch(/profile/);
  });
});

describe('web and native clients, beside machine ones', () => {
  it('still require a redirect URI', async () => {
    const admin = await signIn();
    for (const application_type of ['web', 'native']) {
      const res = await post(admin, { application_type, client_name: 'Lost' });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatch(/redirect_uris/);
    }
  });

  it('still register with one, and with no MACHINE_SCOPES at all', async () => {
    cfg = {};
    const res = await post(await signIn(), {
      application_type: 'native',
      client_name: 'Ordinary',
      redirect_uris: [RP_REDIRECT],
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as WireClient).application_type).toBe('native');
  });

  it('refuse machine scopes and a grant of their own choosing', async () => {
    const admin = await signIn();
    for (const extra of [{ client_credentials_scopes: ['reports:read'] }, { grant_types: ['client_credentials'] }]) {
      const res = await post(admin, {
        application_type: 'web',
        client_name: 'Sideways',
        redirect_uris: ['https://rp.example/cb'],
        ...extra,
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });
});

describe('editing a machine client', () => {
  it('never moves it into web or native, nor a relying party into machine', async () => {
    const admin = await signIn();
    const machine = await registerMachine(admin, ['reports:read']);
    for (const application_type of ['web', 'native']) {
      const res = await patch(admin, machine.client_id, { application_type });
      expect(res.status).toBe(400);
    }
    const rp = (await (
      await post(admin, { application_type: 'native', client_name: 'RP', redirect_uris: [RP_REDIRECT] })
    ).json()) as WireClient;
    const res = await patch(admin, rp.client_id, { application_type: 'machine' });
    expect(res.status).toBe(400);
    const listed = await listClients(admin);
    expect(listed.find((c) => c.client_id === machine.client_id)?.application_type).toBe('machine');
    expect(listed.find((c) => c.client_id === rp.client_id)?.application_type).toBe('native');
  });

  it('refuses the sign-in fields — a machine client is never a consent-skipping public one', async () => {
    const admin = await signIn();
    const machine = await registerMachine(admin, ['reports:read']);
    for (const body of [
      { redirect_uris: [RP_REDIRECT] },
      { post_logout_redirect_uris: [] },
      { skip_consent: true },
      { enable_end_session: true },
      { metadata: { signIn: { password: true } } },
    ]) {
      const res = await patch(admin, machine.client_id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const listed = (await listClients(admin)).find((c) => c.client_id === machine.client_id);
    expect(listed).toMatchObject({ redirect_uris: [], skip_consent: false });
  });

  it('takes a restatement of its own kind alongside a real change', async () => {
    const admin = await signIn();
    const machine = await registerMachine(admin, ['reports:read']);
    const res = await patch(admin, machine.client_id, { application_type: 'machine', client_name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WireClient).application_type).toBe('machine');
  });

  it('narrows its scopes, and the token endpoint follows', async () => {
    const admin = await signIn();
    const machine = await registerMachine(admin, ['reports:read', 'billing:write']);
    const res = await patch(admin, machine.client_id, { client_credentials_scopes: ['billing:write'] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WireClient).client_credentials_scopes).toEqual(['billing:write']);
    const granted = (await (await token(machine.client_id, machine.client_secret)).json()) as { scope?: string };
    expect(granted.scope).toBe('billing:write');
    expect((await token(machine.client_id, machine.client_secret, 'reports:read')).status).toBe(400);
  });

  it('cannot widen its scopes beyond MACHINE_SCOPES', async () => {
    const admin = await signIn();
    const machine = await registerMachine(admin, ['reports:read']);
    for (const scope of ['payroll:write', 'openid']) {
      const res = await patch(admin, machine.client_id, { client_credentials_scopes: ['reports:read', scope] });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain(scope);
    }
    expect((await listClients(admin)).find((c) => c.client_id === machine.client_id)?.client_credentials_scopes).toEqual([
      'reports:read',
    ]);
  });

  it('refuses client_credentials_scopes on a relying party', async () => {
    const admin = await signIn();
    const rp = (await (
      await post(admin, { application_type: 'native', client_name: 'RP', redirect_uris: [RP_REDIRECT] })
    ).json()) as WireClient;
    const res = await patch(admin, rp.client_id, { client_credentials_scopes: ['reports:read'] });
    expect(res.status).toBe(400);
  });
});

describe('the token endpoint, for a machine client', () => {
  it('refuses a disabled one', async () => {
    const admin = await signIn();
    const machine = await registerMachine(admin, ['reports:read']);
    expect((await patch(admin, machine.client_id, { disabled: true })).status).toBe(200);
    expect((await token(machine.client_id, machine.client_secret)).status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a wrong secret', async () => {
    const machine = await registerMachine(await signIn(), ['reports:read']);
    expect((await token(machine.client_id, `${machine.client_secret}x`)).status).toBe(401);
  });

  it('holds every client to MACHINE_SCOPES as it is NOW, not as it was at registration', async () => {
    const machine = await registerMachine(await signIn(), ['reports:read', 'billing:write']);
    cfg = { [MACHINE_SCOPES]: 'billing:write' };
    const narrowed = (await (await token(machine.client_id, machine.client_secret)).json()) as { scope?: string };
    expect(narrowed.scope).toBe('billing:write');
    const asked = await token(machine.client_id, machine.client_secret, 'reports:read');
    expect(asked.status).toBe(400);
    expect(await asked.text()).toMatch(/reports:read/);

    cfg = { [MACHINE_SCOPES]: 'payroll:write' };
    expect((await token(machine.client_id, machine.client_secret)).status).toBe(400);
  });

  it('grants nothing once MACHINE_SCOPES is unset, or refused', async () => {
    const machine = await registerMachine(await signIn(), ['reports:read']);
    for (const value of [undefined, 'reports:read openid']) {
      cfg = { [MACHINE_SCOPES]: value };
      const res = await token(machine.client_id, machine.client_secret);
      expect(res.status, String(value)).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe('unauthorized_client');
    }
  });

  it('refuses a scope-less request it cannot tie to a client, rather than letting all through', async () => {
    await registerMachine(await signIn(), ['reports:read']);
    const res = await call('/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_client');
  });

  it('refuses a request that posts one client and authenticates as another', async () => {
    const admin = await signIn();
    const a = await registerMachine(admin, ['reports:read']);
    const b = await registerMachine(admin, ['billing:write']);
    // With and without a scope: the identity is ambiguous either way, so no default is chosen.
    for (const scope of [undefined, 'billing:write']) {
      const res = await token(b.client_id, b.client_secret, scope, a.client_id);
      expect(res.status, String(scope)).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe('invalid_client');
    }
  });

  it('accepts a posted client_id that agrees with Basic', async () => {
    const b = await registerMachine(await signIn(), ['billing:write']);
    const res = await token(b.client_id, b.client_secret, undefined, b.client_id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scope?: string }).scope).toBe('billing:write');
  });

  it('works again after its secret is rotated, and only with the new one', async () => {
    const admin = await signIn();
    const machine = await registerMachine(admin, ['reports:read']);
    const rotated = await call('/api/auth/oauth2/client/rotate-secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors', cookie: admin },
      body: JSON.stringify({ client_id: machine.client_id }),
    });
    expect(rotated.status).toBe(200);
    const next = ((await rotated.json()) as { client_secret: string }).client_secret;
    expect((await token(machine.client_id, machine.client_secret)).status).toBe(401);
    expect((await token(machine.client_id, next)).status).toBe(200);
  });
});

describe('machine scopes stay out of a person’s sign-in', () => {
  const PKCE = { code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' };

  async function consentFor(cookie: string, clientId: string, scope?: string): Promise<string> {
    const res = await call(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: RP_REDIRECT,
        state: 'st',
        ...PKCE,
        ...(scope ? { scope } : {}),
      })}`,
      { headers: { 'sec-fetch-mode': 'navigate', cookie } },
    );
    const location = new URL(res.headers.get('location') ?? '', ORIGIN);
    // The consent screen is handed the scope it will ask the person about.
    expect(location.pathname, location.toString()).toBe('/consent');
    return location.searchParams.get('scope') ?? '';
  }

  it('drops one a relying party asks for by name', async () => {
    const admin = await signIn();
    const rp = (await (
      await post(admin, { application_type: 'native', client_name: 'RP', redirect_uris: [RP_REDIRECT] })
    ).json()) as WireClient;
    expect((await consentFor(admin, rp.client_id, 'openid reports:read')).split(' ')).toEqual(['openid']);
  });

  it('leaves them out of the default an unscoped request falls back to', async () => {
    const admin = await signIn();
    const rp = (await (
      await post(admin, { application_type: 'native', client_name: 'RP', redirect_uris: [RP_REDIRECT] })
    ).json()) as WireClient;
    expect((await consentFor(admin, rp.client_id)).split(' ').sort()).toEqual(
      ['email', 'offline_access', 'openid', 'profile'],
    );
  });

  it('keeps a self-registered client on the sign-in scopes', async () => {
    const res = await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Walk-in', redirect_uris: [RP_REDIRECT], application_type: 'native', token_endpoint_auth_method: 'none' }),
    });
    expect(res.status).toBe(201);
    const scope = ((await res.json()) as { scope?: string }).scope ?? '';
    expect(scope.split(' ').sort()).toEqual(['email', 'offline_access', 'openid', 'profile']);
  });

  it('refuses a self-registered client that asks for one', async () => {
    const res = await call('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Walk-in',
        redirect_uris: [RP_REDIRECT],
        application_type: 'native',
        token_endpoint_auth_method: 'none',
        scope: 'openid reports:read',
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/reports:read/);
  });
});

describe('discovery', () => {
  const advertised = async () =>
    (
      (await (await call('/.well-known/openid-configuration')).json()) as {
        scopes_supported?: string[];
        grant_types_supported?: string[];
      }
    );

  it('advertises the machine scopes beside the sign-in ones, and the grant', async () => {
    const doc = await advertised();
    expect(doc.scopes_supported?.sort()).toEqual(
      ['billing:write', 'email', 'offline_access', 'openid', 'profile', 'reports:read'],
    );
    expect(doc.grant_types_supported).toContain('client_credentials');
  });

  it('advertises only the sign-in scopes without MACHINE_SCOPES — what it said before', async () => {
    cfg = {};
    expect((await advertised()).scopes_supported?.sort()).toEqual(['email', 'offline_access', 'openid', 'profile']);
  });
});

describe('which client a token request claims to be', () => {
  const b64url = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const assertion = (payload: unknown) => `${b64url({ alg: 'ES256' })}.${b64url(payload)}.sig`;
  const basic = (id: string) => new Headers({ authorization: `Basic ${btoa(`${encodeURIComponent(id)}:s`)}` });

  it('reads the posted id, Basic, or a private_key_jwt assertion’s sub, whichever is present', () => {
    expect(tokenRequestClientId({ body: { client_id: 'posted' } })).toBe('posted');
    expect(tokenRequestClientId({ body: {}, headers: basic('basic') })).toBe('basic');
    expect(tokenRequestClientId({ body: { client_assertion: assertion({ sub: 'asserted', iss: 'asserted' }) } })).toBe(
      'asserted',
    );
  });

  it('says the identities conflict when two presentations name different clients', () => {
    const conflict = 'conflict';
    expect(tokenRequestClientId({ body: { client_id: 'posted' }, headers: basic('basic') })).toBe(conflict);
    expect(tokenRequestClientId({ body: { client_id: 'posted', client_assertion: assertion({ sub: 'asserted' }) } })).toBe(
      conflict,
    );
    expect(
      tokenRequestClientId({ body: { client_assertion: assertion({ sub: 'asserted' }) }, headers: basic('basic') }),
    ).toBe(conflict);
  });

  it('agrees when they all name the same client, and ignores Basic it cannot decode', () => {
    expect(tokenRequestClientId({ body: { client_id: 'same' }, headers: basic('same') })).toBe('same');
    expect(tokenRequestClientId({ body: { client_id: 'same', client_assertion: assertion({ sub: 'same' }) } })).toBe(
      'same',
    );
    const malformed = new Headers({ authorization: 'Basic !!!' });
    expect(tokenRequestClientId({ body: { client_id: 'posted' }, headers: malformed })).toBe('posted');
  });

  it('claims nobody from nothing, or from an assertion it cannot read', () => {
    expect(tokenRequestClientId({ body: {} })).toBeUndefined();
    expect(tokenRequestClientId({ body: { client_assertion: 'not-a-jwt' } })).toBeUndefined();
    expect(tokenRequestClientId({ body: { client_assertion: assertion({ iss: 'no-sub' }) } })).toBeUndefined();
  });
});
