import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { createAdminApi } from '../src/admin-api.js';
import { clientBranding, sanitizeTheme } from '../src/branding.js';
import type { SqlExec } from '../src/introspect.js';
import type { SessionSubject } from '../src/do-contract.js';

/**
 * Per-client theming for the hosted OIDC pages (`src/branding.ts`).
 *
 * Two properties carry the design and are pinned here:
 *
 *  1. **The read is not a registry oracle.** Unknown, disabled and unthemed clients answer
 *     `{ theme: {} }` byte-identically — the branding endpoint must never become the
 *     unauthenticated client-id probe that `public-client-prelogin`'s signed-query gate
 *     exists to prevent.
 *  2. **Sanitization is per key.** The theme is operator-written JSON headed for CSS custom
 *     properties and an <img src>; a value that fails its check is dropped alone, and a
 *     value that could smuggle CSS or a non-https URL never comes back at all.
 *
 * Clients are registered through the real plugin path (the same `adminCreateOAuthClient`
 * proxy the dashboard uses), so the `metadata` column this reads is the one the registry
 * actually writes — a renamed column reddens here, not in production.
 */

const ORIGIN = 'http://localhost:8877';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const RP_REDIRECT = 'http://localhost:9999/cb';

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
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

async function signInAs(who: { email: string; password: string }): Promise<string> {
  const res = await auth.handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(who),
    }) as never,
  );
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

/** Register a client through the dashboard's own path, with metadata riding along. */
async function register(name: string, cookie: string, metadata?: Record<string, unknown>): Promise<string> {
  const res = await api.request('http://localhost/clients', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [RP_REDIRECT],
      application_type: 'native',
      ...(metadata ? { metadata } : {}),
    }),
  });
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { client_id: string }).client_id;
}

beforeEach(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  auth = buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: 'test-secret-000000000000000000000000',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
  });
  const created = await auth.api.signUpEmail({ body: ADMIN });
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
  const session = (headers: Headers): Promise<SessionSubject | null> =>
    auth.api.getSession({ headers: headers as never }).then((s) => {
      const u = s?.user as { id: string; email?: string; name?: string; role?: string } | undefined;
      return u ? { sub: u.id, email: u.email ?? null, name: u.name ?? null, role: u.role ?? null } : null;
    });
  api = createAdminApi({ sql, session, effectiveCfg: () => ({}), auth: () => auth.api as never });
});

const THEME = {
  colorPrimary: '#0a6847',
  colorPrimaryForeground: '#ffffff',
  colorBackground: '#f6f1e9',
  title: 'Egeryds Portal',
  logoUrl: 'https://cdn.example.com/logo.svg',
};

describe('clientBranding', () => {
  it('returns the stored theme for a registered client', async () => {
    const clientId = await register('Themed RP', await signInAs(ADMIN), { theme: THEME, plan: 'internal' });
    expect(clientBranding(sql, clientId)).toEqual({ theme: THEME });
  });

  it('answers identically for an unknown, an unthemed, and a disabled client', async () => {
    const cookie = await signInAs(ADMIN);
    const unthemed = await register('Plain RP', cookie);
    const disabledId = await register('Disabled RP', cookie, { theme: THEME });
    const disable = await api.request(`http://localhost/clients/${disabledId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ disabled: true }),
    });
    expect(disable.status).toBe(200);

    const answers = [
      clientBranding(sql, 'no-such-client'),
      clientBranding(sql, unthemed),
      clientBranding(sql, disabledId),
      clientBranding(sql, null),
    ];
    // Byte-identical, not merely all empty — indistinguishability IS the property.
    for (const answer of answers) expect(JSON.stringify(answer)).toBe('{"theme":{}}');
  });

  it('drops an invalid value alone and keeps the rest', async () => {
    const clientId = await register('Half-broken RP', await signInAs(ADMIN), {
      theme: {
        ...THEME,
        colorBackground: 'red; background: url(https://evil.example/x)', // CSS smuggling
        logoUrl: 'http://not-https.example/logo.png', // insecure scheme
        borderRadius: '900px', // out of range
      },
    });
    expect(clientBranding(sql, clientId)).toEqual({
      theme: {
        colorPrimary: THEME.colorPrimary,
        colorPrimaryForeground: THEME.colorPrimaryForeground,
        title: THEME.title,
      },
    });
  });
});

describe('sanitizeTheme', () => {
  it('accepts every documented key in its valid form', () => {
    const full = {
      colorPrimary: '#0a6847',
      colorPrimaryForeground: '#fff',
      colorBackground: '#f6f1e9',
      colorPanel: '#ffffff',
      colorInput: '#eee8dd',
      colorText: '#1c1b1a',
      colorMutedText: '#6b6560',
      borderRadius: '12px',
      logoUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
      title: 'Acme',
    };
    expect(sanitizeTheme(full)).toEqual(full);
  });

  it('ignores unknown keys and non-object shapes', () => {
    expect(sanitizeTheme({ colorPrimary: '#123456', fontFamily: 'Comic Sans' })).toEqual({
      colorPrimary: '#123456',
    });
    expect(sanitizeTheme('dark')).toEqual({});
    expect(sanitizeTheme(['#123456'])).toEqual({});
    expect(sanitizeTheme(null)).toEqual({});
  });
});
