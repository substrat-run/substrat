import { DurableObject } from 'cloudflare:workers';
import type { Context, Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import {
  PERSONA_ISSUER_PATH,
  personaIssuerUrl,
  scopeId as scopeIdOf,
  type ScopeId,
  type SeededPersona,
  type TenantId,
} from '@substrat-run/contracts';
import { readCookie, safePath, signEphemeral, verifyEphemeral, type OidcEnv, type SessionUser } from '@substrat-run/oidc-rp';
import { refuse } from './problem.js';

/**
 * The control plane's persona issuer (#3108): how a SEEDED preview is signed into.
 *
 * A seeded preview is a clean room holding the vertical's own sample world (`src/world.ts`), and
 * its people are the personas that world names. This is a real OpenID Connect provider for them,
 * one issuer per preview at `<control plane>/persona/<preview scope id>`, so a token minted for one
 * preview names an issuer no other preview trusts. The preview's deployment is delivered a plain
 * `substrat:auth` pointing here and does nothing a production install would not: it discovers,
 * redirects, exchanges a code and verifies an ID token against this issuer's keys.
 *
 * What makes it safe to let someone sign in as somebody else:
 *
 * - **Who may pick.** The picker answers only a person signed in to Substrat who is a member of
 *   the preview's team, read from the same identity directory the builder and the CLI read. Without
 *   that gate anyone holding a preview URL could sign in as its admin persona.
 * - **Where a persona exists.** Only in a clean-room preview: the deployment seats the world there
 *   and nowhere else (`/internal/seed-world` refuses a production scope and a fork of one), so a
 *   persona's `sub` resolves to nobody in any scope holding real data.
 * - **Whose key.** The signing key is generated in this Durable Object and never leaves it, and is
 *   used for nothing else — not the social relay's, whose key vouches for verified identities.
 * - **Which client.** One per preview: its id is the preview's scope id, and its secret is derived
 *   here from a key held here, so every push delivers the same secret and a slower, older push
 *   cannot leave a newer one holding a secret that no longer works. The callback is the one the
 *   control plane registered for the preview, compared exactly; a code is single-use, short-lived
 *   and bound to the PKCE challenge the deployment sent.
 *
 * The person who really signed in is logged with every persona sign-in (`persona-sign-in`).
 *
 * **Inside the studio's frame (#3145).** The studio shows the preview in a cross-site frame, which
 * never carries the Substrat session, and the picker refuses to be framed. So the studio vouches
 * for its signed-in person instead: over its service credential it mints a TICKET for one persona
 * of one preview, after the picker's own checks, and points the frame at `/enter?ticket=…`. That
 * spends the ticket, sets a short-lived partitioned ENTRY cookie on this issuer's path naming the
 * person and the persona, and starts the preview's own login. Its `/authorize` then spends the
 * entry, checks the team and the preview again, and redirects straight back with a code: no page
 * is rendered, so nothing of this issuer is ever framed. Both are single-use, a minute long, and
 * stored here, as codes are.
 */

const ALG = 'ES256';
/** How long a code may wait to be exchanged. The deployment exchanges at once. */
const CODE_TTL_MS = 2 * 60_000;
/** How long the picker's signed request stays good: the time to choose a person. */
const PICK_TTL_SEC = 10 * 60;
const TOKEN_TTL_SEC = 10 * 60;
/** How long a ticket, and the entry it becomes, stays good: the studio uses one at once. */
const TICKET_TTL_MS = 60_000;
/** The entry cookie `/enter` sets for `/authorize`, on this issuer's own path. */
const ENTRY_COOKIE = 'substrat_persona_entry';

const DDL = [
  'CREATE TABLE IF NOT EXISTS persona_key (id INTEGER PRIMARY KEY, kid TEXT NOT NULL, private_jwk TEXT NOT NULL, public_jwk TEXT NOT NULL, client_key TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS persona_client (scope_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, redirect_uri TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS persona_code (
    code_hash TEXT PRIMARY KEY, scope_id TEXT NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
    nonce TEXT, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  // #3145: the studio's tickets, and the entries `/enter` turns them into. Only hashes are stored.
  `CREATE TABLE IF NOT EXISTS persona_ticket (
    token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, scope_id TEXT NOT NULL, uid TEXT NOT NULL, sub TEXT NOT NULL,
    expires_at INTEGER NOT NULL)`,
];

const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of view) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const sha256 = async (value: string): Promise<string> => b64url(await crypto.subtle.digest('SHA-256', enc.encode(value)));

