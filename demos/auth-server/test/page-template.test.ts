import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { createAdminApi } from '../src/admin-api.js';
import { ALLOW_SIGNUP } from '../src/settings.js';
import { ISSUER_THEME } from '../src/branding.js';
import type { SqlExec } from '../src/introspect.js';
import {
  MAX_TEMPLATE_BYTES,
  putPageTemplate,
  readPageTemplate,
  renderPageTemplate,
  sampleVariables,
  templateProblems,
} from '../src/page-template.js';
import { pageTemplateFor, type PageTemplateAnswer } from '../src/page-template-data.js';

/**
 * The install's page template (#3350, `src/page-template.ts`): what a save refuses, what a page
 * is given to print on each screen and in each language, that what it prints is escaped, and
 * that a template failing at request time costs nobody their sign-in.
 */

const ORIGIN = 'http://localhost:8877';
const SECRET = 'test-secret-000000000000000000000000';
const ADMIN = { email: 'admin@auth.test', password: 'admin-demo-pass', name: 'Demo Admin' };
const RP_REDIRECT = 'http://localhost:9999/cb';
/** A self-registered client chooses its own name, so it is the hostile input to print. */
const HOSTILE_NAME = '<img src=x onerror=alert(1)>Acme';

/** Everything a template can print, on one line. */
const PRINT_ALL = `<html lang="{{ locale }}"><head>{%- auth0:head -%}</head><body>
{{ prompt.name }}|{{ prompt.screen.name }}|{{ locale }}|{{ application.name }}|{{ application.client_id }}|{{ application.metadata.tier }}|{{ user.name }}|{{ user.email }}|{{ branding.colors.primary }}|{{ tenant.friendly_name }}|{{ tenant.enabled_locales | join: "," }}
{%- auth0:widget -%}</body></html>`;

let db: Database.Database;
let sql: SqlExec;
let auth: Auth;
const cfg: Record<string, string | undefined> = {};
let clientId: string;
let adminCookie: string;

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

const call = (path: string, init?: RequestInit) => auth.handler(new Request(`${ORIGIN}${path}`, init) as never);

/** The signed query the plugin parks someone on `/login` with, for this suite's client. */
async function signedLoginQuery(extra: Record<string, string> = {}): Promise<string> {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: RP_REDIRECT,
    scope: 'openid profile',
    state: 'state-1',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    ...extra,
  });
  const res = await call(`/api/auth/oauth2/authorize?${q}`, { headers: { 'sec-fetch-mode': 'navigate' } });
  const location = res.headers.get('location') ?? '';
  expect(location.startsWith('/login?')).toBe(true);
  return new URL(`http://x${location}`).search.slice(1);
}

async function answerFor(path: string, search: string, headers: { cookie?: string; acceptLanguage?: string } = {}): Promise<PageTemplateAnswer> {
  return pageTemplateFor(
    {
      sql,
      cfg,
      secret: async () => SECRET,
      user: async () => {
        const session = await auth.api.getSession({ headers: new Headers(headers.cookie ? { cookie: headers.cookie } : {}) });
        return session ? { id: session.user.id, name: session.user.name, email: session.user.email } : null;
      },
      offeredProviders: () => [],
      tenantName: 'Acme Auth',
    },
    { path, search, cookie: headers.cookie ?? null, acceptLanguage: headers.acceptLanguage ?? null },
  );
}

/** The one line `PRINT_ALL` prints, for a page request. */
async function printed(path: string, search: string, headers: { cookie?: string; acceptLanguage?: string } = {}): Promise<string> {
  const answer = await answerFor(path, search, headers);
  if (!answer.template) throw new Error('no template');
  const html = renderPageTemplate(answer.template, answer.variables, { head: '', widget: '<div id="root"></div>' });
  return html.split('\n')[1]!.split('<div id="root">')[0]!;
}

