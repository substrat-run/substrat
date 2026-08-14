/**
 * Provider resolution for the HOSTED studio (#626) — env bindings, not
 * process.env, and static imports only: a worker cannot dynamically install
 * provider packages the way the local CLI offers to.
 *
 * Same `provider:model` spec grammar as src/providers.ts; the D-53 hosting
 * disclosure carries over (the picker must still say where inference runs).
 * Ollama is meaningfully LOCAL and is refused hosted with an error that says
 * why, instead of dialing localhost inside a container.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export interface ProviderSecrets {
	ANTHROPIC_API_KEY?: string;
	DASHSCOPE_API_KEY?: string;
	DASHSCOPE_BASE_URL?: string;
	OPENAI_COMPATIBLE_BASE_URL?: string;
	OPENAI_COMPATIBLE_API_KEY?: string;
}

export class HostedProviderError extends Error {}

export function resolveModelHosted(
	env: ProviderSecrets,
	spec: string,
): { model: LanguageModel; label: string; endpoint?: string } {
	const idx = spec.indexOf(':');
	const provider = idx === -1 ? 'anthropic' : spec.slice(0, idx);
	const modelId = idx === -1 ? spec : spec.slice(idx + 1);
	if (!modelId) throw new HostedProviderError(`no model id in ${JSON.stringify(spec)}`);

	switch (provider) {
		case 'anthropic': {
			if (!env.ANTHROPIC_API_KEY)
				throw new HostedProviderError('ANTHROPIC_API_KEY is not set as a worker secret');
			const p = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
			return { model: p(modelId), label: `anthropic/${modelId}` };
		}
		case 'qwen': {
			if (!env.DASHSCOPE_API_KEY)
				throw new HostedProviderError('DASHSCOPE_API_KEY is not set as a worker secret');
			const baseURL =
				env.DASHSCOPE_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
			const p = createOpenAICompatible({ name: 'qwen', baseURL, apiKey: env.DASHSCOPE_API_KEY });
			return { model: p(modelId), label: `qwen/${modelId}`, endpoint: baseURL };
		}
		case 'compat': {
			if (!env.OPENAI_COMPATIBLE_BASE_URL)
				throw new HostedProviderError('OPENAI_COMPATIBLE_BASE_URL is not set as a worker secret');
			const p = createOpenAICompatible({
				name: 'compat',
				baseURL: env.OPENAI_COMPATIBLE_BASE_URL,
				apiKey: env.OPENAI_COMPATIBLE_API_KEY ?? 'none',
			});
			return {
				model: p(modelId),
				label: `compat/${modelId}`,
				endpoint: env.OPENAI_COMPATIBLE_BASE_URL,
			};
		}
		case 'ollama':
			throw new HostedProviderError(
				'ollama is local-machine inference — it does not exist on builder.substrat.net. Use the local studio (pnpm builder ui) for local models.',
			);
		default:
			throw new HostedProviderError(
				`provider ${JSON.stringify(provider)} is not wired hosted. Available: anthropic, qwen, compat.`,
			);
	}
}
