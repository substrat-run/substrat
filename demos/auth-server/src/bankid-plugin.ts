import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import {
  animatedQr,
  autoStartUrl,
  cancelOrder,
  collectOrder,
  startOrder,
  BankIdApiError,
  type BankIdTransport,
} from './bankid.js';

/**
 * The BankID sign-in flow, as a Better Auth plugin — four endpoints under the issuer's own
 * `/api/auth` surface:
 *
 *   POST /bankid/start     start an order; returns the first QR frame + the same-device URL
 *   POST /bankid/qr        the current QR frame for a pending order (the SPA re-draws each second)
 *   POST /bankid/collect   poll BankID; on completion, sign the verified person in
 *   POST /bankid/cancel    abandon an order (the user pressed back)
 *
 * A plugin rather than routes beside Better Auth, because completing the flow has to END in a
 * Better Auth session, and `setSessionCookie` + the internal adapter are only honest from
 * inside one. Two things come along for free that routes outside would have to reimplement:
 *
 *  - The `admin` plugin's ban check is a database hook on session CREATION, so a banned user's
 *    completed BankID order is refused exactly as their password would be.
 *  - `oauthProvider`'s resume hooks are generic: its before-hook stashes a signed
 *    `oauth_query` from ANY endpoint body, and its after-hook re-runs authorize on ANY
 *    response that sets a session cookie. So `collect` carrying `oauth_query` hands someone a
 *    relying party sent here straight back to that app's callback — the same #898 contract the
 *    password path keeps, with no BankID-specific resume code at all.
 *
 * The pending order's QR material lives in Better Auth's own `verification` table (as SIWE
 * nonces do), keyed `bankid:{orderRef}`, so no schema changes and expiry is the store's own.
 * `qrStartSecret` never reaches the browser: the RP computes each frame, per BankID's
 * guidelines — a client that could compute frames could keep a dead order looking alive.
 *
 * The identity key is the personal number, stored as the `account` row's `accountId` under
 * provider `bankid` — sign in twice, land in the same account. A first sign-in creates the
 * user only when the operator allowed it (`allowSignup` in the panel); otherwise it is
 * refused with a message that says an administrator has to link them, because BankID gives
 * us no email to match an existing account by.
 */

export interface BankIdPluginOptions {
  apiUrl: string;
  transport: BankIdTransport;
  /** May a completed order that matches no account create one? The panel's toggle. */
  allowSignup: boolean;
}

/** Mirrors Better Auth's `createLocalAccountIssuer('bankid')` — the helper is not exported
 *  from a public subpath, and the encoding is the identity for a plain lowercase id. */
const ISSUER = 'local:bankid';

const orderKey = (orderRef: string): string => `bankid:${orderRef}`;

/** Longer than BankID's own order lifetime (the app-start window is 30 s, a started order
 *  three minutes), so the store never expires an order BankID still considers live. */
const ORDER_TTL_MS = 6 * 60_000;

interface PendingOrder {
  qrStartToken: string;
  qrStartSecret: string;
  startedAt: number;
}

const orderBody = z.object({
  orderRef: z.string().min(1),
  /** The pending authorize request, for `oauthProvider`'s resume hooks — see the header. */
  oauth_query: z.string().optional(),
});

