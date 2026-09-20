/**
 * Live reads (#938) — the wire between the coordinator and the scope's Durable Object.
 *
 * The two halves of the live-read path live in different files for different reasons:
 * `host.ts` owns the door (who is asking, and whether this connection can carry a push
 * at all) and `scope-do.ts` owns the subscription and the fan-out (which committed
 * events this subscriber may be told about). Everything they must agree on is here, so
 * neither end can drift from the other by editing its own file.
 *
 * Nothing in this module reaches the network or the database. It is names and shapes.
 */
import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';

/**
 * The path the coordinator fetches on the scope stub to open a subscription.
 *
 * A path rather than an RPC method because a WebSocket cannot cross Durable Object RPC:
 * a socket is not serializable, so the only way to hand one back is a `Response` with a
 * `webSocket` on it, and the only thing that returns a `Response` from a DO is `fetch`.
 * This is the one place in the adapter where the DO is addressed as a fetch target
 * rather than as an object — every other call is `stub.<method>(…)`.
 */
export const LIVE_SUBSCRIBE_PATH = '/_substrat/live';

/**
 * WHO is subscribing, asserted by the coordinator on the request to the stub.
 *
 * The same trust shape as `invoke`'s `principal` argument: the coordinator resolved it
 * from the vertical's own session, and the DO takes it as given. What the DO does NOT
 * take as given is what that principal may see — every frame is checked individually,
 * against live tuple state, at the moment it is about to be sent.
 */
export const LIVE_PRINCIPAL_HEADER = 'x-substrat-live-principal';
export const LIVE_TENANT_HEADER = 'x-substrat-live-tenant';
export const LIVE_SCOPE_HEADER = 'x-substrat-live-scope';

/**
 * Set on every refusal this surface returns, so a client can tell "no push here, poll"
 * from "your request was wrong" without parsing a body or guessing from a status.
 *
 * This exists because of the O2O case below. A downgrade that a client cannot observe
 * is how somebody reports "live updates are broken" two months later and nobody can
 * establish whether they ever worked on that hostname. One header makes the fallback a
 * fact the client can log, display, and report.
 */
export const LIVE_MODE_HEADER = 'x-substrat-live';

/**
 * Cloudflare's own per-request marker for orange-to-orange routing.
 *
 * Set by the edge on requests entering a SaaS provider's zone when the custom hostname's
 * own zone is ALSO a proxied Cloudflare zone, in a different account. WebSockets are not
 * supported across that path — Cloudflare's product-compatibility table lists them `No`
 * for both the customer zone and the provider zone — so an upgrade offered on such a
 * connection would complete for nobody, or worse, appear to.
 *
 * **Read per request, never cached, never configured.** There is no API field and no
 * zone setting that says whether a tenant is O2O: it is decided by the tenant's own DNS,
 * which is theirs to change without telling us, so anything we stored would be a fact
 * with an expiry date we could not see. Cloudflare's documentation names checking this
 * header in a Worker as the way to detect it, and one header read per upgrade is both
 * cheaper than a matrix and correct on the request after the tenant changes their DNS.
 */
export const O2O_HEADER = 'cf-connecting-o2o';

/** Why a subscription was refused — the value of `LIVE_MODE_HEADER` on a refusal. */
export type LiveRefusal =
  /** This connection cannot carry a WebSocket; the client should keep polling. */
  | 'poll'
  /** The request was not an upgrade at all — a programming error at the caller. */
  | 'not-an-upgrade';

/**
 * What a subscribed socket remembers about itself across a hibernation.
 *
 * Carried on the socket's own attachment rather than in a field on the Durable Object,
 * deliberately: a DO is evicted and revived constantly, and an in-memory roster would
 * leave a subscriber holding a socket that still looks open and has silently stopped
 * receiving. The attachment survives the eviction with the socket it belongs to, so a
 * revived object rebuilds the roster from `ctx.getWebSockets()` and nothing is lost.
 */
export interface LiveSubscription {
  readonly principal: PrincipalId;
  readonly tenantId: TenantId;
  readonly scopeId: ScopeId;
  /** When the subscription was accepted (ISO 8601) — for the roster read, and for logs. */
  readonly since: string;
}

/**
 * Read a socket's subscription back, or `null` if it does not have a usable one.
 *
 * Fail-closed on every unusable shape, including ones that "cannot happen": a socket
 * whose attachment is missing, malformed, or from an older field set is a socket whose
 * subscriber we cannot name — and a frame is only ever sent to a named principal whose
 * permission was checked. Dropping it costs a client its live updates, which it is
 * built to survive (it polls); guessing costs somebody else's row.
 */
export function readSubscription(attachment: unknown): LiveSubscription | null {
  if (typeof attachment !== 'object' || attachment === null) return null;
  const a = attachment as Partial<Record<keyof LiveSubscription, unknown>>;
  if (typeof a.principal !== 'string' || a.principal === '') return null;
  if (typeof a.tenantId !== 'string' || a.tenantId === '') return null;
  if (typeof a.scopeId !== 'string' || a.scopeId === '') return null;
  if (typeof a.since !== 'string') return null;
  return {
    principal: a.principal as PrincipalId,
    tenantId: a.tenantId as TenantId,
    scopeId: a.scopeId as ScopeId,
    since: a.since,
  };
}

/**
 * How many newly-committed events one post-commit fan-out will consider.
 *
 * A bound rather than a page, deliberately: this is not a read the client walks, it is
 * work the writing operation pays for after its own commit, and an unbounded loop there
 * would let one bulk import hold the scope while it announced ten thousand rows to
 * everybody watching. Past the bound, a subscriber simply does not hear about the tail —
 * which its poll picks up, because the poll is the floor and the push is the hint.
 *
 * Generous relative to what one operation plus its consumers realistically emits, so
 * reaching it means something unusual happened rather than something normal being cut off.
 */
export const LIVE_FANOUT_LIMIT = 200;

/** Is this request asking to be upgraded to a WebSocket? */
export function isUpgradeRequest(request: Request): boolean {
  // Case-insensitive: the header is `Upgrade: websocket` by the RFC, but the token is
  // compared case-insensitively there too, and browsers are not the only clients.
  return (request.headers.get('Upgrade') ?? '').toLowerCase() === 'websocket';
}

/**
 * Is this request arriving over an orange-to-orange hop?
 *
 * Cloudflare sets the header to `1`. Anything else — absent, empty, `0` — is an
 * ordinary request. Compared exactly rather than for truthiness, so a future value
 * this code has not seen is not silently read as "yes" (or as "no").
 */
export function isOrangeToOrange(request: Request): boolean {
  return request.headers.get(O2O_HEADER) === '1';
}
