import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { oauthProvider, type ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { cimd } from '@better-auth/cimd';
import { jwt } from 'better-auth/plugins/jwt';
import { admin } from 'better-auth/plugins/admin';
import type { EmailAddress, EmailTransport } from '@substrat-run/adapter-email';
import { resetPasswordEmail, verifyEmail } from './email.js';

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

export function buildAuth(deps: AuthDeps) {
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
      },
    },
    disabledPaths: ['/token'],
    secret: deps.secret,
    baseURL: deps.baseURL,
    trustedOrigins: deps.trustedOrigins,
  });
}

export type Auth = ReturnType<typeof buildAuth>;
