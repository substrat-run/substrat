/**
 * Is a failed outbound call worth trying again? (#618)
 *
 * The platform retries a connector delivery by re-draining its `connector:<provider>` intent,
 * and until now every failure looked the same to that loop: a throw meant "transient", so a
 * provider answering `409 requires valid personal number field` was retried a hundred times
 * over two days. That answer is not a fault to wait out — it is the provider telling the
 * CALLER its request is wrong, and attempt 101 carries the identical bytes.
 *
 * The rule lives in the kernel rather than in any one connector because both ends need it:
 * a connector decides what status to raise, the drain decides whether to keep the intent
 * drainable, and they must not disagree. It is deliberately STRUCTURAL — any error carrying a
 * numeric `status` — so the drain never has to import a provider's error class to classify it,
 * and a connector gets the behaviour by raising the status it already knows.
 */

/**
 * 4xx statuses that are nevertheless worth retrying: the provider is refusing this attempt,
 * not the request. Timeouts and locks clear on their own; a rate limit is an instruction to
 * come back later, which is exactly what the next drain pass does.
 */
export const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 423, 425, 429]);

/**
 * The HTTP status an error carries, if it carries one. Structural on purpose (see above):
 * `ScriveApiError` and any future connector's error type both satisfy it without a shared base
 * class, and an error that carries no status — a network failure, a bug — reads as `undefined`,
 * which is the honest answer and keeps it retryable.
 */
export function providerErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/**
 * The provider refused the REQUEST — a 4xx that will refuse the identical request forever.
 * A 5xx is the provider's own fault and stays retryable; so does anything without a status,
 * because "we could not tell" must never settle a delivery terminally.
 */
export function isTerminalProviderError(error: unknown): boolean {
  const status = providerErrorStatus(error);
  return status !== undefined && status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status);
}
