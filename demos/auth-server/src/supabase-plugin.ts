import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { SupabaseTokenError, supabaseIssuerOf, verifySupabaseToken } from './supabase-token.js';

/**
 * Signing in with a token a Supabase project already issued — one endpoint under the issuer's
 * own `/api/auth` surface:
 *
 *   POST /supabase/session   { token } → a session cookie for the person that token describes
 *
 * This is the LEGACY-secret path, and it exists because the good path is unavailable there.
 * A Supabase project that has migrated to asymmetric signing keys should be configured as an
 * ordinary upstream in the sign-in providers panel: a redirect, PKCE, no shared secret held
 * here at all. A project still on the legacy HS256 secret cannot do that — Supabase's OAuth
 * 2.1 server refuses to mint the id_token the `openid` scope requires — so the only proof of
 * identity it can offer is a token its own app is already holding. `src/supabase-token.ts`
 * carries what makes such a token safe to believe, including the one that is easy to miss:
 * the project's PUBLIC anon key is signed with this same secret.
 *
 * A plugin rather than a route beside Better Auth, for the reasons `bankid-plugin.ts` sets
 * out and which apply here unchanged: the flow has to END in a Better Auth session, and
 * `setSessionCookie` plus the internal adapter are only honest from inside one. The `admin`
 * plugin's ban check is a hook on session creation, so a banned user is refused here with no
 * code of ours; and `oauthProvider`'s resume hooks are generic, so a body carrying
 * `oauth_query` hands someone a relying party sent here straight back to that app — the #898
 * contract, kept for free.
 *
 * The account is keyed `(issuer, accountId)` = (the project's issuer, Supabase's `sub`) — the
 * SAME pair `genericOAuth` would use if the project later migrates and moves to the redirect
 * flow. That is deliberate, and it is the migration story: the same person arrives at the same
 * account, and the `sub` every relying party of this issuer already stored does not move.
 */

export interface SupabaseBridgeOptions {
  /** The project's legacy JWT secret. Never leaves this module or `supabase-token.ts`. */
  secret: string;
  /** The project's issuer — `https://<ref>.supabase.co/auth/v1`. */
  issuer: string;
  /**
   * May a verified Supabase user with no account here get one? On by default in the caller,
   * because configuring a shared secret is already the act of trust: the bridge admits exactly
   * the people this one project authenticated, which is what an operator turned it on to do.
   */
  allowSignup: boolean;
  /**
   * The issuer-wide `ACCOUNT_LINKING` decision, applied to this path too.
   *
   * It has to be applied HERE rather than inherited, and that is the trap this option exists
   * for. Better Auth's own implicit-linking rules live in the OAuth callback; a plugin that
   * mints accounts through the internal adapter never passes through them. So a bridge that
   * simply created a user would meet the `user.email` UNIQUE constraint and fail with a
   * database error where the operator's policy should have spoken — and, worse, an issuer set
   * to `block` would have a second door that quietly ignored it.
   */
  autoLinkAccounts: boolean;
}

/** `providerId` on the account row, matching the catalogue id the OIDC path would use. */
const PROVIDER_ID = 'supabase';

/**
 * What the caller is told when a token is not accepted — one message for every reason. The
 * verifier distinguishes a bad signature from a wrong issuer from an anon key so that a test
 * can, but telling a caller which of those they hit turns this endpoint into an oracle for
 * probing the configuration.
 */
const REFUSED = 'That Supabase token was not accepted.';

export const supabasePlugin = (opts: SupabaseBridgeOptions) => {
  const issuer = supabaseIssuerOf(opts.issuer);
  return {
    id: 'supabase-bridge',
    endpoints: {
      supabaseSession: createAuthEndpoint(
        '/supabase/session',
        { method: 'POST', body: z.object({ token: z.string().min(1) }) },
        async (ctx) => {
          const identity = await verifySupabaseToken(ctx.body.token, {
            secret: opts.secret,
            issuer,
          }).catch((e: unknown) => {
            if (e instanceof SupabaseTokenError) throw new APIError('UNAUTHORIZED', { message: REFUSED });
            throw e;
          });

          const account = await ctx.context.internalAdapter.findAccountByKey({
            issuer,
            accountId: identity.sub,
          });
          let user = account ? await ctx.context.internalAdapter.findUserById(account.userId) : null;

          if (!user) {
            // No account under this Supabase id yet. Before minting one, the address has to be
            // answered for: `user.email` is UNIQUE, so a local account already holding it is
            // not a collision to route around but the linking question, asked on a second door.
            const existing = identity.email
              ? await ctx.context.internalAdapter.findUserByEmail(identity.email)
              : null;

            if (existing?.user) {
              // The same two conditions the OAuth path applies, for the same reasons: Supabase
              // must say the address is proved, and the local account must have proved its own
              // — otherwise an address is being accepted as permission to become whoever holds
              // it here. `autoLinkAccounts` is the operator's veto over both.
              if (!opts.autoLinkAccounts || !identity.emailVerified || !existing.user.emailVerified) {
                throw new APIError('FORBIDDEN', {
                  message:
                    'An account here already uses that email address. Sign in the way you already ' +
                    'can and connect Supabase under “Sign-in methods” — that proves the account in ' +
                    'a way a matching address does not.',
                });
              }
              user = existing.user;
            } else {
              if (!opts.allowSignup) {
                throw new APIError('FORBIDDEN', {
                  message: 'That Supabase account has no account here, and this issuer is not creating them.',
                });
              }
              user = await ctx.context.internalAdapter.createUser(
                {
                  name: identity.name ?? identity.email ?? identity.sub,
                  // No address means no address: a placeholder in the local domain would be a
                  // second account waiting to collide. `.invalid` is reserved for exactly this.
                  email: identity.email ?? `${identity.sub}@supabase.placeholder.invalid`,
                  // Never inherited. Local verification is what lets a LATER upstream join this
                  // account, so copying Supabase's flag here would let one project's word
                  // decide a join it was never asked about.
                  emailVerified: false,
                },
                { method: PROVIDER_ID },
              );
            }
            await ctx.context.internalAdapter.linkAccount({
              userId: user.id,
              providerId: PROVIDER_ID,
              issuer,
              accountId: identity.sub,
            });
          }

          // The `admin` plugin's ban check runs inside this create — a banned user is refused
          // here with a valid Supabase token in hand, exactly as they are with a password.
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'could not create a session' });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ signedIn: true as const });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
};
