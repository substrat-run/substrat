/**
 * Riding out a busy studio. The builder refuses a second project operation with a 409 whose
 * sentence starts "project operation already in progress" and names what holds the project
 * (an agent turn, another preview, a build). That is a wait, not a failure: the caller retries
 * it with backoff for a bounded time, and fails with the sentence only once the bound is spent.
 * Any other error is not retried. An aborted signal ends the wait at once, with its reason.
 */
import { ApiError } from './api.js';

/** How long a busy project is waited for before the call fails. */
export const BUSY_RETRY_BOUND_MS = 10 * 60_000;
/** The waits between attempts; the last repeats until the bound. */
export const BUSY_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000] as const;

const BUSY = /\boperation already in progress\b/;
/** The occupant inside the sentence: the control plane relays the sentence, not the `occupant` member. */
const NAMED = /\boperation already in progress: (.+?)(?:, started \d+ s ago)?$/;

/** What holds the project, when `e` is the busy refusal; null for any other error. */
export function busyOccupant(e: unknown): string | null {
	if (!(e instanceof ApiError) || e.status !== 409 || !BUSY.test(e.message)) return null;
	const what = (e.body as { occupant?: { what?: unknown } } | null)?.occupant?.what;
	if (typeof what === 'string' && what !== '') return what;
	return NAMED.exec(e.message)?.[1] ?? 'another operation';
}

export interface BusyRetryOptions {
	/** Called before each wait with what the call is waiting for. */
	onWait?: (occupant: string) => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	boundMs?: number;
	/** Aborting it stops the wait: no further call is made, and the retry rejects with its reason. */
	signal?: AbortSignal;
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve) => {
		// An abort that came before this sleep is not replayed to a listener added now.
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		}
	});
}

export async function retryWhileBusy<T>(call: () => Promise<T>, opts: BusyRetryOptions = {}): Promise<T> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, opts.signal));
	const deadline = now() + (opts.boundMs ?? BUSY_RETRY_BOUND_MS);
	for (let attempt = 0; ; attempt++) {
		opts.signal?.throwIfAborted();
		try {
			return await call();
		} catch (e) {
			const occupant = busyOccupant(e);
			if (occupant === null) throw e;
			const wait = BUSY_BACKOFF_MS[Math.min(attempt, BUSY_BACKOFF_MS.length - 1)]!;
			if (now() + wait > deadline) throw e;
			opts.onWait?.(occupant);
			opts.signal?.throwIfAborted();
			await sleep(wait);
			// A timer may fire late (a backgrounded tab): no attempt starts past the bound.
			if (now() > deadline) throw e;
		}
	}
}
