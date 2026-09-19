/**
 * The three upstreams this relay federates to, and everything that differs between them.
 *
 * The point of the relay is that these three credentials exist ONCE, here, and that no
 * tenant ever holds one (#1544). Everything below is therefore written as "what does this
 * provider need that the others do not", because that difference is the entire reason a
 * tenant would otherwise have had to do this work themselves:
 *
 *   - **Google** is the plain case: an id_token with the claims already in it.
 *   - **GitHub** issues no id_token at all. Identity is two authenticated API reads, and
 *     the email needs judgement — a GitHub account can have several, and only one of them
 *     is both primary and verified.
 *   - **Apple** is the reason a hosted default is worth building: the client secret is an
 *     ES256 JWT minted from a `.p8` key with a six-month ceiling, so "set it and forget
 *     it" is not available to a tenant, and the person's NAME arrives once, in a form
 *     post, on the very first authorization and never again.
 *
 * Each upstream's `sub` is re-emitted unchanged, because the relay serves a separate
 * issuer per provider (`…/google`, `…/github`, `…/apple`) — the issuer is what namespaces
 * a subject in OIDC, so there is nothing to disambiguate and nothing to prefix.
 */
import { signAppleClientSecret } from './apple.js';
import { unverifiedClaims } from './jwt.js';

/** The identity the relay re-mints, whatever it had to do to learn it. */
export interface UpstreamProfile {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
}

/** What an upstream's token endpoint answers with, in the parts we read. */
interface TokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** The credentials for one upstream, as the worker env carries them. */
export interface UpstreamCredentials {
  clientId: string;
  /** Static for Google and GitHub; minted per request for Apple. */
  clientSecret: string;
  /** Apple only: the rest of what signing its client secret takes. */
  apple?: { teamId: string; keyId: string; privateKeyPem: string };
}

export interface UpstreamProvider {
  id: string;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** The scope the relay asks for: identity, and never anything else. */
  scope: string;
  /** Extra authorize params this upstream wants (Apple's `response_mode`, Google's prompt). */
  authorizeParams: Record<string, string>;
  /** Apple posts its callback as a form; the others come back as a redirect with a query. */
  callbackMethod: 'GET' | 'POST';
  clientSecretFor(credentials: UpstreamCredentials, now: number): Promise<string>;
  profileFrom(
    tokens: TokenResponse,
    fetchImpl: typeof globalThis.fetch,
    extra: { formUser?: string },
  ): Promise<UpstreamProfile>;
}

const staticSecret = async (credentials: UpstreamCredentials) => credentials.clientSecret;

/**
 * `email_verified` arrives as a boolean from Google and as the STRING "true" from Apple,
 * which is not a quirk worth spreading: a trusted-email decision on the tenant's side
 * reads this field, and `"false"` is truthy in JavaScript.
 */
function verifiedFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

const google: UpstreamProvider = {
  id: 'google',
  label: 'Google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: 'openid email profile',
  /**
   * `select_account` by default, and this is a decision rather than a default carried
   * over. Consent is remembered per (user, OAuth client), and this relay is ONE client
   * for every install — so a person who signed in to one team's app would otherwise
   * arrive at an unrelated team's app already through, with no screen at all. Forcing
   * the chooser puts the account back in front of them (#1544).
   */
  authorizeParams: { prompt: 'select_account' },
  callbackMethod: 'GET',
  clientSecretFor: staticSecret,
  async profileFrom(tokens) {
    const claims = unverifiedClaims(tokens.id_token ?? '');
    return {
      sub: String(claims.sub ?? ''),
      email: typeof claims.email === 'string' ? claims.email : undefined,
      emailVerified: verifiedFlag(claims.email_verified),
      name: typeof claims.name === 'string' ? claims.name : undefined,
      picture: typeof claims.picture === 'string' ? claims.picture : undefined,
    };
  },
};

