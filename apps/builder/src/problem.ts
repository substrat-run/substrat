/**
 * The builder's refusals, as RFC 9457 problem documents (#113, item 6).
 *
 * Both runtimes answer through here: the node server (`server.ts`) writes the body
 * to a `ServerResponse`, the worker and the agent DO (`worker.ts`, `agent.ts`) wrap it
 * in a `Response`. Every status and every sentence a route used to answer is unchanged;
 * the document carries `error` beside `detail` until the deprecation window closes, so
 * `web/src/api.ts` (which reads `body.error`) keeps working.
 */
import {
	PROBLEM_CONTENT_TYPE,
	problemForStatus,
	substratError,
	toProblem,
	type ErrorCode,
	type Problem,
} from '@substrat-run/contracts';
import { ProviderError } from '@substrat-run/model-providers';

/** The statuses this app refuses with that have a code in the closed taxonomy. */
const CODE_FOR_STATUS: Readonly<Record<number, ErrorCode>> = {
	400: 'validation_failed',
	401: 'unauthenticated',
	403: 'forbidden',
	404: 'not_found',
	409: 'conflict',
};

/**
 * The problem for a status and the sentence the route chose.
 *
 * `detail` must be a reviewed sentence. An unreviewed throw goes through `internalProblem`
 * (500, no detail) or `providerRefusal` (422, relayed only for the provider error class).
 */
export function refusalProblem(status: number, detail: string): Problem {
	const code = CODE_FOR_STATUS[status];
	return code ? toProblem(substratError(code, detail)) : problemForStatus(status, detail);
}

/** A 500 that discloses nothing: an unrecognised throw has a message nobody reviewed. */
export function internalProblem(): Problem {
	return toProblem(new Error('unreviewed'));
}

/**
 * The 422 a bad provider choice answers. Only the provider error class carries a message
 * written for the user (a missing credential, an unknown provider); any other throw's
 * message is unreviewed and is logged, not relayed.
 */
export function providerRefusal(err: unknown): Problem {
	// The one class both runtimes throw: providers.ts and providers-worker.ts re-export it.
	if (err instanceof ProviderError) return problemForStatus(422, err.message);
	console.error('[builder] provider setup failed', err);
	return problemForStatus(422, 'the model provider could not be set up');
}

/** A problem on the wire — the one place both runtimes take the media type from. */
export function problemWire(problem: Problem): {
	status: number;
	headers: Record<string, string>;
	body: string;
} {
	return {
		status: problem.status,
		headers: { 'content-type': PROBLEM_CONTENT_TYPE },
		body: JSON.stringify(problem),
	};
}

export function problemResponse(problem: Problem): Response {
	const { status, headers, body } = problemWire(problem);
	return new Response(body, { status, headers });
}

/** The part of node's `ServerResponse` the writer needs (no `node:http` import: the worker loads this file). */
export interface NodeResponse {
	writeHead(status: number, headers: Record<string, string>): unknown;
	end(body: string): unknown;
}

/** A problem written to the node server's response (`server.ts`). */
export function sendProblem(res: NodeResponse, problem: Problem): void {
	const { status, headers, body } = problemWire(problem);
	res.writeHead(status, headers);
	res.end(body);
}

/** A refusal as a `Response`, for the worker and the agent DO. */
export function refuse(status: number, detail: string): Response {
	return problemResponse(refusalProblem(status, detail));
}

/**
 * The answer to a throw no route caught, in every runtime: the node server's handler
 * catch, the worker's `app.onError` and the agent DO's `fetch`. The throw is logged
 * and the document discloses nothing of it.
 */
export function unhandledProblem(err: unknown): Problem {
	console.error('[builder] unhandled request failure', err);
	return internalProblem();
}

/** `unhandledProblem` as a `Response` — the worker's `app.onError` handler. */
export function unhandledResponse(err: unknown): Response {
	return problemResponse(unhandledProblem(err));
}

/** `handle`'s answer, or the unhandled 500 when it throws — the agent DO's catch-all. */
export async function orUnhandled(handle: () => Promise<Response>): Promise<Response> {
	try {
		return await handle();
	} catch (err) {
		return unhandledResponse(err);
	}
}