beforeAll(async () => {
  db = new Database(':memory:');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = sqlExecOf(db);
  auth = buildAuth({
    database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
    secret: SECRET,
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    transport: new MockEmailTransport(),
    sender: { email: 'no-reply@send.substrat.test', name: 'Substrat Auth' },
    allowSignup: true,
  });
  const created = await auth.api.signUpEmail({ body: ADMIN });
  db.prepare("UPDATE user SET role = 'admin', email_verified = 1 WHERE id = ?").run(created.user.id);
  const registered = await call('/api/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [RP_REDIRECT], client_name: HOSTILE_NAME, application_type: 'native' }),
  });
  clientId = ((await registered.json()) as { client_id: string }).client_id;
  db.prepare('UPDATE oauth_client SET metadata = ? WHERE client_id = ?').run(
    JSON.stringify({ tier: 'gold', theme: { colorPrimary: '#e5833a' } }),
    clientId,
  );
  const signIn = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  adminCookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => c && !c.endsWith('=')).join('; ');
  putPageTemplate(sql, PRINT_ALL);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a save refuses a template that cannot draw every screen', () => {
  const ok = '<html><head>{%- auth0:head -%}</head><body>{%- auth0:widget -%}</body></html>';
  it.each([
    ['the head tag missing', '<body>{%- auth0:widget -%}</body>', 'missing required Liquid tags (auth0:head and auth0:widget)'],
    ['the widget tag missing', '<head>{%- auth0:head -%}</head>', 'missing required Liquid tags (auth0:head and auth0:widget)'],
    ['more than Auth0’s limit', ok + ' '.repeat(MAX_TEMPLATE_BYTES), `greater than maximum allowed: ${MAX_TEMPLATE_BYTES}`],
    ['a syntax error', ok + '{% if %}', 'Liquid template syntax error'],
    ['an include, which would reach outside the template', ok + "{% include 'https://example.com/x' %}", '{% include %} is not available'],
    ['the raw filter, which would print unescaped', ok + '{{ application.name | raw }}', 'raw filter is not available'],
    ['an unknown filter', ok + '{{ locale | nope }}', 'undefined filter: nope'],
    ['the widget left off one screen', '{%- auth0:head -%}{% unless prompt.name == "consent" %}{%- auth0:widget -%}{% endunless %}', 'on the consent screen'],
    ['the widget drawn twice', ok + '{%- auth0:widget -%}', 'drawn exactly once, and was drawn 2 times'],
    [
      'loops that would spend the page’s budget',
      ok + '{% assign a = "1,2,3,4,5,6,7,8,9,10" | split: "," %}{% for i in a %}{% for j in a %}{% for k in a %}{% for l in a %}{% for m in a %}{% for n in a %}{% endfor %}{% endfor %}{% endfor %}{% endfor %}{% endfor %}{% endfor %}',
      'more work than a page may',
    ],
    ['a capture that would grow past the budget', ok + '{% capture c %}{% for i in (1..100000) %}xxxxxxxxxx{% endfor %}{% endcapture %}', 'more work than a page may'],
  ])('%s', (_label, template, problem) => {
    const problems = templateProblems(template);
    expect(problems.join(' ')).toContain(problem);
  });

  it('admits a template that draws both tags once on every screen', () => {
    expect(templateProblems(PRINT_ALL)).toEqual([]);
  });
});

describe('what a page is given to print', () => {
  it('names the screen, the language and a verified application, escaped', async () => {
    const query = await signedLoginQuery({ ui_locales: 'sv' });
    expect(await printed('/login', query)).toBe(
      `login|login|sv|&lt;img src=x onerror=alert(1)&gt;Acme|${clientId}|gold|||#e5833a|Acme Auth|sv,en`,
    );
  });

  it.each([
    ['a sign-up asked for, and open', '/login', { screen_hint: 'signup' }, true, 'signup|signup'],
    ['a sign-up asked for, and closed', '/signup', {}, false, 'login|login'],
  ])('%s', async (_label, path, extra, open, expected) => {
    cfg[ALLOW_SIGNUP] = open ? 'true' : 'false';
    try {
      expect(await printed(path, await signedLoginQuery(extra))).toMatch(new RegExp(`^${expected}\\|`));
    } finally {
      delete cfg[ALLOW_SIGNUP];
    }
  });

  it('does not name an application from an unsigned client_id', async () => {
    // A page that printed the name for any id would be a registry probe.
    expect(await printed('/login', `client_id=${clientId}&sig=forged&ba_param=client_id`)).toMatch(/^login\|login\|en\|\|\|\|/);
  });

  it('gives the consent screen the signed-in person, and the language from Accept-Language', async () => {
    const query = await signedLoginQuery();
    const line = await printed('/consent', query, { cookie: adminCookie, acceptLanguage: 'sv-SE,sv;q=0.9,en;q=0.5' });
    expect(line).toBe(`consent|consent|sv|&lt;img src=x onerror=alert(1)&gt;Acme|${clientId}|gold|Demo Admin|${ADMIN.email}|#e5833a|Acme Auth|sv,en`);
  });

  it.each([
    ['/reset-password', 'token=abc', {}, 'reset-password|reset-password|en|'],
    ['/reset-password', '', {}, 'login|login|en|'],
    ['/accept-invitation', '', { cookie: 'auth_locale=sv' }, 'invitation|accept-invitation|sv|'],
    ['/github-email', '', { acceptLanguage: 'en-GB' }, 'login|github-email|en|'],
  ])('%s?%s draws the screen the app will draw', async (path, search, headers, prefix) => {
    expect(await printed(path, search, headers)).toMatch(new RegExp(`^${prefix.replace(/\|/g, '\\|')}`));
  });

  it('answers no template when none is set', async () => {
    const saved = readPageTemplate(sql)!;
    db.prepare("DELETE FROM config WHERE key = 'page_template'").run();
    try {
      expect(await answerFor('/login', '')).toEqual({ template: null });
    } finally {
      putPageTemplate(sql, saved);
    }
  });
});

