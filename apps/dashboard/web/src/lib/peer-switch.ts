/** A switch write and its confirming read can fail independently. */
export async function changePeerAccess<T>(write: () => Promise<unknown>, read: () => Promise<T>): Promise<
  | { kind: 'applied'; view: T }
  | { kind: 'write-failed'; error: unknown }
  | { kind: 'unconfirmed'; error: unknown }
> {
  try {
    await write();
  } catch (error) {
    return { kind: 'write-failed', error };
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
