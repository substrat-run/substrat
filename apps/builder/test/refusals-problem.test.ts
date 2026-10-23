/**
 * The builder's refusals are problem documents (#113, item 6).
 *
 * Neither server stands up in a unit test (one is a `node:http` handler over module-level
 * state, the other a Durable Object needing a sandbox), so this holds the two halves the
 * way `file-routes.test.ts` does: the document every route builds, run against the
 * producer in `src/problem.ts`; and a source scan that no route in the three entry points
 * answers a bare `{ error }` again.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BLANK, problem, problemDetail } from '@substrat-run/contracts';
import { Hono } from 'hono';
import {
	internalProblem,
	orUnhandled,
	PROVIDER_FAILED,
	providerMessage,
	providerRefusal,
	refuse,
	refusalProblem,
	sendProblem,
	TURN_FAILED,
	turnFailure,
	unhandledResponse,
} from '../src/problem.js';
import { resolveModel } from '../src/providers.js';
import { resolveModelHosted } from '../src/providers-worker.js';

/** [status, a sentence one of the routes really answers, the taxonomy code or undefined for about:blank] */
const SITES = [
	[400, 'name required', 'validation_failed'],
	[401, 'not signed in', 'unauthenticated'],
	[403, 'reads are limited to .builder/projects/x/', 'forbidden'],
	[404, 'no snapshot yet', 'not_found'],
	[409, 'a turn is already running', 'conflict'],
	[500, 'current project missing from registry', undefined],
	[503, 'not hosted yet: /api/dev (preview processes) lands with the #626 follow-ups', undefined],
] as const;

describe('refuse() answers a problem document at every status the builder uses', () => {
	it.each(SITES)('%i keeps its status and sentence', async (status, sentence, code) => {
		const res = refuse(status, sentence);
		expect(res.status).toBe(status);
		expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
		const doc = await res.json();
		expect(problem.safeParse(doc).success).toBe(true);
		expect(doc).toMatchObject({ status, detail: sentence });
		// The sentence web/src/api.ts reads today, until the duplicate is dropped.
		expect(doc.error).toBe(doc.detail);
		expect(problemDetail(doc)).toBe(sentence);
		if (code) expect(doc.code).toBe(code);
		else expect(doc).toMatchObject({ type: PROBLEM_TYPE_BLANK });
	});

	it.each(SITES)("%i: the node server's writer serves the same document and media type", (status, sentence) => {
		const written: { status?: number; headers?: Record<string, string>; body?: string } = {};
		sendProblem(
			{
				writeHead: (s, h) => Object.assign(written, { status: s, headers: h }),
				end: (b) => Object.assign(written, { body: b }),
			},
			refusalProblem(status, sentence),
		);
		expect(written.status).toBe(status);
		expect(written.headers).toEqual({ 'content-type': PROBLEM_CONTENT_TYPE });
		const doc = JSON.parse(written.body ?? '');
		expect(problem.safeParse(doc).success).toBe(true);
		expect(doc).toEqual(refusalProblem(status, sentence));
		expect(doc.error).toBe(sentence);
	});

	it("server.ts writes refusals through problem.ts's writer, not one of its own", () => {
		const src = readFileSync(fileURLToPath(new URL('../src/server.ts', import.meta.url)), 'utf8');
		expect(src).toMatch(/^import \{[^}]*\bsendProblem\b[^}]*\} from '\.\/problem\.js';$/m);
		expect(src).not.toMatch(/function sendProblem\b|PROBLEM_CONTENT_TYPE/);
	});

	it('names a real title, not the class-wide phrase', () => {
		for (const [status, sentence] of SITES) {
			expect(['Request failed', 'Server error']).not.toContain(refusalProblem(status, sentence).title);
		}
	});
});

