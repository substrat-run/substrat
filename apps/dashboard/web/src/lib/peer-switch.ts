import { provesNothingChanged } from '@substrat-run/control-plane-api/browser';

/**
 * A switch write and its confirming read can fail independently. A write that failed without
 * proving nothing moved (`provesNothingChanged`) is `unknown`, and the position is read again:
 * that read is the confirmation the failure asks for (#2010), so it is never shown as a
 * refusal to retry.
 */
export async function changePeerAccess<T>(write: () => Promise<unknown>, read: () => Promise<T>): Promise<
  | { kind: 'applied'; view: T }
  | { kind: 'write-failed'; error: unknown }
  | { kind: 'unknown'; error: unknown; view: T; readError?: never }
  | { kind: 'unknown'; error: unknown; view: null; readError: unknown }
  | { kind: 'unconfirmed'; error: unknown }
> {
  try {
    await write();
  } catch (error) {
    if (provesNothingChanged(error)) return { kind: 'write-failed', error };
    try {
      return { kind: 'unknown', error, view: await read() };
    } catch (readError) {
      return { kind: 'unknown', error, view: null, readError };
    }
  }
  try {
    return { kind: 'applied', view: await read() };
  } catch (error) {
    return { kind: 'unconfirmed', error };
  }
}

/** Match the existing server contract before submitting a reason. */
export function validPeerReason(reason: string): boolean {
  const length = reason.trim().length;
  return length > 0 && length <= 500;
}
