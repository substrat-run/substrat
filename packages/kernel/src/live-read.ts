import {
  permissionKey,
  substratError,
  type EntityRef,
  type PermissionKey,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';

/**
 * The live-read surface (#938): one `Upgrade` in, one long-lived subscription out.
 *
 * **What crosses it is an invalidation, never a payload.** A frame names the event
 * type and the `(entityType, entityId)` it was about, and the client re-reads that
 * entity through the ordinary operation it already calls. That is what keeps the
 * change feed from quietly becoming a second, ungoverned read API: every field a
 * subscriber ever sees came back through the declared read surface, with that read's
 * own permission check, its own field-level omissions and its own PII handling.
 *
 * **Every frame is filtered per subscriber, after the commit and after the check.**
 * The host offers each committed event to each subscriber and delivers it only if
 * that subscriber passes the entity type's declared `liveTargets.readPermission` ON
 * THAT ENTITY — the same walk `ctx.check(key, entityRef)` makes, through the same
 * evaluator, so an entity-narrowed grant decides a push exactly as it decides a read.
 * An entity type no module declared reaches nobody. Knowing that a row exists and
 * changed at 14:02 is information about that row, so "the body was empty" is not a
 * defence: the filter runs whether or not there is a payload to withhold.
 *
 * A subscription may be narrowed `within` one entity (#1853), which only removes frames.
 * Two built roots replace the per-row check with one about the ROOT, and their subscribers
 * are sent bare `LiveNudge` frames that name no entity: `checkedWithin`, whose principal must
 * pass a stated key on the root at the handshake and again on every pass that has something
 * to send (#938), and `vouchedWithin`, which the vertical asserts once and nothing re-checks
 * (#1853). Which to use is on `checkedWithin`.
 *
 * **Generic over the runtime's request and response, because the kernel names
 * neither.** This package has one dependency and no DOM or workers lib
 * (`docs/architecture/dependency-policy.md`), which is why `FetchLike` (`connector-transport.ts`) describes
 * a `fetch` structurally rather than importing one. The same rule applies here, and it
 * is load-bearing in the other direction too: what a caller gets back must be the
 * runtime's OWN response object, because a Worker's handler has to return one. A
 * structural stand-in would describe it correctly and still not be returnable. So the
 * type travels through instead of being restated — `CloudflareScopeHost` binds it to
 * the real `Request`/`Response`, and code holding the bare contract gets `unknown` back
 * and narrows at its own mount point, where it knows which host it is on.
 */
export interface LiveReadSurface<Req extends LiveUpgradeRequest = LiveUpgradeRequest, Res = unknown> {
  /**
   * Accept a WebSocket `Upgrade` and subscribe the principal to the scope's changes.
   *
   * The caller is the vertical, and it has already done the one thing this surface
   * cannot do for itself: resolved WHO is asking. The principal is an authenticated
   * fact the vertical's session carries, exactly as it is for an `invoke` — this
   * surface trusts it the same way and no further, which is why every frame is still
   * checked against it individually rather than a subscription being authorized once.
   *
   * Returns the 101 to hand back to the client, or a refusal to return as-is: a
   * request that is not an upgrade gets 426, and one arriving over a hop that cannot
   * carry a socket gets a refusal naming that, so the client can fall back to polling
   * KNOWINGLY. Neither is thrown, because both are answers to a client rather than
   * faults of the caller.
   */
  subscribe(input: {
    tenantId: TenantId;
    scopeId: ScopeId;
    /** WHO is subscribing — resolved by the vertical from its own session, never by the client. */
    principal: PrincipalId;
    /** The upgrade request as it arrived, carried whole so the host reads its own headers. */
    request: Req;
    /**
     * Narrow the feed to one entity and what hangs beneath it (#1853).
     *
     * A frame is then delivered only if its entity IS this one or reaches it upward
     * through live declared `parent` edges (what `ctx.link` / `ctx.relink` write) — the
     * walk `ctx.check` makes, rooted here instead of at a grant.
     *
     * - **An `EntityRef` narrows and nothing else.** The principal's own per-frame
     *   `liveTargets` check still runs; `within` is ANDed with it, so it can only take
     *   frames away. A screen watching one conversation passes it to stop hearing the
     *   rest of the desk.
     * - **A `vouchedWithin(…)` value replaces the principal's check.** For a subscriber
     *   confined by something other than a grant — a widget visitor holding a session
     *   token the vertical has just redeemed. The vertical asserts access to the root,
     *   the same trust it already extends in naming `principal`, and the scope's walk is
     *   the whole filter. Such a subscriber receives `LiveNudge` frames only, which name
     *   no event type and no entity.
     * - **A `checkedWithin(…)` value replaces the per-row check with one on the root**
     *   (#938). The principal must pass the stated key on the root, at the handshake (a
     *   `403` otherwise) and again on every pass that has a row beneath it to announce,
     *   so a grant withdrawn, or a root moved out from under it, closes the socket
     *   instead of nudging it. `LiveNudge` frames only, as for a vouched root.
     *
     * **Freshness (Codex #2077 r5).** A decision is reused within a pass only while the
     * scope has had no write and nothing it holds has reached its `expires_at` since the
     * decision. It is never reused while the scope reads its permissions from the directory.
     * Both are checked against the clock immediately before each send. A change that lands
     * while a check is still being evaluated can let that one frame through. Frames name
     * nothing the subscriber could not read when checked, and the next frame, pass and poll
     * see the change: a push is a hint at most one evaluation stale.
     */
    within?: EntityRef | VouchedWithin | CheckedWithin;
    /**
     * When the credential that proved `principal` stops being valid (ISO 8601), so the
     * socket never outlives it (#938). Pass the session's or the bearer's expiry
     * (`AuthSubject.expiresAt`). A handshake at or past it is refused, and the scope closes
     * the socket (`1008`) on its first pass at or past it, before sending anything on that
     * pass. Absent: the socket lives until either end closes it, as before.
     */
    expiresAt?: string;
  }): Promise<Res>;
}

/** The brand only `vouchedWithin` can apply — a literal cannot type-check as one. */
declare const vouchedBrand: unique symbol;
const VOUCHED = Symbol('substrat.live.vouched-within');

/** A frozen value carrying `mark`, non-enumerable, so a spread copy or a literal never does. */
function branded<T>(value: object, mark: symbol): T {
  Object.defineProperty(value, mark, { value: true, enumerable: false });
  return Object.freeze(value) as unknown as T;
}

function hasBrand(value: unknown, mark: symbol): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[mark] === true;
}

