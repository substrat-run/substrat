/**
 * The link-share exchange (#1672) — the HTTP half of a capability, authored once.
 *
 * A capability is minted inside an operation (`ctx.capabilities.mint`) and handed back as a
 * secret. The secret is the credential, so it must be presented ONCE and then leave: a
 * secret that lives in a URL lives in browser history, in the `Referer` of every request the
 * page makes, and in every log line that records a path. This module is the one place that
 * trades it for something that does not travel — an HttpOnly session cookie — so no
 * vertical hand-rolls that step, and none gets it subtly wrong.
 *
 * **The link carries the secret in its FRAGMENT**, `https://<host>/#share=<secret>`. A
 * fragment is never sent to a server, so it is in no router log, no invocation log and no
 * `Referer`; and a mail scanner or chat unfurler that fetches the URL cannot spend a
 * single-use link, because what it fetches carries no secret. The page reads the fragment,
 * drops it from history, and posts it here:
 *
 * ```ts
 * const m = location.hash.match(/(?:^#|&)share=([^&]+)/);
 * if (m) {
 *   history.replaceState(null, '', location.pathname + location.search); // gone before the call
 *   await fetch('/api/capability/exchange', {
 *     method: 'POST',
 *     headers: { 'content-type': 'application/json' },
 *     body: JSON.stringify({ secret: decodeURIComponent(m[1]) }),
 *   });
 * }
 * ```
 *
 * The route answers with the session in `Set-Cookie` only (never in the body), `no-store`,
 * and `Referrer-Policy: no-referrer`. From then on a link-share route resolves its stub with
 * `linkShareStub` — the capability FIRST, then a signed-in principal — and every call acts
 * as `{ capability }`, resolved by the checker against the capability's own row on every
 * call, so a revoke is the next call.
 *
 * **Only `act` capabilities are exchanged here.** A `become` secret (a claim link) answers
 * 404 and is NOT spent, so pasting a claim link into a share page cannot burn it.
 *
 * **A JSON content type is required**, so a cross-site page cannot plant its own link's
 * session in a visitor's browser with a plain form post: `application/json` is not a CORS
 * "simple" type, so the browser asks first, and this origin does not say yes.
 *
 * Rate limiting the exchange is the neighbouring control and is not here (#130). With 256
 * bits of entropy a secret cannot be guessed; what a limit would bound is load.
 */
import type { Context, Env, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { substratError, z, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { ScopeHost, ScopeStub, ScopeStubOptions } from '@substrat-run/kernel';
import { problemResponse } from './errors.js';

/** The cookie a capability session rides in. Named beside oidc-rp's `sb_session`. */
export const CAPABILITY_COOKIE = 'sb_capability';
/** Where `mountCapabilityExchange` listens unless told otherwise. */
export const CAPABILITY_EXCHANGE_PATH = '/api/capability/exchange';

type Awaitable<T> = T | Promise<T>;

/** The scope a request is for — the router-asserted (tenant, scope) the vertical already resolves. */
export interface CapabilityNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

export interface CapabilityExchangeOptions<E extends Env = Env> {
  /** The host serving the scope. Taken structurally — any host with the exchange verb. */
  host: (c: Context<E>) => Awaitable<Pick<ScopeHost, 'exchangeCapability'>>;
  /** Which scope this request is for. */
  node: (c: Context<E>) => Awaitable<CapabilityNode>;
  /** Defaults to `CAPABILITY_EXCHANGE_PATH`. */
  path?: string;
  /** Defaults to `CAPABILITY_COOKIE`. */
  cookieName?: string;
}

const exchangeBody = z.object({ secret: z.string().min(1).max(256) });

/** One refusal for every way an exchange can fail, so a probe learns nothing it can act on. */
const invalidLink = () => substratError('not_found', 'This link is not valid, or no longer is.');

/**
 * Mount `POST <path>`: trade a link's secret for an HttpOnly session cookie.
 *
 * 200 `{ capabilityId, entity, expiresAt }` — what the page needs to know where it is — and
 * the session in `Set-Cookie` alone. 404 for an unknown, expired, revoked or used-up secret
 * and for a `become` secret, all alike. 400 (`validation_failed`) without a JSON content type.
 */
export function mountCapabilityExchange<E extends Env>(
  app: Hono<E>,
  options: CapabilityExchangeOptions<E>,
): void {
  const path = options.path ?? CAPABILITY_EXCHANGE_PATH;
  const cookieName = options.cookieName ?? CAPABILITY_COOKIE;
  app.post(path, async (c) => {
    // Before anything can fail: nothing about this exchange may be cached, and the page
    // that posted it must not hand its own URL onwards.
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    try {
      if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        throw substratError('validation_failed', 'the exchange takes a JSON body: { "secret": "…" }');
      }
      const parsed = exchangeBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw invalidLink();
      const node = await options.node(c);
      const host = await options.host(c);
      const outcome = await host.exchangeCapability(node.tenantId, node.scopeId, parsed.data.secret, {
        mode: 'act',
      });
      if (!outcome || outcome.kind !== 'session') throw invalidLink();
      const maxAge = Math.max(0, Math.floor((Date.parse(outcome.expiresAt) - Date.now()) / 1000));
      setCookie(c, cookieName, outcome.sessionToken, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        secure: new URL(c.req.url).protocol === 'https:',
        maxAge,
      });
      return c.json({
        capabilityId: outcome.capabilityId,
        entity: outcome.entity,
        expiresAt: outcome.expiresAt,
      });
    } catch (err) {
      return problemResponse(c, err);
    }
  });
}

