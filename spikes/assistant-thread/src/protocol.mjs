/**
 * The wire events, shaped like the AI SDK's UI message parts (start / delta / end for text,
 * tool input and output, an approval request) plus the three the platform adds:
 * `turn-start` / `turn-finish`, `approval-resolved` and `step-restart`.
 *
 * `id` is assigned by the record, never by the producer: it is the resume cursor.
 */

export const TERMINAL = new Set(['turn-finish', 'turn-error']);

/**
 * The digest an approval binds to: sha-256 of `JSON.stringify` of the proposed input. That is
 * NOT a canonical encoding (it depends on key order), which is harmless here only because both
 * sides hash the same stored object. It binds the input alone: no operation, thread, call or
 * approving principal (RFC §6.0 says what the real one binds).
 */
export async function digestOf(input) {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** An SSE frame for one event; `id:` lets a browser's EventSource resume natively. */
export function sseFrame(event) {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}