/**
 * A `within` root the VERTICAL vouches the subscriber may watch, in place of the
 * principal's own grants (#1853). Built only by `vouchedWithin`.
 */
export interface VouchedWithin {
  readonly [vouchedBrand]: true;
  readonly entity: EntityRef;
  /** Why the vertical vouches — what it checked. Required, and kept on the subscription. */
  readonly because: string;
}

/**
 * Vouch that the subscriber may watch `entity` and everything beneath it, though the
 * principal it subscribes as holds no read on it.
 *
 * The one way to reach the replacing mode, so every use is greppable and none is an
 * accident: an object literal is refused by the type checker, and anything not built
 * here is refused by the host at run time (`isVouchedWithin`). Call it only after the
 * vertical itself has proven access — for ticket0's widget, by redeeming the session
 * token for the session it names.
 *
 * What it costs the subscriber is detail: a vouched feed carries `LiveNudge` frames, so
 * the scope never tells it which entity changed or how. Root it at an entity whose
 * subtree holds only what the subscriber may see — the walk is the whole filter.
 */
export function vouchedWithin(entity: EntityRef, opts: { because: string }): VouchedWithin {
  if (!entity?.entityType || !entity?.entityId) {
    throw substratError('validation_failed', 'vouchedWithin needs an entity with a type and an id');
  }
  if (!opts?.because?.trim()) {
    throw substratError('validation_failed', 'vouchedWithin needs a reason: what the vertical checked');
  }
  return branded({ entity: { entityType: entity.entityType, entityId: entity.entityId }, because: opts.because }, VOUCHED);
}

/** Was this value built by `vouchedWithin`? A host asks before it drops the principal's check. */
export function isVouchedWithin(value: unknown): value is VouchedWithin {
  return hasBrand(value, VOUCHED);
}

/** The brand only `checkedWithin` can apply. */
declare const checkedBrand: unique symbol;
const CHECKED = Symbol('substrat.live.checked-within');

/**
 * A `within` root the PRINCIPAL must be allowed `permission` on, re-checked for as long
 * as the socket is open (#938). Built only by `checkedWithin`.
 */
export interface CheckedWithin {
  readonly [checkedBrand]: true;
  readonly entity: EntityRef;
  readonly permission: PermissionKey;
}

/**
 * Watch `entity` and everything beneath it, for as long as the subscriber may
 * `permission` on `entity` itself.
 *
 * For a subscriber whose grant reaches the ROOT but not each row under it the way a
 * `liveTargets` key would: ticket0's portal customer holds `conversation:read-own` on
 * their contact, which reaches the conversation's public thread, while the per-row key
 * on a message is the staff read. Rooted at an entity whose subtree is exactly what that
 * key's read returns, the walk is the row filter and the key is the gate.
 *
 * The gate is asked at the handshake (`403` if it refuses) and again, once per socket,
 * on every post-commit pass that has a row beneath the root to announce. A refusal or a
 * check that throws closes the socket (`1008`) and sends nothing on that pass, so a
 * revoked grant, a principal who is gone, or a root relinked out of the grant's reach
 * ends the subscription instead of nudging it, and the client's reconnect meets the
 * handshake's `403`. A pass with nothing beneath the root asks nothing, so an idle
 * subscription costs no checks.
 *
 * **`checkedWithin` or `vouchedWithin`?** Use `checkedWithin` whenever the subscriber is
 * a principal with a grant that reaches the root: authority leaves with the grant. Use
 * `vouchedWithin` only when there is no such grant to ask, as for ticket0's widget
 * visitor, who holds a session token rather than a principal of their own. A vouched
 * socket is asserted once, so a token revoked mid-socket keeps receiving content-free
 * nudges until the socket closes. That is known and accepted for the widget: the nudge
 * names nothing, and every re-read it causes is checked again.
 *
 * Both send `LiveNudge` frames only: the subscriber may not read each row, so it is
 * never told which one changed. Only rows of a type some module declared in
 * `liveTargets` are announced, as for every other subscriber.
 */
