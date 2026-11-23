import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { SqlExec } from './introspect.js';
import { ISSUER_THEME, clientBranding } from './branding.js';
import { clientIdOrConsole } from './console-client.js';
import { ISSUER_LOCALE, LOCALE_COOKIE, cookieValue, issuerLocale, resolveLocale } from './locale-wire.js';
import { isPlaceholderAddress } from './placeholder-address.js';
import { ALLOW_SIGNUP, isTruthy } from './settings.js';
import { clientSignIn } from './sign-in-policy.js';
import { SCREENS, imageOrigins, pageVariables, readPageTemplate, type PageVariables, type ScreenName } from './page-template.js';

/**
 * What one hosted page needs to be drawn inside the install's template (#3350): the template,
 * and the variables for THIS request. Read inside the issuer (it needs the issuer's SQLite, its
 * signing secret and the session), rendered by the caller.
 *
 * The screen and the language are decided the way the sign-in app decides them, from the same
 * inputs, so `prompt.screen.name` names the screen the person is actually shown.
 */

/** The header the worker names the page's path in, on its `/__page-template` read. */
export const PAGE_PATH_HEADER = 'x-substrat-page-path';

/** The parts of the page request this reads. */
export interface PageRequest {
  path: string;
  /** The query string, without its `?`. */
  search: string;
  cookie: string | null;
  acceptLanguage: string | null;
}

export interface PageTemplateDeps {
  sql: SqlExec;
  cfg: Record<string, string | undefined>;
  /** The secret the authorize request is signed with (Better Auth's). */
  secret(): Promise<string>;
  /** The signed-in person behind the request's cookies, or null. */
  user(): Promise<{ id: string; name: string | null; email: string | null } | null>;
  /** The sign-in buttons this issuer offers (the same list the screens are drawn from). */
  offeredProviders(): { id: string; label: string }[];
  /** The install's name, where the platform recorded one. */
  tenantName: string | null;
}

export type PageTemplateAnswer =
  | { template: null }
  | { template: string; variables: PageVariables; imageOrigins: string[] };

/** The plugin's name for the list of parameters a signature covers (as `app/src/api.ts`). */
const SIGNED_PARAM_NAMES = 'ba_param';

/**
 * The authorize request carried by the page's query: exactly the parameters its signature covers
 * (a refused upstream sign-in appends `error=…` to the address), as `pendingOAuthQuery` in the
 * app reads it. Null when there is none.
 */
export function signedQueryOf(params: URLSearchParams): string | null {
  if (!params.has('sig')) return null;
  const covered = new Set(params.getAll(SIGNED_PARAM_NAMES));
  if (!covered.size) return null;
  const signed = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key === 'sig' || key === SIGNED_PARAM_NAMES || covered.has(key)) signed.append(key, value);
  }
  return signed.toString();
}

/** The language tags an `Accept-Language` header names, most preferred first. */
export function acceptedLanguages(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = Number(params.map((p) => p.trim()).find((p) => p.startsWith('q='))?.slice(2) ?? '1');
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((l) => l.tag && l.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((l) => l.tag);
}

export async function pageTemplateFor(deps: PageTemplateDeps, request: PageRequest): Promise<PageTemplateAnswer> {
  const template = readPageTemplate(deps.sql);
  if (template === null) return { template: null };
  const params = new URLSearchParams(request.search);
  const oauthQuery = signedQueryOf(params);
  const forOidc = oauthQuery !== null;
  const queryClientId = forOidc ? params.get('client_id') : null;

  // The theme the app paints with: the relying party's mid-authorize, the console's own (the
  // issuer's) otherwise — `clientBranding` is public, so no signature is needed to read it.
  const { theme } = clientBranding(deps.sql, clientIdOrConsole(queryClientId), deps.cfg[ISSUER_THEME]);

  // The application is NAMED only inside a request this issuer signed and that has not expired:
  // a page that printed the name for any `client_id` would be the registry probe the plugin's
  // own pre-login endpoint refuses to be.
  const verified = oauthQuery !== null && queryClientId !== null && (await verifyOAuthQueryParams(oauthQuery, await deps.secret()));
  const application = verified ? clientRow(deps.sql, queryClientId!) : null;

  const user = await deps.user();
  const screen = screenOf(request.path, params, {
    signedIn: user !== null,
    consentable: verified,
    signUpOpen: isTruthy(deps.cfg[ALLOW_SIGNUP]) && clientSignIn(deps.sql, clientIdOrConsole(queryClientId), deps.offeredProviders()).password,
  });
  if (!screen) return { template: null };

  const locale = resolveLocale({
    uiLocales: params.get('ui_locales'),
    cookie: cookieValue(request.cookie, LOCALE_COOKIE),
    browser: acceptedLanguages(request.acceptLanguage),
    issuerDefault: issuerLocale(deps.cfg[ISSUER_LOCALE]),
    allowed: theme.languages,
  });

  const picture = user ? userPicture(deps.sql, user.id) : null;
  const variables = pageVariables({
    screen,
    locale,
    application,
    theme,
    tenantName: deps.tenantName,
    user: user
      ? { name: user.name, email: user.email && !isPlaceholderAddress(user.email) ? user.email : null, picture }
      : null,
  });
  return { template, variables, imageOrigins: imageOrigins(variables) };
}

/**
 * The screen the app will draw for this path, mirroring `App.tsx`: sign-up only where it was
 * asked for and is open to this client, consent only with a session and a valid request, a reset
 * only with its token. Null for a path no template wraps.
 */
export function screenOf(
  path: string,
  params: URLSearchParams,
  state: { signedIn: boolean; consentable: boolean; signUpOpen: boolean },
): ScreenName | null {
  switch (path) {
    case SCREENS.login.path:
    case SCREENS.signup.path: {
      const asked = path === SCREENS.signup.path || params.get('screen_hint') === 'signup';
      return asked && state.signUpOpen && !params.has('social_error') ? 'signup' : 'login';
    }
    case SCREENS.consent.path:
      return state.signedIn && state.consentable ? 'consent' : 'login';
    case SCREENS['reset-password'].path:
      return params.get('token') ? 'reset-password' : 'login';
    case SCREENS['accept-invitation'].path:
      return 'accept-invitation';
    case SCREENS['github-email'].path:
      return 'github-email';
    default:
      return null;
  }
}

function clientRow(sql: SqlExec, clientId: string): { clientId: string; name: string | null; icon: string | null; metadata: unknown } | null {
  const row = sql
    .exec('SELECT client_id, name, icon, metadata, disabled FROM oauth_client WHERE client_id = ?', clientId)
    .toArray()[0] as { client_id: string; name: string | null; icon: string | null; metadata: string | null; disabled: number | null } | undefined;
  if (!row || row.disabled) return null;
  let metadata: unknown = null;
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : null;
  } catch {
    metadata = null;
  }
  return { clientId: row.client_id, name: row.name, icon: row.icon, metadata };
}

function userPicture(sql: SqlExec, userId: string): string | null {
  const row = sql.exec('SELECT image FROM user WHERE id = ?', userId).toArray()[0] as { image: string | null } | undefined;
  return row?.image ?? null;
}
