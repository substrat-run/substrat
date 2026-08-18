/**
 * Mechanical guards the prompt alone failed to hold (observed: a fast
 * interview model asking 11 questions in one turn, three duplicated; two
 * scaffold turns silently cut at the 40-step ceiling and read as finished).
 *
 * - ask_user: duplicate questions and the 5th call are REFUSED in the tool,
 *   with an instruction the model can act on inside the same turn.
 * - truncated: a clean stream end whose final step still wanted tools means
 *   stopWhen cut the loop — said out loud as an event, and spelled into
 *   durable history by `historyMarker` so the next turn knows too.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { AiSdkGenerator, collect, historyMarker, workspaceTools } from '../src/index.js';
import { tokenBudgetIs, uncachedEquivalent } from '../src/ai-sdk.js';
import { MAX_QUESTIONS_PER_TURN } from '../src/tools.js';

async function scratchWorkspace(): Promise<LocalWorkspace> {
	const root = await mkdtemp(join(tmpdir(), 'builder-guards-'));
	const ws = new LocalWorkspace({ root });
	await ws.exec('git init -q');
	return ws;
}

const CALL_OPTS = { toolCallId: 't', messages: [] };

async function ask(
	tools: ReturnType<typeof workspaceTools>,
	question: string,
	header?: string,
): Promise<string> {
	return (await tools.ask_user.execute!(
		{ question, options: ['a', 'b'], ...(header ? { header } : {}) },
		CALL_OPTS,
	)) as string;
}

describe('ask_user guards', () => {
	it('refuses a repeated question and a repeated header, emitting neither', async () => {
		const ws = await scratchWorkspace();
		const emit = vi.fn();
		const tools = workspaceTools({ workspace: ws, emit });

		expect(await ask(tools, 'Who uses it?', 'Audience')).toContain('Question shown');
		// Same question, cosmetic differences — still a duplicate.
		expect(await ask(tools, '  who USES it??')).toContain('REFUSED: you already asked');
		// New question under an already-used tab label — also a duplicate.
		expect(await ask(tools, 'Which people are the users?', 'Audience')).toContain(
			'REFUSED: you already asked',
		);

		expect(emit.mock.calls.filter(([e]) => e.type === 'question')).toHaveLength(1);
		await ws.dispose();
	});

	it(`refuses question ${MAX_QUESTIONS_PER_TURN + 1} of a turn`, async () => {
		const ws = await scratchWorkspace();
		const emit = vi.fn();
		const tools = workspaceTools({ workspace: ws, emit });

		for (let i = 0; i < MAX_QUESTIONS_PER_TURN; i++) {
			expect(await ask(tools, `Question number ${i}?`)).toContain('Question shown');
		}
		expect(await ask(tools, 'One question too many?')).toContain('REFUSED: question limit');
		expect(emit.mock.calls.filter(([e]) => e.type === 'question')).toHaveLength(
			MAX_QUESTIONS_PER_TURN,
		);
		await ws.dispose();
	});
});

/** A model that calls a tool on EVERY step — it never finishes on its own. */
function insatiableModel(): MockLanguageModelV3 {
	let call = 0;
	return new MockLanguageModelV3({
		doStream: async () => {
			call += 1;
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: 'stream-start' as const, warnings: [] },
						{
							type: 'tool-call' as const,
							toolCallId: `t${call}`,
							toolName: 'list_files',
							input: JSON.stringify({ path: '.' }),
						},
						{
							type: 'finish' as const,
							// LanguageModelV3 shape: unified + raw, not a bare string.
							finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
							usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
						},
					],
				}),
			};
		},
	});
}

describe('step-ceiling truncation', () => {
	it('emits `truncated` when stopWhen cuts a turn mid-tool-call', async () => {
		const ws = await scratchWorkspace();
		const gen = new AiSdkGenerator({ model: insatiableModel(), label: 'mock/stub', maxSteps: 2 });
		const events = await collect(
			gen.run({ workspace: ws, verticalDir: '.', concept: 'c', message: 'm' }),
		);

		expect(events.find((e) => e.type === 'truncated')).toEqual({
			type: 'truncated',
			steps: 2,
			maxSteps: 2,
		});
		await ws.dispose();
	});

	it('historyMarker spells questions and truncation into history; nothing else', () => {
		expect(historyMarker({ type: 'truncated', steps: 40, maxSteps: 40 })).toContain(
			'cut off at the 40-step ceiling',
		);
		expect(
			historyMarker({ type: 'question', question: 'Who uses it?', options: [], header: 'Audience' }),
		).toBe('[asked Audience: Who uses it?]');
		expect(historyMarker({ type: 'assistant-text', text: 'hi' })).toBeNull();
	});
});

