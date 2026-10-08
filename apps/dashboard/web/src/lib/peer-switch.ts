import { provesNothingChanged } from '@substrat-run/control-plane-api/browser';

/**
 * A switch write and its confirming read can fail independently. A write that failed without
 * proving nothing moved (`provesNothingChanged`) is `unknown`, and the position is read again:
 * that read is the confirmation the failure asks for (#2010), so it is never shown as a
 * refusal to retry.
 *
 * A write that went through carries the answer's `auditWarning` (#2089) when the platform could
 * not record it in its admin log: still a change made, shown as a warning, never offered again.
 */
export async function changePeerAccess<T>(write: () => Promise<{ changed: boolean; auditWarning?: string }>, read: () => Promise<T>): Promise<
  | { kind: 'applied'; view: T; auditWarning?: string }
  | { kind: 'write-failed'; error: unknown }
  | { kind: 'unknown'; error: unknown; view: T; readError?: never }
  | { kind: 'unknown'; error: unknown; view: null; readError: unknown }
  | { kind: 'unconfirmed'; error: unknown; auditWarning?: string }
> {
  let auditWarning: string | undefined;
  try {
    ({ auditWarning } = await write());
  } catch (error) {
    if (provesNothingChanged(error)) return { kind: 'write-failed', error };
    try {
      return { kind: 'unknown', error, view: await read() };
    } catch (readError) {
      return { kind: 'unknown', error, view: null, readError };
    }
  }
  const warned = auditWarning ? { auditWarning } : {};
  try {
    return { kind: 'applied', view: await read(), ...warned };
  } catch (error) {
    return { kind: 'unconfirmed', error, ...warned };
  }
}

/** Match the existing server contract before submitting a reason. */
export function validPeerReason(reason: string): boolean {
  const length = reason.trim().length;
  return length > 0 && length <= 500;
}