export function checkedWithin(entity: EntityRef, permission: string): CheckedWithin {
  if (!entity?.entityType || !entity?.entityId) {
    throw substratError('validation_failed', 'checkedWithin needs an entity with a type and an id');
  }
  const key = permissionKey.safeParse(permission);
  if (!key.success) throw substratError('validation_failed', 'checkedWithin needs a permission key');
  return branded({ entity: { entityType: entity.entityType, entityId: entity.entityId }, permission: key.data }, CHECKED);
}

/** Was this value built by `checkedWithin`? */
export function isCheckedWithin(value: unknown): value is CheckedWithin {
  return hasBrand(value, CHECKED);
}

/**
 * Is this request asking to be upgraded to a WebSocket?
 *
 * Paired with `LIVE_MODE_HEADER` (`@substrat-run/contracts`) because a vertical's live
 * route asks it first, before anything else it decides: only a WebSocket handshake is a
 * live read, and a browser always sends `Origin` on one, so everything past this check
 * can trust that a missing `Origin` did not come from a browser page. A plain GET with a
 * cookie on it cannot.
 */
export function isUpgradeRequest(request: LiveUpgradeRequest): boolean {
  // `Upgrade` is a comma-separated protocol list (RFC 9110 §7.8), e.g. `h2c, websocket`,
  // and protocol names compare case-insensitively. Browsers send `websocket` alone, but
  // they are not the only clients. A whole token must match: `websocketx` is not one.
  // Accepting a list is safe for the Origin rule that follows: `fetch()` cannot set
  // `Upgrade` at all, so only a real WebSocket client reaches it.
  return (request.headers.get('Upgrade') ?? '')
    .split(',')
    .some((token) => token.trim().toLowerCase() === 'websocket');
}

/**
 * The only thing this surface needs of an incoming request: its headers.
 *
 * Narrow on purpose. A live-read door reads `Upgrade` to know what is being asked for
 * and `cf-connecting-o2o` to know whether this hop can carry it, and nothing else — it
 * does not route on the path, read the body, or care about the method. Describing
 * exactly that much is what lets a test drive the door with a two-line object instead
 * of constructing a runtime request.
 */
export interface LiveUpgradeRequest {
  readonly headers: { get(name: string): string | null };
}

/**
 * One frame on a live read (#938) — the wire shape, so both ends name it once.
 *
 * Deliberately not the outbox envelope. An envelope carries the payload, the
 * authorization chain, the impersonation stamp and the PII class, and none of those
 * belong on a channel whose contract is "re-read it yourself". What a subscriber
 * needs in order to act is what is here: which entity changed, and what happened to it.
 */
export interface LiveChange {
  /** Always `'change'` today; a field rather than an assumption, so a second kind can be added. */
  readonly kind: 'change';
  /**
   * The event id — a ULID, so frames sort and a repeat is recognisable.
   *
   * **Not a gap detector, and a client must not use it as one.** ULIDs are ordered but
   * not contiguous, so "the next id is not the one after this" says nothing on its own.
   * More to the point, gaps here are the NORMAL case and the deliberate one: the
   * permission filter withholds every event this subscriber may not read, so the ids it
   * receives are a sparse subset of what the scope emitted, by design. A client
   * inferring missed updates from the spacing would be reading someone else's
   * entitlements as its own packet loss.
   *
   * What it is good for: ordering frames that arrive out of order, and discarding one
   * it has already acted on. Detecting a genuinely missed update would need an
   * authorized contiguous cursor — a per-subscriber sequence, counted after the filter —
   * which this protocol does not have and should not grow by accident.
   */
  readonly id: string;
  /** The emitted event type, e.g. `'ticket0/message-posted'`. */
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  /** When the event was emitted (ISO 8601), i.e. the emitting operation's instant. */
  readonly at: string;
}

/**
 * What a vouched or checked subscriber is told (#1853, #938): something beneath its root
 * changed, and nothing else.
 *
 * No event type and no entity, deliberately. Such a subscriber holds no read on the
 * entities its frames are about — the vertical vouched for the ROOT, or the principal was
 * checked on the root alone, and the scope cannot know which rows under it the vertical's
 * own read would show. Naming the type
 * or the id would tell it what it never asked to read. The client re-reads, as it does
 * on a `LiveChange`.
 */
export interface LiveNudge {
  readonly kind: 'nudge';
  /** The event id, as on `LiveChange` — for ordering and de-duplication only. */
  readonly id: string;
  readonly at: string;
}

/** Any frame a live read sends. */
export type LiveFrame = LiveChange | LiveNudge;
