import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import type { EmailAddress, EmailTransport } from '@substrat-run/adapter-email';
import type { MergeOutcome } from './account-merge.js';
import { bankidEmailCode, bankidJoinedNotice, type MailStyle } from './email.js';
import { isPlaceholderAddress } from './placeholder-address.js';

/**
 * The address a BankID sign-in has to prove before it becomes an account (#2939, #2940).
 *
 * BankID asserts a person and carries no address, so `/bankid/collect` parks the verified
 * identity here rather than minting a placeholder, and this step decides where it lands once
 * the person proves an address with an emailed code. The address is what joins two halves of
 * one person: someone who proves an address already in use has proven both sides.
 *
 * The personal number stays in the `verification` row. The browser holds a random token, kept
 * here only as a hash, which goes back to whoever completed the order.
 *
 * `/bankid/email/send` looks nothing up, so its answer and its timing say nothing about whether
 * an address has an account. Only `/bankid/email/verify`, past the code, says so.
 *
 * An emailed code is the whole proof here, so it may only join an account that an emailed link
 * could already take over: see `joinRefusal`. Everything stronger is joined by signing in first
 * and connecting BankID from `/account`, where a session is the proof of that side.
 */

export interface BankIdEmailStepOptions {
  mailStyle?: (headers?: Headers | null) => MailStyle;
  transport: EmailTransport;
  sender: EmailAddress;
  /** May a proven address that matches nothing create an account? */
  allowSignup: boolean;
  /** `ACCOUNT_LINKING`: may a proven address join an account that already holds it? */
  autoLinkAccounts: boolean;
  /** Join a placeholder account to another, in one transaction (`account-merge.ts`). */
  merge(placeholderId: string, otherId: string): MergeOutcome;
}

export interface ParkedIdentity {
  personalNumber: string;
  name: string;
  /** Set when the person already has a placeholder account: the step replaces its address. */
  userId?: string;
}

const PROVIDER_ID = 'bankid';
const STEP_TTL_MS = 10 * 60_000;
const SEND_COOLDOWN_MS = 60_000;
const MAX_SENDS = 5;
const MAX_ATTEMPTS = 5;
/** How often an existing placeholder account may put this off, so a mail outage is no lockout. */
const MAX_SKIPS = 3;
const SKIP_TTL_MS = 5 * 365 * 24 * 60 * 60_000;

const SIGN_IN_FIRST = 'This account is protected. Sign in to it first, then connect BankID from your account page.';

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const stepKey = (tokenHash: string): string => `bankid-email:${tokenHash}`;
const challengeKey = (tokenHash: string): string => `bankid-email-challenge:${tokenHash}`;
const skipKey = (userId: string, i: number): string => `bankid-email-skip:${userId}:${i}`;

