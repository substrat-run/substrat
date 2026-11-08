/**
 * Provider-error classification and backoff policy — builder-harness.md H2
 * (#663 row 2). Shape ported from opencode's `session/retry.ts` (MIT,
 * © 2025 opencode); the overflow pattern table follows OpenHands'
 * agent_controller (MIT) — litellm-style SDKs don't reliably type overflow
 * errors, so the classification is partly textual by necessity.
 *
 * Policy, stated once:
 *   - Transient provider failures (429, 5xx incl. 529 "overloaded", network
 *     resets, timeouts) are retryable — one mid-turn 529 must not kill a
 *     30-step build and its cache investment.
 *   - Context overflow is NEVER retryable — the same request will overflow
 *     again. It is classified separately so the caller can one day compact
 *     instead (RFC H3); until then it surfaces as a fatal error.
 *   - Client errors (400/401/403/404/422) are never retryable: the request is
 *     wrong, not unlucky, and the provider-specific explainError path already
 *     turns them into actionable advice.
 *   - A provider-sent `retry-after` wins over our backoff, capped — a turn
 *     inside a Durable Object must not sleep for minutes on a header.
 */

export interface RetryDecision {
	readonly retryable: boolean;
	/** Context overflow — never retried; named for the future compaction path. */
	readonly overflow: boolean;
	/** Provider-mandated wait, already capped, when a retry-after header exists. */
	readonly retryAfterMs?: number;
	/** HTTP 429: the provider is shedding load, so the backoff is longer (`RATE_LIMIT_*`). */
	readonly rateLimited?: boolean;
	/** Short human label for the retry event ("overloaded", "HTTP 503", …). */
	readonly reason: string;
}

/** Longest we honor a provider's retry-after header. */
const RETRY_AFTER_CAP_MS = 60_000;
/** Backoff: base × 2^(attempt-1), jittered ±25%, capped. */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 30_000;
/**
 * A 429 with no retry-after: 5 s doubling to 90 s, about 2.5 minutes over the default five tries.
 * The plain backoff spent about a minute, and five builds sharing a Workers AI model's limit each
 * gave up mid-scaffold after it; a hosted builder shares one account's limit across every tenant.
 */
const RATE_LIMIT_BASE_MS = 5_000;
const RATE_LIMIT_CAP_MS = 90_000;

const OVERFLOW_PATTERNS =
	/prompt is too long|context.?(length|window).{0,20}exceed|exceeds? the (available )?context|maximum context length|input length and .?max_tokens.? exceed|reduce the length of|too many total text bytes/i;

const RETRYABLE_MESSAGE =
	/overloaded|rate.?limit|too many requests|server had an error|internal server error|bad gateway|service unavailable|gateway time.?out|timed? ?out|econnreset|econnrefused|etimedout|epipe|socket hang ?up|fetch failed|network error|connection (error|closed|reset)/i;

interface ErrorFacts {
	statusCode?: number;
	headers?: Record<string, string>;
	message: string;
	aborted: boolean;
	timedOut: boolean;
}

/** Walk err and its causes for the AI SDK APICallError shape. */
function factsOf(err: unknown): ErrorFacts {
	let statusCode: number | undefined;
	let headers: Record<string, string> | undefined;
	const messages: string[] = [];
	let aborted = false;
	let timedOut = false;
	let cur: unknown = err;
	for (let depth = 0; cur != null && depth < 5; depth++) {
		const e = cur as Record<string, unknown>;
		if (statusCode === undefined && typeof e['statusCode'] === 'number') {
			statusCode = e['statusCode'] as number;
		}
		if (!headers && typeof e['responseHeaders'] === 'object' && e['responseHeaders'] !== null) {
			headers = Object.fromEntries(
				Object.entries(e['responseHeaders'] as Record<string, unknown>)
					.filter(([, v]) => typeof v === 'string')
					.map(([k, v]) => [k.toLowerCase(), v as string]),
			);
		}
		if (typeof e['message'] === 'string') messages.push(e['message'] as string);
		if (typeof e['responseBody'] === 'string') messages.push(e['responseBody'] as string);
		if (e['name'] === 'AbortError') aborted = true;
		if (e['name'] === 'TimeoutError') timedOut = true;
		cur = e['cause'];
	}
	return { statusCode, headers, message: messages.join('\n'), aborted, timedOut };
}

/** Seconds-or-HTTP-date `retry-after`, or `retry-after-ms`; capped; undefined when absent/garbled. */
function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
	if (!headers) return undefined;
	const ms = headers['retry-after-ms'];
	if (ms !== undefined) {
		const n = Number(ms);
		if (Number.isFinite(n) && n >= 0) return Math.min(n, RETRY_AFTER_CAP_MS);
	}
	const ra = headers['retry-after'];
	if (ra === undefined) return undefined;
	const secs = Number(ra);
	if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
	const date = Date.parse(ra);
	if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), RETRY_AFTER_CAP_MS);
	return undefined;
}

export function classifyProviderError(err: unknown): RetryDecision {
	const facts = factsOf(err);

	// A stream that went silent past the stall timeout. The SDK aborts it with a TimeoutError,
	// which can arrive wrapped in an AbortError, so this is asked before cancellation is.
	if (facts.timedOut) return { retryable: true, overflow: false, reason: 'stalled stream' };

	// User cancellation is neither a failure nor retryable.
	if (facts.aborted) return { retryable: false, overflow: false, reason: 'aborted' };

	// Overflow before status: providers ship it as 400, which would otherwise
	// classify as a plain client error and lose the compaction signal.
	if (OVERFLOW_PATTERNS.test(facts.message)) {
		return { retryable: false, overflow: true, reason: 'context overflow' };
	}

	// A 200 whose body the SDK could not parse: Workers AI answers one now and then, and four builds
	// died on it. It carries the 200, so it is asked before the status is.
	if (/failed to process successful response/i.test(facts.message)) {
		return { retryable: true, overflow: false, reason: 'unreadable response' };
	}

	const status = facts.statusCode;
	const after = retryAfterMs(facts.headers);
	if (status !== undefined) {
		if (status === 429 || status === 408 || status >= 500) {
			return {
				retryable: true,
				overflow: false,
				...(after !== undefined ? { retryAfterMs: after } : {}),
				...(status === 429 ? { rateLimited: true } : {}),
				reason: status === 429 ? 'rate limited' : `HTTP ${status}`,
			};
		}
		return { retryable: false, overflow: false, reason: `HTTP ${status}` };
	}

	// No status — thrown before a response (network) or wrapped by the SDK.
	if (RETRYABLE_MESSAGE.test(facts.message)) {
		const label = facts.message.match(RETRYABLE_MESSAGE)?.[0].toLowerCase() ?? 'transient error';
		return { retryable: true, overflow: false, reason: label };
	}
	return { retryable: false, overflow: false, reason: 'provider error' };
}

/**
 * Wait before retry `attempt` (1-based). A capped provider retry-after wins;
 * otherwise jittered exponential backoff. `random` injectable for tests.
 */
export function retryDelayMs(
	attempt: number,
	decision: RetryDecision,
	random: () => number = Math.random,
): number {
	if (decision.retryAfterMs !== undefined) return Math.round(decision.retryAfterMs);
	const [first, cap] = decision.rateLimited
		? [RATE_LIMIT_BASE_MS, RATE_LIMIT_CAP_MS]
		: [BACKOFF_BASE_MS, BACKOFF_CAP_MS];
	const base = Math.min(cap, first * 2 ** Math.max(0, attempt - 1));
	const jitter = 1 + (random() * 0.5 - 0.25);
	return Math.round(base * jitter);
}
