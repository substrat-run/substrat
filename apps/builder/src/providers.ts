/**
 * Provider resolution — builder-studio.md §5.3, D-49.
 *
 * "Any LLM" is expressed here and nowhere else: a `provider:model` string becomes
 * a `LanguageModel`, the provider package is imported dynamically, and nothing
 * downstream knows which one ran. Adding a provider is a row in this table plus
 * `pnpm add` — no change to the generator, the tools, or the UI. If that ever
 * stops being true, the seam has leaked.
 *
 * Two shapes of provider:
 *   - `direct`     — the package exports a factory called with a model id.
 *   - `compatible` — an OpenAI-compatible HTTP endpoint, built with
 *                    `createOpenAICompatible({ baseURL, apiKey })`. One package
 *                    (`@ai-sdk/openai-compatible`) covers DashScope/Qwen, Ollama,
 *                    vLLM, LM Studio, OpenRouter and anything else speaking that
 *                    dialect, which is why most new entries land here.
 *
 * The honest bound (§5.3): this makes a model *runnable*, not *capable*. Writing a
 * correct vertical is a hard agentic task with a long tool loop, and smaller models
 * will fail the tier-1 gates rather than fail quietly. That is the right outcome
 * and it is what `evals/` (§9.6) exists to measure.
 */
import type { LanguageModel } from 'ai';
import { envHint } from './env.js';
import { explainProviderFailure } from './provider-errors.js';

interface DirectProvider {
	readonly kind: 'direct';
	readonly pkg: string;
	/** Default export, used when no base-URL override is set. */
	readonly factory: string;
	/** `createX` form, used when the base URL is overridden (proxies, gateways). */
	readonly createFactory?: string;
	/** Env var holding a base-URL override. Absent ⇒ endpoint is not overridable. */
	readonly baseUrlEnv?: string;
	readonly envVar?: string;
}

interface CompatibleProvider {
	readonly kind: 'compatible';
	/** Default endpoint; override with `baseUrlEnv` for self-hosted or regional. */
	readonly baseUrl: string;
	readonly baseUrlEnv: string;
	/** Absent for local runtimes that need no credential. */
	readonly envVar?: string;
	readonly note?: string;
}

export type ProviderSpec = DirectProvider | CompatibleProvider;

export const PROVIDERS: Readonly<Record<string, ProviderSpec>> = {
	anthropic: {
		kind: 'direct',
		pkg: '@ai-sdk/anthropic',
		factory: 'anthropic',
		createFactory: 'createAnthropic',
		baseUrlEnv: 'ANTHROPIC_BASE_URL',
		envVar: 'ANTHROPIC_API_KEY',
	},
	openai: {
		kind: 'direct',
		pkg: '@ai-sdk/openai',
		factory: 'openai',
		createFactory: 'createOpenAI',
		baseUrlEnv: 'OPENAI_BASE_URL',
		envVar: 'OPENAI_API_KEY',
	},
	google: {
		kind: 'direct',
		pkg: '@ai-sdk/google',
		factory: 'google',
		envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
	},
	mistral: { kind: 'direct', pkg: '@ai-sdk/mistral', factory: 'mistral', envVar: 'MISTRAL_API_KEY' },

	/**
	 * Alibaba Model Studio (DashScope), OpenAI-compatible mode. Defaults to the
	 * international endpoint; set DASHSCOPE_BASE_URL for the China-mainland
	 * (`https://dashscope.aliyuncs.com/compatible-mode/v1`), US, or a regional
	 * workspace endpoint.
	 */
	qwen: {
		kind: 'compatible',
		baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
		baseUrlEnv: 'DASHSCOPE_BASE_URL',
		envVar: 'DASHSCOPE_API_KEY',
		note: 'e.g. qwen:qwen3-coder-plus · region override via DASHSCOPE_BASE_URL',
	},

	/**
	 * Cloudflare Workers AI, OpenAI-compatible mode. The endpoint is
	 * account-scoped (`…/accounts/<id>/ai/v1`), so there is no static default —
	 * set CLOUDFLARE_AI_BASE_URL with your account id. Model ids keep their full
	 * catalog prefix: `@cf/…` runs on Cloudflare's own network, a bare
	 * `vendor/model` slug (e.g. `deepseek/deepseek-v4-pro`) is partner-served
	 * under unified billing. Deliberately NOT wrangler's CLOUDFLARE_API_TOKEN,
	 * so an ambient deploy token is never silently used for inference.
	 */
	cloudflare: {
		kind: 'compatible',
		baseUrl: '',
		baseUrlEnv: 'CLOUDFLARE_AI_BASE_URL',
		envVar: 'CLOUDFLARE_AI_API_TOKEN',
		note: 'e.g. cloudflare:@cf/zai-org/glm-5.2 · set CLOUDFLARE_AI_BASE_URL to https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1',
	},

	/** Local models. No credential; the endpoint is Ollama's OpenAI-compatible one. */
	ollama: {
		kind: 'compatible',
		baseUrl: 'http://localhost:11434/v1',
		baseUrlEnv: 'OLLAMA_BASE_URL',
		note: 'e.g. ollama:qwen3-coder · needs `ollama serve` and the model pulled',
	},

	/** Escape hatch: anything else speaking the OpenAI dialect (vLLM, LM Studio, OpenRouter…). */
	compat: {
		kind: 'compatible',
		baseUrl: '',
		baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL',
		envVar: 'OPENAI_COMPATIBLE_API_KEY',
		note: 'set OPENAI_COMPATIBLE_BASE_URL to the endpoint',
	},
};

