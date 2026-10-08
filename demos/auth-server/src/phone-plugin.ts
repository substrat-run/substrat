import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import type { PhoneVerifier } from './twilio.js';

const phoneNumber = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use an international phone number, such as +46701234567');
const FRESH_MS = 10 * 60_000;

/** Fresh password sessions may enroll or step up. Other methods and impersonation do
 * not prove the password; a registered phone cannot be replaced through this flow. */
export const phonePlugin = (verifier: PhoneVerifier | undefined) => ({
  id: 'phone-factor',
  endpoints: {
    phoneStatus: createAuthEndpoint('/phone/status', { method: 'GET', use: [sessionMiddleware] }, async (ctx) => {
      const user = ctx.context.session.user as typeof ctx.context.session.user & { phoneNumber?: string };
      return ctx.json({ available: Boolean(verifier), enrolled: Boolean(user.phoneNumber), emailVerified: user.emailVerified, suffix: user.phoneNumber?.slice(-4) ?? null });
    }),
    phoneSend: createAuthEndpoint('/phone/send', {
      method: 'POST', use: [sessionMiddleware], body: z.object({ phoneNumber: phoneNumber.optional() }),
    }, async (ctx) => {
      if (!verifier) throw new APIError('SERVICE_UNAVAILABLE', { message: 'SMS verification is not configured' });
      const { session, user } = ctx.context.session;
      const method = (session as Record<string, unknown>).signInProvider;
      if (method !== 'password' || Date.now() - new Date(session.createdAt).getTime() > FRESH_MS) {
        throw new APIError('FORBIDDEN', { message: 'Sign in again with your password before verifying your phone' });
      }
      const enrolled = (user as Record<string, unknown>).phoneNumber as string | undefined;
      // Once enrolled, the caller cannot replace the factor by supplying a different number.
      if (enrolled && ctx.body.phoneNumber && ctx.body.phoneNumber !== enrolled) {
        throw new APIError('FORBIDDEN', { message: 'Use your registered phone number' });
      }
      if (!enrolled && !user.emailVerified) throw new APIError('FORBIDDEN', { message: 'Verify your email before registering a phone' });
      const phone = enrolled ?? ctx.body.phoneNumber;
      if (!phone) throw new APIError('BAD_REQUEST', { message: 'A phone number is required' });
      const adapter = ctx.context.internalAdapter;
      // Atomic account-wide cooldown, including parallel requests and different sessions.
      const reserved = await adapter.reserveVerificationValue({
        identifier: `phone-send:${user.id}:${Math.floor(Date.now() / 60_000)}`,
        value: 'sent', expiresAt: new Date(Date.now() + 2 * 60_000),
      });
      if (!reserved) throw new APIError('TOO_MANY_REQUESTS', { message: 'Wait a minute before requesting another code' });
      await verifier.send(phone).catch(() => {
        throw new APIError('SERVICE_UNAVAILABLE', { message: 'SMS verification is unavailable. Please try again later.' });
      });
      await adapter.deleteVerificationByIdentifier(`phone-challenge:${session.id}`);
      await adapter.createVerificationValue({ identifier: `phone-challenge:${session.id}`, value: JSON.stringify({ phone, enrolled: Boolean(enrolled) }), expiresAt: new Date(Date.now() + FRESH_MS) });
      return ctx.json({ sent: true, suffix: phone.slice(-4) });
    }),
    phoneVerify: createAuthEndpoint('/phone/verify', {
      method: 'POST', use: [sessionMiddleware], body: z.object({ code: z.string().regex(/^\d{4,10}$/), oauth_query: z.string().optional() }),
    }, async (ctx) => {
      if (!verifier) throw new APIError('SERVICE_UNAVAILABLE', { message: 'SMS verification is not configured' });
      const { session, user } = ctx.context.session;
      const adapter = ctx.context.internalAdapter;
      const key = `phone-challenge:${session.id}`;
      const challenge = await adapter.findVerificationValue(key);
      if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now()) throw new APIError('BAD_REQUEST', { message: 'Request a new SMS code' });
      const { phone, enrolled } = JSON.parse(challenge.value) as { phone: string; enrolled: boolean };
      // Account-wide attempt budget; opening another session does not reset it.
      let allowed = false;
      for (let i = 0; i < 5; i++) {
        if (await adapter.reserveVerificationValue({ identifier: `phone-attempt:${user.id}:${Math.floor(Date.now() / FRESH_MS)}:${i}`, value: 'attempt', expiresAt: new Date(Date.now() + 2 * FRESH_MS) })) { allowed = true; break; }
      }
      if (!allowed) throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many attempts. Try again in ten minutes.' });
      const approved = await verifier.check(phone, ctx.body.code).catch(() => {
        throw new APIError('SERVICE_UNAVAILABLE', { message: 'SMS verification is unavailable. Please try again later.' });
      });
      if (!approved) throw new APIError('BAD_REQUEST', { message: 'Invalid or expired SMS code' });
      const consumed = await adapter.consumeVerificationValue(key);
      if (!consumed || consumed.value !== challenge.value) throw new APIError('BAD_REQUEST', { message: 'This code has already been used or replaced' });
      const current = await adapter.findUserById(user.id);
      const currentPhone = (current as Record<string, unknown> | null)?.phoneNumber;
      if ((enrolled && currentPhone !== phone) || (!enrolled && currentPhone && currentPhone !== phone)) {
        throw new APIError('FORBIDDEN', { message: 'Your registered phone changed. Sign in again.' });
      }
      if (!enrolled && !await adapter.reserveVerificationValue({ identifier: `phone-enrollment:${user.id}`, value: 'enrolled', expiresAt: new Date(Date.now() + 24 * 60 * 60_000) })) {
        throw new APIError('CONFLICT', { message: 'Phone enrollment is already in progress. Sign in again.' });
      }
      const updatedUser = enrolled ? user : await adapter.updateUser(user.id, { phoneNumber: phone });
      // Rotate, rather than upgrade the old password token: possession of that old token
      // must not become possession of a completed second factor.
      const updatedSession = await adapter.createSession(user.id);
      if (!updatedSession) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create a session' });
      await adapter.deleteSession(session.token);
      await setSessionCookie(ctx, { session: updatedSession, user: updatedUser });
      return ctx.json({ verified: true });
    }),
  },
}) satisfies BetterAuthPlugin;
