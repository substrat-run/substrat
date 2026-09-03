import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import {
  MockEmailTransport,
  type EmailMessage,
  type EmailTransport,
  type SendResult,
} from '@substrat-run/adapter-email';
import { resolveScopedEnvSpec } from '@substrat-run/contracts';
import { schema } from './auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { upgradeLegacySchema } from '../db/upgrade.js';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { buildAuth, DEMO_CLIENT, seedDemoClient, type Auth } from './auth.js';
import { senderFor } from './email.js';
import { AUTH_SERVER_ENV } from './manifest.js';
import { createAdminApi } from './admin-api.js';
import type { SqlExec } from './introspect.js';
import type { SessionSubject } from './do-contract.js';
import { ALLOW_SIGNUP, deliveredConfig, isTruthy } from './settings.js';
import { publicProvidersFrom, readProviders, socialProvidersFrom, trustedProvidersFrom } from './providers.js';
import { bankIdApiUrl, publicBankIdFrom, readBankIdConfig, type BankIdConfig } from './bankid.js';
import { clientBranding } from './branding.js';
import { nodeBankIdTransport } from './bankid-transport-node.js';

/**
 * Dev API server for the auth-server demo — Better Auth over a local better-sqlite3 file,
 * the exact same `buildAuth` config the worker's Durable Object runs. No Durable Object and
 * no Cloudflare account needed: this is the fast inner loop for the OIDC provider + admin UI.
 *
 * Email has no real sending domain in dev, so the transport is a mock that ALSO logs each
 * message — a password-reset or verification link is printed to this terminal, where you can
 * click it. That is the demo's "email adapter" made observable.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const PORT = Number(process.env.PORT ?? 8877);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5277);
const ORIGIN = `http://localhost:${PORT}`;

/** A mock transport that also prints each message (and its action link) to the terminal. */
class LoggingMockTransport extends MockEmailTransport {
  override async send(message: EmailMessage): Promise<SendResult> {
    const result = await super.send(message);
    const to = Array.isArray(message.to) ? message.to.map((r) => (typeof r === 'string' ? r : r.email)).join(', ') : typeof message.to === 'string' ? message.to : message.to.email;
    const link = /(https?:\/\/\S+)/.exec(message.text)?.[1];
    console.log(`\n  📧 ${message.subject}  → ${to}`);
    if (link) console.log(`     ${link}\n`);
    return result;
  }
}

const transport: EmailTransport = new LoggingMockTransport();

const sqlite = new Database(join(dataDir, 'auth.sqlite'));
sqlite.pragma('journal_mode = WAL');
const db = drizzle(sqlite, { schema });