interface Adapter {
  createVerificationValue(data: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
  findVerificationValue(id: string): Promise<{ value: string; expiresAt: Date } | null>;
}

/** Is a skip left? Read only: the budget is spent by `/bankid/email/skip`. */
async function skipsLeft(adapter: Adapter, userId: string): Promise<boolean> {
  for (let i = 0; i < MAX_SKIPS; i++) {
    if (!await adapter.findVerificationValue(skipKey(userId, i))) return true;
  }
  return false;
}

/** Park a verified identity and answer what the browser needs for the next screen. */
export async function parkIdentity(adapter: Adapter, identity: ParkedIdentity) {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  await adapter.createVerificationValue({
    identifier: stepKey(await digest(token)),
    value: JSON.stringify(identity),
    expiresAt: new Date(Date.now() + STEP_TTL_MS),
  });
  return { status: 'email_required' as const, hintCode: null, token, canSkip: identity.userId ? await skipsLeft(adapter, identity.userId) : false };
}

/** Why an emailed code may not join this account, or null when it may. */
export function joinRefusal(
  existing: { user: Record<string, unknown>; accounts: { providerId: string }[] },
  autoLinkAccounts: boolean,
): string | null {
  const { user, accounts } = existing;
  if (user.banned) return 'This account cannot be used.';
  if (accounts.some((a) => a.providerId === PROVIDER_ID)) return 'This address belongs to an account with another BankID.';
  // Otherwise whoever registered the address without proving it keeps a way in.
  if (!user.emailVerified) return 'This address has an unfinished account. Finish setting it up, then connect BankID from your account page.';
  // An admin is not refused: the code proves what a password reset proves, and this join is
  // announced to the address. A phone is a second factor the code would step around.
  if (!autoLinkAccounts || user.phoneNumber) return SIGN_IN_FIRST;
  return null;
}

const tokenBody = { token: z.string().min(64).max(200) };
/** The pending authorize request, for `oauthProvider`'s resume hooks (`bankid-plugin.ts`). */
const resumeBody = { oauth_query: z.string().optional() };

export const bankidEmailEndpoints = (opts: BankIdEmailStepOptions) => {
  type Ctx = { context: { internalAdapter: Adapter } };

  const readStep = async (ctx: Ctx, token: string): Promise<{ tokenHash: string; identity: ParkedIdentity }> => {
    const tokenHash = await digest(token);
    const row = await ctx.context.internalAdapter.findVerificationValue(stepKey(tokenHash));
    if (!row || new Date(row.expiresAt).getTime() < Date.now()) {
      throw new APIError('BAD_REQUEST', { message: 'This sign-in has expired. Start again with BankID.' });
    }
    return { tokenHash, identity: JSON.parse(row.value) as ParkedIdentity };
  };

  return {
    bankidEmailSend: createAuthEndpoint(
      '/bankid/email/send',
      { method: 'POST', body: z.object({ ...tokenBody, email: z.string().email().max(320) }) },
      async (ctx) => {
        const adapter = ctx.context.internalAdapter;
        const { tokenHash } = await readStep(ctx, ctx.body.token);
        const email = ctx.body.email.trim().toLowerCase();
        if (isPlaceholderAddress(email)) throw new APIError('BAD_REQUEST', { message: 'Enter an address you can receive mail at' });

        // Per address, so nobody uses this to flood one inbox; per step, so one finished order
        // cannot be walked across many inboxes. A lapsed cooldown has to go before it can be
        // reserved again, and the conditional delete cannot remove one another request just made.
        const cooldownKey = `bankid-email-send:${await digest(email)}`;
        await ctx.context.adapter.deleteMany({ model: 'verification', where: [
          { field: 'identifier', value: cooldownKey },
          { field: 'expiresAt', value: new Date(), operator: 'lt' },
        ] });
        if (!await adapter.reserveVerificationValue({ identifier: cooldownKey, value: 'sent', expiresAt: new Date(Date.now() + SEND_COOLDOWN_MS) })) {
          throw new APIError('TOO_MANY_REQUESTS', { message: 'Wait a minute before requesting another code' });
        }
        let allowed = false;
        for (let i = 0; i < MAX_SENDS && !allowed; i++) {
          allowed = Boolean(await adapter.reserveVerificationValue({ identifier: `bankid-email-sends:${tokenHash}:${i}`, value: 'sent', expiresAt: new Date(Date.now() + STEP_TTL_MS) }));
        }
        if (!allowed) throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many codes requested. Start again with BankID.' });

        const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
        await adapter.deleteVerificationByIdentifier(challengeKey(tokenHash));
        await adapter.createVerificationValue({
          identifier: challengeKey(tokenHash),
          value: JSON.stringify({ email, code: await digest(`${tokenHash}:${code}`) }),
          expiresAt: new Date(Date.now() + STEP_TTL_MS),
        });
        try {
          const sent = await opts.transport.send(bankidEmailCode({ to: email, from: opts.sender, code, style: opts.mailStyle?.(ctx.headers) }));
          if (sent.bounced.includes(email)) throw new Error('bounced');
        } catch {
          await adapter.deleteVerificationByIdentifier(challengeKey(tokenHash));
          throw new APIError('SERVICE_UNAVAILABLE', { message: 'The code could not be sent. Check the address and try again.' });
        }
        return ctx.json({ sent: true });
      },
    ),

    bankidEmailVerify: createAuthEndpoint(
      '/bankid/email/verify',
      { method: 'POST', body: z.object({ ...tokenBody, ...resumeBody, code: z.string().regex(/^\d{6}$/) }) },
      async (ctx) => {
        const adapter = ctx.context.internalAdapter;
        const { tokenHash, identity } = await readStep(ctx, ctx.body.token);

        // Per step and never reset by a new code, so more guesses cost a new BankID order.
        let allowed = false;
        for (let i = 0; i < MAX_ATTEMPTS && !allowed; i++) {
          allowed = Boolean(await adapter.reserveVerificationValue({ identifier: `bankid-email-attempt:${tokenHash}:${i}`, value: 'attempt', expiresAt: new Date(Date.now() + STEP_TTL_MS) }));
        }
        if (!allowed) throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many attempts. Start again with BankID.' });

        const row = await adapter.findVerificationValue(challengeKey(tokenHash));
        if (!row || new Date(row.expiresAt).getTime() < Date.now()) throw new APIError('BAD_REQUEST', { message: 'Request a new code' });
        const challenge = JSON.parse(row.value) as { email: string; code: string };
        if (challenge.code !== await digest(`${tokenHash}:${ctx.body.code}`)) throw new APIError('BAD_REQUEST', { message: 'Invalid code' });
        if (!await adapter.consumeVerificationValue(challengeKey(tokenHash))) throw new APIError('BAD_REQUEST', { message: 'This code has already been used' });

        // A refusal leaves the step open, so the person can prove a different address.
        const existing = await adapter.findUserByEmail(challenge.email, { includeAccounts: true });
        if (existing) {
          const refused = joinRefusal(existing as never, opts.autoLinkAccounts);
          if (refused) throw new APIError('CONFLICT', { message: refused });
        } else if (!identity.userId && !opts.allowSignup) {
          throw new APIError('FORBIDDEN', { message: 'There is no account with this address here. Ask an administrator to create one.' });
        }
        if (!await adapter.consumeVerificationValue(stepKey(tokenHash))) throw new APIError('BAD_REQUEST', { message: 'This sign-in has already been used' });

        let userId: string;
        if (identity.userId && existing) {
          const merged = opts.merge(identity.userId, existing.user.id);
          if ('refused' in merged) throw new APIError('CONFLICT', { message: merged.refused });
          userId = merged.survivor;
        } else if (identity.userId) {
          await adapter.updateUser(identity.userId, { email: challenge.email, emailVerified: true });
          userId = identity.userId;
        } else {
          const user = existing?.user ?? await adapter.createUser({ name: identity.name, email: challenge.email, emailVerified: true }, { method: PROVIDER_ID });
          await adapter.linkAccount({ userId: user.id, providerId: PROVIDER_ID, accountId: identity.personalNumber });
          userId = user.id;
        }

        const user = await adapter.findUserById(userId);
        // The `admin` plugin's banned check runs inside this create, as it does in `collect`.
        const session = user && await adapter.createSession(user.id);
        if (!user || !session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'could not create a session' });
        await setSessionCookie(ctx, { session, user });
        // A joined BankID is a lasting way in that a password change does not end, so the
        // address hears about it. The join has happened: a failed notice must not fail the sign-in.
        if (existing) {
          try {
            await opts.transport.send(bankidJoinedNotice({ to: challenge.email, from: opts.sender, style: opts.mailStyle?.(ctx.headers) }));
          } catch {
            // Nothing to undo, and the person is already signed in.
          }
        }
        return ctx.json({ status: 'complete' as const, hintCode: null });
      },
    ),

    bankidEmailSkip: createAuthEndpoint(
      '/bankid/email/skip',
      { method: 'POST', body: z.object({ ...tokenBody, ...resumeBody }) },
      async (ctx) => {
        const adapter = ctx.context.internalAdapter;
        const { tokenHash, identity } = await readStep(ctx, ctx.body.token);
        if (!identity.userId) throw new APIError('FORBIDDEN', { message: 'An email address is required' });
        let allowed = false;
        for (let i = 0; i < MAX_SKIPS && !allowed; i++) {
          allowed = Boolean(await adapter.reserveVerificationValue({ identifier: skipKey(identity.userId, i), value: 'skipped', expiresAt: new Date(Date.now() + SKIP_TTL_MS) }));
        }
        if (!allowed) throw new APIError('FORBIDDEN', { message: 'An email address is required' });
        if (!await adapter.consumeVerificationValue(stepKey(tokenHash))) throw new APIError('BAD_REQUEST', { message: 'This sign-in has already been used' });
        const user = await adapter.findUserById(identity.userId);
        const session = user && await adapter.createSession(user.id);
        if (!user || !session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'could not create a session' });
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ status: 'complete' as const, hintCode: null });
      },
    ),
  };
};
