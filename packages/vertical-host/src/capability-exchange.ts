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
 *
 * **One browser holds several links (#1686).** Each exchange sets a cookie of its own,
 * `sb_capability_<capabilityId>`, so opening a second link no longer drops the first. A page
 * holding several says which one a call acts as — the `capabilityId` the exchange answered
 * with — in the `X-Substrat-Capability` header, or as `?capability=<id>` on a plain link (a
 * download `<a href>` cannot set a header). The name only SELECTS: the session behind it is
 * resolved by the host to its own capability row, so a session for share A acts within A's
 * narrowing whatever it is called, and nothing ever falls back from one session to another.
 * See `capabilitySessionOf` for the selection rule and `CAPABILITY_SESSIONS_MAX` for the cap.
 */
import type { Context, Env, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { substratError, z, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import type { ScopeAttachments, ScopeHost, ScopeStub, ScopeStubOptions } from '@substrat-run/kernel';
import { problemResponse } from './errors.js';

/**
 * The cookie a capability session rides in. Named beside oidc-rp's `sb_session`.
 *
 * Since #1686 this is a PREFIX: an exchange sets `sb_capability_<capabilityId>`, one cookie
 * per link. A bare `sb_capability` cookie is the one-link format set before that, and is
 * still read (see `capabilitySessionOf`), so a browser that exchanged before the deploy keeps
 * working without opening its link again; the next exchange deletes it.
 */
export const CAPABILITY_COOKIE = 'sb_capability';
/**
 * The request header naming which of a browser's capability sessions a call acts as — the
 * `capabilityId` the exchange answered with. `?capability=<id>` says the same on a plain link.
 */
export const CAPABILITY_HEADER = 'x-substrat-capability';
/** The query-string twin of `CAPABILITY_HEADER`, for a link a browser follows unaided. */
export const CAPABILITY_QUERY = 'capability';
/**
 * The most capability sessions one browser holds for one vertical host. An exchange beyond
 * it evicts the OLDEST (by when it was exchanged): that cookie is deleted, a call naming its
 * capability is then refused exactly as a revoked link is (`unauthenticated`), and opening
 * the link again re-exchanges it if it has uses left. The session row itself is not revoked
 * — the browser no longer holds its token, and the row lapses at its own expiry (≤24 h).
 *
 * Why 8, and why a cookie each rather than one cookie holding a set: a cookie is
 * `sb_capability_` + a 26-character id + a ~60-character value — under 100 bytes — so eight
 * are well under 1 KB of `Cookie` header, far from the 4 KB-per-cookie and ~50-per-domain
 * floors RFC 6265 asks browsers to support, with room beside the sign-in session. One cookie
 * per link keeps every attribute (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`) exactly as
 * the one-link cookie had them, lets each expire at its OWN session's end rather than the
 * longest one's, and — the deciding reason — needs no read-modify-write: two links opened at
 * once in two tabs each set their own cookie, where a shared set would be rewritten by
 * whichever response landed last and silently lose the other, the bug this replaces.
 */
export const CAPABILITY_SESSIONS_MAX = 8;
/** Where `mountCapabilityExchange` listens unless told otherwise. */
export const CAPABILITY_EXCHANGE_PATH = '/api/capability/exchange';
/** Where `mountLinkShareDownload` listens unless told otherwise (#1686). */
export const LINK_SHARE_DOWNLOAD_PATH = '/api/capability/attachments/:attachmentId';

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
      const now = Date.now();
      const maxAge = Math.max(0, Math.floor((Date.parse(outcome.expiresAt) - now) / 1000));
      // Make room: keep the newest MAX-1 OTHER sessions, so this one is the MAX-th. The same
      // link opened again replaces its own cookie and evicts nothing. Two exchanges racing
      // can each keep MAX-1 and briefly leave MAX+1; the next exchange trims back.
      const others = capabilitySessionsOf(c, cookieName).filter((s) => s.capabilityId !== outcome.capabilityId);
      for (const evicted of others.slice(0, Math.max(0, others.length - (CAPABILITY_SESSIONS_MAX - 1)))) {
        deleteCookie(c, sessionCookieName(cookieName, evicted.capabilityId), { path: '/' });
      }
      // The one-link cookie this format replaces: an exchange replaced it before, and does now.
      if (getCookie(c, cookieName)) deleteCookie(c, cookieName, { path: '/' });
      setCookie(c, sessionCookieName(cookieName, outcome.capabilityId), `${now.toString(36)}.${outcome.sessionToken}`, {
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

/** One of the capability sessions a browser holds (#1686) — the id is the cookie's name. */
export interface HeldCapabilitySession {
  capabilityId: string;
  /** When this browser exchanged it (epoch ms), from the cookie's value — the eviction order. */
  exchangedAt: number;
  sessionToken: string;
}

const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const sessionCookieName = (cookieName: string, capabilityId: string) => `${cookieName}_${capabilityId}`;

/** A named capability this browser holds no session for: refused as a revoked link is. */
const noSuchSession = () =>
  substratError('unauthenticated', 'This link is not open in this browser, or no longer is. Open it again.');

/**
 * Every per-link capability session this request carries, OLDEST first — the order an
 * exchange evicts in. The one-link `sb_capability` cookie is not among them: it names no
 * capability, so nothing can select it by name (see `capabilitySessionOf`).
 */
export function capabilitySessionsOf(c: Context, cookieName: string = CAPABILITY_COOKIE): HeldCapabilitySession[] {
  const prefix = `${cookieName}_`;
  const held: HeldCapabilitySession[] = [];
  for (const [name, value] of Object.entries(getCookie(c))) {
    if (!name.startsWith(prefix) || !value) continue;
    const capabilityId = name.slice(prefix.length);
    if (!ULID_SHAPE.test(capabilityId)) continue;
    const dot = value.indexOf('.');
    const exchangedAt = dot > 0 ? parseInt(value.slice(0, dot), 36) : NaN;
    const sessionToken = dot > 0 ? value.slice(dot + 1) : value;
    if (!sessionToken) continue;
    held.push({ capabilityId, exchangedAt: Number.isFinite(exchangedAt) ? exchangedAt : 0, sessionToken });
  }
  return held.sort((a, b) => a.exchangedAt - b.exchangedAt || (a.capabilityId < b.capabilityId ? -1 : 1));
}

/**
 * The capability this request NAMES — `X-Substrat-Capability`, or `?capability=` — or
 * `undefined` when it names none. Both, disagreeing, is refused rather than picked between.
 */
export function namedCapabilityOf(c: Context): string | undefined {
  const header = c.req.header(CAPABILITY_HEADER) || undefined;
  const query = c.req.query(CAPABILITY_QUERY) || undefined;
  if (header && query && header !== query) {
    throw substratError('validation_failed', `${CAPABILITY_HEADER} and ?${CAPABILITY_QUERY}= name different links`);
  }
  return header ?? query;
}

/**
 * The capability session this request acts through, or `undefined` when it carries none.
 *
 * Deterministic, and never a search (#1686):
 * - **The request names a capability** (`namedCapabilityOf`): that capability's own cookie,
 *   and nothing else. A name this browser holds no session for — never exchanged here,
 *   evicted, cleared, or not an id at all — THROWS `unauthenticated`, the refusal a revoked
 *   link gets. It never falls back to another session, nor to the one-link cookie (which
 *   names no capability, so cannot be shown to be the named one), nor to the signed-in
 *   principal: trying the next credential until one is allowed would turn a share someone
 *   was sent into ambient authority over every share the browser holds.
 * - **It names none**: the most recently exchanged session, else the one-link
 *   `sb_capability` cookie — exactly what the single cookie held before #1686, where each
 *   exchange replaced the last. So a page that names nothing behaves as it always did, and
 *   a browser holding only a pre-#1686 cookie keeps working with no re-exchange.
 */
export function capabilitySessionOf(c: Context, cookieName: string = CAPABILITY_COOKIE): string | undefined {
  const named = namedCapabilityOf(c);
  if (named !== undefined) {
    // The name is the caller's text. It is held to the capability-id shape first and then
    // only COMPARED with the ids parsed off cookie names — never spliced into one — so no
    // `;`, `=`, space or non-ASCII character in it reaches a header; anything else is the
    // 401 an unknown id gets.
    const held = ULID_SHAPE.test(named) ? capabilitySessionsOf(c, cookieName).find((s) => s.capabilityId === named) : undefined;
    if (!held) throw noSuchSession();
    return held.sessionToken;
  }
  // Naming nothing can only NARROW: the token chosen is one session, resolved by the host to
  // its own capability row, so the call acts within that link's entity subtree and keys or
  // is refused — it never unions two links, and never widens past the newest one's grant.
  return capabilitySessionsOf(c, cookieName).at(-1)?.sessionToken ?? (getCookie(c, cookieName) || undefined);
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

export interface ClearCapabilitySessionOptions {
  /** The one link to forget. Defaults to the one the request names (`namedCapabilityOf`). */
  capabilityId?: string;
  /** Defaults to `CAPABILITY_COOKIE`. */
  cookieName?: string;
}

/**
 * Forget a capability session.
 *
 * With a capability named — `options.capabilityId`, else the request's
 * `X-Substrat-Capability` / `?capability=` — exactly that link's session is forgotten and
 * every other link this browser holds stays open. With none named, every capability session
 * is forgotten, the one-link cookie included, so a signed-in visitor acts as themselves again
 * — what this did when a browser could hold only one. A string argument is the cookie name,
 * as before #1686.
 */
export function clearCapabilitySession(
  c: Context,
  options: string | ClearCapabilitySessionOptions = {},
): void {
  const { capabilityId, cookieName = CAPABILITY_COOKIE } = typeof options === 'string' ? { cookieName: options } : options;
  const named = capabilityId ?? namedCapabilityOf(c);
  if (named !== undefined) {
    // The one place a caller's text becomes part of a cookie NAME, so it must be an id first:
    // anything else (`;`, `=`, spaces, non-ASCII) names no cookie this module set, and
    // clearing it is a no-op with no `Set-Cookie` at all — forgetting is idempotent.
    if (ULID_SHAPE.test(named)) deleteCookie(c, sessionCookieName(cookieName, named), { path: '/' });
    return;
  }
  for (const held of capabilitySessionsOf(c, cookieName)) {
    deleteCookie(c, sessionCookieName(cookieName, held.capabilityId), { path: '/' });
  }
  deleteCookie(c, cookieName, { path: '/' });
}

// ---------------------------------------------------------------------------
// Files through a link share (#1686).
// ---------------------------------------------------------------------------

/**
 * The attachment surface a LINK-SHARE route reads through: **the capability first, then the
 * principal** — `linkShareStub`'s precedence, for files. With the capability cookie present
 * the surface is the host's `getCapabilityAttachments`: every read checked as the
 * capability (its keys, its subtree, its minter's authority now), every write refused. With
 * no cookie, `principal` decides, and a signed-in visitor reads as themselves.
 *
 * A host without `getCapabilityAttachments` (it is optional on `ScopeHost`) REFUSES a
 * request carrying the cookie rather than falling back to the principal: the precedence is
 * what a link-share route promises, and quietly answering as someone else would break it.
 */
export async function linkShareAttachments(
  c: Context,
  host: Pick<ScopeHost, 'getCapabilityAttachments' | 'attachments'>,
  node: CapabilityNode,
  principal: () => Awaitable<PrincipalId | undefined>,
  options?: { cookieName?: string },
): Promise<ScopeAttachments | undefined> {
  const token = capabilitySessionOf(c, options?.cookieName);
  if (token) {
    if (!host.getCapabilityAttachments) {
      throw substratError(
        'unavailable',
        'this scope host serves no files through a link share (getCapabilityAttachments)',
      );
    }
    return host.getCapabilityAttachments(token, node.tenantId, node.scopeId);
  }
  const who = await principal();
  return who ? host.attachments(who, node.tenantId, node.scopeId) : undefined;
}

export interface LinkShareDownloadOptions<E extends Env = Env> {
  /** The host serving the scope — any host with the two attachment doors. */
  host: (c: Context<E>) => Awaitable<Pick<ScopeHost, 'getCapabilityAttachments' | 'attachments'>>;
  /** Which scope this request is for. */
  node: (c: Context<E>) => Awaitable<CapabilityNode>;
  /** The signed-in principal, for a request carrying no capability. Omitted: links only. */
  principal?: (c: Context<E>) => Awaitable<PrincipalId | undefined>;
  /** Defaults to `LINK_SHARE_DOWNLOAD_PATH`; must carry an `:attachmentId` parameter. */
  path?: string;
  /** Defaults to `CAPABILITY_COOKIE`. */
  cookieName?: string;
}

/**
 * `Content-Disposition` for a stored filename: always `attachment`, so the browser saves
 * the file rather than rendering it on this origin, with an ASCII fallback (quotes,
 * backslashes, control and non-ASCII characters replaced) and the exact name as RFC 5987
 * `filename*`. The filename is the uploader's text, so nothing of it reaches the header raw.
 */
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
  const exact = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`;
}

/**
 * Mount `GET <path>`: download one attachment through `linkShareAttachments` — the file a
 * link share of its folder or document reaches, or, with no capability cookie, one the
 * signed-in visitor may read themselves.
 *
 * 200 with the bytes; 404 for an id the scope does not know; 403 for a file outside the
 * capability's subtree, or one its minter can no longer read (recorded in the denial log
 * against the capability); 401 for a revoked or expired link, or no session at all.
 *
 * **Nothing about the response may leak.** `Cache-Control: private, no-store` — a shared
 * cache must never hold a private file, and neither should the browser's once the link is
 * gone — plus `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a
 * `sandbox` CSP, so a file that is secretly HTML cannot run as this origin even if opened
 * directly. `Content-Disposition` is always `attachment` (`attachmentDisposition`). All of
 * it is set before anything can fail, so a refusal carries it too.
 *
 * A download is not a use: `maxUses` counts exchanges, and reading a file through a session
 * takes nothing from the link.
 */
export function mountLinkShareDownload<E extends Env>(
  app: Hono<E>,
  options: LinkShareDownloadOptions<E>,
): void {
  const path = options.path ?? LINK_SHARE_DOWNLOAD_PATH;
  app.get(path, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    // Generic until there is a file to name — the 200 replaces it with the sanitised name.
    c.header('Content-Disposition', 'attachment');
    try {
      const attachmentId = c.req.param('attachmentId');
      if (!attachmentId) throw substratError('not_found', 'no attachment named');
      const [host, node] = await Promise.all([options.host(c), options.node(c)]);
      const files = await linkShareAttachments(
        c,
        host,
        node,
        () => options.principal?.(c),
        { cookieName: options.cookieName },
      );
      if (!files) throw substratError('unauthenticated', 'sign in, or open the link you were sent');
      const opened = await files.open(attachmentId);
      if (!opened) throw substratError('not_found', 'no such file');
      return c.body(opened.body as unknown as ArrayBuffer, 200, {
        'Content-Type': opened.contentType,
        'Content-Length': String(opened.body.byteLength),
        'Content-Disposition': attachmentDisposition(opened.record.filename),
      });
    } catch (err) {
      return problemResponse(c, err);
    }
  });
}
