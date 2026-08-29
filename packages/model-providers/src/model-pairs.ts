/**
 * Auto model pairs — a provider-scoped {fast, strong} pair behind the spec
 * `<provider>:auto`, resolved per tier at call time: conversational turns run
 * the fast model, the hard agentic turns run the strong one.
 *
 * Pairs never cross a provider: the provider choice is a consent decision (the
 * picker's D-53 disclosure — WHERE the data goes), so auto-routing must stay
 * inside the provider the user picked. A mixed pair is a deliberate future
 * feature gated on both credentials being configured — never an implicit
 * fallback.
 *
 * Worker-safe on purpose: every host and every catalog import this, so the
 * pair the picker SHOWS is the pair the turn loop RUNS.
 */
import { parseModelSpec } from './spec.js';

export interface ModelPair {
	/** Conversational turns — cheap. */
	readonly fast: string;
	/** The hard turns — the tier where models actually diverge. */
	readonly strong: string;
}

export type PairTier = keyof ModelPair;

/**
 * Model ids are config, not architecture: the qwen ids were verified against
 * the DashScope /models endpoint (2026-08-15) — update them here when the
 * catalog moves, nothing else needs to change.
 */
export const MODEL_PAIRS: Readonly<Record<string, ModelPair>> = {
	qwen: { fast: 'qwen3.6-flash', strong: 'qwen3.8-max' },
	anthropic: { fast: 'claude-sonnet-5', strong: 'claude-opus-5' },
};

/**
 * Sampling defaults per provider (builder-harness.md H4). Qwen's own
 * recommendation — and opencode's shipped per-family table — is 0.55 for the
 * qwen family; the SDK default (1.0) is measurably chattier and loopier on
 * agentic runs. topP 0.8 is Qwen's published qwen3-coder setting; without
 * nucleus truncation the family degenerates into single-token repetition loops
 * mid-turn. Others: undefined — adaptive thinking dislikes a pinned
 * temperature, and the SDK default is the provider's own.
 */
export function samplingFor(spec: string): { temperature?: number; topP?: number } {
	return parseModelSpec(spec).provider === 'qwen' ? { temperature: 0.55, topP: 0.8 } : {};
}

/** The `<provider>:auto` pair a spec names, or null for a concrete spec. */
export function pairFor(spec: string): { provider: string; pair: ModelPair } | null {
	const { provider, modelId } = parseModelSpec(spec);
	if (modelId !== 'auto') return null;
	const pair = MODEL_PAIRS[provider];
	return pair ? { provider, pair } : null;
}

/**
 * `qwen:auto` + tier → a concrete spec; concrete specs pass through untouched.
 * `<provider>:auto` for a provider with no declared pair also passes through —
 * the provider's own "model not exist" error names the fix better than we can.
 */
export function resolveAutoSpec(spec: string, tier: PairTier): string {
	const hit = pairFor(spec);
	if (!hit) return spec;
	return `${hit.provider}:${hit.pair[tier]}`;
}
