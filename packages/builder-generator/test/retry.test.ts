/**
 * Retry policy (builder-harness.md H2, #663 row 2): the classifier's verdicts
 * in isolation, and the loop's behavior end-to-end over a mock model — a
 * transient failure mid-turn resumes instead of killing the turn; overflow and
 * client errors stay fatal; billed steps are metered even when the turn dies.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { AiSdkGenerator, type BuildEvent } from '../src/index.js';
import { classifyProviderError, retryDelayMs } from '../src/retry.js';

const err = (message: string, extra: Record<string, unknown> = {}): Error =>
	Object.assign(new Error(message), extra);

describe('classifyProviderError', () => {
	it('retries 529 overloaded and 5xx', () => {
		expect(classifyProviderError(err('Overloaded', { statusCode: 529 }))).toMatchObject({
			retryable: true,
			overflow: false,
			reason: 'HTTP 529',
		});
		expect(classifyProviderError(err('boom', { statusCode: 503 })).retryable).toBe(true);
	});

	it('honors retry-after headers, capped', () => {
		const ms = classifyProviderError(
			err('rate', { statusCode: 429, responseHeaders: { 'Retry-After-Ms': '1234' } }),
		);
		expect(ms).toMatchObject({ retryable: true, retryAfterMs: 1234, reason: 'rate limited' });
		const secs = classifyProviderError(
			err('rate', { statusCode: 429, responseHeaders: { 'retry-after': '7' } }),
		);
		expect(secs.retryAfterMs).toBe(7_000);
		const capped = classifyProviderError(
			err('rate', { statusCode: 429, responseHeaders: { 'retry-after': '3600' } }),
		);
		expect(capped.retryAfterMs).toBe(60_000);
	});

	it('never retries client errors', () => {
		expect(classifyProviderError(err('unauthorized', { statusCode: 401 })).retryable).toBe(false);
		expect(classifyProviderError(err('Model not exist.', { statusCode: 404 })).retryable).toBe(
			false,
		);
	});

	it('classifies overflow as non-retryable even under a 400', () => {
		const d = classifyProviderError(err('prompt is too long: 210000 tokens', { statusCode: 400 }));
		expect(d).toMatchObject({ retryable: false, overflow: true, reason: 'context overflow' });
		expect(classifyProviderError(err('context length exceeded')).overflow).toBe(true);
	});

	it('retries statusless network failures, not aborts', () => {
		expect(classifyProviderError(err('read ECONNRESET')).retryable).toBe(true);
		expect(classifyProviderError(err('fetch failed')).retryable).toBe(true);
		expect(
			classifyProviderError(Object.assign(new Error('aborted'), { name: 'AbortError' })).retryable,
		).toBe(false);
	});
});

describe('retryDelayMs', () => {
	it('lets a provider retry-after win over backoff', () => {
		expect(
			retryDelayMs(1, { retryable: true, overflow: false, retryAfterMs: 1234, reason: 'x' }),
		).toBe(1234);
	});

	it('backs off exponentially with a cap, jitter injectable', () => {
		const mid = (): number => 0.5; // jitter factor 1.0
		const d = { retryable: true, overflow: false, reason: 'x' };
		expect(retryDelayMs(1, d, mid)).toBe(2_000);
		expect(retryDelayMs(2, d, mid)).toBe(4_000);
		expect(retryDelayMs(5, d, mid)).toBe(30_000); // capped, not 32s
	});
});

// ── the loop, end-to-end over a mock model ────────────────────────────────────

async function input(signal?: AbortSignal) {
	const root = await mkdtemp(join(tmpdir(), 'builder-retry-'));
	return {
		workspace: new LocalWorkspace({ root }),
		verticalDir: 'demos/x',
		concept: 'a test vertical',
		message: 'do the thing',
		...(signal ? { signal } : {}),
	};
}

const okStream = (text: string) => ({
	stream: new ReadableStream({
		start(c) {
			c.enqueue({ type: 'stream-start' as const, warnings: [] });
			c.enqueue({ type: 'text-start' as const, id: '0' });
			c.enqueue({ type: 'text-delta' as const, id: '0', delta: text });
			c.enqueue({ type: 'text-end' as const, id: '0' });
			c.enqueue({
				type: 'finish' as const,
				finishReason: 'stop' as const,
				// The nested V3 usage shape — flat numbers normalize to undefined.
				usage: {
					inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: 7, text: 7, reasoning: undefined },
				},
			});
			c.close();
		},
	}),
});

/** Drive the generator under fake timers so backoff costs no wall-clock. */
async function collectFake(gen: AiSdkGenerator, inp: Awaited<ReturnType<typeof input>>) {
	const done = (async () => {
		const events: BuildEvent[] = [];
		for await (const e of gen.run(inp)) events.push(e);
		return events;
	})();
	await vi.advanceTimersByTimeAsync(300_000);
	return done;
}

