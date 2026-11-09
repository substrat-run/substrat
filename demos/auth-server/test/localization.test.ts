import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { schema } from '../src/auth-schema.generated.js';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { buildAuth, type Auth } from '../src/auth.js';
import { emailBrandOf, invitationEmail, resetPasswordEmail } from '../src/email.js';
import { issuerLocale, requestLocale, resolveLocale } from '../src/locale-wire.js';
import { SWEDISH_REFUSALS } from '../src/server-messages.js';
import { clientBranding } from '../src/branding.js';
import { translate } from '../src/messages.js';
import { sanitizeTheme, themeProblems, themeTitle, withAllText, withoutDefaultText } from '../src/theme-wire.js';

const ORIGIN = 'http://localhost:8877';
const from = { email: 'no-reply@send.substrat.test', name: 'Acme' };

describe('resolveLocale', () => {
  it.each([
    [{ uiLocales: 'sv', cookie: 'en', browser: ['en-US'] }, 'sv'],
    [{ uiLocales: 'de sv en' }, 'sv'],
    [{ uiLocales: 'de', cookie: 'sv', browser: ['en'] }, 'sv'],
    [{ cookie: 'sv', browser: ['en-US'] }, 'sv'],
    [{ cookie: 'de', browser: ['de-DE', 'sv-SE', 'en'] }, 'sv'],
    [{ browser: ['en-GB', 'sv'] }, 'en'],
    [{ browser: ['de-DE'] }, 'sv'],
    [{}, 'sv'],
  ])('%j reads as %s against a Swedish issuer', (input, expected) => {
    expect(resolveLocale({ ...input, issuerDefault: 'sv' })).toBe(expected);
  });

  it('takes the issuer default from config, English unless it says otherwise', () => {
    expect([issuerLocale('sv'), issuerLocale('en'), issuerLocale('de'), issuerLocale(undefined)]).toEqual(['sv', 'en', 'en', 'en']);
  });

  it('reads a request by its cookie, then its languages, then the default', () => {
    const headers = (entries: Record<string, string>) => new Headers(entries);
    expect(requestLocale(headers({ cookie: 'a=b; auth_locale=sv', 'accept-language': 'en' }), 'en')).toBe('sv');
    expect(requestLocale(headers({ 'accept-language': 'de;q=0.9, sv-SE;q=0.8' }), 'en')).toBe('sv');
    expect(requestLocale(null, 'sv')).toBe('sv');
  });
});

describe('the refusals our plugins throw', () => {
  it('all have Swedish', () => {
    const missing: string[] = [];
    for (const name of ['bankid-email-step', 'bankid-plugin', 'phone-plugin', 'invitation-plugin', 'github-email-plugin']) {
      const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
      const literals = [
        ...source.matchAll(/APIError\([^,]+,\s*\{\s*message:\s*'([^']+)'/g),
        ...source.matchAll(/const [A-Z_]+ = '([A-Z][^']{20,})';/g),
      ].map((m) => m[1]!);
      expect(literals.length).toBeGreaterThan(0);
      missing.push(...literals.filter((l) => !Object.hasOwn(SWEDISH_REFUSALS, l)));
    }
    expect(missing).toEqual([]);
  });
});

describe('an error the issuer answers with', () => {
  let auth: Auth;
  beforeEach(() => {
    const db = new Database(':memory:');
    for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    auth = buildAuth({
      database: drizzleAdapter(drizzle(db, { schema }), { provider: 'sqlite', schema }),
      secret: 'test-secret-000000000000000000000000',
      baseURL: ORIGIN,
      trustedOrigins: [ORIGIN],
      transport: new MockEmailTransport(),
      sender: from,
      allowSignup: false,
    });
  });
  const post = async (path: string, body: unknown, headers: Record<string, string>) => {
    const res = await auth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify(body),
      }) as never,
    );
    return (await res.json()) as { message: string };
  };
  const signIn = { email: 'nobody@auth.test', password: 'not-the-password' };
  const invitation = { token: 'x'.repeat(64) };

  it('is in Swedish for a Swedish browser, whether Better Auth threw it or we did', async () => {
    const sv = { cookie: 'auth_locale=sv' };
    expect((await post('/sign-in/email', signIn, sv)).message).toMatch(/lösenord/i);
    expect((await post('/invitation/accept', invitation, sv)).message).toBe('Inbjudan är ogiltig eller har gått ut');
  });

  it('stays in English otherwise', async () => {
    const en = { 'accept-language': 'en-GB' };
    expect((await post('/sign-in/email', signIn, en)).message).toBe('Invalid email or password');
    expect((await post('/invitation/accept', invitation, en)).message).toBe('This invitation is invalid or expired');
  });
});