/** Equal strings, compared without an early exit. */
function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** A sign-in the picker settled: who, for which preview, bound to the deployment's PKCE challenge. */
export interface PersonaCodeInput {
  scopeId: ScopeId;
  persona: Pick<SeededPersona, 'sub' | 'name' | 'email'>;
  nonce: string | null;
  challenge: string;
  redirectUri: string;
}

/** A ticket the studio minted, or the entry `/enter` made of it: who, as whom, in which preview. */
export interface PersonaTicket {
  kind: 'ticket' | 'entry';
  scopeId: ScopeId;
  /** The Substrat login the studio vouched for. */
  uid: string;
  sub: string;
}

export interface PersonaExchangeInput {
  scopeId: ScopeId;
  issuer: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
}

export type PersonaExchange =
  | { ok: true; idToken: string; accessToken: string; expiresIn: number }
  | { ok: false; error: 'invalid_client' | 'invalid_grant'; description: string };

/** One Durable Object holds the whole issuer: its key, the previews' clients and the codes in flight. */
export class PersonaIssuerDO extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(async () => {
      for (const stmt of DDL) this.sql.exec(stmt);
      if (this.sql.exec('SELECT 1 FROM persona_key WHERE id = 1').toArray().length > 0) return;
      const pair = await generateKeyPair(ALG, { extractable: true });
      const kid = b64url(crypto.getRandomValues(new Uint8Array(8)));
      this.sql.exec(
        'INSERT INTO persona_key (id, kid, private_jwk, public_jwk, client_key) VALUES (1, ?, ?, ?, ?)',
        kid,
        JSON.stringify(await exportJWK(pair.privateKey)),
        JSON.stringify(await exportJWK(pair.publicKey)),
        b64url(crypto.getRandomValues(new Uint8Array(32))),
      );
    });
  }

  private keyRow(): { kid: string; private_jwk: string; public_jwk: string; client_key: string } {
    return this.sql.exec('SELECT kid, private_jwk, public_jwk, client_key FROM persona_key WHERE id = 1').one() as never;
  }

  /** The preview's client secret: an HMAC of its scope id under a key that never leaves here. */
  private async secretOf(scopeId: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', enc.encode(this.keyRow().client_key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`persona-client:${scopeId}`)));
  }

  /** The public half, as the JWKS serves it. */
  async jwks(): Promise<{ keys: JWK[] }> {
    const row = this.keyRow();
    return { keys: [{ ...(JSON.parse(row.public_jwk) as JWK), kid: row.kid, alg: ALG, use: 'sig' }] };
  }

  /** Register a preview (idempotently) and answer its client secret, the same on every call. */
  async register(scopeId: string, tenantId: string, redirectUri: string): Promise<string> {
    this.sql.exec(
      'INSERT INTO persona_client (scope_id, tenant_id, redirect_uri) VALUES (?, ?, ?) ' +
        'ON CONFLICT (scope_id) DO UPDATE SET tenant_id = excluded.tenant_id, redirect_uri = excluded.redirect_uri',
      scopeId,
      tenantId,
      redirectUri,
    );
    return await this.secretOf(scopeId);
  }

  async clientOf(scopeId: string): Promise<{ tenantId: TenantId; redirectUri: string } | null> {
    const row = this.sql.exec('SELECT tenant_id, redirect_uri FROM persona_client WHERE scope_id = ?', scopeId).toArray()[0];
    return row ? { tenantId: row.tenant_id as TenantId, redirectUri: row.redirect_uri as string } : null;
  }

  /** Mint a single-use code for a settled pick. Only its hash is stored. */
  async issueCode(input: PersonaCodeInput): Promise<string> {
    const now = Date.now();
    this.sql.exec('DELETE FROM persona_code WHERE expires_at <= ?', now);
    const code = b64url(crypto.getRandomValues(new Uint8Array(32)));
    this.sql.exec(
      'INSERT INTO persona_code (code_hash, scope_id, sub, name, email, nonce, challenge, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      await sha256(code),
      input.scopeId,
      input.persona.sub,
      input.persona.name,
      input.persona.email,
      input.nonce,
      input.challenge,
      input.redirectUri,
      now + CODE_TTL_MS,
    );
    return code;
  }

  /** Mint a single-use ticket or entry. Only its hash is stored. */
  async issueTicket(input: PersonaTicket, ttlMs: number): Promise<string> {
    const now = Date.now();
    this.sql.exec('DELETE FROM persona_ticket WHERE expires_at <= ?', now);
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    this.sql.exec(
      'INSERT INTO persona_ticket (token_hash, kind, scope_id, uid, sub, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      await sha256(token),
      input.kind,
      input.scopeId,
      input.uid,
      input.sub,
      now + ttlMs,
    );
    return token;
  }

  /** Spend a ticket or entry: null unless it is of this kind, for this preview, and unexpired. */
  async redeemTicket(kind: PersonaTicket['kind'], scopeId: ScopeId, token: string): Promise<{ uid: string; sub: string } | null> {
    // Spent on the first try whatever it finds, as a code is.
    const row = this.sql.exec('DELETE FROM persona_ticket WHERE token_hash = ? RETURNING *', await sha256(token)).toArray()[0];
    if (!row || row.kind !== kind || row.scope_id !== scopeId || (row.expires_at as number) <= Date.now()) return null;
    return { uid: row.uid as string, sub: row.sub as string };
  }

  /** Exchange a code for the persona's tokens: client, callback, PKCE and expiry, then sign. */
  async exchange(input: PersonaExchangeInput): Promise<PersonaExchange> {
    if (!this.sql.exec('SELECT 1 FROM persona_client WHERE scope_id = ?', input.scopeId).toArray().length ||
        !timingSafeEqual(input.clientSecret, await this.secretOf(input.scopeId))) {
      return { ok: false, error: 'invalid_client', description: 'unknown client, or a wrong secret' };
    }
    // Spent on the first try whatever it finds: a code is single-use.
    const row = this.sql.exec('DELETE FROM persona_code WHERE code_hash = ? RETURNING *', await sha256(input.code)).toArray()[0];
    const grant = (description: string): PersonaExchange => ({ ok: false, error: 'invalid_grant', description });
    if (!row || (row.expires_at as number) <= Date.now()) return grant('the code is invalid or has expired');
    if (row.scope_id !== input.scopeId) return grant('the code was issued to another client');
    if (row.redirect_uri !== input.redirectUri) return grant('redirect_uri does not match the code');
    if ((await sha256(input.verifier)) !== row.challenge) return grant('PKCE verification failed');

    const key = this.keyRow();
    const signing = await importJWK(JSON.parse(key.private_jwk) as JWK, ALG);
    const base = {
      email: row.email as string,
      // A persona's address is the sample world's own, asserted by the world and by nobody else:
      // verified here so the door joins them and an invite to it admits them, as locally.
      email_verified: true,
      name: row.name as string,
    };
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: ALG, kid: key.kid, typ: 'JWT' })
        .setIssuer(input.issuer)
        .setSubject(row.sub as string)
        .setAudience(input.scopeId)
        .setIssuedAt()
        .setExpirationTime(`${TOKEN_TTL_SEC}s`)
        .sign(signing);
    const [idToken, accessToken] = await Promise.all([
      sign({ ...base, ...(row.nonce ? { nonce: row.nonce } : {}) }),
      sign({ ...base, typ: 'access' }),
    ]);
    return { ok: true, idToken, accessToken, expiresIn: TOKEN_TTL_SEC };
  }
}

