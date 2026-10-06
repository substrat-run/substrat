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
import {
  permissionKey,
  substratError,
  type EntityRef,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { isCheckedWithin, isVouchedWithin, type CheckedWithin, type VouchedWithin } from '@substrat-run/kernel';

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
 * The `within` root a subscription is narrowed to (#1853), and whether the vertical
 * vouched for it or the principal is checked on it (#938) — `encodeLiveWithin`'s output, asserted by the coordinator exactly as
 * the principal is. Absent means an unnarrowed feed.
 */
export const LIVE_WITHIN_HEADER = 'x-substrat-live-within';

/**
 * When the credential that proved the principal stops being valid (#938), as ISO 8601 —
 * asserted by the coordinator from `subscribe`'s `expiresAt`. Absent: no expiry was given.
 */
export const LIVE_EXPIRES_HEADER = 'x-substrat-live-expires';

/** An instant as the scope keeps it (`toISOString`), or `undefined` for one that is not an instant. */
export function liveInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** A subscription's narrowing, as it is carried on the header and kept on the socket. */
export interface LiveWithin {
  readonly entityType: string;
  readonly entityId: string;
  /**
   * Set when the vertical vouched for the root (`vouchedWithin`): its stated reason, and
   * the principal's own check is then NOT applied. Absent: the check is ANDed with the walk.
   */
  readonly vouched?: string;
  /**
   * Set for a `checkedWithin` root (#938): the key the principal must pass ON THE ROOT, at
   * the handshake and on every pass with a row beneath it. The per-row check is then NOT
   * applied. Never set together with `vouched`.
   */
  readonly checked?: string;
}

/** Header-safe: a reason may carry any character, and a header value may not. */
export function encodeLiveWithin(within: LiveWithin): string {
  return encodeURIComponent(JSON.stringify(within));
}

/**
 * Read a narrowing back — from the header, or from a socket's attachment. `undefined`
 * for a value that is not one, so the caller can refuse it rather than open the feed
 * wider than was asked: a malformed narrowing is never read as "no narrowing".
 */
export function readLiveWithin(value: unknown): LiveWithin | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const w = value as Partial<Record<keyof LiveWithin, unknown>>;
  if (typeof w.entityType !== 'string' || w.entityType === '') return undefined;
  if (typeof w.entityId !== 'string' || w.entityId === '') return undefined;
  if (w.vouched !== undefined && (typeof w.vouched !== 'string' || w.vouched.trim() === '')) return undefined;
  if (w.checked !== undefined && !permissionKey.safeParse(w.checked).success) return undefined;
  // Both would mean two different filters, and neither reading is the one that was asked for.
  if (w.vouched !== undefined && w.checked !== undefined) return undefined;
  return {
    entityType: w.entityType,
    entityId: w.entityId,
    ...(w.vouched !== undefined ? { vouched: w.vouched } : {}),
    ...(w.checked !== undefined ? { checked: w.checked as string } : {}),
  };
}

/**
 * What `subscribe`'s `within` argument asks for, as the narrowing the scope keeps.
 *
 * Only three shapes are accepted: a value `vouchedWithin` built, one `checkedWithin` built,
 * and a plain `EntityRef`. Anything else throws — in particular an object that LOOKS
 * built (`{ entity, because }`, `{ entity, permission }`) but was not: read as a plain ref
 * it has no type or id, and the only other reading would replace the principal's per-row
 * check on the caller's say-so.
 */
export function liveWithinOf(within: EntityRef | VouchedWithin | CheckedWithin | undefined): LiveWithin | undefined {
  if (within === undefined) return undefined;
  if (isVouchedWithin(within)) {
    return { entityType: within.entity.entityType, entityId: within.entity.entityId, vouched: within.because };
  }
  if (isCheckedWithin(within)) {
    return { entityType: within.entity.entityType, entityId: within.entity.entityId, checked: within.permission };
  }
  const plain = readLiveWithin(within);
  if (!plain || 'vouched' in (within as object) || 'checked' in (within as object)) {
    throw substratError(
      'validation_failed',
      'live reads: `within` must be an EntityRef, or a value built by vouchedWithin() or checkedWithin()',
    );
  }
  return { entityType: plain.entityType, entityId: plain.entityId };
}

/** `readLiveWithin` over the header's encoding. */
export function decodeLiveWithin(header: string): LiveWithin | undefined {
  try {
    return readLiveWithin(JSON.parse(decodeURIComponent(header)));
  } catch {
    return undefined;
  }
}

/**
 * Set on every refusal this surface returns, so a client can tell "no push here, poll"
 * from "your request was wrong" without parsing a body or guessing from a status.
 *
 * This exists because of the O2O case below. A downgrade that a client cannot observe
 * is how somebody reports "live updates are broken" two months later and nobody can
 * establish whether they ever worked on that hostname. One header makes the fallback a
 * fact the client can log, display, and report.
 *
 * Defined in `@substrat-run/contracts` (#1859, #1978), because the pure host's `501` names
 * it too and a vertical's dev server should not import this adapter to spell it.
 * Re-exported here so `host.ts` and `scope-do.ts` keep reading every wire name from this
 * one file.
 */
export { LIVE_MODE_HEADER, type LiveRefusal } from '@substrat-run/contracts';

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
  /** The root the feed is narrowed to (#1853). Absent on an unnarrowed one, and on every socket opened before it existed. */
  readonly within?: LiveWithin;
  /** When the session that opened it ends (#938); the scope closes the socket at it. */
  readonly expiresAt?: string;
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
  // Present but unreadable is NOT "unnarrowed": that would widen the feed past what was
  // asked for, and a vouched one past anything the principal could read.
  const within = a.within === undefined ? undefined : readLiveWithin(a.within);
  if (a.within !== undefined && !within) return null;
  // The same rule for an expiry: one that cannot be read is not "never expires".
  const expiresAt = a.expiresAt === undefined ? undefined : liveInstant(a.expiresAt);
  if (a.expiresAt !== undefined && !expiresAt) return null;
  return {
    principal: a.principal as PrincipalId,
    tenantId: a.tenantId as TenantId,
    scopeId: a.scopeId as ScopeId,
    since: a.since,
    ...(within ? { within } : {}),
    ...(expiresAt ? { expiresAt } : {}),
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

/**
 * How many times one row is decided for one subscriber before it is given up on (#938, Codex
 * #2077 r4). A decision is redone when the store wrote while it was being taken; the pass runs
 * inside the scope's queue, so a write landing then is rare, and one landing on every attempt
 * means the store is busy enough that the client's poll is the better answer for this row.
 */
export const LIVE_DECIDE_ATTEMPTS = 3;

/** Is this request asking to be upgraded to a WebSocket? Defined in the kernel (#1859). */
export { isUpgradeRequest } from '@substrat-run/kernel';

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
