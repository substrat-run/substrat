/**
 * The next-step button: every phase before iterate ends its turn on purpose, so
 * the builder continues with a click rather than a phrase to guess. What is the
 * chat's own is the DECISION — which step, and never while the model is waiting
 * for an answer to its own question.
 */
import { describe, expect, it } from 'vitest';
import { nextStepFor, type ChatItem } from '../src/Chat.js';

const said = (text: string): ChatItem => ({ kind: 'assistant', text });

describe('nextStepFor', () => {
	it.each([
		['interview', null],
		['model', 'Create the model'],
		['scenario', 'Write the tests'],
		['scaffold', 'Build the app'],
		['iterate', null],
		[null, null],
	] as const)('%s → %s', (phase, label) => {
		expect(nextStepFor(phase, [said('Concept written.')])).toBe(label);
	});

	it('hides while the turn asked a question, and returns once it is answered', () => {
		const asked: ChatItem[] = [
			{ kind: 'user', text: 'Create the model' },
			{ kind: 'event', e: { type: 'question', question: 'Who approves?', options: ['a', 'b'] } },
		];
		expect(nextStepFor('model', asked)).toBeNull();
		expect(nextStepFor('model', [said('Which one?\n\n1. Parents\n2. Anyone')])).toBeNull();
		expect(nextStepFor('model', [...asked, { kind: 'user', text: '1. a' }, said('Done.')])).toBe(
			'Create the model',
		);
	});

	it('hides for a question restored from history, which carries only its marker', () => {
		const reloaded: ChatItem[] = [
			{ kind: 'user', text: 'Create the model' },
			said('Two ways to model approval.\n\n[asked Approval: Who approves?]'),
		];
		expect(nextStepFor('model', reloaded)).toBeNull();
	});

	it('sees inline options past the usage event that follows the text', () => {
		const usage: ChatItem = { kind: 'event', e: { type: 'usage', inputTokens: 1, outputTokens: 1, steps: 1 } };
		expect(nextStepFor('model', [said('Which one?\n\n1. Parents\n2. Anyone'), usage])).toBeNull();
	});
});
