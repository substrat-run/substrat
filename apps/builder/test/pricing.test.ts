/**
 * The studio's markup over the list math (which is pinned in
 * packages/model-providers/test). What is the studio's alone: list × 1.2.
 */
import { describe, expect, it } from 'vitest';
import { costOf, costOfSteps, withMarkup } from '../src/pricing.js';

describe('costOfSteps', () => {
	it('carries list and billed together', () => {
		// 1M in × $2/1M + 100k out × $6/1M = 2.6 list
		const c = costOfSteps('qwen:qwen3.8-max', [{ inputTokens: 1_000_000, outputTokens: 100_000 }]);
		expect(c).toEqual({ listUsd: '2.6', billedUsd: '3.12' });
	});

	it('returns null for unpriced models — never a guessed $0', () => {
		expect(costOfSteps('ollama:qwen3-coder', [{ inputTokens: 1000, outputTokens: 10 }])).toBeNull();
	});

	it('costOf equals the single-pseudo-step price', () => {
		expect(costOf('qwen:qwen3.8-max', 1_000_000, 100_000)).toEqual(
			costOfSteps('qwen:qwen3.8-max', [{ inputTokens: 1_000_000, outputTokens: 100_000 }]),
		);
	});
});

describe('withMarkup', () => {
	it('applies exactly the 20% markup', () => {
		expect(withMarkup('2.6')).toBe('3.12');
		expect(withMarkup('0')).toBe('0');
	});
});