afterEach(() => {
	vi.useRealTimers();
});

describe('AiSdkGenerator retry loop', () => {
	it('resumes after a transient failure: retry event, then the turn completes', async () => {
		vi.useFakeTimers();
		let call = 0;
		const model = new MockLanguageModelV3({
			doStream: async () => {
				call += 1;
				if (call === 1) throw err('Overloaded', { statusCode: 529 });
				return okStream('done after retry');
			},
		});
		const events = await collectFake(
			new AiSdkGenerator({ model, label: 'mock/test' }),
			await input(),
		);

		const retries = events.filter((e) => e.type === 'retry');
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({ attempt: 1, maxAttempts: 5, reason: 'HTTP 529' });
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(
			events
				.filter((e): e is Extract<BuildEvent, { type: 'assistant-text' }> => e.type === 'assistant-text')
				.map((e) => e.text)
				.join(''),
		).toContain('done after retry');
		const usage = events.find((e) => e.type === 'usage');
		expect(usage).toMatchObject({ inputTokens: 20, outputTokens: 7 });
		expect(call).toBe(2);
	});

	it('fails fast on a non-retryable error — no retry, no sleep', async () => {
		const model = new MockLanguageModelV3({
			doStream: async () => {
				throw err('unauthorized', { statusCode: 401 });
			},
		});
		const gen = new AiSdkGenerator({ model, label: 'mock/test' });
		const events: BuildEvent[] = [];
		for await (const e of gen.run(await input())) events.push(e);

		expect(events.filter((e) => e.type === 'retry')).toHaveLength(0);
		expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
		expect(events.some((e) => e.type === 'usage')).toBe(false);
	});

	it('exhausts maxRetries then reports one fatal error', async () => {
		vi.useFakeTimers();
		let calls = 0;
		const model = new MockLanguageModelV3({
			doStream: async () => {
				calls += 1;
				throw err('Service Unavailable', { statusCode: 503 });
			},
		});
		const events = await collectFake(
			new AiSdkGenerator({ model, label: 'mock/test', maxRetries: 2 }),
			await input(),
		);

		expect(events.filter((e) => e.type === 'retry')).toHaveLength(2);
		expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
		expect(calls).toBe(3); // first attempt + 2 retries
	});

	it('passes a host-declared temperature through to the provider (H4)', async () => {
		const model = new MockLanguageModelV3({ doStream: async () => okStream('ok') });
		const gen = new AiSdkGenerator({ model, label: 'qwen/qwen3.8-max', temperature: 0.55 });
		for await (const _ of gen.run(await input())) {
			// drain
		}
		expect(model.doStreamCalls[0]?.temperature).toBe(0.55);
	});

	it('never retries context overflow', async () => {
		const model = new MockLanguageModelV3({
			doStream: async () => {
				throw err('prompt is too long: 210000 tokens > 200000 maximum', { statusCode: 400 });
			},
		});
		const gen = new AiSdkGenerator({ model, label: 'mock/test' });
		const events: BuildEvent[] = [];
		for await (const e of gen.run(await input())) events.push(e);

		expect(events.filter((e) => e.type === 'retry')).toHaveLength(0);
		expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
	});
});
