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
import { isSubstratError } from '@substrat-run/contracts';

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
 * Is this delivery over? — the DRAIN's question, and the only one that decides retries.
 *
 * A non-retryable 4xx, whoever raised it: attempt 101 carries the identical bytes past the
 * identical check. Deliberately blind to WHO refused, because terminality does not depend on
 * it — our own `validation_failed` is as final as the provider's 409, and both statuses come
 * from the same structural read (`SubstratError` carries its catalog status; a connector's
 * error carries the provider's).
 */
export function isTerminalDispatchFailure(error: unknown): boolean {
  const status = providerErrorStatus(error);
  return status !== undefined && status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status);
}

/**
 * The PROVIDER refused the request — a 4xx that came back over the wire, not one we raised.
 *
 * The exclusion is the whole point (#841). This predicate reads a bare numeric `status`, and
 * every `SubstratError` carries one from the problem catalog — so a `permission denied:
 * protocol:read` raised on our own side of egress answered `true` here, and the drain
 * captioned it "a client error the provider will refuse identically on retry". Scrive never
 * saw that request. An operator who reads that sentence goes and audits their Scrive account.
 *
 * Terminality was never the part that was wrong, so it did not move: see
 * {@link isTerminalDispatchFailure}, which is what the drain now asks. This one answers only
 * "may we quote this as the provider's words", and one of ours never may.
 */
export function isTerminalProviderError(error: unknown): boolean {
  return !isSubstratError(error) && isTerminalDispatchFailure(error);
}
