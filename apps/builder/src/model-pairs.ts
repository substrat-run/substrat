/**
 * The studio's use of the auto pairs (`@substrat-run/model-providers`): a build
 * PHASE picks the pair TIER — interview turns run the fast model, scaffold and
 * iterate turns run the strong one — and the edit-tool rule, which is a
 * harness fact, not a provider one.
 */
import { MODEL_PAIRS, parseModelSpec, resolveAutoSpec as resolveTier, samplingFor, type ModelPair } from '@substrat-run/model-providers';
import type { BuildPhase } from './phase.js';

export { MODEL_PAIRS, samplingFor, type ModelPair };

/** `qwen:auto` + phase → a concrete spec; concrete specs pass through untouched. */
export function resolveAutoSpec(spec: string, phase: BuildPhase): string {
	return resolveTier(spec, phase === 'interview' ? 'fast' : 'strong');
}

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
	return EDIT_TOOL_PROVIDERS.has(parseModelSpec(spec).provider);
}
