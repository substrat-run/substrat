import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import type { GithubOptions, GithubProfile } from 'better-auth/social-providers';
import { APIError, addOAuthServerContext, createAuthEndpoint, createAuthMiddleware, getOAuthState, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import type { EmailAddress, EmailTransport } from '@substrat-run/adapter-email';
import { githubEmailVerification } from './email.js';
import { routeFor, sanitizeSignInPolicy } from './sign-in-policy.js';

const githubProfile = z.object({ id: z.number().int().positive().safe(), login: z.string().min(1), name: z.string().nullable().optional(), email: z.string().nullable().optional(), avatar_url: z.string().optional() }).passthrough();
const githubEmails = z.array(z.object({ email: z.string().email(), primary: z.boolean(), verified: z.boolean() }));

/** Authenticate the stable profile independently of GitHub's optional email service. */
export function withGithubEmailFallback(providers: BetterAuthOptions['socialProviders']): BetterAuthOptions['socialProviders'] {
  const configured = providers?.github;
  if (!configured) return providers;
  const decorate = (options: GithubOptions) => ({
    ...options,
    getUserInfo: options.getUserInfo ?? (async (token) => {
      const headers = { 'User-Agent': 'better-auth', authorization: `Bearer ${token.accessToken}` };
      // Redirects are refused by not following them: `'manual'` hands back the 3xx, which is not
      // `ok`. workerd throws on `redirect: 'error'` (#2722), so that spelling failed every
      // GitHub callback on a deployed issuer while Node accepted it.
      const response = await fetch('https://api.github.com/user', { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) { await response.body?.cancel(); return null; }
      // Invalid identity data must fail closed; only the email lookup is optional.
      const profile = githubProfile.parse(await response.json());
      let emails: z.infer<typeof githubEmails> = [];
      try {
        const response = await fetch('https://api.github.com/user/emails', { headers, redirect: 'manual', signal: AbortSignal.timeout(1500) });
        if (response.ok) emails = githubEmails.parse(await response.json());
        else await response.body?.cancel();
      } catch { /* Authenticated profile remains usable through mailbox verification. */ }
      if (!profile.email) profile.email = (emails.find((email) => email.primary) ?? emails[0])?.email ?? null;
      // The SDK declares id as a string although GitHub supplies a numeric id.
      const data = profile as unknown as GithubProfile;
      const mapped = await options.mapProfileToUser?.(data);
      return { user: { name: profile.name || profile.login, email: profile.email, image: profile.avatar_url, emailVerified: emails.find((email) => email.email === profile.email)?.verified ?? false, ...mapped }, data };
    }) satisfies NonNullable<GithubOptions['getUserInfo']>,
  });
  return { ...providers, github: typeof configured === 'function' ? async () => decorate(await configured()) : decorate(configured) };
}

const TTL = 10 * 60_000;
const SEND_COOLDOWN_MS = 60_000;
const address = z.string().trim().toLowerCase().email().max(254);
const secret = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;
const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, '0')).join('');
interface Pending {
  accountId: string;
  userId?: string;
  linkSessionId?: string;
  name: string;
  githubLogin: string;
  email: string | null;
  callbackURL: string;
  oauthQuery: string | null;
  requestSignUp: boolean;
}

/** No user, account, session or OIDC code is created from an unverified address.
 * The browser's opaque cookie and the separately emailed secret must both be presented.
 * Only the authenticated GitHub profile supplies the stable account id. */