type IssuerStub = Pick<PersonaIssuerDO, 'jwks' | 'register' | 'clientOf' | 'issueCode' | 'exchange' | 'issueTicket' | 'redeemTicket'>;

/** What the routes need from the control plane around them. */
export interface PersonaIssuerDeps<E> {
  stub(env: E): IssuerStub;
  /** The control plane's public origin, which every issuer URL is under. */
  origin(env: E): string | undefined;
  /** Signs the picker's request and reads the Substrat session. */
  oidc(env: E): OidcEnv;
  session(env: E, headers: Headers): Promise<SessionUser | null>;
  isMember(env: E, user: SessionUser, tenantId: TenantId): Promise<boolean>;
  /** The personas an ACTIVE clean-room preview offers, or null when it is not one (gone, a fork, not a preview). */
  personas(env: E, tenantId: TenantId, scopeId: ScopeId): Promise<SeededPersona[] | null>;
  /** Whether the preview is still an active clean-room preview — asked again at the exchange. */
  active(env: E, tenantId: TenantId, scopeId: ScopeId): Promise<boolean>;
  /** Whether the request carries the studio's service credential: who may vouch for a login (#3145). */
  service(env: E, request: Request): Promise<boolean>;
  /** How long a ticket and its entry stay good. Defaults to a minute. */
  ticketTtlMs?: number;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1c1c1a}
