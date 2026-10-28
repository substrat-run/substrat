import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import type { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { oauthProvider, type ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { cimd } from '@better-auth/cimd';
import { jwt } from 'better-auth/plugins/jwt';
import { admin } from 'better-auth/plugins/admin';
import { genericOAuth, type GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
import type { EmailAddress, EmailTransport } from '@substrat-run/adapter-email';
import { TOKEN_EXCHANGE_GRANT_TYPE } from '@substrat-run/contracts';
import { resetPasswordEmail, verifyEmail } from './email.js';
import { legacyAwarePassword } from './legacy-password.js';
import { invitationPlugin } from './invitation-plugin.js';
import { phonePlugin } from './phone-plugin.js';
import type { PhoneVerifier } from './twilio.js';
import { bankidPlugin, type BankIdPluginOptions } from './bankid-plugin.js';
import { supabasePlugin, type SupabaseBridgeOptions } from './supabase-plugin.js';
import { policyAdmits, signInMethodOfPath, type SignInPolicy } from './sign-in-policy.js';
import { USER_DELEGATED_SCOPES } from './settings.js';
import { basicCredentialsOf } from './token-exchange.js';
import { diagnoseSignInCallback, recordSignInException, signInDiagnosticDescription } from './sign-in-diagnostics.js';
import {
  authorityOf,
  callbackProviderOf,
  clientIdOfSignedQuery,
  correlationOfState,
  errorOfRedirect,
  refusalOf,
  stateOfAuthorizationUrl,
  type SignInLogger,
} from './sign-in-log.js';

/**
 * The Better Auth instance that IS this standalone OIDC provider. Runtime-agnostic: the
 * caller supplies the database (a `drizzleAdapter` over a Durable Object's SQLite in the
 * worker, or over better-sqlite3 in the Node dev server) and the email transport, so this
 * one config is the single source of truth for how the issuer behaves in every runtime.
 *
 * Plugins, in order:
 *   - `jwt`           — asymmetric signing keys (JWKS at `/api/auth/jwks`); id_tokens are
 *                       verifiable by any relying party from the public key, never a shared
 *                       secret. This is what makes the issuer consumable by external apps.
 *                       `oauthProvider` REQUIRES it, so it comes first.
 *   - `oauthProvider` — the OAuth 2.1 / OIDC surface: discovery, `/oauth2/authorize`,
 *                       `/oauth2/token`, `/oauth2/userinfo`, introspection, revocation,
 *                       end-session, consent, and the client registry.
 *   - `admin`         — user management API (list/create/ban/role/impersonate) + the `admin`
 *                       role the dashboard gates on. The dashboard signs in HERE (the issuer
 *                       is its own first relying party) and is admin-gated by this role.
 *
 * This was `oidcProvider` from better-auth core until 1.7 removed it (deprecated since 1.6).
 * The replacement is a different plugin, not a rename — six tables instead of three, and a
 * different contract with the pages it redirects to. See `spec/concept.md` for what changed
 * on the wire; the schema is now GENERATED from the plugin's own declarations rather than
 * hand-kept in step (`scripts/gen-schema.mts`).
 */

/** The database argument Better Auth's drizzle adapter accepts — kept structural so this
 *  module imports no runtime-specific (node-only) drizzle driver types. */
export type AuthDatabase = ReturnType<typeof drizzleAdapter>;

export interface AuthDeps {
  /** `drizzleAdapter(db, { provider: 'sqlite', schema })` — built by the caller. */
  database: AuthDatabase;
  /** The session-signing / private-key-encryption secret (per-instance, persisted). */
  secret: string;
  /** The canonical issuer origin — Better Auth's baseURL; discovery/token URLs derive from it. */
  baseURL: string;
  /** Origins allowed to drive sign-in (the app itself, plus any first-party surface). */
  trustedOrigins: string[];
  /** The resolved email transport (Cloudflare in prod, mock in dev/tests). */
  transport: EmailTransport;
  /** The sender address for password-reset / verification mail. */
  sender: EmailAddress;
  /**
   * How CIMD fetches a client's metadata document — injected, because the guarantee it has
   * to make is runtime-specific and this module is runtime-agnostic.
   *
   * The Node dev server passes `@better-auth/cimd/node`, which resolves DNS once and pins
   * the answer. The Durable Object passes `src/cimd-fetch.ts`, which cannot (workerd has no
   * DNS API) and says so. Omit it and CIMD is simply not mounted — an issuer with no way to
   * fetch a document safely must not advertise that it will.
   */
  fetchClientMetadataResource?: ClientMetadataResourceFetch;
  /**
   * May a visitor create their own account? Off unless an operator turns it on (the
   * `ALLOW_SIGNUP` key, settable from the dashboard's Sign-in panel). Off, Better Auth
   * refuses `/sign-up/email` at the endpoint — the SPA hides the screen, and this is what
   * makes hiding it more than decoration. Administrators can always create accounts
   * through the admin API regardless.
   */
  allowSignup?: boolean;
  /**
   * The UPSTREAM providers this issuer federates to, built from the `identity_provider` rows
   * by `socialProvidersFrom` — "sign in with Microsoft", enabled by an operator rather than
   * by a deploy. Undefined when none is configured, which is not the same as `{}`: an issuer
   * with no upstream must not advertise one.
   */
  socialProviders?: BetterAuthOptions['socialProviders'];
  /**
   * The upstream providers whose verified email is accepted as proof that the person IS the
   * local account holding that address. Empty by default, and the panel is where an operator
   * says otherwise per provider — see `trustedProvidersFrom`.
   */
  trustedProviders?: string[];
  /**
   * The GENERIC OIDC upstreams — operator-named providers whose endpoints come from their
   * issuer's discovery document, built from the same `identity_provider` rows by
   * `genericProvidersFrom`. Mounted through Better Auth's `genericOAuth` plugin, which
   * registers them as first-class social providers: same `/sign-in/social`, same
   * `/callback/{id}`, and therefore the same `oauth_query` authorize-resume as the catalogue
   * providers. Undefined when none is configured — the plugin is then not mounted at all.
   */
  genericProviders?: GenericOAuthConfig[];
  /**
   * Whether an upstream sign-in may JOIN a local account that already holds the same email
   * address, without anyone being asked. True unless an operator says otherwise — see
   * `accountLinkingMode` in `src/settings.ts` for the two values and why there is no third.
   *
   * False does not disable linking, only the IMPLICIT kind: connecting a provider from inside
   * a session still works, and is the path the refusal names. A session proves the account; a
   * matching address does not.
   */
  autoLinkAccounts?: boolean;
  /**
   * The Supabase LEGACY-secret bridge (`src/supabase-plugin.ts`), mounted only when an
   * operator has configured both halves. Absent, the endpoint does not exist — the same
   * honesty CIMD and BankID keep about a flow that could not finish.
   *
   * Not an alternative to the `supabase` entry in the sign-in providers catalogue but a
   * fallback for the case that entry cannot serve: a project still on the shared HS256 secret,
   * whose OAuth 2.1 server refuses to mint the id_token the redirect flow needs.
   */
  supabase?: SupabaseBridgeOptions;
  /**
   * BankID sign-in (`src/bankid.ts` / `src/bankid-plugin.ts`), mounted only when the caller
   * has both a stored configuration AND a runtime able to present the mTLS client
   * certificate — the Node dev server always, the worker only with an mTLS binding. Absent,
   * the endpoints do not exist, which is the honest version of a flow that could not finish.
   */
  bankid?: BankIdPluginOptions;
  phoneVerifier?: PhoneVerifier;
  /**
   * One relying party's sign-in policy, by client id (`src/sign-in-policy.ts`) — read from
   * the registry by the caller, on the same per-request basis as everything else here, so an
   * operator narrowing a client decides the very next authorize request.
   *
   * A callback rather than the rows, because this module is runtime-agnostic and the two
   * stores are not: the Durable Object reads its own SQLite, the dev server reads
   * better-sqlite3. Undefined ⇒ no client is restricted, and the hook below never runs.
   */
  signInPolicyFor?: (clientId: string) => SignInPolicy | undefined;
  /**
   * Record one federated sign-in hop (`src/sign-in-log.ts`) — what makes a refused Microsoft
   * sign-in a row an operator can read instead of a sentence in somebody else's browser.
   *
   * A callback for the same reason `signInPolicyFor` is one: this module is runtime-agnostic
   * and the two stores are not. Undefined ⇒ nothing is recorded and the hook below does not
   * run, which is what the schema-generation config and a test that does not care pass.
   */
  recordSignIn?: SignInLogger;
  /**
   * Where work that must not hold up a RESPONSE goes — Better Auth's
   * `advanced.backgroundTasks.handler`.
   *
   * This is not an optimisation. Better Auth awaits a new user's verification email INLINE
   * unless this is set (`runInBackgroundOrAwait`: with no handler, `else await promise`), and
   * for a federated sign-up that await sits in the middle of the browser's redirect chain —
   * `/callback/:id` has not answered yet, so the person is looking at a page that is still
   * loading while two more services decide how long the mail takes. On this issuer both
   * conditions that trigger it hold: `emailVerification.sendOnSignUp` is on, and Entra does not
   * publish `email_verified`, which Better Auth maps to `false` — so EVERY brand-new Microsoft
   * user paid for it and no returning one did. That asymmetry is what it looks like from the
   * outside: sign-in works, except for people who have never signed in before.
   *
   * Undefined ⇒ Better Auth awaits, which is what the tests want: a suite asserting that a
   * verification mail was sent must not race the assertion against a floating promise. So the
   * runtimes opt in and the tests stay deterministic.
   */
  runInBackground?: (promise: Promise<unknown>) => void;
  /**
   * Whether this runtime answers RFC 8693 token exchange at the token endpoint (#1824). The
   * plugin implements none of it: the worker routes the grant to the Durable Object's
   * `/__token-exchange`, and the Node dev server mounts nothing (it has no `/internal/configure`,
   * so no delegation could exist there). Discovery describes the runtime it is served from, so
   * only the DO sets this, and anything else leaves the grant out of `grant_types_supported`.
   */
  servesTokenExchange?: boolean;
  /**
   * The scopes a machine client (`client_credentials`) may hold — `MACHINE_SCOPES`, already
   * parsed by `machineScopesOf`, so a refused value arrives here as `[]`. Undefined or empty ⇒
   * the plugin is configured exactly as it was before machine clients existed, and the token
   * hook below refuses every `client_credentials` request.
   */
  machineScopes?: readonly string[];
}

/**
 * The demo relying party, so the round-trip is exercisable out of the box (the scenario test
 * drives authorize → token against it). It is now DATA, not config: `oauthProvider` has no
 * `trustedClients` option — every client is a row, and `skipConsent` is a column on it. So
 * this is seeded by `seedDemoClient` into the dev server's database and the test databases,
 * and NOT into a hosted install, which is the point: the old plugin resolved this client, with
 * this published secret, on every deployment including production. A demo credential now
 * exists exactly where the demo runs.
 */
export const DEMO_CLIENT = {
  name: 'Substrat Demo RP',
  redirectUris: ['http://localhost:5271/oidc-callback'],
  skipConsent: true,
} as const;

/**
 * Register the demo relying party, returning the credentials the plugin MINTED for it.
 *
 * It carries no fixed id and no fixed secret any more, and cannot: `storeClientSecret`
 * defaults to `hashed` when the jwt plugin is on, so a secret is knowable only at the moment
 * it is issued — a stored one cannot be read back by anything, including this. That is a
 * straight improvement on what it replaced, which shipped `demo-rp-secret-not-for-production`
 * in source and resolved it on every deployment, production included.
 *
 * Registration goes through the plugin's own admin endpoint, as an administrator, because
 * that is the only way in — `clientPrivileges` gates it, and there is no back door through
 * SQL now that secrets are hashed. So the seed exercises the same path the dashboard does.
 */
export async function seedDemoClient(
  auth: Auth,
  headers: Headers,
): Promise<{ clientId: string; clientSecret: string }> {
  const created = (await auth.api.adminCreateOAuthClient({
    headers,
    body: {
      client_name: DEMO_CLIENT.name,
      redirect_uris: [...DEMO_CLIENT.redirectUris],
      // `native`, not `web`, because the demo's callback is `http://localhost:…`: OAuth 2.1
      // lets a native client use HTTP on loopback, and refuses a `web` client anything but
      // HTTPS off-loopback. A demo that only runs locally is a native client by this
      // definition, whatever it looks like.
      application_type: 'native',
      // The secret travels in the form body rather than an Authorization header. The plugin
      // now REFUSES the wrong one — a client registered for `client_secret_basic` cannot post
      // its secret — so this is a choice a relying party has to make explicitly.
      token_endpoint_auth_method: 'client_secret_post',
      skip_consent: DEMO_CLIENT.skipConsent,
    },
  })) as { client_id: string; client_secret?: string };
  return { clientId: created.client_id, clientSecret: created.client_secret ?? '' };
}

/**
 * The two discovery documents, at every path the plugin serves them from: the root forms
 * (`/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server`, and its
 * issuer-path form), and the Better Auth base-path forms.
 */
const DISCOVERY_PATH = /\/\.well-known\/(?:openid-configuration|oauth-authorization-server)(?:\/|$)/;

/**
 * Say in discovery what this issuer does beyond the plugin: it takes an RFC 8707 `resource`
 * parameter (#1619), and it answers RFC 8693 token exchange at the token endpoint (#1824).
 *
 * `resource_parameter_supported` is NOT an IANA-registered authorization-server metadata
 * name. RFC 8707 defines none, and no registry entry exists for one. RFC 8414 §2 allows
 * additional members, and a client that does not know this one ignores it. It is published
 * because a client reading the metadata otherwise learns only at `/authorize`, from an
 * `invalid_target`, that resources are enforced here.
 *
 * Added on the way out of the handler rather than through a Better Auth hook, because the
 * plugin answers the root documents from its own `onRequest`, and better-call returns an
 * `onRequest` response without running any `onResponse`. This wrapper is the one place
 * both runtimes' requests pass through.
 */
async function advertiseExtensions(
  request: Request,
  response: Response,
  servesTokenExchange: boolean,
): Promise<Response> {
  if (request.method !== 'GET' || response.status !== 200) return response;
  if (!DISCOVERY_PATH.test(new URL(request.url).pathname)) return response;
  if (!response.headers.get('content-type')?.includes('json')) return response;
  const document = (await response.json()) as Record<string, unknown>;
  // Built with the constructor of the response Better Auth handed back, not the global
  // `Response`. This module is runtime-agnostic and typechecks under node too, where the
  // global is undici's and the handler's declared type is the lib's (the reason
  // `tsconfig.json` excludes every file that constructs one). The runtime class is the
  // same either way.
  const Rebuilt = response.constructor as new (body: string, init: { status: number; headers: Headers }) => Response;
  // A copy: the handler's own headers may be immutable, as a fetched response's are.
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  // Token exchange is served beside the plugin (`token-exchange.ts`, dispatched by `routes.ts`),
  // so the plugin's own list cannot know about it.
  // Only where it is served (`servesTokenExchange`).
  const grants = Array.isArray(document['grant_types_supported']) ? (document['grant_types_supported'] as unknown[]) : [];
  const grant_types_supported =
    !servesTokenExchange || grants.includes(TOKEN_EXCHANGE_GRANT_TYPE) ? grants : [...grants, TOKEN_EXCHANGE_GRANT_TYPE];
  return new Rebuilt(JSON.stringify({ ...document, grant_types_supported, resource_parameter_supported: true }), {
    status: response.status,
    headers,
  });
}

/** The slice of a Better Auth hook context the machine-scope checks read. */
interface ScopeHookCtx {
  body?: unknown;
  headers?: Headers;
  context: {
    adapter: {
      findOne<T>(query: { model: string; where: { field: string; value: string }[] }): Promise<T | null>;
    };
  };
}

/** The two scope columns of a client row, as the plugin's adapter hands them back. */
interface ClientScopes {
  scopes?: string[] | null;
  clientCredentialsScopes?: string[] | null;
}

const findClientScopes = (ctx: ScopeHookCtx, clientId: string): Promise<ClientScopes | null> =>
  ctx.context.adapter.findOne<ClientScopes>({ model: 'oauthClient', where: [{ field: 'clientId', value: clientId }] });

const scopeList = (scope: string | undefined): string[] | undefined => scope?.split(' ').filter(Boolean);

/**
 * The scope a person's sign-in may ask for, with every machine scope taken out — or
 * `undefined` when there is nothing to take out and the request goes through untouched.
 *
 * A machine scope names what an unattended client may do, and a person's consent is not that
 * operator's decision. Without this, any administrator-registered client — whose stored scope
 * list is empty, so the plugin falls back to its configured list — could ask a person for one.
 * An absent `scope` is resolved here the way the plugin would resolve it, because the plugin
 * resolves it AFTER this hook, to the list that now includes them.
 *
 * Narrowed rather than refused: RFC 6749 §3.3 lets an issuer grant less than was asked, and a
 * refusal would have to be delivered to a redirect URI this hook has not validated.
 */
async function withoutMachineScopes(
  ctx: ScopeHookCtx,
  clientId: string,
  scope: string | undefined,
  machineScopes: readonly string[],
): Promise<string | undefined> {
  if (!machineScopes.length) return undefined;
  let asked = scopeList(scope);
  if (!asked) {
    const client = await findClientScopes(ctx, clientId);
    // An unknown client is the plugin's to refuse, with its own error.
    if (!client) return undefined;
    asked = client.scopes?.length ? client.scopes : [...USER_DELEGATED_SCOPES];
  }
  const kept = asked.filter((s) => !machineScopes.includes(s));
  return scope !== undefined && kept.length === asked.length ? undefined : kept.join(' ');
}

/**
 * The client id a token request CLAIMS to authenticate as — the form body's, HTTP Basic's, or a
 * `private_key_jwt` assertion's `sub` (RFC 7523 §3, where `client_id` is optional). Read
 * before the plugin verifies anything, which is fine for the one use it has: choosing whose
 * stored scopes to narrow. A claim that is false fails the plugin's own authentication next.
 *
 * When two presentations name DIFFERENT clients the answer is `{ conflict: true }`, never a
 * pick — a result shape no client id can take, so a client really named "conflict" is still
 * itself. A request posting client A while authenticating as B would otherwise narrow B to A's
 * stored scopes. RFC 6749 §2.3.1 and RFC 7523 §3 both require the posted `client_id` to agree with
 * the credential, so a disagreement is a malformed request, refused before anything is read.
 * Basic credentials that do not decode name nobody here, as before; the plugin refuses them.
 *
 * Exported for its test: an assertion-authenticated client is the one a narrowing that read
 * only the first two presentations would have let through unnarrowed.
 */
export function tokenRequestClientId(
  ctx: Pick<ScopeHookCtx, 'body' | 'headers'>,
): { conflict: true } | { conflict?: never; clientId?: string } {
  const body = ctx.body as Record<string, unknown> | undefined;
  const posted = typeof body?.client_id === 'string' && body.client_id ? body.client_id : undefined;
  const basic = basicCredentialsOf(ctx.headers?.get('authorization'));
  const claimed = new Set(
    [posted, basic && basic !== 'malformed' ? basic.clientId : undefined, assertionSubject(body?.client_assertion)].filter(
      (id): id is string => id !== undefined,
    ),
  );
  if (claimed.size > 1) return { conflict: true };
  const [clientId] = claimed;
  return clientId === undefined ? {} : { clientId };
}

/** A `private_key_jwt` assertion's `sub`, unverified — or undefined when it has none to read. */
function assertionSubject(assertion: unknown): string | undefined {
  if (typeof assertion !== 'string') return undefined;
  try {
    const payload = assertion.split('.')[1] ?? '';
    const sub = (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub ? sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `MACHINE_SCOPES` as a ceiling the token endpoint enforces, on every `client_credentials`
 * request — not only at registration.
 *
 * The plugin checks a request against the CLIENT's stored list alone, so a scope an operator
 * removes from `MACHINE_SCOPES` would keep being minted to every client registered while it was
 * there. Here the request is narrowed to what is in both lists before the plugin sees it: a
 * scope asked for outside the ceiling is refused, an absent scope becomes the intersection, and
 * an empty intersection is refused. With no `MACHINE_SCOPES` at all the grant is refused
 * outright, whatever any client row holds.
 *
 * This runs before the plugin authenticates the client. What it can disclose without a secret
 * is whether a client id currently holds a machine scope; client ids are not secrets.
 */
async function machineGrantCeiling(ctx: ScopeHookCtx, machineScopes: readonly string[]) {
  const body = ctx.body as Record<string, unknown> | undefined;
  if (body?.grant_type !== 'client_credentials') return;
  const refuse = (error: string, error_description: string) =>
    new APIError('BAD_REQUEST', { error, error_description });
  if (!machineScopes.length) throw refuse('unauthorized_client', 'this issuer grants no machine scopes');
  // Before the scope is looked at, so an ambiguous identity is refused whether or not it asked.
  const claimed = tokenRequestClientId(ctx);
  if (claimed.conflict) throw refuse('invalid_client', 'the client_id does not match the client credentials');
  const { clientId } = claimed;
  const asked = scopeList(typeof body.scope === 'string' ? body.scope : undefined);
  if (asked) {
    const outside = asked.filter((s) => !machineScopes.includes(s));
    if (outside.length) throw refuse('invalid_scope', `The following scopes are invalid: ${outside.join(', ')}`);
    return;
  }
  // Fail closed: with no client to read, the stored scopes cannot be narrowed, and letting the
  // request through would let the plugin mint all of them.
  if (!clientId) throw refuse('invalid_client', 'client authentication is required');
  // An unknown id is the plugin's to refuse, with its own error; it mints nothing for it.
  const client = await findClientScopes(ctx, clientId);
  if (!client) return;
  const granted = (client.clientCredentialsScopes ?? []).filter((s) => machineScopes.includes(s));
  if (!granted.length) throw refuse('unauthorized_client', 'client has no authorized client_credentials scopes');
  return { context: { body: { ...body, scope: granted.join(' ') } } };
}

export function buildAuth(deps: AuthDeps) {
  const auth = betterAuthFor(deps);
  const handle = auth.handler;
  // `fetch` is Better Auth's alias for the same function; both are replaced so neither
  // spelling serves a document without the flag.
  auth.handler = auth.fetch = async (request: Request) => {
    try {
      const response = await handle(request);
      // Better Auth's HTTP router can turn an unexpected exception into a 500 before it
      // reaches this wrapper. Both paths need the same safe record.
      if (response.status >= 500) await recordSignInException(request, deps.recordSignIn);
      return advertiseExtensions(request, response, deps.servesTokenExchange === true);
    } catch (error) {
      await recordSignInException(request, deps.recordSignIn);
      throw error;
    }
  };
  return auth;
}

function betterAuthFor(deps: AuthDeps) {
  const machineScopes = deps.machineScopes ?? [];
  return betterAuth({
    database: deps.database,
    emailAndPassword: {
      enabled: true,
      // Self-service registration is a policy decision, so it is opt-in. `autoSignIn` means a
      // successful sign-up sets a session — which the oidcProvider's after-hook watches for,
      // so someone who arrives from a relying party, creates an account and lands back at
      // that app's callback never sees this dashboard (the #898 failure, on the sign-up path).
      disableSignUp: !deps.allowSignup,
      autoSignIn: true,
      minPasswordLength: 8,
      // Imported people keep the bcrypt hash their old issuer gave them until they next set a
      // password (`src/legacy-password.ts`); everything written here is still scrypt.
      password: legacyAwarePassword,
      // The primary ask: password reset via the email adapter. Better Auth builds the
      // one-time reset URL; we wrap it in the transactional template and send it.
      sendResetPassword: async ({ user, url }) => {
        await deps.transport.send(resetPasswordEmail({ to: user.email, from: deps.sender, url }));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // Verification is offered (mail goes out through the same adapter) but not required to
      // sign in — this is a demo, not a compliance gate. Flip `requireEmailVerification` on
      // in emailAndPassword to make it mandatory.
      sendVerificationEmail: async ({ user, url }) => {
        await deps.transport.send(verifyEmail({ to: user.email, from: deps.sender, url }));
      },
    },
    plugins: [
      // The issuer identity, pinned to the CLEAN origin. `oauthProvider` derives it from the
      // jwt plugin, falling back to Better Auth's `baseURL` — which includes the base path,
      // so discovery would advertise `{origin}/api/auth` while every relying party was
      // configured with `OIDC_ISSUER = {origin}` and fetched discovery from the root alias in
      // `routes.ts`. OIDC requires the advertised `issuer` to match the URL discovery came
      // from, so that mismatch is not cosmetic: strict RPs reject the id_token. The 1.6
      // plugin used the clean `baseURL`, and this keeps that promise across the move.
      jwt({ jwt: { issuer: deps.baseURL } }),
      oauthProvider({
        loginPage: '/login',
        consentPage: '/consent',
        // `prompt=create` — a relying party asking for a sign-up screen rather than a
        // sign-in. Without this the plugin sends those people to `loginPage`, and the
        // vertical's own sign-up screen would only ever be reached by someone who clicked
        // through to it.
        signup: { page: '/signup' },
        // Let any OIDC-compatible app register itself as a relying party (the "standalone
        // auth server for whatever app" goal), with no session — RFC 7591. Turn BOTH off to
        // lock the issuer down to clients an administrator registers by hand.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // The gate on the MANAGEMENT endpoints (create/read/list/update/delete/rotate the
        // dashboard calls). Unauthenticated dynamic registration is deliberately NOT gated
        // by this — the plugin only consults the hook when a session is present — so
        // self-registration stays open while managing the registry stays administrator-only.
        // This is why the dashboard needs no client API of its own.
        clientPrivileges: ({ user }) => (user as { role?: string } | undefined)?.role === 'admin',
        // Let the SIGNED-OUT login screen name the application that sent someone here. It is
        // opt-in because it resolves a client id to a name without a session — but only
        // inside a validly signed authorize query, so it answers for the request in hand
        // rather than acting as an oracle over the registry. Without it the login screen can
        // only say "an application", which is what the old plugin's session-gated client read
        // forced.
        allowPublicClientPrelogin: true,
        /**
         * How long a login page stays usable: the plugin signs the authorize query with an `exp`
         * of `codeExpiresIn`, and every sign-in step that carries it (password, SMS, BankID)
         * is refused as `invalid_signature` after that. Ten minutes — the default — is too
         * short for a first-time phone enrolment (type a number, wait for the SMS, find the
         * code).
         *
         * It sets TWO lifetimes: the signed query's `exp` (`signParams`) and the authorization
         * code's (`redirectWithAuthorizationCode`). @better-auth/oauth-provider 1.7.7 has no
         * separate option for the query, so the login window cannot be widened alone. Thirty
         * minutes is therefore a deliberate deviation from RFC 6749 §4.1.2, which recommends a
         * code live at most ten: a phone enrolment that times out halfway is a person locked
         * out, while an unspent code is worth little to anyone else. It is single-use (a
         * replay revokes what it issued) and PKCE-bound — mandatory for a public client and on
         * by default for every other. That last claim holds only while nothing here sets
         * `require_pkce: false` on a client or `clientRegistrationRequirePKCE: false` on the
         * plugin; whoever changes either should shorten this back to the default.
         */
        codeExpiresIn: 30 * 60,
        /**
         * RESOURCE INDICATORS (RFC 8707), for the MCP endpoint every vertical mounts (#1619).
         *
         * A token for a `resource` is minted only if an `oauth_resource` row names it. Here
         * the platform writes those rows: `src/resources.ts`, one per hostname a vertical
         * answers on, delivered by the dashboard when it binds that vertical to this issuer.
         * Nothing else registers one, and an unregistered resource is still `invalid_target`.
         *
         * `enforcePerClientResources: false` is the CHECKPOINT decision here. With it on (the
         * plugin's default), a client may target a resource only if a row in
         * `oauth_client_resource` links the two. No self-registered client, DCR or CIMD, is
         * ever linked, so every MCP client would be refused `client … is not linked`. Linking
         * every such client to every platform resource would grant exactly what turning the
         * check off grants, at the cost of a row per pair. Linking only the clients whose
         * redirect URI shares the resource's origin would exclude every real MCP client,
         * whose callback lives at its own vendor. The trade-off, plainly: any client of this
         * issuer may obtain a token for any registered resource, gated by the user's own
         * sign-in and consent. After that, the resource server's `aud` check and its own
         * permission checks are what protect the resource. The lever this gives up — "client
         * X may only target resource Y" — had no links and no screen behind it.
         */
        enforcePerClientResources: false,
        /**
         * Who may create, change, delete or link resources through the plugin's
         * `adminCreateOAuthResource` family. Those are `SERVER_ONLY`, so nothing reaches them
         * over HTTP, and nothing here calls them today. But left unset, the plugin lets them
         * run for ANY authenticated session they are handed. So the first console route that
         * forwarded a caller's headers to one would let any signed-in user register a
         * resource, or delete the platform's, now that resources decide what gets minted.
         * Administrators only, the same gate `clientPrivileges` puts on the client registry.
         */
        resourcePrivileges: ({ user }) => (user as { role?: string } | undefined)?.role === 'admin',
        /**
         * MACHINE CLIENTS (`client_credentials`, #2267). The plugin grants a machine client only
         * scopes it was configured with and that no person grants by signing in — and left
         * unset, its configured scopes are exactly those four, so no machine client could hold
         * anything. `MACHINE_SCOPES` is the operator's list, added here only when there is one,
         * so an issuer without it is configured byte for byte as before.
         *
         * Adding them makes them valid in EVERY scope check the plugin runs, not just the
         * machine one, which is wider than meant. Two pins narrow it back:
         *   - `clientRegistrationDefaultScopes` keeps a SELF-registered client (RFC 7591, CIMD)
         *     on the sign-in scopes; without it the plugin would stamp the whole list on it.
         *   - the authorize hook below strips machine scopes from every sign-in, covering the
         *     administrator-registered clients whose scope column is empty and so falls back to
         *     this list.
         * They also appear in discovery's `scopes_supported`, which is accurate: they are scopes
         * this issuer mints.
         */
        ...(machineScopes.length
          ? {
              scopes: [...USER_DELEGATED_SCOPES, ...machineScopes],
              clientRegistrationDefaultScopes: [...USER_DELEGATED_SCOPES],
            }
          : {}),
      }),
      // Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document), under
      // the MCP 2026-07-28 profile. A client identifies itself by an HTTPS URL that IS its
      // metadata document: no registration write, no client secret, nothing to revoke.
      //
      // Mounted only when the caller supplied a transport, because the plugin's contract
      // for that transport is a security one (see `cimd-fetch.ts`) and an issuer with no
      // safe way to fetch a document must not advertise that it will. `client_id_metadata
      // _document_supported: true` is published by the plugin itself, so this one line is
      // what a client discovers.
      //
      // It composes with, rather than replaces, dynamic registration: `allowUnauthenticated
      // ClientRegistration` above already makes this issuer usable by an MCP client via
      // RFC 7591. CIMD is the better option for a directory client — nothing is persisted
      // per client until one actually arrives — not the only one.
      ...(deps.fetchClientMetadataResource
        ? [
            cimd({
              fetchClientMetadataResource: deps.fetchClientMetadataResource,
              // The MCP revision pins CIMD draft-00, which makes `client_name` and
              // `redirect_uris` required rather than optional. Naming the profile is what
              // turns a document missing them into a refusal here instead of a puzzling
              // failure at the client.
              metadataProfile: 'mcp-2026-07-28',
            }),
          ]
        : []),
      // Generic OIDC upstreams — see the `genericProviders` dep above. Registered into the
      // same social-provider list the catalogue providers live in, so nothing downstream
      // knows the difference.
      ...(deps.genericProviders?.length ? [genericOAuth({ config: deps.genericProviders })] : []),
      // The Supabase legacy-secret bridge — see the `supabase` dep above for when it is
      // mounted, and `supabase-token.ts` for what it refuses.
      ...(deps.supabase ? [supabasePlugin(deps.supabase)] : []),
      // BankID sign-in — see the `bankid` dep above for when this is (and is not) mounted.
      ...(deps.bankid ? [bankidPlugin(deps.bankid)] : []),
      invitationPlugin({ transport: deps.transport, sender: deps.sender, baseURL: deps.baseURL }),
      phonePlugin(deps.phoneVerifier),
      admin(),
    ],
    // The `jwt` plugin's `/token` mints a JWT for the CURRENT SESSION. On an authorization
    // server that is a second, session-shaped way to get a bearer token beside
    // `/oauth2/token`, and nothing here uses it: relying parties go through the OIDC flow and
    // verify id_tokens from the public JWKS. Disabled rather than left reachable.
    /**
     * Federated sign-in, from the registry rather than from config (`src/providers.ts`). Read
     * per request like everything else here, so enabling Microsoft in the dashboard answers on
     * the next request instead of the next deploy.
     */
    ...(deps.socialProviders ? { socialProviders: deps.socialProviders } : {}),
    account: {
      accountLinking: {
        /**
         * Which upstreams may sign a person into an account that already exists here.
         *
         * This is not belt-and-braces. Entra does not put `email_verified` in its token, and
         * Better Auth's Microsoft provider maps that absence to FALSE unless Graph reports the
         * address as a verified primary — so an administrator creates a user, that user signs
         * in with Microsoft, and the two are refused a join ("account not linked") unless the
         * provider is trusted. Trusting a directory the operator owns is right; trusting a
         * consumer provider by default is not, so this list is empty until someone says so.
         *
         * Better Auth still requires the LOCAL row to be email-verified before it will link,
         * and that gate is the library's own — an attacker who pre-registers at a victim's
         * address must not inherit the victim's identity. Left alone deliberately.
         */
        trustedProviders: deps.trustedProviders ?? [],
        /**
         * The operator's answer to "may an upstream claim an existing account by address?".
         * Set only when it is `false`: Better Auth reads the key's presence in a `=== true`
         * test, and an explicit `false` is the same as absent — but writing it unconditionally
         * would put a key in the options that says nothing, which is how a reader concludes
         * the toggle does not work.
         */
        ...(deps.autoLinkAccounts === false ? { disableImplicitLinking: true } : {}),
      },
    },
    /**
     * The session carries WHICH METHOD established it (`src/sign-in-policy.ts`).
     *
     * Better Auth records the providers a USER has linked, in `account` — but not the one the
     * person in front of us used just now, and those are different questions. "Has a Microsoft
     * identity" is satisfied forever by one link; "signed in with Microsoft" is what a client
     * restricted to a directory is actually asking, and it is the only one an enforcement
     * check can honour. So it is stamped here, and the authorize hook below reads it.
     *
     * `input: false` — nothing a caller sends can set it. The stamp is derived from the path
     * the session was created on and from nothing else.
     */
    user: {
      additionalFields: {
        // Only the successful verification endpoint writes this field.
        phoneNumber: { type: 'string', required: false, input: false },
      },
    },
    session: {
      additionalFields: {
        signInProvider: { type: 'string', required: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          /**
           * The stamp itself. `ctx` is the endpoint context Better Auth carries ambiently, so
           * this fires for EVERY session — including the two this issuer's own plugins mint
           * through `internalAdapter.createSession` (BankID, the Supabase bridge), which pass
           * no context of their own. A path the vocabulary does not name stamps `null`, which
           * every policy then refuses; see `signInMethodOfPath` for why that direction.
           */
          before: async (_session, ctx) => ({
            // `ctx.params` as well as `ctx.path`: the social callback's route is the literal
            // `/callback/:id` and the provider is the bound parameter, so the path alone
            // stamps nothing (see `signInMethodOfPath`).
            data: { signInProvider: signInMethodOfPath(ctx?.path, ctx?.params) },
          }),
        },
      },
    },
    hooks: {
      /**
       * PER-CLIENT SIGN-IN POLICY, enforced (`src/sign-in-policy.ts`).
       *
       * `/oauth2/authorize` is the only place this can live. The login screen showing one
       * button is decoration — `POST /sign-in/social` names its provider directly, and a
       * session established ANY way at all resumes an authorize request into a code. Here the
       * client id is the request's own, the session is whoever is holding the browser, and the
       * two can finally be compared.
       *
       * The refusal is `max_age=0` — re-authenticate — and the plugin does the rest: it
       * redirects to `loginPage` with the signed query (where the screen, reading the same
       * policy, offers only the methods that would pass), and for a relying party that asked
       * for `prompt=none` it answers `login_required` at the redirect URI instead, which is
       * the spec's own answer and one we would otherwise have had to build by hand over a URI
       * we have not validated.
       *
       * `max_age=0` rather than the more obvious `prompt=login`, for two library facts. The
       * authorize query schema REFUSES `none` combined with any other prompt value, so adding
       * `login` to a silent request turns it into `invalid_request` — a refusal that blames
       * the relying party for something we did. And `isWithinMaxAge` special-cases zero as
       * never satisfied, so this cannot be accidentally met by a session created in the same
       * millisecond. One lever, both paths, no clock races. It can only ever be stricter than
       * what the client asked for: an untouched request is one that passed.
       *
       * It cannot loop: the plugin STRIPS `max_age` from the query it resumes after a fresh
       * sign-in, and the session that comes back through here is stamped with whatever the
       * person just used. Satisfy the policy and this hook is a no-op; refuse to, and you are
       * asked again — by a screen that only offers what it will accept.
       *
       * This runs on the resume too. `oauthProvider` re-enters the endpoint through
       * `dispatchAuthEndpoint`, which is the hook-running path — deliberately, per its own
       * docs — so a sign-in that carried `oauth_query` for a restricted client is checked at
       * the moment it tries to become a code, not merely on the way in.
       */
      before: createAuthMiddleware(async (ctx) => {
        const callbackMethod = callbackProviderOf(ctx.path, ctx.params);
        if (deps.recordSignIn && callbackMethod) diagnoseSignInCallback(ctx.context, callbackMethod, ctx.request);
        if (ctx.path === '/oauth2/token') return machineGrantCeiling(ctx, machineScopes);
        if (ctx.path !== '/oauth2/authorize') return;
        const query = ctx.query as Record<string, string | undefined> | undefined;
        const clientId = query?.client_id;
        if (!clientId) return;
        // Before the policy, so a refusal below re-asks with the narrowed scope too.
        const scope = await withoutMachineScopes(ctx, clientId, query?.scope, machineScopes);
        const narrowed = scope === undefined ? undefined : { context: { query: { ...query, scope } } };
        const policy = deps.signInPolicyFor?.(clientId);
        // No session is not this hook's business: the plugin already sends that person to the
        // login screen, which applies the same policy to what it draws.
        const session = await getSessionFromCtx(ctx);
        if (!session) return narrowed;
        const method = (session.session as Record<string, unknown>).signInProvider;
        if (method !== 'invitation' && policyAdmits(policy, typeof method === 'string' ? method : null, session.user.email)) return narrowed;
        return { context: { query: { ...(narrowed?.context.query ?? query), max_age: '0' } } };
      }),
      /**
       * THE SIGN-IN LOG (`src/sign-in-log.ts`) — both ends of a federated round trip, recorded.
       *
       * An after-hook is the only place either end is observable, and the reason is Better
       * Auth's control flow: `/callback/:id` finishes by THROWING `c.redirect(…)` on every path
       * it has, success and refusal alike. `dispatchAuthEndpoint` catches that `APIError` and
       * hands it to the after-hooks as `context.returned` with its `location` header in
       * `context.responseHeaders` — so a hook here sees outcomes that never become a return
       * value and that no wrapper around `auth.handler` could tell apart (both are a 302).
       *
       * Which is also why the OUTCOME is read off that `location` rather than from the error:
       * the refusal is `?error=…&error_description=…` on the redirect, and for a provider that
       * refused at its own end — Entra's `AADSTS…` — the description is the upstream's own
       * sentence about what is wrong. That sentence is usually the entire diagnosis, and this
       * is the only moment it exists anywhere in this process.
       *
       * It records and returns nothing: an after-hook that returns a value REPLACES the
       * response (`runAfterHooks` assigns `context.returned`), so a logging hook must fall off
       * the end. `recordSignInAttempt` swallows its own errors for the matching reason — a
       * debugging aid must not be able to cost anyone a login.
       */
      after: createAuthMiddleware(async (ctx) => {
        const record = deps.recordSignIn;
        if (!record) return;
        // `/sign-in/social` serves BOTH kinds of upstream: `genericOAuth` registers its
        // providers as first-class social providers, so there is no second path to match.
        if (ctx.path === '/sign-in/social') {
          // The RAW body, which is what a hook is handed — the endpoint's own schema strips
          // `oauth_query` inside the handler, and `oauthProvider`'s own before-hook reads it
          // from here for exactly that reason.
          const body = ctx.body as { provider?: unknown; oauth_query?: unknown } | undefined;
          const method = typeof body?.provider === 'string' ? body.provider : 'unknown';
          const clientId = clientIdOfSignedQuery(body?.oauth_query);
          const returned = ctx.context.returned as { url?: unknown } | undefined;
          // An `APIError` here is a refusal BEFORE anyone left — the provider is not
          // configured, or is disabled — which is worth a row: it is the shape of "the button
          // does nothing", and it never reaches a callback to be recorded there.
          if (returned instanceof Error) {
            record({ method, outcome: 'failed', phase: 'sign-in', clientId, ...refusalOf(returned) });
            return;
          }
          const url = typeof returned?.url === 'string' ? returned.url : null;
          record({
            method,
            outcome: 'started',
            phase: 'sign-in',
            clientId,
            authority: authorityOf(url),
            // The `state` is the only thing that survives the trip to the provider and back, so
            // a digest of it is what lets the callback's row find this one.
            correlation: await correlationOfState(stateOfAuthorizationUrl(url)),
          });
          return;
        }
        const method = callbackProviderOf(ctx.path, ctx.params);
        if (!method) return;
        // The redirect target IS the outcome — see the header. No location at all means the
        // endpoint did not finish the way any of its paths do, which is worth a row saying so
        // rather than silence.
        const location = ctx.context.responseHeaders?.get('location');
        // The same digest the outbound hop recorded — the provider hands the `state` back, which
        // is what makes these two rows one attempt even when several are in flight.
        const correlation = await correlationOfState(
          (ctx.query as Record<string, string | undefined> | undefined)?.state,
        );
        const refusal = errorOfRedirect(location);
        if (refusal) {
          record({
            method, outcome: 'failed', phase: 'callback', correlation, ...refusal,
            errorDescription: signInDiagnosticDescription(ctx.context, refusal.errorDescription),
          });
          return;
        }
        record({
          method,
          outcome: 'succeeded',
          phase: 'callback',
          correlation,
          // Set by `setSessionCookie`, so present on a sign-in and absent on a LINK — which
          // redirects to the same callback URL with no new session. Both are successes.
          userId: (ctx.context.newSession as { user?: { id?: string } } | null | undefined)?.user?.id ?? null,
        });
      }),
    },
    // See `runInBackground` above — the difference between a new user's first sign-in finishing
    // and a redirect that waits on an email.
    ...(deps.runInBackground
      ? { advanced: { backgroundTasks: { handler: deps.runInBackground } } }
      : {}),
    disabledPaths: ['/token'],
    secret: deps.secret,
    baseURL: deps.baseURL,
    trustedOrigins: deps.trustedOrigins,
  });
}

export type Auth = ReturnType<typeof betterAuthFor>;
