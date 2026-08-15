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

/**
 * Format-per-model (builder-harness.md H1): which models get the edit_file
 * search/replace tool. Aider's leaderboard puts frontier models at ~97–99%
 * well-formed search/replace and shows sub-tier collapse (~68%), so weak and
 * unknown models keep whole-file writes BY DECLARATION, not by failing at it.
 * Provider-level is the honest granularity today — every model we serve from
 * these providers is frontier-tier; local/compat/cloudflare ids are unknowable
 * in advance. Refine to per-model when evals/ measures it (§9.6).
 */
const EDIT_TOOL_PROVIDERS = new Set(['anthropic', 'qwen', 'openai', 'google', 'mistral']);

/** Whether a (concrete) spec's model should be offered edit_file. */
export function editToolFor(spec: string): boolean {
	const idx = spec.indexOf(':');
	const provider = idx === -1 ? 'anthropic' : spec.slice(0, idx);
	return EDIT_TOOL_PROVIDERS.has(provider);
}

/**
 * Sampling defaults per provider (builder-harness.md H4). Qwen's own
 * recommendation — and opencode's shipped per-family table — is 0.55 for the
 * qwen family; we currently send the SDK default (1.0) to our DEFAULT
 * provider, which is measurably chattier and loopier on agentic runs.
 * Anthropic/others: undefined — adaptive thinking dislikes a pinned
 * temperature, and the SDK default is the provider's own.
 */
export function samplingFor(spec: string): { temperature?: number } {
	const idx = spec.indexOf(':');
	const provider = idx === -1 ? 'anthropic' : spec.slice(0, idx);
	return provider === 'qwen' ? { temperature: 0.55 } : {};
}

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