// ── the token budget (#740's first real run) ─────────────────────────────────

describe('the token budget bounds SPEND, which the step ceiling does not', () => {
	const step = (input: number, output: number, cached = 0) => ({
		usage: {
			inputTokens: input,
			outputTokens: output,
			totalTokens: input + output,
			inputTokenDetails: { cacheReadTokens: cached },
		},
	});

	it('counts uncached-equivalent tokens, not raw ones', () => {
		// The measured run: 2,036,785 input tokens at 96% cached. Counted raw it
		// looks like a catastrophe; counted the way it is billed it is ~80k. A
		// budget on raw tokens would cut off long well-cached builds that are
		// behaving perfectly — the failure mode that gets a guard disabled.
		expect(uncachedEquivalent([step(2_000_000, 18_000, 1_920_000)])).toBe(98_000);
		expect(uncachedEquivalent([step(1000, 100)])).toBe(1100);
		expect(uncachedEquivalent([step(1000, 100, 400), step(500, 50)])).toBe(1250);
	});

	it('never lets a provider buy extra budget with impossible cache numbers', () => {
		// cacheRead > input would otherwise subtract from the running total and
		// extend the turn — a guard that a bad number can switch off.
		expect(uncachedEquivalent([step(100, 10, 900)])).toBe(10);
	});

	it('fires exactly at the budget, and not before', () => {
		const stop = tokenBudgetIs(1000);
		const at = (steps: { usage: unknown }[]) =>
			(stop as (o: { steps: unknown }) => boolean)({ steps });
		expect(at([step(500, 100)])).toBe(false);
		expect(at([step(500, 100), step(300, 90)])).toBe(false); // 990
		expect(at([step(500, 100), step(300, 100)])).toBe(true); // 1000
	});

	it('is not fooled by a turn whose steps are individually small', () => {
		// The shape of the real runaway: forty cheap-looking steps, each re-sending
		// a transcript that keeps growing. The step ceiling saw 40 and stopped; it
		// had already cost a fortune.
		const many = Array.from({ length: 40 }, () => step(50_000, 500, 48_000));
		expect(uncachedEquivalent(many)).toBe(40 * 2500);
		expect((tokenBudgetIs(50_000) as (o: { steps: unknown }) => boolean)({ steps: many })).toBe(true);
	});
});

describe('the tool surface refuses the escapes that rewrote the monorepo', () => {
	const refusalFor = async (cmd: string): Promise<string> => {
		const root = await mkdtemp(join(tmpdir(), 'deny-'));
		const tools = workspaceTools({ workspace: new LocalWorkspace({ root }), emit: () => {} });
		return (await tools.run_command.execute!({ cmd }, {} as never)) as string;
	};

	it('refuses pnpm patch and patch-commit', async () => {
		// What actually happened: the model patched zod's type declarations, and
		// because a studio project is a workspace MEMBER, patch-commit rewrote the
		// monorepo's own pnpm-workspace.yaml.
		expect(await refusalFor('pnpm patch zod@4.4.3 --edit-dir .tmp')).toMatch(/REFUSED.*never patch/s);
		expect(await refusalFor('pnpm patch-commit .tmp-zod-patch')).toMatch(/REFUSED/);
	});

	it('refuses workspace-root commands and hand-edits to node_modules', async () => {
		expect(await refusalFor('pnpm -w add zod')).toMatch(/REFUSED.*outside this project/s);
		expect(await refusalFor("sed -i '' -E 's|a|b|' node_modules/zod/index.d.cts")).toMatch(
			/REFUSED.*installed output/s,
		);
		expect(await refusalFor('rm -rf node_modules/zod/')).toMatch(/REFUSED/);
	});

	it('still allows the commands a build legitimately needs', async () => {
		// A deny-list that refuses honest work gets turned off. Reading
		// node_modules is how the model learns an engine's surface, and it must
		// stay allowed — only MUTATING it is refused.
		for (const ok of [
			'pnpm exec tsc -p tsconfig.json --noEmit',
			'pnpm install',
			'pnpm vitest run',
			'cat node_modules/@substrat-run/kernel/dist/index.d.ts',
			'grep -n "export" node_modules/@substrat-run/contracts/dist/index.d.ts',
		]) {
			expect(await refusalFor(ok), ok).not.toMatch(/^REFUSED/);
		}
	});
});