describe('unreviewed throws are not relayed', () => {
	afterEach(() => vi.restoreAllMocks());

	it('a 500 carries no detail and no error sentence', () => {
		const doc = internalProblem();
		expect(problem.safeParse(doc).success).toBe(true);
		expect(doc).toMatchObject({ status: 500, code: 'internal' });
		expect(doc.detail).toBeUndefined();
		expect(doc.error).toBeUndefined();
	});

	it("a provider error keeps its own message on the 422 — the hosted resolver's", () => {
		let thrown: unknown;
		try {
			resolveModelHosted({}, 'anthropic:claude-opus-5');
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(providerRefusal(thrown)).toMatchObject({ status: 422, detail: message, error: message });
	});

	it("a provider error keeps its own message on the 422 — the local resolver's", async () => {
		const thrown = await resolveModel('no-such-provider:model').then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(providerRefusal(thrown)).toMatchObject({ status: 422, detail: message, error: message });
	});

	it('the class is decided inside the helper: a plain Error with the same text is not relayed', () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const doc = providerRefusal(new Error('ANTHROPIC_API_KEY is not set'));
		expect(JSON.stringify(doc)).not.toContain('ANTHROPIC_API_KEY');
	});

	it('any other throw is logged, and its message stays off the wire', () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const doc = providerRefusal(new Error('connect ECONNREFUSED 10.0.0.7:5432'));
		expect(doc.status).toBe(422);
		expect(JSON.stringify(doc)).not.toContain('ECONNREFUSED');
		expect(log).toHaveBeenCalledOnce();
	});
});

/**
 * A throw no route caught (#113 review). The worker had no `app.onError` and the agent DO's
 * `fetch` no catch, so on the hosted path such a throw answered Hono's text/plain
 * `Internal Server Error`. Neither module loads under node (their graph reaches
 * `cloudflare:workers`), so the handlers are driven here — the worker's in a Hono app
 * wired the way `worker.ts` wires it — and the wiring is read off the source below.
 */
describe('an unhandled throw answers the 500 problem document on the hosted path', () => {
	afterEach(() => vi.restoreAllMocks());

	const SECRET = 'bundle restore failed: r2://projects/acme/repo.bundle';

	async function expectInternal(res: Response): Promise<void> {
		expect(res.status).toBe(500);
		expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
		const text = await res.text();
		expect(text).not.toContain('bundle restore');
		const doc = JSON.parse(text);
		expect(problem.safeParse(doc).success).toBe(true);
		expect(doc).toMatchObject({ status: 500, code: 'internal' });
		expect(doc.detail).toBeUndefined();
	}

	it("the worker's onError: a route that throws", async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const app = new Hono();
		app.onError(unhandledResponse);
		app.post('/api/gates', () => {
			throw new Error(SECRET);
		});
		await expectInternal(await app.request('/api/gates', { method: 'POST' }));
		expect(log).toHaveBeenCalledOnce();
	});

	it("the worker's onError: the dispatched stub's fetch rejecting", async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const app = new Hono();
		app.onError(unhandledResponse);
		app.all('/api/*', async () => await Promise.reject(new Error(SECRET)));
		await expectInternal(await app.request('/api/session'));
	});

	it("the agent DO's catch-all", async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await expectInternal(
			await orUnhandled(async () => {
				throw new Error(SECRET);
			}),
		);
		expect(log).toHaveBeenCalledOnce();
	});

	it("passes the route's own answer through untouched", async () => {
		const res = await orUnhandled(async () => refuse(404, 'no snapshot yet'));
		expect(res.status).toBe(404);
	});

	it('worker.ts registers the handler, and the DO routes through the catch-all', () => {
		const worker = readFileSync(fileURLToPath(new URL('../src/worker.ts', import.meta.url)), 'utf8');
		expect(worker).toMatch(/^app\.onError\(unhandledResponse\);$/m);
		const agent = readFileSync(fileURLToPath(new URL('../src/agent.ts', import.meta.url)), 'utf8');
		expect(agent.replace(/\s+/g, ' ')).toContain(
			'override async fetch(req: Request): Promise<Response> { return orUnhandled(() => this.#route(req)); }',
		);
	});
});

/**
 * The same rule past the refusals (#113 review): `/api/session`'s `modelError` and the
 * turn stream's fatal `error` event relayed any throw's message, in both runtimes.
 */
