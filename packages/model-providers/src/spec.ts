/**
 * The `provider:model` grammar — the one string every host, picker, ledger and
 * rate-card lookup agrees on.
 *
 * `anthropic:claude-opus-5`, `cloudflare:@cf/zai-org/glm-5.2`, `scaleway:…`. A
 * bare id with no colon is an Anthropic model, because that is the default
 * provider — and the default lives HERE, once, so `claude-opus-5` and
 * `anthropic:claude-opus-5` land on one meter rather than two.
 */

export const DEFAULT_PROVIDER = 'anthropic';

export interface ModelSpec {
	readonly provider: string;
	readonly modelId: string;
}

/** Split a spec; the provider defaults, the model id may be empty (callers refuse that). */
export function parseModelSpec(spec: string): ModelSpec {
	const idx = spec.indexOf(':');
	if (idx === -1) return { provider: DEFAULT_PROVIDER, modelId: spec };
	return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}

/** `provider:modelId` with the default provider made explicit. */
export function normalizeModelSpec(spec: string): string {
	const { provider, modelId } = parseModelSpec(spec);
	return `${provider}:${modelId}`;
}

/** The provider half alone — for error messages and per-provider lookups. */
export function providerOf(spec: string): string {
	return parseModelSpec(spec).provider;
}
