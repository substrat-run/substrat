/**
 * Tier-selection semantics over a SYNTHETIC tiered card — the served models
 * are currently flat, so the tier machinery is pinned here against the shape
 * it exists for: LiteLLM's `dashscope/qwen-flash` two-tier table (the real
 * upstream fixture, builder-harness.md §2.2). DashScope tiering is
 * all-or-nothing: the request's TOTAL input tokens pick one tier, and every
 * token in the request — input and output — bills at that tier's rates.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/rate-card.generated.js', () => ({
	RATE_CARD_GENERATED_AT: 'fixture',
	RATE_CARD: [
		{
			provider: 'qwen',
			idPrefix: 'qwen-flash',
			label: 'Qwen Flash (LiteLLM fixture)',
			contextTokens: 997_952,
			tiers: [
				{
					upToInputTokens: 256_000,
					inputPer1M: '0.05',
					outputPer1M: '0.4',
					cacheReadPer1M: null,
					cacheWritePer1M: null,
				},
				{
					upToInputTokens: null,
					inputPer1M: '0.25',
					outputPer1M: '2',
					cacheReadPer1M: null,
					cacheWritePer1M: null,
				},
			],
			sources: ['litellm:dashscope/qwen-flash'],
		},
	],
}));

const { listCostOf, listCostOfSteps } = await import('../src/pricing.js');

describe('all-or-nothing tier selection', () => {
	it('prices a small request entirely in tier 1', () => {
		// 100k × 0.05/1M + 10k × 0.4/1M = 0.005 + 0.004
		const c = listCostOfSteps('qwen:qwen-flash', [{ inputTokens: 100_000, outputTokens: 10_000 }]);
		expect(c).toBe('0.009');
	});

	it('prices a large request — including its OUTPUT — entirely in tier 2', () => {
		// 300k input lands in tier 2: 0.3 × 0.25 + 0.01 × 2 = 0.075 + 0.02
		const c = listCostOfSteps('qwen:qwen-flash', [{ inputTokens: 300_000, outputTokens: 10_000 }]);
		expect(c).toBe('0.095');
	});

	it('treats the tier boundary as inclusive', () => {
		// exactly 256k stays in tier 1: 0.256 × 0.05 = 0.0128
		const c = listCostOfSteps('qwen:qwen-flash', [{ inputTokens: 256_000, outputTokens: 0 }]);
		expect(c).toBe('0.0128');
	});

	it('per-step pricing lands in a tier the summed totals never reached', () => {
		// THE reason cost is computed at record time from steps (#663): two 200k
		// requests each bill in tier 1, but their 400k sum would bill in tier 2 —
		// 5× the price for the same tokens.
		const steps = [
			{ inputTokens: 200_000, outputTokens: 0 },
			{ inputTokens: 200_000, outputTokens: 0 },
		];
		expect(listCostOfSteps('qwen:qwen-flash', steps)).toBe('0.02');
		expect(listCostOf('qwen:qwen-flash', 400_000, 0)).toBe('0.1');
	});
});
