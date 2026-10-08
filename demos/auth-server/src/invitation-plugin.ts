import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import type { EmailAddress, EmailTransport } from '@substrat-run/adapter-email';
import { invitationEmail } from './email.js';

async function digest(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Auth account invitations. Membership/role invitations remain the vertical's concern.
 * The emailed single-use capability proves the address before either identity is linked. */
export const invitationPlugin = (opts: { transport: EmailTransport; sender: EmailAddress; baseURL: string }) => ({
  id: 'account-invitations',
  endpoints: {
    createAccountInvitation: createAuthEndpoint('/invitation/create', {
      method: 'POST', use: [sessionMiddleware], body: z.object({ email: z.string().email(), name: z.string().min(1).max(200) }),
    }, async (ctx) => {
      if ((ctx.context.session.user as Record<string, unknown>).role !== 'admin') throw new APIError('FORBIDDEN', { message: 'Administrators only' });
      const adapter = ctx.context.internalAdapter;
      const email = ctx.body.email.trim().toLowerCase();
      const existing = await adapter.findUserByEmail(email, { includeAccounts: true });
      // Invitations never replace credentials or recover an existing account.
      if (existing && (existing.user.emailVerified || existing.accounts.length || (existing.user as Record<string, unknown>).role === 'admin')) {
        throw new APIError('CONFLICT', { message: 'This account already exists. Use its existing sign-in method.' });
      }
      const user = existing?.user ?? await adapter.createUser({ email, name: ctx.body.name, emailVerified: false, role: 'user' }, { method: 'invitation' });
      const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const key = `account-invite:${await digest(token)}`;
      await adapter.createVerificationValue({ identifier: key, value: user.id, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) });
      // The token is only delivered by email, never returned to the caller or logged here.
      const url = `${new URL(opts.baseURL).origin}/accept-invitation#token=${token}`;
      try {
        const sent = await opts.transport.send(invitationEmail({ to: email, from: opts.sender, url }));
        if (sent.bounced.includes(email)) throw new Error('Invitation bounced');
      } catch {
        await adapter.deleteVerificationByIdentifier(key);
        throw new APIError('SERVICE_UNAVAILABLE', { message: 'The invitation email could not be sent' });
      }
      return ctx.json({ invited: true });
    }),
    acceptAccountInvitation: createAuthEndpoint('/invitation/accept', {
      method: 'POST', body: z.object({ token: z.string().min(64).max(200) }),
    }, async (ctx) => {
      const adapter = ctx.context.internalAdapter;
      const invite = await adapter.consumeVerificationValue(`account-invite:${await digest(ctx.body.token)}`);
      if (!invite) throw new APIError('BAD_REQUEST', { message: 'This invitation is invalid or expired' });
      const user = await adapter.findUserById(invite.value);
      if (!user || user.emailVerified || (await adapter.findAccounts(user.id)).length || (user as Record<string, unknown>).role === 'admin') {
        throw new APIError('FORBIDDEN', { message: 'This account is already set up. Sign in with its existing method.' });
      }
      const updated = await adapter.updateUser(user.id, { emailVerified: true });
      const session = await adapter.createSession(user.id);
      if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create a setup session' });
      await setSessionCookie(ctx, { session, user: updated });
      return ctx.json({ email: updated.email });
    }),
    invitationPassword: createAuthEndpoint('/invitation/password', {
      method: 'POST', use: [sessionMiddleware], body: z.object({ password: z.string().min(8).max(128) }),
    }, async (ctx) => {
      const { session, user } = ctx.context.session;
      if ((session as Record<string, unknown>).signInProvider !== 'invitation' || !user.emailVerified || Date.now() - new Date(session.createdAt).getTime() > 10 * 60_000) {
        throw new APIError('FORBIDDEN', { message: 'Open your invitation to set up this account' });
      }
      const adapter = ctx.context.internalAdapter;
      if ((await adapter.findAccounts(user.id)).length) throw new APIError('CONFLICT', { message: 'This account already has a sign-in method' });
      // One invitation setup can win, even when submitted concurrently.
      if (!await adapter.reserveVerificationValue({ identifier: `invite-password:${user.id}`, value: 'set', expiresAt: new Date(Date.now() + 24 * 60 * 60_000) })) {
        throw new APIError('CONFLICT', { message: 'Password setup is already in progress' });
      }
      try {
        await adapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: await ctx.context.password.hash(ctx.body.password) });
      } catch (error) {
        await adapter.deleteVerificationByIdentifier(`invite-password:${user.id}`).catch(() => {
          console.error('Could not release failed invite-password reservation');
        });
        throw error;
      }
      const next = await adapter.createSession(user.id);
      if (!next) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create a session' });
      await adapter.deleteSession(session.token);
      await setSessionCookie(ctx, { session: next, user });
      return ctx.json({ configured: true });
    }),
  },
}) satisfies BetterAuthPlugin;
