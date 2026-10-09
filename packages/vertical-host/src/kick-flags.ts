/**
 * The two response flags that ask the router for a kick (#1705 PR 2, #1998).
 *
 * Here rather than in the kernel since #1998: only a vertical's worker raises them, from the
 * scope stub's observers, and the header names are contracts' wire vocabulary.
 */
import { EXPORTED_EVENTS_HEADER, PLATFORM_REQUEST_HEADER } from '@substrat-run/contracts/wire-headers';
import type { ScopeStubOptions } from '@substrat-run/kernel';

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