/** better-sqlite3 in the DO-cursor shape the shared helpers consume (see `introspect.ts`). */
const sql: SqlExec = {
  exec(query: string, ...bindings: unknown[]) {
    const stmt = sqlite.prepare(query);
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

// Same order as the Durable Object's constructor: upgrade a pre-1.7 store BEFORE the DDL,
// because `CREATE TABLE IF NOT EXISTS` cannot fix a table whose shape changed.
const upgraded = upgradeLegacySchema(sql);
for (const stmt of SCHEMA_STATEMENTS) sqlite.exec(stmt);

/**
 * The declared config, resolved the same way the DO resolves it: manifest env-spec over
 * process.env, overlaid with the per-instance `cfg:` rows the dashboard writes. Read fresh
 * per request so a settings toggle lands on the next request, not the next restart.
 */
const config = (): Record<string, string | undefined> =>
  resolveScopedEnvSpec(AUTH_SERVER_ENV, process.env as Record<string, unknown>, deliveredConfig(sql, AUTH_SERVER_ENV))
    .values;

/**
 * Better Auth over the dev database. Rebuilt per request, as the DO does, for the same
 * reason: the sign-up setting is read from config, so a toggle has to be able to change it.
 * `allowSignup` is overridable for the bootstrap paths — creating the FIRST administrator is
 * not self-service registration, and must work on an issuer with sign-up closed.
 */
/**
 * The header this server vouches for as the end user's IP (BankID requires one). Stamped
 * onto every `/api/auth/*` request FROM THE ACCEPTED SOCKET below, overwriting anything a
 * caller sent — `x-forwarded-for` stays untrusted, because nothing sits in front of this
 * dev server that would make it trustworthy.
 */
const CLIENT_IP_HEADER = 'x-bankid-client-ip';

/** BankID for `buildAuth`, from the stored config. Node can always present the client
 *  certificate, so an enabled configuration is the only condition. */
const bankidFor = (cfg: BankIdConfig | undefined) =>
  cfg && !cfg.disabled
    ? {
        apiUrl: bankIdApiUrl(cfg.environment),
        transport: nodeBankIdTransport(cfg),
        allowSignup: cfg.allowSignup,
        clientIpHeader: CLIENT_IP_HEADER,
      }
    : undefined;

const authFor = (overrides?: { allowSignup?: boolean }): Auth => {
  const cfg = config();
  const providers = readProviders(sql);
  return buildAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    secret: process.env.AUTH_SECRET ?? 'dev-secret-not-for-production-000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN, `http://localhost:${WEB_PORT}`],
    transport,
    sender: senderFor(cfg.EMAIL_FROM),
    // Node can honour the transport contract in full — resolve once, reject special-use
    // answers, pin the address, refuse redirects — so the shipped implementation is used
    // rather than the workerd one this vertical also carries.
    fetchClientMetadataResource,
    allowSignup: overrides?.allowSignup ?? isTruthy(cfg[ALLOW_SIGNUP]),
    socialProviders: socialProvidersFrom(providers),
    trustedProviders: trustedProvidersFrom(providers),
    bankid: bankidFor(readBankIdConfig(sql)),
  });
};

/** The bootstrap instance: sign-up forced on, used ONLY to create the first administrator. */
const bootstrapAuth = authFor({ allowSignup: true });
const cfg = config();

const needsSetup = (): boolean => (sqlite.prepare('SELECT count(*) AS n FROM user').get() as { n: number }).n === 0;

// Bootstrap admin from the env (ADMIN_EMAIL/ADMIN_PASSWORD), same contract as the worker DO,
// falling back to the demo defaults so `pnpm dev` runs with zero config.
const ADMIN_EMAIL = cfg.ADMIN_EMAIL ?? 'admin@auth.test';
const ADMIN_PASSWORD = cfg.ADMIN_PASSWORD ?? 'admin-demo-pass';

/** Seed the administrator so you can sign into the dashboard immediately. Idempotent. */
async function seedAdmin(): Promise<void> {
  const existing = sqlite.prepare('SELECT id FROM user WHERE email = ?').get(ADMIN_EMAIL) as { id: string } | undefined;
  if (existing) return;
  const created = await bootstrapAuth.api.signUpEmail({ body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Administrator' } });
  sqlite.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
}
await seedAdmin();

/**
 * Register the demo relying party — every boot, because its secret is HASHED at rest and so
 * cannot be recovered to print. A fresh one each start is the honest version of a banner
 * that tells you the credentials; the previous demo registration (if any) is removed first so
 * restarts do not pile up rows. Nothing outside this demo holds the old id.
 */
async function seedDemo(): Promise<{ clientId: string; clientSecret: string }> {
  const headers = new Headers();
  const signIn = await authFor().api.signInEmail({
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    asResponse: true,
  });
  for (const cookie of signIn.headers.getSetCookie()) headers.append('cookie', cookie.split(';')[0] ?? '');
  for (const stale of sqlite.prepare('SELECT client_id FROM oauth_client WHERE name = ?').all(DEMO_CLIENT.name) as {
    client_id: string;
  }[]) {
    sqlite.prepare('DELETE FROM oauth_client WHERE client_id = ?').run(stale.client_id);
  }
  return seedDemoClient(authFor(), headers);
}
const demo = await seedDemo();

const app = new Hono();

app.get('/api/setup-state', (c) => {
  const bankid = publicBankIdFrom(readBankIdConfig(sql), true);
  return c.json({
    needsSetup: needsSetup(),
    signupEnabled: isTruthy(config()[ALLOW_SIGNUP]),
    providers: [...publicProvidersFrom(readProviders(sql)), ...(bankid ? [bankid] : [])],
  });
});

app.post('/api/setup', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; name?: string }>();
  if (!body.email || !body.password || !body.name) throw new HTTPException(400, { message: 'email, password and name are required' });
  if (!needsSetup()) throw new HTTPException(409, { message: 'the auth server is already set up' });
  // Bootstrapping the first admin is not sign-up, so it goes through Better Auth's internal
  // API on an instance with sign-up ON — otherwise `ALLOW_SIGNUP=false` would leave a fresh
  // issuer with no way to create anybody, including its own first administrator.
  const created = await bootstrapAuth.api.signUpEmail({ body: { email: body.email, password: body.password, name: body.name } });
  sqlite.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
  return c.json({ ok: true, id: created.user.id }, 201);
});

