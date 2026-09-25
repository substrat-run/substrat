/**
 * The export-break acknowledgement on an Update or a Bind (#1756).
 *
 * The plane refuses to point an app at a version that drops or re-versions an event type
 * another app in this team imports: that app's edge would stop delivering it. The refusal
 * counts what breaks. This asks once, with the plane's own sentence, and sends the same
 * request again acknowledged. It never sends the acknowledgement first: the flag is the
 * answer to a refusal somebody read, not a default.
 */

/** How the bind gate's refusal begins (`BIND_EXPORT_BREAK_REFUSAL` in the kernel). */
export const BIND_EXPORT_BREAK = 'this bind drops or re-versions';

/** The refusal's sentence, when `message` carries one, else null. */
export function bindExportBreakOf(message: string): string | null {
  const at = message.indexOf(BIND_EXPORT_BREAK);
  return at >= 0 ? message.slice(at) : null;
}

/**
 * Send, and on the export-break refusal ask `confirm` with its sentence, then send once more
 * acknowledged. Any other failure, and a refusal of the acknowledged send, is thrown as it is.
 */
export async function sendWithExportBreakAck<T>(
  send: (ackExportBreak: boolean) => Promise<T>,
  confirm: (refusal: string) => boolean | Promise<boolean>,
): Promise<T | 'cancelled'> {
  try {
    return await send(false);
  } catch (e) {
    const refusal = bindExportBreakOf(e instanceof Error ? e.message : String(e));
    if (refusal === null) throw e;
    if (!(await confirm(refusal))) return 'cancelled';
    return await send(true);
  }
}
