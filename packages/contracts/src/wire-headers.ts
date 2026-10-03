/**
 * Wire names shared by the router, the platform and a vertical: the headers a request or a
 * response carries between them (#1978).
 *
 * Constants rather than code, so they sit in the shared vocabulary rather than in the
 * kernel, and every end that has to spell one imports it from here. This module imports
 * nothing, which is what lets the platform's entry bundle (`withInvocationLog`) reach it
 * through `@substrat-run/contracts/wire-headers` without pulling the rest of this package,
 * and zod, in behind it.
 */

/** The header the platform presents. */
export const PLATFORM_SECRET_HEADER = 'x-substrat-platform';

/**
 * The RESPONSE header carrying an attachment's metadata record when the vertical
 * hands its bytes back over the connector seam (#711).
 *
 * The bytes are the body — a rendered contract is megabytes, and base64 in a JSON
 * envelope would inflate and re-encode it on both ends for nothing. The record is
 * small, fixed-shape and needs no streaming, so it rides a header. Not a secret and
 * not a privilege: the caller has already passed the platform-secret gate, and the
 * far end has already run the permission check that decided it may see any of this.
 */
export const CONNECTOR_ATTACHMENT_RECORD_HEADER = 'x-substrat-attachment';

/**
 * The RESPONSE header a vertical sets when the operation it just ran enqueued
 * platform requests (`ctx.requestPlatform`). The router — the one hop that sees
 * every response — reads it and kicks an immediate drain of that scope (#381),
 * so provisioning settles in seconds instead of at the sweep. Carries no payload
 * and no privilege: a forged or spurious flag costs the platform one wasted
 * pull, nothing more. Fed by `ScopeStubOptions.onPlatformRequests` (#458).
 */
export const PLATFORM_REQUEST_HEADER = 'x-substrat-platform-request';

/**
 * The RESPONSE header a vertical sets when the operation it just ran committed an event of a
 * type this deployment EXPORTS to other verticals (#1705). The router reads it beside
 * {@link PLATFORM_REQUEST_HEADER} and asks the control plane to run this producer's outgoing
 * edges now, so a consumer in another vertical receives the event in seconds rather than at
 * the next sweep. Like its sibling it carries no payload and no privilege: the control plane
 * takes the tenant and scope from the route the router resolved, never from the response, and a
 * spurious flag costs one pass over that producer's own edges. The router strips every
 * `x-substrat-*` header from an inbound request, so only a response can raise it. Fed by
 * `ScopeStubOptions.onExportedEvents`.
 */
export const EXPORTED_EVENTS_HEADER = 'x-substrat-exported-events';

/**
 * Set on every refusal a live-read door returns, so a client can tell "no push here,
 * poll" from "your request was wrong" without parsing a body or guessing from a status.
 *
 * Here rather than in the hosted adapter because both ends of a refusal need to spell it
 * the same way: the hosted adapter sets it on its own refusals, and a vertical's mount
 * sets it on the pure host's `501` (the ask-don't-assume recipe on `ScopeHost.liveReads`).
 * A dev server should not have to import the Cloudflare adapter to say "poll".
 */
export const LIVE_MODE_HEADER = 'x-substrat-live';

/** Why a subscription was refused — the value of `LIVE_MODE_HEADER` on a refusal. */
export type LiveRefusal =
  /** This host or connection cannot carry a WebSocket; the client should keep polling. */
  | 'poll'
  /** The request was not an upgrade at all — a programming error at the caller. */
  | 'not-an-upgrade';

/**
 * The RESPONSE header on `/internal/export` carrying the scope store's load stamp, read in the
 * same call as the dump it rides beside (#1722). A carry's fenced wipe of the copy it leaves
 * behind expects exactly this stamp, so the wipe is refused when anything was loaded into the
 * store since. The stamp itself never travels inside a dump.
 */
export const LOAD_STAMP_HEADER = 'x-substrat-load-stamp';
