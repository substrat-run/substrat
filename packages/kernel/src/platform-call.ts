import type { ScopeStubOptions } from './scope-host.js';
import {
  EXPORTED_EVENTS_HEADER,
  PLATFORM_REQUEST_HEADER,
  PLATFORM_SECRET_HEADER,
} from '@substrat-run/contracts/wire-headers';
import { secretMatches } from './secret-match.js';

/**
 * Authenticating a call FROM the platform TO a vertical (K-31).
 *
 * Provisioning is control-plane-driven: the platform decides an instance should
 * exist and tells the vertical to create it, because only the vertical can create a
 * usable scope DO. This is the vertical's side of that call.
 *
 * It is shared code for the same reason `readRoutedNode` is — five verticals each
 * re-deriving how to trust a header is five chances to get it wrong, and the one that
 * gets it wrong is not obviously broken. `readRoutedNode` moved to `vertical-host` in
 * #1978 and this one is moving after it; `vertical-host` already re-exports it.
 *
 * Note the direction. `readRoutedNode` answers "which tenant is this request for",
 * and a request with no assertion is legitimate (a standalone deploy). This answers
 * "is the platform itself calling", and there is no legitimate unauthenticated case:
 * an open provisioning endpoint lets a stranger mint tenants inside the vertical.
 * So this one **fails closed with no configuration at all**.
 */

/** The one method this needs from a `Headers`. A real `Headers` satisfies it. */
interface HeaderReader {
  get(name: string): string | null;
}

/** Thrown when a call does not prove it came from the platform. */
export class PlatformCallError extends Error {}

/**
 * Both kick flags as the stub options that raise them (#1705 PR 2): spread into `getScope`'s
 * options with the handler's header setter. One call per worker rather than one line per flag,
 * so a flag added later reaches every vertical that uses this, and not only the ones that
 * remembered the line. A vertical that skips it still works, and waits for the sweep.
 */
export function kickFlags(
  setHeader: (name: string, value: string) => void,
): Pick<ScopeStubOptions, 'onPlatformRequests' | 'onExportedEvents'> {
  return {
    onPlatformRequests: () => setHeader(PLATFORM_REQUEST_HEADER, '1'),
    onExportedEvents: () => setHeader(EXPORTED_EVENTS_HEADER, '1'),
  };
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
