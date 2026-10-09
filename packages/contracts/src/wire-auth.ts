/**
 * Authenticating a call FROM the platform (K-31, #1998).
 *
 * Provisioning is control-plane-driven: the platform decides an instance should
 * exist and tells the vertical to create it, because only the vertical can create a
 * usable scope DO. This is the receiving side of that call — a vertical's, and the
 * platform's own workers' that take calls carrying the same header.
 *
 * It is shared code for the same reason `readRoutedNode` is — five verticals each
 * re-deriving how to trust a header is five chances to get it wrong, and the one that
 * gets it wrong is not obviously broken. Here in the shared vocabulary rather than in the
 * kernel or `vertical-host` because its callers are not all verticals: the control plane
 * and the social relay check it too, and neither should depend on a vertical's host for it.
 *
 * Note the direction. `readRoutedNode` answers "which tenant is this request for",
 * and a request with no assertion is legitimate (a standalone deploy). This answers
 * "is the platform itself calling", and there is no legitimate unauthenticated case:
 * an open provisioning endpoint lets a stranger mint tenants inside the vertical.
 * So this one **fails closed with no configuration at all**.
 *
 * Imports nothing but its sibling `wire-headers.ts`, which imports nothing either: the
 * platform's entry (#1893) bundles `secretMatches` in front of every deployed vertical
 * through `@substrat-run/contracts/wire-auth`, and this package's root would bring every
 * schema in the vocabulary, and zod, with it.
 */
import { PLATFORM_SECRET_HEADER } from './wire-headers.js';

/** The one method this needs from a `Headers`. A real `Headers` satisfies it. */
interface HeaderReader {
  get(name: string): string | null;
}

/** Thrown when a call does not prove it came from the platform. */
export class PlatformCallError extends Error {}

/**
 * Constant-time compare: it runs in time independent of the presented value, so a wrong
 * secret leaks nothing through timing.
 *
 * Every call walks the whole of `expected`, whatever was presented. A presented value's
 * length is folded into the result instead of returned early on, and so is an absent or
 * empty one, which never matches.
 *
 * The one copy: the platform-call check below and vertical-host's router assertion
 * (`readRoutedNode`) both use it.
 */
export function secretMatches(presented: string | null, expected: string): boolean {
  const given = presented ?? '';
  let diff = (given.length ^ expected.length) | (given.length === 0 ? 1 : 0);
  for (let i = 0; i < expected.length; i++) {
    diff |= (i < given.length ? given.charCodeAt(i) : 0) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

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