/** The default: Opus 5 runs adaptive thinking without being asked (§5.3). */
export const DEFAULT_MODEL = 'anthropic:claude-opus-5';

export interface ResolvedModel {
	readonly model: LanguageModel;
	readonly label: string;
	/**
	 * The endpoint this model will actually call, and whether an override applied.
	 * Surfaced in the banner because a silently-ignored base-URL override is
	 * otherwise invisible until a request fails — and then it looks like a bad key.
	 */
	readonly endpoint?: string;
	readonly endpointSource?: 'default' | string;
}

export class ProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProviderError';
	}
}

function knownProviders(): string {
	return Object.entries(PROVIDERS)
		.map(([name, spec]) => `    ${name.padEnd(10)} ${'note' in spec && spec.note ? spec.note : ''}`)
		.join('\n');
}

async function importOrExplain(pkg: string): Promise<Record<string, unknown>> {
	try {
		return (await import(pkg)) as Record<string, unknown>;
	} catch {
		throw new ProviderError(
			`provider package ${pkg} is not installed.\n  pnpm add --filter @substrat-run/builder ${pkg}`,
		);
	}
}

/**
 * `anthropic:claude-opus-5`, `qwen:qwen3-coder-plus`, `ollama:qwen3-coder` → a
 * LanguageModel. A bare string with no colon is an Anthropic model id, since that
 * is the default provider.
 */
export async function resolveModel(spec: string): Promise<ResolvedModel> {
	const idx = spec.indexOf(':');
	const providerName = idx === -1 ? 'anthropic' : spec.slice(0, idx);
	const modelId = idx === -1 ? spec : spec.slice(idx + 1);

	const provider = PROVIDERS[providerName];
	if (!provider) {
		throw new ProviderError(
			`unknown provider ${JSON.stringify(providerName)}. Known:\n${knownProviders()}\n` +
				`  Use provider:model, e.g. ${DEFAULT_MODEL}`,
		);
	}
	if (!modelId) throw new ProviderError(`no model id in ${JSON.stringify(spec)}`);

	if (provider.envVar && !process.env[provider.envVar]) {
		throw new ProviderError(
			`no credential for provider ${providerName}.\n${envHint(provider.envVar)}`,
		);
	}

	if (provider.kind === 'direct') {
		const mod = await importOrExplain(provider.pkg);
		const override = provider.baseUrlEnv ? process.env[provider.baseUrlEnv] : undefined;

		// Only reach for the createX form when an endpoint override is present —
		// the default export is the well-trodden path and needs no config.
		if (override && provider.createFactory) {
			const create = mod[provider.createFactory];
			if (typeof create !== 'function') {
				throw new ProviderError(`${provider.pkg} has no callable export ${provider.createFactory}`);
			}
			const built = (
				create as (cfg: { baseURL: string; apiKey?: string }) => (id: string) => LanguageModel
			)({
				baseURL: override,
				...(provider.envVar ? { apiKey: process.env[provider.envVar] } : {}),
			});
			return { model: built(modelId), label: `${providerName}/${modelId}` };
		}

		const factory = mod[provider.factory];
		if (typeof factory !== 'function') {
			throw new ProviderError(`${provider.pkg} has no callable export ${provider.factory}`);
		}
		return {
			model: (factory as (id: string) => LanguageModel)(modelId),
			label: `${providerName}/${modelId}`,
		};
	}

	const baseURL = process.env[provider.baseUrlEnv] ?? provider.baseUrl;
	if (!baseURL) {
		throw new ProviderError(
			`provider ${providerName} needs an endpoint.\n  set ${provider.baseUrlEnv} in apps/builder/.env`,
		);
	}

	const mod = await importOrExplain('@ai-sdk/openai-compatible');
	const create = mod['createOpenAICompatible'];
	if (typeof create !== 'function') {
		throw new ProviderError('@ai-sdk/openai-compatible has no createOpenAICompatible export');
	}

	const factory = (
		create as (cfg: {
			name: string;
			baseURL: string;
			apiKey?: string;
		}) => (id: string) => LanguageModel
	)({
		name: providerName,
		baseURL,
		// Local runtimes ignore this but the client still wants a value.
		apiKey: provider.envVar ? process.env[provider.envVar] : 'local',
	});

	return {
		model: factory(modelId),
		label: `${providerName}/${modelId}`,
		endpoint: baseURL,
		endpointSource: process.env[provider.baseUrlEnv] ? provider.baseUrlEnv : 'default',
	};
}

/**
 * Ask an OpenAI-compatible endpoint which models it actually serves.
 *
 * Worth having as a first-class affordance: a workspace or regional plan exposes
 * its own model list, so a model id that is valid on one endpoint returns a bare
 * "Model not exist." on another — with no hint of what would work instead.
 */