export const bankidPlugin = (opts: BankIdPluginOptions) => {
  const readOrder = async (
    ctx: { context: { internalAdapter: { findVerificationValue(id: string): Promise<{ value: string; expiresAt: Date } | null> } } },
    orderRef: string,
  ): Promise<PendingOrder> => {
    const row = await ctx.context.internalAdapter.findVerificationValue(orderKey(orderRef));
    if (!row || new Date(row.expiresAt).getTime() < Date.now()) {
      throw new APIError('NOT_FOUND', { message: 'unknown or expired BankID order' });
    }
    return JSON.parse(row.value) as PendingOrder;
  };

  const rpError = (e: unknown): never => {
    if (e instanceof BankIdApiError) {
      // `alreadyInProgress` means a live order for the same person — a user error worth
      // words; everything else is the operator's certificate or BankID itself.
      throw new APIError('BAD_REQUEST', { message: e.message });
    }
    throw e;
  };

  return {
    id: 'bankid',
    endpoints: {
      bankidStart: createAuthEndpoint(
        '/bankid/start',
        { method: 'POST', body: z.object({}).optional(), requireRequest: true },
        async (ctx) => {
          // BankID requires the END USER's address as the RP sees it (their fraud signal,
          // not ours). Behind Cloudflare that is `cf-connecting-ip`; behind a proxy the
          // first `x-forwarded-for` hop; a local dev request has only its own socket.
          const headers = ctx.request?.headers;
          const endUserIp =
            headers?.get('cf-connecting-ip') ??
            headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ??
            '127.0.0.1';
          const order = await startOrder(opts.transport, opts.apiUrl, { endUserIp }).catch(rpError);
          const startedAt = Date.now();
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: orderKey(order.orderRef),
            value: JSON.stringify({
              qrStartToken: order.qrStartToken,
              qrStartSecret: order.qrStartSecret,
              startedAt,
            } satisfies PendingOrder),
            expiresAt: new Date(startedAt + ORDER_TTL_MS),
          });
          return ctx.json({
            orderRef: order.orderRef,
            autoStartUrl: autoStartUrl(order.autoStartToken),
            qr: await animatedQr(order.qrStartToken, order.qrStartSecret, 0),
          });
        },
      ),

      bankidQr: createAuthEndpoint(
        '/bankid/qr',
        { method: 'POST', body: z.object({ orderRef: z.string().min(1) }) },
        async (ctx) => {
          const order = await readOrder(ctx, ctx.body.orderRef);
          const seconds = Math.max(0, Math.floor((Date.now() - order.startedAt) / 1000));
          return ctx.json({ qr: await animatedQr(order.qrStartToken, order.qrStartSecret, seconds) });
        },
      ),

      bankidCollect: createAuthEndpoint(
        '/bankid/collect',
        { method: 'POST', body: orderBody },
        async (ctx) => {
          // Refuse unknown orders before calling out: `collect` on an arbitrary orderRef
          // would otherwise let anyone use this issuer as a proxy onto BankID's API.
          await readOrder(ctx, ctx.body.orderRef);
          const result = await collectOrder(opts.transport, opts.apiUrl, ctx.body.orderRef).catch(rpError);

          if (result.status === 'pending') {
            return ctx.json({ status: 'pending' as const, hintCode: result.hintCode ?? null });
          }
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(orderKey(ctx.body.orderRef));
          if (result.status === 'failed' || !result.completionData) {
            return ctx.json({ status: 'failed' as const, hintCode: result.hintCode ?? null });
          }

          const who = result.completionData.user;
          const account = await ctx.context.internalAdapter.findAccountByKey({
            issuer: ISSUER,
            accountId: who.personalNumber,
          });
          let user = account ? await ctx.context.internalAdapter.findUserById(account.userId) : null;
          if (!user) {
            if (!opts.allowSignup) {
              throw new APIError('FORBIDDEN', {
                message:
                  'This BankID is not linked to an account here. Ask an administrator to create one, or allow BankID to create accounts.',
              });
            }
            // BankID asserts identity, not an email address, so the account gets the same
            // placeholder shape Better Auth's other identity-only sign-ins mint. The name is
            // the verified one from the completion data.
            user = await ctx.context.internalAdapter.createUser(
              {
                name: who.name,
                email: `${who.personalNumber}@bankid.placeholder.invalid`,
                emailVerified: false,
              },
              { method: 'bankid' },
            );
            await ctx.context.internalAdapter.linkAccount({
              userId: user.id,
              providerId: 'bankid',
              issuer: ISSUER,
              accountId: who.personalNumber,
            });
          }
          // The `admin` plugin's banned check runs inside this create, so a banned user is
          // refused here with its own FORBIDDEN — completed order or not.
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'could not create a session' });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ status: 'complete' as const, hintCode: null });
        },
      ),

      bankidCancel: createAuthEndpoint(
        '/bankid/cancel',
        { method: 'POST', body: z.object({ orderRef: z.string().min(1) }) },
        async (ctx) => {
          // Verify the order is ours before relaying the cancel — same proxy argument as
          // `collect` — then drop it locally whatever BankID says: the user already left.
          await readOrder(ctx, ctx.body.orderRef);
          await cancelOrder(opts.transport, opts.apiUrl, ctx.body.orderRef).catch(() => undefined);
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(orderKey(ctx.body.orderRef));
          return ctx.json({ cancelled: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
};
