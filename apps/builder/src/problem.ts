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
export function providerRefusal(err: unknown, isProviderError: boolean): Problem {
	if (isProviderError) return problemForStatus(422, (err as Error).message);
	console.error('[builder] provider setup failed', err);
	return problemForStatus(422, 'the model provider could not be set up');
}

export function problemResponse(problem: Problem): Response {
	return new Response(JSON.stringify(problem), {
		status: problem.status,
		headers: { 'content-type': PROBLEM_CONTENT_TYPE },
	});
}

/** A refusal as a `Response`, for the worker and the agent DO. */
export function refuse(status: number, detail: string): Response {
	return problemResponse(refusalProblem(status, detail));
}