/** The capability session this request carries, or `undefined`. */
export function capabilitySessionOf(c: Context, cookieName: string = CAPABILITY_COOKIE): string | undefined {
  return getCookie(c, cookieName) || undefined;
}

/**
 * The stub a request's capability session acts through, or `undefined` when it carries
 * none. The session is resolved on every invoke through the stub, not here, so a stub
 * obtained before a revoke refuses the call after it. A link-share route wants
 * `linkShareStub`, which also says what happens when the visitor is signed in.
 */
export async function capabilityStubOf(
  c: Context,
  host: Pick<ScopeHost, 'getCapabilityScope'>,
  node: CapabilityNode,
  options?: ScopeStubOptions & { cookieName?: string },
): Promise<ScopeStub | undefined> {
  const token = capabilitySessionOf(c, options?.cookieName);
  return token ? host.getCapabilityScope(token, node.tenantId, node.scopeId, options) : undefined;
}

/**
 * The stub a LINK-SHARE route acts through: **the capability first, then the principal.**
 *
 * On a route a link share serves, a presented capability wins over a signed-in principal.
 * The other order ignores the link whenever the browser happens to be signed in: a
 * recipient who is signed in but holds no access of their own would act as themselves, and
 * the shared folder would answer 403 — the opposite of "whoever holds the link". With no
 * capability cookie, `principal` decides, exactly as a route without link shares would.
 *
 * ```ts
 * const stub = await linkShareStub(c, host, node, () => principalStubOf(c)); // yours
 * ```
 *
 * The flip side of the precedence: a capability cookie that has gone stale (the link was
 * revoked, or its session expired) refuses every call on such a route as `unauthenticated`,
 * even for a visitor who is signed in. A page that sees that — or that is done with a
 * link — calls `clearCapabilitySession`, and the principal decides again.
 */
export async function linkShareStub(
  c: Context,
  host: Pick<ScopeHost, 'getCapabilityScope'>,
  node: CapabilityNode,
  principal: () => Awaitable<ScopeStub | undefined>,
  options?: ScopeStubOptions & { cookieName?: string },
): Promise<ScopeStub | undefined> {
  return (await capabilityStubOf(c, host, node, options)) ?? (await principal());
}

/** Forget this browser's capability session — so a signed-in visitor acts as themselves again. */
export function clearCapabilitySession(c: Context, cookieName: string = CAPABILITY_COOKIE): void {
  deleteCookie(c, cookieName, { path: '/' });
}
