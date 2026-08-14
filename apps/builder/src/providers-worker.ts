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

/** Structurally identical to hosting.ts `ProviderCatalogEntry` (and the web
 * client's `ProviderEntry`) — declared here because even a type-only import of
 * hosting.ts would drag the Node-bound files into the worker tsconfig. */
export interface HostedCatalogEntry {
	readonly name: string;
	readonly kind: 'direct' | 'compatible';
	readonly hosting: {
		readonly vendor: string;
		readonly location: string;
		readonly host: string;
		readonly dataNote: string;
	};
	readonly credential: { readonly envVar: string | null; readonly set: boolean };
	readonly listable: boolean;
	readonly suggested: readonly string[];
}

export interface ProviderSecrets {
	ANTHROPIC_API_KEY?: string;
	DASHSCOPE_API_KEY?: string;
	DASHSCOPE_BASE_URL?: string;
	CLOUDFLARE_AI_BASE_URL?: string;
	CLOUDFLARE_AI_API_TOKEN?: string;
	OPENAI_COMPATIBLE_BASE_URL?: string;
	OPENAI_COMPATIBLE_API_KEY?: string;
}

export class HostedProviderError extends Error {}

const QWEN_DEFAULT_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

/** The compatible providers' effective endpoints, from worker secrets.
 * `undefined` = not a hosted compatible provider; `''` = known but unconfigured. */
function compatibleBase(env: ProviderSecrets, provider: string): string | undefined {
	switch (provider) {
		case 'qwen':
			return env.DASHSCOPE_BASE_URL ?? QWEN_DEFAULT_BASE;
		case 'cloudflare':
			return env.CLOUDFLARE_AI_BASE_URL ?? '';
		case 'compat':
			return env.OPENAI_COMPATIBLE_BASE_URL ?? '';
		default:
			return undefined;
	}
}

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
			const baseURL = env.DASHSCOPE_BASE_URL ?? QWEN_DEFAULT_BASE;
			const p = createOpenAICompatible({ name: 'qwen', baseURL, apiKey: env.DASHSCOPE_API_KEY });
			return { model: p(modelId), label: `qwen/${modelId}`, endpoint: baseURL };
		}
		case 'cloudflare': {
			if (!env.CLOUDFLARE_AI_BASE_URL)
				throw new HostedProviderError('CLOUDFLARE_AI_BASE_URL is not set as a worker secret');
			if (!env.CLOUDFLARE_AI_API_TOKEN)
				throw new HostedProviderError('CLOUDFLARE_AI_API_TOKEN is not set as a worker secret');
			const p = createOpenAICompatible({
				name: 'cloudflare',
				baseURL: env.CLOUDFLARE_AI_BASE_URL,
				apiKey: env.CLOUDFLARE_AI_API_TOKEN,
			});
			return {
				model: p(modelId),
				label: `cloudflare/${modelId}`,
				endpoint: env.CLOUDFLARE_AI_BASE_URL,
			};
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
				`provider ${JSON.stringify(provider)} is not wired hosted. Available: anthropic, qwen, cloudflare, compat.`,
			);
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Same three endpoint families hosting.ts decodes — duplicated because
 * hosting.ts reaches process.env via providers.ts/env.ts (node:fs). */
function qwenLocation(host: string): string {
	if (host.includes('dashscope-intl')) return 'Singapore (international endpoint)';
	if (host.includes('dashscope-us')) return 'United States';
	if (host === 'dashscope.aliyuncs.com') return 'China mainland';
	const regional = host.match(/^([^.]+)\.([a-z]{2}-[a-z]+-\d)\.maas\.aliyuncs\.com$/);
	if (regional) return `workspace "${regional[1]}" · region ${regional[2]}`;
	return 'unknown region';
}

/**
 * The picker catalog for the HOSTED studio — only the providers
 * `resolveModelHosted` can actually run, with the D-53 disclosure intact
 * (who runs inference, where, what is sent). Credentials are worker secrets,
 * so `credential.set` reflects the deployed configuration, not anyone's .env.
 */