/** The verified subject behind a request's cookies, or null. */
const sessionOf = async (headers: Headers): Promise<SessionSubject | null> => {
  const session = await authFor().api.getSession({ headers });
  const u = session?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
  return u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null;
};

app.get('/api/session', async (c) => c.json(await sessionOf(c.req.raw.headers)));

// The per-client theme for the login/consent screens — same shared read the worker's DO
// serves at `/__branding` (see src/branding.ts for why it is public and ungated).
app.get('/api/branding', (c) => c.json(clientBranding(sql, c.req.query('client_id'))));

// The issuer's own admin API — the relying-party registry and settings. The SAME factory the
// worker's DO mounts, over this dev database, so the dashboard is exercised identically here.
app.route(
  '/api/admin',
  createAdminApi({ sql, session: sessionOf, effectiveCfg: config, auth: () => authFor().api as never }),
);

// Root-level OIDC discovery + RFC 8414 metadata — `oauthProvider` serves these paths itself
// (the 1.6 plugin served them under the base path, which is why this used to rewrite).
app.get('/.well-known/:document{(openid-configuration|oauth-authorization-server)}', (c) =>
  authFor().handler(c.req.raw),
);

// The whole Better Auth surface (sign-in, reset, OIDC, admin API). The client-IP header is
// re-stamped from the accepted socket first — @hono/node-server hands the Node request in as
// the env — so the value the BankID plugin reads is this server's own observation, never the
// caller's claim.
app.on(['GET', 'POST', 'OPTIONS'], '/api/auth/*', (c) => {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } }).incoming?.socket;
  // Node reports an IPv4 peer on a dual-stack listener as `::ffff:a.b.c.d` — send BankID
  // the plain IPv4 it wraps.
  const address = (socket?.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/i, '');
  // The copy exists to own mutable headers; the cast is the undici-vs-hono Request
  // collision the tsconfig split describes, not a real shape difference.
  const req = new Request(c.req.raw);
  req.headers.set(CLIENT_IP_HEADER, address);
  return authFor().handler(req as unknown as typeof c.req.raw);
});

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 400;
  return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
});

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  Auth Server demo (OIDC provider)  ${ORIGIN}`);
console.log(`  admin dashboard                   http://localhost:${WEB_PORT}`);
console.log(`  discovery                         ${ORIGIN}/.well-known/openid-configuration`);
console.log(`  seeded admin                      ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
console.log(`  demo relying party                client_id=${demo.clientId}`);
console.log(`                                    client_secret=${demo.clientSecret}  (fresh each boot — stored hashed)`);
console.log(`                                    redirect ${DEMO_CLIENT.redirectUris[0]}`);
if (upgraded.renamed.length || upgraded.added.length) {
  console.log(`  schema upgraded                   ${JSON.stringify(upgraded)}`);
}
console.log(`  data                              ${dataDir}\n`);