export async function listModels(providerName: string): Promise<string[]> {
	const provider = PROVIDERS[providerName];
	if (!provider) throw new ProviderError(`unknown provider ${JSON.stringify(providerName)}`);
	if (provider.kind !== 'compatible') {
		throw new ProviderError(
			`listing models is only supported for OpenAI-compatible providers; ` +
				`${providerName} is a direct provider — see its own documentation.`,
		);
	}

	const baseURL = process.env[provider.baseUrlEnv] ?? provider.baseUrl;
	if (!baseURL) {
		throw new ProviderError(`provider ${providerName} needs ${provider.baseUrlEnv} set.`);
	}
	const key = provider.envVar ? process.env[provider.envVar] : undefined;

	const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
		headers: key ? { Authorization: `Bearer ${key}` } : {},
	});
	if (!res.ok) {
		throw new ProviderError(`${baseURL}/models returned HTTP ${res.status}`);
	}
	const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
	return (body.data ?? [])
		.map((m) => (typeof m.id === 'string' ? m.id : null))
		.filter((id): id is string => id !== null)
		.sort();
}

/**
 * Turns a provider's HTTP error into something actionable. Provider knowledge
 * lives here rather than in the generator (D-49) — `AiSdkGenerator` takes this as
 * an opaque hook and stays free of any provider's semantics.
 *
 * The DashScope case is worth special handling because the failure is
 * indistinguishable from a typo: Model Studio API keys are **region-scoped**, so
 * a key minted in one console returns a plain 401 against the other region's
 * endpoint, with no hint that the key itself is fine.
 */
export function explainProviderError(providerName: string): (err: unknown) => string | null {
	return (err: unknown) => {
		// Shared classes first (quota, rate limit, model-not-exist, generic auth) —
		// the local-specific region/endpoint detail below only refines 401/403.
		const shared = explainProviderFailure(providerName, err, 'local');
		const e = err as Record<string, unknown> | null;
		const status = typeof e?.['statusCode'] === 'number' ? (e['statusCode'] as number) : undefined;
		const url = typeof e?.['url'] === 'string' ? (e['url'] as string) : '';
		const base = err instanceof Error ? err.message : String(err);

		// "Model not exist." — valid credential, wrong model id for THIS endpoint.
		// Distinct from an auth failure and needs completely different advice.
		if (/model.{0,4}not.{0,4}exist|model_not_found|does not exist/i.test(base)) {
			return [
				base,
				'',
				`  provider ${providerName} does not serve that model id at this endpoint.`,
				'  A workspace or regional plan exposes its own model list, so an id that',
				'  works elsewhere can be absent here.',
				'',
				'  See what this endpoint offers:',
				`    pnpm builder models --provider ${providerName}`,
				'',
				'  Then set SUBSTRAT_BUILDER_MODEL in apps/builder/.env, or pass --model.',
			].join('\n');
		}

		if (status !== 401 && status !== 403) return shared;

		const spec = PROVIDERS[providerName];
		const envVar = spec && 'envVar' in spec ? spec.envVar : undefined;
		const lines = [`${base}`, '', `  provider ${providerName} rejected the credential (HTTP ${status}).`];

		if (providerName === 'qwen') {
			// Three endpoint families, not two — a workspace-scoped regional endpoint
			// (`{workspace}.{region}.maas.aliyuncs.com`) is neither intl nor mainland,
			// so offering the intl↔mainland swap there would be wrong advice.
			const regional = url.includes('.maas.aliyuncs.com');
			lines.push(
				'',
				'  Model Studio API keys are REGION- and WORKSPACE-scoped, which is the',
				'  usual cause — the key is often fine, just minted somewhere else:',
				`    you called   ${url || '(unknown endpoint)'}`,
			);
			if (regional) {
				lines.push(
					'',
					'  This is a workspace-scoped regional endpoint, so the key must come from',
					'  that same workspace and region. Check DASHSCOPE_BASE_URL matches the',
					'  workspace the key belongs to, in apps/builder/.env.',
				);
			} else {
				const intl = url.includes('dashscope-intl');
				lines.push(
					`    a key from the ${intl ? 'China-mainland' : 'international'} console will not work there.`,
					'',
					'  If the key came from the other console, set in apps/builder/.env:',
					`    DASHSCOPE_BASE_URL=${
						intl
							? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
							: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
					}`,
					'',
					'  For a workspace-scoped plan, use its own endpoint instead:',
					'    DASHSCOPE_BASE_URL=https://<workspace>.<region>.maas.aliyuncs.com/compatible-mode/v1',
				);
			}
			lines.push(
				'',
				'  Otherwise check the key itself, and that it has no stray quotes or',
				'  trailing whitespace in .env.',
			);
		} else if (envVar) {
			lines.push(
				'',
				`  Check ${envVar} in apps/builder/.env — no stray quotes or trailing whitespace,`,
				'  and confirm the key is enabled for this endpoint.',
			);
		}
		return lines.join('\n');
	};
}