export function hostedProviderCatalog(env: ProviderSecrets): HostedCatalogEntry[] {
	const sent = 'Session code and chat are sent to this provider.';
	const qwenBase = compatibleBase(env, 'qwen') ?? QWEN_DEFAULT_BASE;
	const cfBase = compatibleBase(env, 'cloudflare');
	const compatBase = compatibleBase(env, 'compat');
	return [
		{
			name: 'anthropic',
			kind: 'direct',
			hosting: {
				vendor: 'Anthropic',
				location: 'United States',
				host: 'api.anthropic.com',
				dataNote: sent,
			},
			credential: { envVar: 'ANTHROPIC_API_KEY', set: Boolean(env.ANTHROPIC_API_KEY) },
			listable: false,
			suggested: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5'],
		},
		{
			name: 'qwen',
			kind: 'compatible',
			hosting: {
				vendor: 'Alibaba Cloud (Model Studio)',
				location: qwenLocation(hostOf(qwenBase)),
				host: hostOf(qwenBase),
				dataNote: sent,
			},
			credential: { envVar: 'DASHSCOPE_API_KEY', set: Boolean(env.DASHSCOPE_API_KEY) },
			listable: true,
			suggested: [],
		},
		{
			name: 'cloudflare',
			kind: 'compatible',
			hosting: {
				vendor: 'Cloudflare (Workers AI)',
				location: 'global (Cloudflare network) · vendor/model ids partner-served',
				host: cfBase ? hostOf(cfBase) : '(CLOUDFLARE_AI_BASE_URL not set)',
				dataNote: sent,
			},
			credential: {
				envVar: 'CLOUDFLARE_AI_API_TOKEN',
				set: Boolean(env.CLOUDFLARE_AI_API_TOKEN && cfBase),
			},
			listable: true,
			suggested: ['@cf/zai-org/glm-5.2', '@cf/moonshotai/kimi-k2.7-code', 'deepseek/deepseek-v4-pro'],
		},
		{
			name: 'compat',
			kind: 'compatible',
			hosting: {
				vendor: 'Custom endpoint',
				location: 'operator-defined',
				host: compatBase ? hostOf(compatBase) : '(OPENAI_COMPATIBLE_BASE_URL not set)',
				dataNote: sent,
			},
			credential: {
				envVar: 'OPENAI_COMPATIBLE_BASE_URL',
				set: Boolean(compatBase),
			},
			listable: true,
			suggested: [],
		},
	];
}

/** `GET {base}/models` against a compatible provider's endpoint — the hosted
 * twin of providers.ts `listModels`, credentials from worker secrets. */
export async function listModelsHosted(env: ProviderSecrets, provider: string): Promise<string[]> {
	const baseURL = compatibleBase(env, provider);
	if (baseURL === undefined) {
		if (provider === 'anthropic')
			throw new HostedProviderError(
				'listing models is only supported for OpenAI-compatible providers; anthropic is a direct provider — see its own documentation.',
			);
		throw new HostedProviderError(`provider ${JSON.stringify(provider)} is not wired hosted.`);
	}
	if (!baseURL) {
		const envVar = provider === 'cloudflare' ? 'CLOUDFLARE_AI_BASE_URL' : 'OPENAI_COMPATIBLE_BASE_URL';
		throw new HostedProviderError(`provider ${provider} needs ${envVar} set as a worker secret.`);
	}
	const key =
		provider === 'qwen'
			? env.DASHSCOPE_API_KEY
			: provider === 'cloudflare'
				? env.CLOUDFLARE_AI_API_TOKEN
				: env.OPENAI_COMPATIBLE_API_KEY;

	const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
		headers: key ? { Authorization: `Bearer ${key}` } : {},
	});
	if (!res.ok) {
		throw new HostedProviderError(`${baseURL}/models returned HTTP ${res.status}`);
	}
	const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
	return (body.data ?? [])
		.map((m) => (typeof m.id === 'string' ? m.id : null))
		.filter((id): id is string => id !== null)
		.sort();
}