export const githubEmailPlugin = (opts: { transport: EmailTransport; sender: EmailAddress; baseURL: string }) => {
  const cookieName = (ctx: { context: { createAuthCookie(name: string): { name: string } } }) => ctx.context.createAuthCookie('github_email').name;
  // Use the endpoint's inferred context for the adapter and cookie APIs.
  const status = createAuthEndpoint('/github-email/status', { method: ['GET', 'POST'], body: z.object({ token: z.string().min(64).max(200) }).optional() }, async (ctx) => {
    const browser = ctx.getCookie(cookieName(ctx));
    if (!browser && ctx.body?.token) throw new APIError('BAD_REQUEST', { message: 'Open this verification link in the browser where you signed in with GitHub.' });
    const pendingKey = browser ? `github-email:${await digest(browser)}` : '';
    const row = pendingKey && await ctx.context.internalAdapter.findVerificationValue(pendingKey);
    if (!row || new Date(row.expiresAt).getTime() <= Date.now()) throw new APIError('BAD_REQUEST', { message: 'This GitHub sign-in expired. Sign in again.' });
    const pending = JSON.parse(row.value) as Pending;
    let email = pending.email;
    if (ctx.body?.token) {
      const proof = await ctx.context.internalAdapter.findVerificationValue(`github-email-proof:${await digest(ctx.body.token)}`);
      if (!proof || new Date(proof.expiresAt).getTime() <= Date.now()) throw new APIError('BAD_REQUEST', { message: 'This verification link is invalid or expired.' });
      const value = JSON.parse(proof.value) as { pendingKey: string; email: string };
      if (value.pendingKey !== pendingKey) throw new APIError('BAD_REQUEST', { message: 'Open this link in the browser where you signed in with GitHub.' });
      email = value.email;
    }
    return ctx.json({ name: pending.githubLogin, email, oauthQuery: pending.oauthQuery, linking: Boolean(pending.linkSessionId) });
  });
  return {
    id: 'github-email-fallback',
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === '/sign-in/social' || (ctx.path === '/callback/:id' && ctx.params?.id === 'github') || ctx.path === '/callback/github',
        handler: createAuthMiddleware(async (ctx) => {
          if (ctx.path === '/sign-in/social') {
            // oauthProvider verifies this signed query before generating state. It is checked
            // again on completion, and retained only in server-controlled state in between.
            await addOAuthServerContext({ githubEmailQuery: typeof ctx.body?.oauth_query === 'string' ? ctx.body.oauth_query : null });
            return;
          }
          ctx.context.socialProviders = ctx.context.socialProviders.map((provider) => provider.id !== 'github' ? provider : {
            ...provider,
            async getUserInfo(tokens) {
              const result = await provider.getUserInfo(tokens);
              const state = await getOAuthState();
              if (!result?.user || !state) return result;
              const profile = result.data as { id?: unknown; login?: unknown } | undefined;
              if (typeof profile?.id !== 'number' || !Number.isSafeInteger(profile.id) || profile.id <= 0) return result;
              const accountId = String(profile.id);
              const adapter = ctx.context.internalAdapter;
              const owner = await adapter.findAccountOwnerByKey({ providerId: 'github', accountId });
              if (owner?.kind === 'orphaned') throw new APIError('FORBIDDEN', { message: 'This GitHub account needs administrator help.' });
              const linking = state.link ? await getSessionFromCtx(ctx) : null;
              if (state.link) {
                // Matching, verified upstream emails keep the library's existing link path.
                if (result.user.emailVerified && result.user.email?.toLowerCase() === state.link.email.toLowerCase()) return result;
                if (ctx.context.options.account?.accountLinking?.enabled === false || !linking || linking.user.id !== state.link.userId || linking.session.impersonatedBy || Date.now() - new Date(linking.session.createdAt).getTime() > TTL) {
                  throw new APIError('FORBIDDEN', { message: 'Sign in again with your existing method before connecting GitHub.' });
                }
                const method = (linking.session as Record<string, unknown>).signInProvider;
                if (method === 'invitation' || ((linking.user as Record<string, unknown>).phoneNumber && method === 'password')) throw new APIError('FORBIDDEN', { message: 'Finish account setup and SMS verification before connecting GitHub.' });
                if (owner?.kind === 'owned' && owner.user.id !== linking.user.id) throw new APIError('CONFLICT', { message: 'This GitHub account already belongs to another account.' });
              }
              const local = linking?.user ?? owner?.user;
              const email = local?.email ?? result.user.email;
              const verified = local?.emailVerified ?? result.user.emailVerified;
              const query = typeof state.serverContext?.query === 'string' ? new URLSearchParams(state.serverContext.query) : null;
              const hint = address.safeParse(query?.get('login_hint'));
              if (!state.link && email && verified && (!hint.success || hint.data === email.trim().toLowerCase())) {
                // A returning GitHub account remains usable when GitHub's email API is down.
                return { ...result, user: { ...result.user, email, emailVerified: verified } };
              }
              if (!local && (provider.options?.disableSignUp || (provider.disableImplicitSignUp && !state.requestSignUp))) return result;
              const browser = secret();
              const pending: Pending = {
                accountId, ...(local ? { userId: local.id } : {}),
                ...(linking ? { linkSessionId: linking.session.id } : {}),
                name: local?.name ?? result.user.name ?? 'GitHub user',
                githubLogin: typeof profile.login === 'string' ? `@${profile.login}` : `GitHub account ${accountId}`,
                email: linking ? linking.user.email.trim().toLowerCase() : hint.success ? hint.data : null,
                callbackURL: state.callbackURL,
                oauthQuery: typeof state.serverContext?.githubEmailQuery === 'string' ? state.serverContext.githubEmailQuery : null,
                requestSignUp: state.requestSignUp === true,
              };
              await adapter.createVerificationValue({ identifier: `github-email:${await digest(browser)}`, value: JSON.stringify(pending), expiresAt: new Date(Date.now() + TTL) });
              const cookie = ctx.context.createAuthCookie('github_email', { maxAge: TTL / 1000 });
              ctx.setCookie(cookie.name, browser, cookie.attributes);
              throw ctx.redirect(`${new URL(opts.baseURL).origin}/github-email`);
            },
          });
        }),
      }],
    },
    endpoints: {
      githubEmailStatus: status,
      githubEmailSend: createAuthEndpoint('/github-email/send', { method: 'POST', body: z.object({ email: address }) }, async (ctx) => {
        const browser = ctx.getCookie(cookieName(ctx));
        const pendingKey = browser ? `github-email:${await digest(browser)}` : '';
        const row = pendingKey && await ctx.context.internalAdapter.findVerificationValue(pendingKey);
        if (!row || new Date(row.expiresAt).getTime() <= Date.now()) throw new APIError('BAD_REQUEST', { message: 'This GitHub sign-in expired. Sign in again.' });
        const pending = JSON.parse(row.value) as Pending;
        const adapter = ctx.context.internalAdapter;
        if (pending.linkSessionId && ctx.body.email !== pending.email) throw new APIError('FORBIDDEN', { message: 'Verify your existing account email before connecting GitHub.' });
        const existing = await adapter.findUserByEmail(ctx.body.email);
        if (existing && existing.user.id !== pending.userId) throw new APIError('CONFLICT', { message: 'This email already has an account. Sign in with its existing method and connect GitHub under Sign-in methods.' });
        // One reservation per GitHub account, good for a minute from the send: a live one is never
        // replaced, so no clock edge lets two sends through. A lapsed one is deleted by a
        // conditional delete, which cannot remove a reservation another request just made.
        const cooldownKey = `github-email-send:${pending.accountId}`;
        await ctx.context.adapter.deleteMany({ model: 'verification', where: [
          { field: 'identifier', value: cooldownKey },
          { field: 'expiresAt', value: new Date(), operator: 'lt' },
        ] });
        if (!await adapter.reserveVerificationValue({ identifier: cooldownKey, value: 'sent', expiresAt: new Date(Date.now() + SEND_COOLDOWN_MS) })) throw new APIError('TOO_MANY_REQUESTS', { message: 'Wait a minute before requesting another email.' });
        const token = secret();
        const key = `github-email-proof:${await digest(token)}`;
        await adapter.createVerificationValue({ identifier: key, value: JSON.stringify({ pendingKey, email: ctx.body.email }), expiresAt: row.expiresAt });
        try {
          const sent = await opts.transport.send(githubEmailVerification({ to: ctx.body.email, from: opts.sender, name: pending.githubLogin, url: `${new URL(opts.baseURL).origin}/github-email#token=${token}` }));
          if (sent.bounced.includes(ctx.body.email)) throw new Error('Verification bounced');
        } catch {
          await adapter.deleteVerificationByIdentifier(key);
          throw new APIError('SERVICE_UNAVAILABLE', { message: 'The verification email could not be sent. Try again shortly.' });
        }
        return ctx.json({ sent: true });
      }),
      githubEmailVerify: createAuthEndpoint('/github-email/verify', { method: 'POST', body: z.object({ token: z.string().min(64).max(200), oauth_query: z.string().optional() }) }, async (ctx) => {
        const adapter = ctx.context.internalAdapter;
        const browser = ctx.getCookie(cookieName(ctx));
        if (!browser) throw new APIError('BAD_REQUEST', { message: 'Open this verification link in the browser where you signed in with GitHub.' });
        const pendingKey = `github-email:${await digest(browser)}`;
        const row = await adapter.findVerificationValue(pendingKey);
        if (!row || new Date(row.expiresAt).getTime() <= Date.now()) throw new APIError('BAD_REQUEST', { message: 'This GitHub sign-in expired. Sign in again.' });
        const pending = JSON.parse(row.value) as Pending;
        const provider = ctx.context.socialProviders.find((p) => p.id === 'github');
        if (!provider || (!pending.userId && (provider.options?.disableSignUp || (provider.disableImplicitSignUp && !pending.requestSignUp)))) {
          throw new APIError('FORBIDDEN', { message: 'GitHub sign-up is no longer available. Use an existing sign-in method.' });
        }
        if ((ctx.body.oauth_query ?? null) !== pending.oauthQuery) throw new APIError('BAD_REQUEST', { message: 'The sign-in request changed. Sign in again.' });
        const key = `github-email-proof:${await digest(ctx.body.token)}`;
        // Check the browser before consuming, so a forwarded link cannot invalidate its owner.
        const proofRow = await adapter.findVerificationValue(key);
        if (!proofRow || new Date(proofRow.expiresAt).getTime() <= Date.now()) throw new APIError('BAD_REQUEST', { message: 'This verification link is invalid or expired.' });
        const proof = JSON.parse(proofRow.value) as { pendingKey: string; email: string };
        if (proof.pendingKey !== pendingKey) throw new APIError('BAD_REQUEST', { message: 'Open this link in the browser where you signed in with GitHub.' });
        const owner = await adapter.findAccountOwnerByKey({ providerId: 'github', accountId: pending.accountId });
        if (owner?.kind === 'orphaned' || (pending.linkSessionId ? owner?.kind === 'owned' && owner.user.id !== pending.userId : owner?.user.id !== pending.userId)) throw new APIError('CONFLICT', { message: 'This GitHub account changed. Sign in again.' });
        if (pending.linkSessionId) {
          const linking = await getSessionFromCtx(ctx);
          if (ctx.context.options.account?.accountLinking?.enabled === false || !linking || linking.session.id !== pending.linkSessionId || linking.user.id !== pending.userId || linking.user.email.trim().toLowerCase() !== proof.email || Date.now() - new Date(linking.session.createdAt).getTime() > TTL || linking.session.impersonatedBy) throw new APIError('FORBIDDEN', { message: 'Sign in again with your existing method before connecting GitHub.' });
        }
        const existing = await adapter.findUserByEmail(proof.email);
        if (existing && existing.user.id !== pending.userId) throw new APIError('CONFLICT', { message: 'This email already has an account. Sign in with its existing method and connect GitHub under Sign-in methods.' });
        if (owner?.kind === 'owned') {
          const user = owner.user as typeof owner.user & { banned?: boolean; banExpires?: Date | string | number | null };
          const banExpired = user.banExpires && new Date(user.banExpires).getTime() < Date.now();
          if (user.banned && !banExpired) throw new APIError('FORBIDDEN', { message: 'This account is disabled.' });
          if (user.email.trim().toLowerCase() !== proof.email) {
            // A primary-email change affects every RP sharing this user id. An
            // unrestricted RP (or issuer login) must not erase another RP's SSO route.
            for (let offset = 0; ; offset += 100) {
              const clients = await ctx.context.adapter.findMany<{ metadata?: unknown; disabled?: boolean }>({ model: 'oauthClient', limit: 100, offset, sortBy: { field: 'id', direction: 'asc' } });
              for (const client of clients) {
                if (client.disabled) continue;
                const metadata = typeof client.metadata === 'string' ? JSON.parse(client.metadata) as unknown : client.metadata;
                const route = routeFor(sanitizeSignInPolicy((metadata as { signIn?: unknown } | null)?.signIn), user.email);
                if (route && route.provider !== 'github') throw new APIError('FORBIDDEN', { message: 'Use your organization’s required sign-in method to change this account email.' });
              }
              if (clients.length < 100) break;
            }
          }
        }
        if (!await adapter.consumeVerificationValue(key) || !await adapter.consumeVerificationValue(pendingKey)) throw new APIError('BAD_REQUEST', { message: 'This verification link has already been used.' });
        const current = await adapter.findAccountByKey({ providerId: 'github', accountId: pending.accountId });
        if (pending.linkSessionId ? current && current.userId !== pending.userId : current?.userId !== pending.userId) throw new APIError('CONFLICT', { message: 'This GitHub account changed. Sign in again.' });
        const user = pending.userId
          ? await adapter.updateUser(pending.userId, { email: proof.email, emailVerified: true })
          : await adapter.createUser({ name: pending.name, email: proof.email, emailVerified: true }, { method: 'oauth', oauth: { providerId: 'github', profile: { id: pending.accountId } } });
        if (!current) {
          try {
            // The database's unique (providerId, accountId) key arbitrates concurrent flows.
            await adapter.linkAccount({ providerId: 'github', accountId: pending.accountId, userId: user.id });
          } catch {
            if (!pending.userId) await adapter.deleteUser(user.id);
            throw new APIError('CONFLICT', { message: 'This GitHub account changed. Sign in again.' });
          }
        }
        // Rotating all issuer sessions prevents old sessions retaining the previous address.
        await adapter.deleteUserSessions(user.id);
        const session = await adapter.createSession(user.id);
        if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create a session. Sign in again.' });
        await setSessionCookie(ctx, { session, user });
        const cookie = ctx.context.createAuthCookie('github_email', { maxAge: 0 });
        ctx.setCookie(cookie.name, '', cookie.attributes);
        return ctx.json({ url: pending.callbackURL });
      }),
    },
  } satisfies BetterAuthPlugin;
};
