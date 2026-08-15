/**
 * Auto model pairs — a provider-scoped {fast, strong} pair behind the spec
 * `<provider>:auto`, resolved per phase at turn start: interview turns run the
 * fast model (conversation — the gates and the interview structure carry the
 * quality), scaffold and iterate turns run the strong one (the hard agentic
 * task where models actually diverge).
 *
 * Pairs never cross a provider: the provider choice is a consent decision (the
 * picker's D-53 disclosure — WHERE the code goes), so auto-routing must stay
 * inside the provider the user picked. A mixed pair (e.g. qwen-flash for
 * interview + Claude for scaffold) is a deliberate future feature gated on both
 * credentials being configured — never an implicit fallback.
 *
 * Worker-safe on purpose: both hosts and both catalogs import this, so the
 * pair the picker SHOWS is the pair the turn loop RUNS.
 */
import type { BuildPhase } from './phase.js';

export interface ModelPair {
	/** Interview turns — cheap, conversational. */
	readonly fast: string;
	/** Scaffold and iterate turns — the code-writing tier. */
	readonly strong: string;
}

/**
 * Model ids are config, not architecture: the qwen ids were verified against
 * the DashScope /models endpoint (2026-08-15) — update them here when the
 * catalog moves, nothing else needs to change.
 */
export const MODEL_PAIRS: Readonly<Record<string, ModelPair>> = {
	qwen: { fast: 'qwen3.6-flash', strong: 'qwen3.8-max' },
	anthropic: { fast: 'claude-sonnet-5', strong: 'claude-opus-5' },
};

/** The `<provider>:auto` pair a spec names, or null for a concrete spec. */
export function pairFor(spec: string): { provider: string; pair: ModelPair } | null {
	const idx = spec.indexOf(':');
	if (idx === -1 || spec.slice(idx + 1) !== 'auto') return null;
	const provider = spec.slice(0, idx);
	const pair = MODEL_PAIRS[provider];
	return pair ? { provider, pair } : null;
}

/**
 * `qwen:auto` + phase → a concrete spec; concrete specs pass through untouched.
 * `<provider>:auto` for a provider with no declared pair also passes through —
 * the provider's own "model not exist" error names the fix better than we can.
 */
export function resolveAutoSpec(spec: string, phase: BuildPhase): string {
	const hit = pairFor(spec);
	if (!hit) return spec;
	return `${hit.provider}:${phase === 'interview' ? hit.pair.fast : hit.pair.strong}`;
}