const github: UpstreamProvider = {
  id: 'github',
  label: 'GitHub',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  /** GitHub has no `openid`; `user:email` is what makes the private address readable. */
  scope: 'read:user user:email',
  /**
   * The same reasoning as Google's, and — this is the part worth writing down — the same
   * spelling: authorization is remembered per (user, OAuth app), this app is shared by
   * every install, so without a forced screen a person who signed in at one install is
   * silently through at an unrelated one, with nothing on screen naming what they joined.
   *
   * `select_account` is the ONLY value GitHub documents for `prompt`, and it forces the
   * account picker. `consent` is OIDC's spelling, not GitHub's — GitHub does not document
   * it and drops it, which fails in the worst direction available: the authorize call
   * still succeeds, so the relay looks like it is asking for a screen while the person is
   * waved straight through. An undocumented value is not a stricter prompt, it is no
   * prompt.
   *
   * Apple is the one that cannot be given parity here: it re-shows its own screen only
   * when the person has revoked the app, and offers no parameter to ask for it. That is a
   * limit worth stating rather than leaving as an apparent oversight in this table.
   */
  authorizeParams: { prompt: 'select_account' },
  callbackMethod: 'GET',
  clientSecretFor: staticSecret,
  async profileFrom(tokens, fetchImpl) {
    const headers = {
      authorization: `Bearer ${tokens.access_token ?? ''}`,
      accept: 'application/vnd.github+json',
      // GitHub rejects an API request with no User-Agent outright.
      'user-agent': 'substrat-social-relay',
    };
    const user = (await fetchImpl('https://api.github.com/user', { headers }).then((r) =>
      r.ok ? r.json() : null,
    )) as { id?: number; login?: string; name?: string; avatar_url?: string; email?: string } | null;
    if (!user?.id) throw new Error('github: the user read returned no account');
    /**
     * The email needs its own read, and its own rule. `/user` returns the PUBLIC profile
     * address, which is frequently null and, when set, is not necessarily verified — so a
     * tenant trusting emails from this relay would be trusting an address GitHub never
     * confirmed. `/user/emails` is the authoritative list; the only address worth
     * re-emitting is the one that is both primary and verified.
     */
    const emails = (await fetchImpl('https://api.github.com/user/emails', { headers })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])) as { email?: string; primary?: boolean; verified?: boolean }[];
    const chosen = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : undefined;
    return {
      sub: String(user.id),
      email: chosen?.email,
      emailVerified: chosen ? true : undefined,
      name: user.name ?? user.login,
      picture: user.avatar_url,
    };
  },
};

const apple: UpstreamProvider = {
  id: 'apple',
  label: 'Apple',
  authorizeUrl: 'https://appleid.apple.com/auth/authorize',
  tokenUrl: 'https://appleid.apple.com/auth/token',
  scope: 'name email',
  /**
   * `form_post` is not optional: Apple refuses to return `name` or `email` to a plain
   * redirect response mode, so the callback is a POST with a form body.
   */
  authorizeParams: { response_mode: 'form_post' },
  callbackMethod: 'POST',
  async clientSecretFor(credentials, now) {
    if (!credentials.apple) throw new Error('apple: team id, key id and private key are all required');
    return signAppleClientSecret({ clientId: credentials.clientId, ...credentials.apple }, now);
  },
  async profileFrom(tokens, _fetchImpl, extra) {
    const claims = unverifiedClaims(tokens.id_token ?? '');
    /**
     * The name rides the FIRST authorization only, as a JSON form field beside the code —
     * never in the id_token, and never again on any later sign-in. A relay that drops it
     * makes every account downstream permanently nameless, so it is read here and passed
     * on; a tenant issuer that already knows the person simply ignores it.
     */
    let name: string | undefined;
    if (extra.formUser) {
      try {
        const parsed = JSON.parse(extra.formUser) as { name?: { firstName?: string; lastName?: string } };
        const parts = [parsed.name?.firstName, parsed.name?.lastName].filter(Boolean);
        if (parts.length) name = parts.join(' ');
      } catch {
        // A malformed `user` field costs a display name, never a sign-in.
      }
    }
    return {
      sub: String(claims.sub ?? ''),
      email: typeof claims.email === 'string' ? claims.email : undefined,
      emailVerified: verifiedFlag(claims.email_verified),
      name,
    };
  },
};

export const PROVIDERS: readonly UpstreamProvider[] = [google, github, apple];

export function providerOf(id: string): UpstreamProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
