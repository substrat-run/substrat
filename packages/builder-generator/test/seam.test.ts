/**
 * Proves the generator seam drives a real `Workspace` and emits our `BuildEvent`
 * union — using a stub model, so it spends no tokens and needs no API key.
 *
 * This is deliberately a test of the SEAM, not of any model's behaviour: it
 * asserts that a tool call reaches the filesystem and comes back out as our
 * events. Whether a given model can actually build a vertical is what `evals/`
 * answers (builder-studio.md §9.6), and that is a different kind of check.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { AiSdkGenerator, collect, NullGenerator, type BuildEvent } from '../src/index.js';

async function scratchWorkspace(): Promise<LocalWorkspace> {
	const root = await mkdtemp(join(tmpdir(), 'builder-seam-'));
	const ws = new LocalWorkspace({ root });
	await ws.exec('git init -q');
	return ws;
}

/** A model that writes one file, then reports what it did. */
function stubModel(): MockLanguageModelV3 {
	let call = 0;
	return new MockLanguageModelV3({
		doStream: async () => {
			call += 1;
			const chunks =
				call === 1
					? [
							{ type: 'stream-start' as const, warnings: [] },
							{
								type: 'tool-call' as const,
								toolCallId: 't1',
								toolName: 'write_file',
								input: JSON.stringify({
									path: 'demos/x/src/module.ts',
									content: 'export const MODULE = 1;\n',
								}),
							},
							{
								type: 'finish' as const,
								finishReason: 'tool-calls' as const,
								usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
							},
						]
					: [
							{ type: 'stream-start' as const, warnings: [] },
							{ type: 'text-start' as const, id: '0' },
							{ type: 'text-delta' as const, id: '0', delta: 'Created the module.' },
							{ type: 'text-end' as const, id: '0' },
							{
								type: 'finish' as const,
								finishReason: 'stop' as const,
								usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
							},
						];
			return { stream: simulateReadableStream({ chunks }) };
		},
	});
}

describe('the generator seam (§5.2)', () => {
	it('routes a model tool call through Workspace onto the filesystem', async () => {
		const ws = await scratchWorkspace();
		const gen = new AiSdkGenerator({ model: stubModel(), label: 'mock/stub' });

		const events = await collect(
			gen.run({
				workspace: ws,
				verticalDir: 'demos/x',
				concept: 'A trivial vertical.',
				message: 'Create the module file.',
			}),
		);

		expect(await ws.readFile('demos/x/src/module.ts')).toBe('export const MODULE = 1;\n');

		const written = events.find((e) => e.type === 'file-written');
		expect(written).toMatchObject({ type: 'file-written', path: 'demos/x/src/module.ts' });

		await ws.dispose();
	});

	it('emits only our BuildEvent union — no provider types leak through', async () => {
		const ws = await scratchWorkspace();
		const gen = new AiSdkGenerator({ model: stubModel(), label: 'mock/stub' });
		const events = await collect(
			gen.run({ workspace: ws, verticalDir: 'demos/x', concept: 'c', message: 'm' }),
		);

		const known: ReadonlyArray<BuildEvent['type']> = [
			'assistant-text',
			'tool-call',
			'file-written',
			'command',
			'check',
			'gates',
			'commit',
			'preview-ready',
			'needs-review',
			'question',
			'plan',
			'thinking',
			'project-named',
			'usage',
			'error',
		];
		for (const e of events) expect(known).toContain(e.type);
		expect(events.some((e) => e.type === 'assistant-text')).toBe(true);
		expect(events.at(-1)).toMatchObject({ type: 'usage' });

		await ws.dispose();
	});

	it('reports the model that ran, for evals and logs', async () => {
		expect(new AiSdkGenerator({ model: stubModel(), label: 'anthropic/claude-opus-5' }).id).toBe(
			'ai-sdk:anthropic/claude-opus-5',
		);
		expect(new NullGenerator().id).toBe('null');
	});

	it('refuses commands the turn loop owns, without asking the model nicely', async () => {
		const ws = await scratchWorkspace();
		const refusing = new MockLanguageModelV3({
			doStream: async () => ({
				stream: simulateReadableStream({
					chunks: [
						{ type: 'stream-start' as const, warnings: [] },
						{
							type: 'tool-call' as const,
							toolCallId: 't1',
							toolName: 'run_command',
							input: JSON.stringify({ cmd: 'git commit -m "sneaky"' }),
						},
						{
							type: 'finish' as const,
							finishReason: 'stop' as const,
							usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
						},
					],
				}),
			}),
		});

		const events = await collect(
			new AiSdkGenerator({ model: refusing, label: 'mock/stub' }).run({
				workspace: ws,
				verticalDir: 'demos/x',
				concept: 'c',
				message: 'commit for me',
			}),
		);

		// The refusal happens before execution, so no `command` event is emitted.
		expect(events.some((e) => e.type === 'command')).toBe(false);
		const log = await ws.exec('git log --oneline');
		expect(log.stdout.trim()).toBe('');

		await ws.dispose();
	});
});
