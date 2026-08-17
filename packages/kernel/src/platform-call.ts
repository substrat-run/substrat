import type { HeaderReader } from './routed-node.js';

/**
 * Authenticating a call FROM the platform TO a vertical (K-31).
 *
 * Provisioning is control-plane-driven: the platform decides an instance should
 * exist and tells the vertical to create it, because only the vertical can create a
 * usable scope DO. This is the vertical's side of that call.
 *
 * It lives in the kernel for the same reason `readRoutedNode` does — five verticals
 * each re-deriving how to trust a header is five chances to get it wrong, and the
 * one that gets it wrong is not obviously broken.
 *
 * Note the direction. `readRoutedNode` answers "which tenant is this request for",
 * and a request with no assertion is legitimate (a standalone deploy). This answers
 * "is the platform itself calling", and there is no legitimate unauthenticated case:
 * an open provisioning endpoint lets a stranger mint tenants inside the vertical.
 * So this one **fails closed with no configuration at all**.
 */

/** Thrown when a call does not prove it came from the platform. */
export class PlatformCallError extends Error {}

/** Constant-time compare, so a wrong secret leaks nothing through timing. */
export function secretMatches(presented: string | null, expected: string): boolean {
  if (!presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

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
 * Throw unless this request proves it came from the platform.
 *
 * **An unset secret is a failure, not a bypass.** That is the opposite of how the
 * router secret behaves, and deliberately so: there, an unset secret means "no router
 * is configured", which a standalone deploy legitimately wants. Here it would mean
 * "anyone may provision", which nothing legitimately wants. A template copied without
 * the secret configured must refuse to provision rather than provision for strangers.
 */
export function assertPlatformCall(
  headers: HeaderReader,
  options: { expectedSecret?: string } = {},
): void {
  const { expectedSecret } = options;
  if (!expectedSecret) {
    throw new PlatformCallError('platform calls are not configured on this deployment');
  }
  if (!secretMatches(headers.get(PLATFORM_SECRET_HEADER), expectedSecret)) {
    throw new PlatformCallError('not a platform call');
  }
}