main{max-width:420px;margin:10vh auto;padding:0 16px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 20px;color:#5c5c58}
form{margin:0 0 8px}button{width:100%;text-align:left;padding:12px 14px;border:1px solid #d8d8d2;border-radius:8px;background:#fff;font:inherit;cursor:pointer}
button:hover{border-color:#8a8a84}small{display:block;color:#6c6c66}
@media (prefers-color-scheme:dark){body{background:#161615;color:#ececea}p,small{color:#a3a39e}button{background:#1f1f1d;border-color:#3a3a37;color:inherit}}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'no-referrer',
    },
  });
}

/** An authorize request, as the picker signs it so the POST that settles it cannot be altered. */
interface PickRequest {
  scope: string;
  uid: string;
  ru: string;
  st: string | null;
  n: string | null;
  cc: string;
}

/** Where the studio reads a preview's personas and mints a ticket, over its service credential (#3145). */
export const STUDIO_PERSONA_PATH = '/internal/builder/persona';
/** Where a deployed vertical begins its login (vertical-auth's fixed path), which `/enter` starts. */
const VERTICAL_LOGIN_PATH = '/api/auth/login';

/** The entry cookie: partitioned, so it lives only inside the studio's frame, and on this issuer's path alone. */
const entryCookie = (scope: ScopeId, value: string, maxAgeSec: number): string =>
  `${ENTRY_COOKIE}=${value}; Path=${PERSONA_ISSUER_PATH}/${scope}; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=None; Partitioned`;

/**
 * Mount the issuer at `/persona/:scope/…`: discovery, JWKS, the picker (`/authorize`), the code
 * exchange (`/token`) and the studio's door into its frame (`/enter`). Nothing here is under `/api`,
 * so no staff gate applies; each route decides who it answers itself.
 */
export function mountPersonaIssuer<E extends object>(app: Hono<{ Bindings: E }>, deps: PersonaIssuerDeps<E>): void {
  const base = `${PERSONA_ISSUER_PATH}/:scope`;
  const ticketTtlMs = deps.ticketTtlMs ?? TICKET_TTL_MS;
  const scopeOf = (c: Context<{ Bindings: E }>): ScopeId | null => {
    const parsed = scopeIdOf.safeParse(c.req.param('scope'));
    return parsed.success ? parsed.data : null;
  };
  const issuerOf = (c: Context<{ Bindings: E }>, scope: ScopeId): string | null => {
    const origin = deps.origin(c.env);
    return origin ? personaIssuerUrl(origin, scope) : null;
  };

  app.get(`${base}/.well-known/openid-configuration`, (c) => {
    const scope = scopeOf(c);
    const issuer = scope && issuerOf(c, scope);
    if (!issuer) return c.json({ error: 'not_found' }, 404);
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [ALG],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['sub', 'name', 'email', 'email_verified'],
    });
  });

  app.get(`${base}/jwks`, async (c) => {
    if (!scopeOf(c)) return c.json({ error: 'not_found' }, 404);
    c.header('cache-control', 'public, max-age=300');
    return c.json(await deps.stub(c.env).jwks());
  });

  /**
   * Everything both halves of the picker check, in order: the request names this preview's own
   * client and callback, a Substrat session is present (or the browser is sent to sign in), its
   * person is on the preview's team, and the preview is still an active clean room.
   *
   * With an `entry` (#3145), the person is the one the studio vouched for, and the persona is
   * the one they chose there (`pinned`), in place of the session the studio's frame never carries.
   * The entry is spent here, whatever follows.
   */
  const gate = async (
    c: Context<{ Bindings: E }>,
    req: { clientId: string; redirectUri: string },
    entry?: string,
  ): Promise<Response | { scope: ScopeId; user: SessionUser; personas: SeededPersona[]; redirectUri: string; pinned: string | null }> => {
    const scope = scopeOf(c);
    const client = scope ? await deps.stub(c.env).clientOf(scope) : null;
    if (!scope || !client) return page('Not found', '<h1>No such preview</h1><p>This sign-in page belongs to no preview.</p>', 404);
    if (req.clientId !== scope || req.redirectUri !== client.redirectUri) {
      // Never redirected: a callback that is not the preview's own is not trusted with an error either.
      return page('Bad request', '<h1>This sign-in request is not valid</h1><p>Open the preview again and sign in from there.</p>', 400);
    }
    let user: SessionUser | null;
    let pinned: string | null = null;
    if (entry) {
      const entered = await deps.stub(c.env).redeemTicket('entry', scope, entry);
      if (!entered) return page('Expired', '<h1>This sign-in has expired</h1><p>Choose who to sign in as again.</p>', 400);
      user = { id: entered.uid };
      pinned = entered.sub;
    } else {
      user = await deps.session(c.env, c.req.raw.headers);
      if (!user?.id) {
        const back = safePath(new URL(c.req.url).pathname + new URL(c.req.url).search) ?? '/';
        return c.redirect(`/api/auth/login?returnTo=${encodeURIComponent(back)}`);
      }
    }
    if (!(await deps.isMember(c.env, user, client.tenantId))) {
      return page('Not on this team', '<h1>You are not on this preview\'s team</h1><p>Only a member of the team that owns this preview can sign in to it.</p>', 403);
    }
    const personas = await deps.personas(c.env, client.tenantId, scope);
    if (!personas) return page('Gone', '<h1>This preview is gone</h1><p>It was deleted or replaced. Run it again.</p>', 410);
    return { scope, user, personas, redirectUri: client.redirectUri, pinned };
  };

  /** Settle a sign-in: a single-use code for `persona`, logged beside the person really there, and back to the callback. */
  const settle = async (
    c: Context<{ Bindings: E }>,
    passed: { scope: ScopeId; user: SessionUser; redirectUri: string },
    persona: SeededPersona,
    req: { nonce: string | null; challenge: string; state: string | null },
    via?: 'ticket',
  ): Promise<Response> => {
    const code = await deps.stub(c.env).issueCode({ scopeId: passed.scope, persona, nonce: req.nonce, challenge: req.challenge, redirectUri: passed.redirectUri });
    // The person who was really there, beside who they chose to be.
    console.log(JSON.stringify({ host: 'persona-sign-in', scopeId: passed.scope, persona: persona.sub, user: passed.user.id, ...(via ? { via } : {}) }));
    const back = new URL(passed.redirectUri);
    back.searchParams.set('code', code);
    if (req.state) back.searchParams.set('state', req.state);
    back.searchParams.set('iss', issuerOf(c, passed.scope)!);
    return c.redirect(back.toString(), 302);
  };

  app.get(`${base}/authorize`, async (c) => {
    const q = c.req.query();
    const entry = readCookie(c.req.header('cookie'), ENTRY_COOKIE);
    const passed = await gate(c, { clientId: q.client_id ?? '', redirectUri: q.redirect_uri ?? '' }, entry);
    if (passed instanceof Response) return passed;
    if (q.response_type !== 'code' || !q.code_challenge || q.code_challenge_method !== 'S256') {
      return page('Bad request', '<h1>This sign-in request is not valid</h1><p>It must ask for a code, with a PKCE S256 challenge.</p>', 400);
    }
    if (passed.pinned) {
      // #3145: chosen in the studio, so no picker: the code, and straight back, with nothing rendered in its frame.
      const persona = passed.personas.find((p) => p.sub === passed.pinned);
      if (!persona) return page('Not found', '<h1>That person is not in this preview</h1>', 400);
      c.header('set-cookie', entryCookie(passed.scope, '', 0));
      return await settle(c, passed, persona, { nonce: q.nonce ?? null, challenge: q.code_challenge, state: q.state ?? null }, 'ticket');
    }
    const request = await signEphemeral(
      deps.oidc(c.env),
      { typ: 'persona-pick', scope: passed.scope, uid: passed.user.id, ru: passed.redirectUri, st: q.state ?? null, n: q.nonce ?? null, cc: q.code_challenge } satisfies PickRequest & { typ: string },
      PICK_TTL_SEC,
    );
    const action = `${PERSONA_ISSUER_PATH}/${passed.scope}/authorize`;
    const people = passed.personas
      .map(
        (p) => `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="request" value="${escapeHtml(request)}">` +
          `<input type="hidden" name="sub" value="${escapeHtml(p.sub)}"><button type="submit">${escapeHtml(p.name)}` +
          `<small>${escapeHtml([p.note ?? p.role, p.email].filter(Boolean).join(' · '))}</small></button></form>`,
      )
      .join('');
    return page(
      'Sign in as',
      `<h1>Sign in as…</h1><p>This preview holds the app's sample world. Pick who to be; you can sign out and pick someone else.</p>` +
        (people || '<p>This preview\'s sample world has nobody in it.</p>'),
    );
  });

  app.post(`${base}/authorize`, async (c) => {
    // Same origin only: the picker posts to itself, and nothing else may settle a pick.
    const origin = deps.origin(c.env);
    if (!origin || c.req.header('origin') !== new URL(origin).origin) {
      return page('Forbidden', '<h1>This sign-in did not come from the picker</h1>', 403);
    }
    const form = await c.req.parseBody();
    const field = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');
    const signed = (await verifyEphemeral(deps.oidc(c.env), field('request'))) as (PickRequest & { typ?: string }) | null;
    if (!signed || signed.typ !== 'persona-pick' || signed.scope !== c.req.param('scope')) {
      return page('Expired', '<h1>This sign-in has expired</h1><p>Open the preview again and sign in from there.</p>', 400);
    }
    const passed = await gate(c, { clientId: signed.scope, redirectUri: signed.ru });
    if (passed instanceof Response) return passed;
    if (passed.user.id !== signed.uid) return page('Expired', '<h1>You signed in as someone else meanwhile</h1><p>Open the preview again.</p>', 400);
    const persona = passed.personas.find((p) => p.sub === field('sub'));
    if (!persona) return page('Not found', '<h1>That person is not in this preview</h1>', 400);

    return await settle(c, passed, persona, { nonce: signed.n, challenge: signed.cc, state: signed.st });
  });

  /**
   * #3145: the studio's frame lands here with a ticket. Spend it, leave the entry `/authorize`
   * reads, and start the preview's own login, which comes back to `/authorize`. Only a redirect:
   * nothing of this issuer is rendered in the frame.
   */
  app.get(`${base}/enter`, async (c) => {
    const scope = scopeOf(c);
    const client = scope ? await deps.stub(c.env).clientOf(scope) : null;
    if (!scope || !client) return page('Not found', '<h1>No such preview</h1><p>This sign-in page belongs to no preview.</p>', 404);
    const ticket = await deps.stub(c.env).redeemTicket('ticket', scope, c.req.query('ticket') ?? '');
    if (!ticket) return page('Expired', '<h1>This sign-in has expired</h1><p>Choose who to sign in as again.</p>', 400);
    const entry = await deps.stub(c.env).issueTicket({ kind: 'entry', scopeId: scope, uid: ticket.uid, sub: ticket.sub }, ticketTtlMs);
    c.header('set-cookie', entryCookie(scope, entry, Math.ceil(ticketTtlMs / 1000)));
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.redirect(new URL(VERTICAL_LOGIN_PATH, client.redirectUri).toString(), 302);
  });

  /**
   * #3145: what the studio asks as its signed-in person (`externalId`, the OIDC subject its own
   * session verified), over its service credential: the picker's checks, without the picker.
   */
  const vouched = async (
    c: Context<{ Bindings: E }>,
  ): Promise<Response | { scope: ScopeId; user: SessionUser; personas: SeededPersona[]; body: { sub?: unknown } }> => {
    if (!(await deps.service(c.env, c.req.raw))) return refuse('forbidden', 'service token required');
    const scope = scopeOf(c);
    const client = scope ? await deps.stub(c.env).clientOf(scope) : null;
    if (!scope || !client) return refuse('not_found', 'no seeded preview has this scope id');
    const body = (await c.req.json().catch(() => ({}))) as { externalId?: unknown; sub?: unknown };
    if (typeof body.externalId !== 'string' || body.externalId === '') {
      return refuse('validation_failed', 'externalId (the OIDC subject) is required');
    }
    const user: SessionUser = { id: body.externalId };
    if (!(await deps.isMember(c.env, user, client.tenantId))) return refuse('forbidden', "only a member of the preview's team can sign in to it");
    const personas = await deps.personas(c.env, client.tenantId, scope);
    if (!personas) return refuse('not_found', 'this preview is gone: it was deleted or replaced');
    return { scope, user, personas, body };
  };

  app.post(`${STUDIO_PERSONA_PATH}/:scope/personas`, async (c) => {
    const passed = await vouched(c);
    if (passed instanceof Response) return passed;
    return c.json({ personas: passed.personas });
  });

  app.post(`${STUDIO_PERSONA_PATH}/:scope/ticket`, async (c) => {
    const passed = await vouched(c);
    if (passed instanceof Response) return passed;
    const persona = passed.personas.find((p) => p.sub === passed.body.sub);
    if (!persona) return refuse('validation_failed', 'that person is not in this preview');
    const issuer = issuerOf(c, passed.scope);
    if (!issuer) return refuse('not_found', 'this control plane has no public origin to sign in at');
    const ticket = await deps.stub(c.env).issueTicket({ kind: 'ticket', scopeId: passed.scope, uid: passed.user.id, sub: persona.sub }, ticketTtlMs);
    console.log(JSON.stringify({ host: 'persona-ticket', scopeId: passed.scope, persona: persona.sub, user: passed.user.id }));
    return c.json({ url: `${issuer}/enter?ticket=${encodeURIComponent(ticket)}`, expiresIn: Math.ceil(ticketTtlMs / 1000) });
  });

  app.post(`${base}/token`, async (c) => {
    const fail = (error: string, description: string, status: 400 | 401 = 400) =>
      c.json({ error, error_description: description }, status, { 'cache-control': 'no-store' });
    const scope = scopeOf(c);
    const issuer = scope && issuerOf(c, scope);
    if (!scope || !issuer) return fail('invalid_client', 'no such issuer', 401);
    const form = await c.req.parseBody();
    const field = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');
    let clientId = field('client_id');
    let clientSecret = field('client_secret');
    const basic = /^basic (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (basic) {
      const [id, secret] = atob(basic).split(':').map((p) => decodeURIComponent(p ?? ''));
      clientId = id ?? '';
      clientSecret = secret ?? '';
    }
    if (field('grant_type') !== 'authorization_code') return fail('unsupported_grant_type', 'only authorization_code is supported');
    if (clientId !== scope || !clientSecret) return fail('invalid_client', 'the client is this preview, with its secret', 401);
    const client = await deps.stub(c.env).clientOf(scope);
    if (!client || !(await deps.active(c.env, client.tenantId, scope))) return fail('invalid_grant', 'this preview is gone');
    const out = await deps.stub(c.env).exchange({
      scopeId: scope,
      issuer,
      clientSecret,
      code: field('code'),
      redirectUri: field('redirect_uri'),
      verifier: field('code_verifier'),
    });
    if (!out.ok) return fail(out.error, out.description, out.error === 'invalid_client' ? 401 : 400);
    return c.json(
      { token_type: 'Bearer', expires_in: out.expiresIn, id_token: out.idToken, access_token: out.accessToken, scope: 'openid email profile' },
      200,
      { 'cache-control': 'no-store' },
    );
  });
}