describe("a throw's message reaches the client only when it is the provider error class", () => {
	afterEach(() => vi.restoreAllMocks());

	function providerThrow(): unknown {
		try {
			resolveModelHosted({}, 'anthropic:claude-opus-5');
		} catch (err) {
			return err;
		}
		throw new Error('the hosted resolver accepted a spec with no credential');
	}

	it("modelError: a provider error's own message", () => {
		const err = providerThrow();
		expect(providerMessage(err)).toBe((err as Error).message);
	});

	it('modelError: a transient network failure is logged and reads as neither a setup fault nor its text', () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const message = providerMessage(new TypeError('fetch failed: getaddrinfo ENOTFOUND api.internal'));
		expect(message).toBe(PROVIDER_FAILED);
		expect(message).not.toMatch(/set up|configur|ENOTFOUND/);
		expect(log).toHaveBeenCalledOnce();
	});

	it('the 422 and modelError say the same sentence for the same throw', () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const err = new TypeError('fetch failed');
		expect(providerRefusal(err).detail).toBe(providerMessage(err));
	});

	it('the fatal turn event: a sandbox or repo throw is logged, not streamed', () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const message = turnFailure(new Error('git bundle create failed: /workspace/.builder/projects/acme'));
		expect(message).toBe(TURN_FAILED);
		expect(log).toHaveBeenCalledOnce();
	});

	it("the fatal turn event: a phase's model failing to resolve keeps its reviewed message", () => {
		const err = providerThrow();
		expect(turnFailure(err)).toBe((err as Error).message);
	});

	it.each(['../src/server.ts', '../src/agent.ts', '../src/worker.ts'])(
		'%s reads no throw message itself — problem.ts is the one door',
		(file) => {
			const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
			expect(src).not.toMatch(/\.message\b/);
			expect(src).not.toMatch(/String\(\s*(?:err|e|error)\s*\)/);
		},
	);

	it.each(['../src/server.ts', '../src/agent.ts'])('%s answers modelError and the fatal event through it', (file) => {
		const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
		expect(src).toContain('modelError = providerMessage(err);');
		expect(src).toContain("emit({ type: 'error', message: turnFailure(err), fatal: true });");
	});
});

/** The text from `open` (just past a call's `(`) to its matching `)`, skipping quoted strings. */
function callArgs(src: string, open: number): string {
	let depth = 1;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (ch === "'" || ch === '"' || ch === '`') {
			const close = src.indexOf(ch, i + 1);
			if (close === -1) break;
			i = close;
		} else if (ch === '(') depth++;
		else if (ch === ')' && --depth === 0) return src.slice(open, i);
	}
	return src.slice(open);
}

/**
 * Every call that can put a body on the wire — `json(`, `.json(`, `.body(`, `.text(`,
 * `stringify(` — whose arguments hold an object with an `error` key, in any position and
 * either spelling (`error: x` or the shorthand `error`). Whatever the status argument is.
 */
function bareErrorCalls(src: string): string[] {
	const flat = src.replace(/\s+/g, ' ');
	return [...flat.matchAll(/(?:\bjson|\.json|\.body|\.text|\bstringify)\(/g)]
		.map((m) => `${m[0]}${callArgs(flat, (m.index ?? 0) + m[0].length)})`)
		.filter((call) => /[{,]\s*error\s*[:,}]/.test(call));
}

describe('no route in server.ts, agent.ts or worker.ts answers a bare { error } again', () => {
	it('sees the wrapped, the two-argument, the stringified and the non-literal forms', () => {
		expect(bareErrorCalls("return json(res, 409, { error: 'x' });")).toHaveLength(1);
		expect(bareErrorCalls("return json(422, {\n error: 'x',\n });")).toHaveLength(1);
		expect(bareErrorCalls("return c.json({ error: 'x' }, 403);")).toHaveLength(1);
		expect(
			bareErrorCalls("return new Response(JSON.stringify({ error: 'path required' }), { status: 400 });"),
		).toHaveLength(1);
		// Seen twice: the `.body(` holds the `stringify(` that holds the object.
		expect(bareErrorCalls('return c.body(JSON.stringify({ error }), 400);')).toHaveLength(2);
		expect(bareErrorCalls('return json(res, status, { error });')).toHaveLength(1);
		expect(bareErrorCalls("return json(res, 400, { ok: false, error: msg(') ') });")).toHaveLength(1);
		expect(bareErrorCalls("return refuse(409, 'x');")).toEqual([]);
		expect(bareErrorCalls('return json(200, { ok: true });')).toEqual([]);
		expect(bareErrorCalls("emit({ type: 'error', message: 'x' }); json(200, { modelError });")).toEqual([]);
	});

	it.each(['../src/server.ts', '../src/agent.ts', '../src/worker.ts'])('%s', (file) => {
		const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
		expect(bareErrorCalls(src)).toEqual([]);
	});
});