describe('the console’s door', () => {
  const admin = () =>
    createAdminApi({
      sql,
      session: async (headers) => {
        const s = await auth.api.getSession({ headers });
        const u = s?.user as { id: string; email: string; name: string; role?: string } | undefined;
        return u ? { sub: u.id, email: u.email, name: u.name, role: u.role ?? null } : null;
      },
      effectiveCfg: () => ({ ...cfg, [ISSUER_THEME]: JSON.stringify({ colorPrimary: '#123456' }) }),
      auth: () => auth.api as never,
      offeredProviders: () => [],
      transaction: (fn) => fn(),
      indexHtml: () => '<html><head><script type="module" crossorigin src="/assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head></html>',
    });
  const request = (path: string, init: RequestInit = {}) =>
    admin().request(`${ORIGIN}/branding/templates/universal-login${path}`, {
      ...init,
      headers: { cookie: adminCookie, ...(init.headers as Record<string, string>) },
    });

  it('reads, replaces, previews and removes the template, in Auth0’s statuses', async () => {
    const saved = readPageTemplate(sql)!;
    db.prepare("DELETE FROM config WHERE key = 'page_template'").run();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect((await request('')).status).toBe(404);
      const put = (template: unknown) =>
        request('', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template }) });
      expect((await put(PRINT_ALL)).status).toBe(201);
      expect(await (await request('')).json()).toEqual({ body: PRINT_ALL });
      expect((await put(PRINT_ALL + '<!-- v2 -->')).status).toBe(204);

      const refused = await put('<p>no tags</p>');
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain('missing required Liquid tags');
      expect(readPageTemplate(sql)).toBe(PRINT_ALL + '<!-- v2 -->');

      const preview = await request('/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
        body: new URLSearchParams({ template: PRINT_ALL, screen: 'consent', locale: 'sv' }).toString(),
      });
      expect(preview.headers.get('content-security-policy')).toContain("'nonce-");
      const html = await preview.text();
      expect(html).toContain('consent|consent|sv|Example app|example-client||Ada Example|ada@example.com|#123456|');
      expect(html).toContain('data-preview-screen="consent"');
      expect(html).toMatch(/<script nonce="[^"]+" type="module" crossorigin src="\/assets\/index-abc.js"><\/script>/);

      const crossSite = await request('/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
        body: 'template=x',
      });
      expect(crossSite.status).toBe(403);

      expect((await request('', { method: 'DELETE' })).status).toBe(204);
      expect((await request('')).status).toBe(404);
      // Every change is a line naming who made it, with the template's size, never its text.
      const lines = logs.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
      expect(lines.map((l) => [l.message, l.outcome])).toEqual([
        ['page template saved', 'created'],
        ['page template saved', 'updated'],
        ['page template deleted', undefined],
      ]);
      expect(lines[0]).toMatchObject({ by: { admin: expect.any(String) }, bytes: PRINT_ALL.length, sha256: expect.stringMatching(/^[0-9a-f]{16}$/) });
    } finally {
      putPageTemplate(sql, saved);
    }
  });

  it('is an administrator’s alone', async () => {
    const res = await admin().request(`${ORIGIN}/branding/templates/universal-login`, { method: 'PUT', body: '{}' });
    expect(res.status).toBe(401);
  });
});
