/**
 * The studio's rate card. The metering engine owns QUANTITIES and never prices
 * (engine-metering D-E) — pricing is vertical vocabulary, and for the studio's
 * own spend the studio is the vertical. List rates are the provider's
 * published per-1M-token prices; what the studio charges is list × MARKUP.
 *
 * Decimal strings end to end (K-14). Token counts convert to exact millions
 * (an integer / 1e6 is at most 6 dp), so mulDecimal's 6 dp micro-unit scale
 * never truncates — which is also why rates are multiplied per-MILLION, never
 * pre-divided to a per-token rate ($0.19/1M per-token would be 1.9e-7, below
 * the 6 dp floor).
 */
import { addDecimal, mulDecimal } from '@substrat-run/contracts';

export const MARKUP_PERCENT = 20;
const MARKUP_FACTOR = '1.2';

export interface ModelRate {
	provider: string;
	/** Longest-prefix match on the model id, so dated snapshots (`qwen3.8-max-2026-01-01`) price as their base model. */
	idPrefix: string;
	label: string;
	/** Provider list price in USD per 1M tokens, decimal strings. */
	inputPer1M: string;
	outputPer1M: string;
}

const RATE_CARD: ModelRate[] = [
	{
		provider: 'qwen',
		idPrefix: 'qwen3.6-flash',
		label: 'Qwen 3.6 Flash',
		inputPer1M: '0.19',
		outputPer1M: '1.13',
	},
	{
		provider: 'qwen',
		idPrefix: 'qwen3.8-max',
		label: 'Qwen 3.8 Max',
		inputPer1M: '2.00',
		outputPer1M: '6.00',
	},
];

/**
 * `provider:modelId`, defaulting the provider exactly like resolveModelHosted
 * does — so `claude-opus-5` and `anthropic:claude-opus-5` land on ONE meter,
 * not two.
 */
export function normalizeModelSpec(spec: string): string {
	const idx = spec.indexOf(':');
	const provider = idx === -1 ? 'anthropic' : spec.slice(0, idx);
	const modelId = idx === -1 ? spec : spec.slice(idx + 1);
	return `${provider}:${modelId}`;
}

export function rateFor(model: string): ModelRate | null {
	const idx = model.indexOf(':');
	if (idx === -1) return null;
	const provider = model.slice(0, idx);
	const modelId = model.slice(idx + 1);
	let best: ModelRate | null = null;
	for (const rate of RATE_CARD) {
		if (rate.provider !== provider || !modelId.startsWith(rate.idPrefix)) continue;
		if (!best || rate.idPrefix.length > best.idPrefix.length) best = rate;
	}
	return best;
}

/** An integer token count as an exact millions decimal (12_345 → '0.012345'). */
function tokensInMillions(tokens: number): string {
	const s = String(Math.max(0, Math.round(tokens))).padStart(7, '0');
	const frac = s.slice(-6).replace(/0+$/, '');
	return `${s.slice(0, -6)}${frac ? `.${frac}` : ''}`;
}

export interface UsageCost {
	/** Provider list price, USD decimal string. */
	listUsd: string;
	/** What the studio charges: list × 1.2 (MARKUP_PERCENT). */
	billedUsd: string;
}

/** Null when the model has no rate card entry — unpriced, never guessed. */
export function costOf(model: string, inputTokens: number, outputTokens: number): UsageCost | null {
	const rate = rateFor(model);
	if (!rate) return null;
	const listUsd = addDecimal(
		mulDecimal(tokensInMillions(inputTokens), rate.inputPer1M),
		mulDecimal(tokensInMillions(outputTokens), rate.outputPer1M),
	);
	return { listUsd, billedUsd: mulDecimal(listUsd, MARKUP_FACTOR) };
}
