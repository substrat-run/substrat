/**
 * qwen-cache.ts — the wire-level explicit cache markers. The shapes pinned
 * here were verified live against the DashScope token-plan gateway
 * (2026-08-15): block-level `cache_control` caches (system and tool messages
 * both), message-level markers are silently ignored, and requests without
 * markers get no caching at all on the flash tier. The transform is the only
 * thing between a build turn and full-price re-billing of ~1M input tokens.
 */
import { describe, expect, it } from 'vitest';
import { qwenCacheFetch, withQwenCacheMarkers } from '../src/qwen-cache.js';

const EPHEMERAL = { type: 'ephemeral' };

interface Marked {
	messages: Array<{ role: string; content: unknown; [k: string]: unknown }>;
}

describe('withQwenCacheMarkers', () => {
	it('marks system messages and the last message, in block form', () => {
		const out = withQwenCacheMarkers({
			messages: [
				{ role: 'system', content: 'skills prefix' },
				{ role: 'system', content: 'concept' },
				{ role: 'user', content: 'build it' },
			],
		}) as Marked;
		expect(out.messages[0].content).toEqual([
			{ type: 'text', text: 'skills prefix', cache_control: EPHEMERAL },
		]);
		expect(out.messages[1].content).toEqual([
			{ type: 'text', text: 'concept', cache_control: EPHEMERAL },
		]);
		expect(out.messages[2].content).toEqual([
			{ type: 'text', text: 'build it', cache_control: EPHEMERAL },
		]);
	});

	it('marks a tool-result tail — the shape every tool-loop step sends', () => {
		const out = withQwenCacheMarkers({
			messages: [
				{ role: 'system', content: 's' },
				{ role: 'user', content: 'go' },
				{ role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
				{ role: 'tool', tool_call_id: 'c1', content: 'file written' },
			],
		}) as Marked;
		expect(out.messages[3].content).toEqual([
			{ type: 'text', text: 'file written', cache_control: EPHEMERAL },
		]);
		// The unmarkable assistant (tool_calls only, null content) is untouched.
		expect(out.messages[2].content).toBeNull();
	});

	it('walks past an unmarkable tail instead of dropping the moving marker', () => {
		const out = withQwenCacheMarkers({
			messages: [
				{ role: 'user', content: 'go' },
				{ role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
			],
		}) as Marked;
		expect(out.messages[0].content).toEqual([
			{ type: 'text', text: 'go', cache_control: EPHEMERAL },
		]);
	});

	it('marks only the last block of array content', () => {
		const out = withQwenCacheMarkers({
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'a' },
						{ type: 'text', text: 'b' },
					],
				},
			],
		}) as Marked;
		expect(out.messages[0].content).toEqual([
			{ type: 'text', text: 'a' },
			{ type: 'text', text: 'b', cache_control: EPHEMERAL },
		]);
	});

	it('stays within the 4-marker request limit however many system messages ride', () => {
		const out = withQwenCacheMarkers({
			messages: [
				...Array.from({ length: 6 }, (_, i) => ({ role: 'system', content: `s${i}` })),
				{ role: 'user', content: 'go' },
			],
		}) as Marked;
		const marked = out.messages.filter(
			(m) =>
				Array.isArray(m.content) &&
				(m.content as Array<{ cache_control?: unknown }>).some((b) => b.cache_control),
		);
		expect(marked.length).toBeLessThanOrEqual(4);
	});

	it('passes non-chat bodies and empty content through untouched', () => {
		expect(withQwenCacheMarkers({ input: 'embed me' })).toEqual({ input: 'embed me' });
		const out = withQwenCacheMarkers({
			messages: [{ role: 'user', content: '' }],
		}) as Marked;
		expect(out.messages[0].content).toBe('');
	});
});

describe('qwenCacheFetch', () => {
	const capture = (): { fetch: typeof globalThis.fetch; bodies: unknown[] } => {
		const bodies: unknown[] = [];
		const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
			return new Response('{}');
		}) as typeof globalThis.fetch;
		return { fetch: fetchStub, bodies };
	};

	it('rewrites chat/completions bodies', async () => {
		const { fetch: inner, bodies } = capture();
		await qwenCacheFetch(inner)('https://x.test/compatible-mode/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ messages: [{ role: 'system', content: 's' }] }),
		});
		const sent = bodies[0] as Marked;
		expect(sent.messages[0].content).toEqual([
			{ type: 'text', text: 's', cache_control: EPHEMERAL },
		]);
	});

	it('leaves other endpoints and non-string bodies alone', async () => {
		const { fetch: inner, bodies } = capture();
		const wrapped = qwenCacheFetch(inner);
		await wrapped('https://x.test/compatible-mode/v1/models', { method: 'GET' });
		await wrapped('https://x.test/compatible-mode/v1/chat/completions', {
			method: 'POST',
			body: new Blob(['{}']),
		});
		expect(bodies[0]).toBeUndefined();
		expect(bodies[1]).toBeInstanceOf(Blob);
	});
});