describe('the mail', () => {
  const url = 'https://auth.example.com/reset?token=abc';

  it('is written in the language and look it is given', () => {
    const mail = resetPasswordEmail({
      to: 'a@example.com', from, url,
      style: { locale: 'sv', brand: { color: '#e5833a', foreground: '#ffffff', logoUrl: 'https://cdn.example.com/l.svg' } },
    });
    expect(mail.subject).toBe('Återställ ditt lösenord');
    expect(mail.text).toContain('Återställ det här');
    expect(mail.html).toContain('background:#e5833a');
    expect(mail.html).toContain('src="https://cdn.example.com/l.svg"');
  });

  it('names no vendor by default', () => {
    const mail = invitationEmail({ to: 'a@example.com', from, url });
    expect(`${mail.subject} ${mail.text} ${mail.html}`).not.toContain('Substrat');
  });

  it('leaves out a logo a mail client would block', () => {
    expect(emailBrandOf({ logoUrl: 'data:image/png;base64,AAAA', colorPrimary: '#111111' })).toEqual({ color: '#111111' });
  });
});

describe('a theme file\'s text', () => {
  const ISSUER_TEXT = JSON.stringify({ text: { sv: { 'common.signIn': 'Issuer', 'common.back': 'Backa' } } });

  it('names each wrong language, key and placeholder, and serves the rest', () => {
    const file = {
      text: {
        de: { 'common.signIn': 'Anmelden' },
        sv: {
          nope: 'x',
          'common.continueWith': 'Via {provder}',
          'common.signIn': 'Kom in',
          'common.back': '',
        },
      },
    };
    expect(themeProblems(file)).toEqual([
      'text has no language "de"; use sv or en; .sv has no key "nope"; .sv.common.continueWith uses {provder}, which nothing fills; .sv.common.back must be 1 to 500 characters',
    ]);
    expect(sanitizeTheme(file)).toEqual({ text: { sv: { 'common.signIn': 'Kom in' } } });
  });

  it('cannot reach an object\'s prototype through a key', () => {
    const file = JSON.parse('{"text":{"sv":{"__proto__":"x","constructor":"y"}}}');
    expect(sanitizeTheme(file)).toEqual({});
  });

  it('is laid over the issuer\'s entry by entry', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE oauth_client (client_id TEXT, metadata TEXT, disabled INTEGER)');
    db.prepare('INSERT INTO oauth_client VALUES (?, ?, 0)').run('rp', JSON.stringify({ theme: { text: { sv: { 'common.signIn': 'Klient' } } } }));
    const sql = { exec: (q: string, ...b: unknown[]) => ({ toArray: () => db.prepare(q).all(...(b as [])) }) } as never;
    expect(clientBranding(sql, 'rp', ISSUER_TEXT).theme.text).toEqual({ sv: { 'common.signIn': 'Klient', 'common.back': 'Backa' } });
  });

  it('is what a screen says, filling placeholders, with the built-in behind it', () => {
    expect(translate('sv', 'common.continueWith', { provider: 'BankID' }, { 'common.continueWith': 'Via {provider}' })).toBe('Via BankID');
    expect(translate('sv', 'common.back', {}, { 'common.signIn': 'x' })).toBe('Tillbaka');
  });

  it('decides the heading before the theme\'s one title', () => {
    const theme = { title: 'Acme', text: { sv: { 'common.title': 'Välkommen' } } };
    expect([themeTitle(theme, 'sv'), themeTitle(theme, 'en'), themeTitle({}, 'en')]).toEqual(['Välkommen', 'Acme', 'Substrat Auth']);
  });

  it('survives being shown in full: only what changed is stored', () => {
    const shown = withAllText({ sv: { 'common.signIn': 'Kom in' } });
    expect(shown.sv!['common.back']).toBe('Tillbaka');
    expect(shown.en!['common.signIn']).toBe('Sign in');
    expect(withoutDefaultText(shown)).toEqual({ sv: { 'common.signIn': 'Kom in' } });
  });
});
