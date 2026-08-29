/**
 * The provider table — "any LLM" is expressed here and nowhere else (D-49, D-50,
 * #1054).
 *
 * A `provider:model` string names a row; the row says how to reach the
 * endpoint, which environment keys carry its credential, where inference runs
 * (the D-53/D-54 subprocessor disclosure) and what to suggest in a picker.
 * Adding a provider is one row. Nothing downstream — the builder's generator,
 * a vertical's assistant, the pricing ledger, a settings screen — knows which
 * row ran. If that ever stops being true, the seam has leaked.
 *
 * Two shapes:
 *   - `direct`     — an AI SDK provider package with a `createX` factory. The
 *                    package is NOT imported here: a Node host loads it
 *                    dynamically, a Worker host imports it statically, and both
 *                    hand the factory to `createModel`. That is what keeps this
 *                    file loadable everywhere.
 *   - `compatible` — an OpenAI-compatible HTTP endpoint, built with
 *                    `createOpenAICompatible({ baseURL, apiKey })`. One package
 *                    covers DashScope/Qwen, Cloudflare, Scaleway, Ollama, vLLM,
 *                    LM Studio, OpenRouter and anything else speaking that
 *                    dialect, which is why most rows land here.
 *
 * Cloudflare is deliberately an ordinary `compatible` row. Its gateway features
 * (unified billing, per-request metadata, spend limits) are extras a host may
 * layer on THAT row — never a reason for a second code path.
 */

import { isLoopbackHost } from './host.js';

export interface HostingSpec {
	/** Who operates the inference endpoint. */
	readonly vendor: string;
	/**
	 * Where, as precisely as the endpoint tells us. A function decodes it from the
	 * effective host when one vendor serves several regions (DashScope).
	 */
	readonly location: string | ((host: string) => string);
	/**
	 * True for inference that never leaves the machine the host runs on. A hosted
	 * catalog excludes these; the disclosure sentence changes.
	 */
	readonly local?: boolean;
}

interface ProviderBase {
	readonly hosting: HostingSpec;
	/** Env var holding the credential. Absent for local runtimes that need none. */
	readonly envVar?: string;
	/** Picker suggestions for a provider with no listable catalog; free text still wins. */
	readonly suggested?: readonly string[];
	/** One line for `--help`-style listings. */
	readonly note?: string;
}

export interface DirectProvider extends ProviderBase {
	readonly kind: 'direct';
	/** The AI SDK package a host imports. */
	readonly pkg: string;
	/** Default export, used by a Node host when no base-URL override is set. */
	readonly factory: string;
	/** `createX` form — what `createModel` is handed. */
	readonly createFactory: string;
	/** Env var holding a base-URL override. Absent ⇒ endpoint is not overridable. */
	readonly baseUrlEnv?: string;
	/** The host requests go to when no override is set — for the disclosure. */
	readonly defaultHost: string;
}

export interface CompatibleProvider extends ProviderBase {
	readonly kind: 'compatible';
	/** Default endpoint; empty when the endpoint is account-scoped and must be set. */
	readonly baseUrl: string;
	/** Env var overriding the endpoint — self-hosted, regional, or account-scoped. */
	readonly baseUrlEnv: string;
	/**
	 * How the endpoint lists its models. `openai` = `GET {base}/models`;
	 * `cloudflare-catalog` = the account-level `…/ai/models/search` (Workers AI's
	 * compatible surface answers 405 to `/models`).
	 */
	readonly catalog?: 'openai' | 'cloudflare-catalog';
	/**
	 * A fetch wrapper the row needs at the wire — DashScope's explicit
	 * context-cache markers. Named, not imported, so the table stays data.
	 */
	readonly wire?: 'qwen-cache';
}

export type ProviderSpec = DirectProvider | CompatibleProvider;

const SENT = 'sent to this provider';

export const PROVIDERS: Readonly<Record<string, ProviderSpec>> = {
	anthropic: {
		kind: 'direct',
		pkg: '@ai-sdk/anthropic',
		factory: 'anthropic',
		createFactory: 'createAnthropic',
		baseUrlEnv: 'ANTHROPIC_BASE_URL',
		envVar: 'ANTHROPIC_API_KEY',
		defaultHost: 'api.anthropic.com',
		hosting: { vendor: 'Anthropic', location: 'United States' },
		suggested: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5'],
		note: 'e.g. anthropic:claude-opus-5',
	},
	openai: {
		kind: 'direct',
		pkg: '@ai-sdk/openai',
		factory: 'openai',
		createFactory: 'createOpenAI',
		baseUrlEnv: 'OPENAI_BASE_URL',
		envVar: 'OPENAI_API_KEY',
		defaultHost: 'api.openai.com',
		hosting: { vendor: 'OpenAI', location: 'United States' },
	},
	google: {
		kind: 'direct',
		pkg: '@ai-sdk/google',
		factory: 'google',
		createFactory: 'createGoogleGenerativeAI',
		envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
		defaultHost: 'generativelanguage.googleapis.com',
		hosting: { vendor: 'Google', location: 'United States / global' },
	},
	mistral: {
		kind: 'direct',
		pkg: '@ai-sdk/mistral',
		factory: 'mistral',
		createFactory: 'createMistral',
		envVar: 'MISTRAL_API_KEY',
		defaultHost: 'api.mistral.ai',
		hosting: { vendor: 'Mistral', location: 'European Union (France)' },
	},

	/**
	 * Alibaba Model Studio (DashScope), OpenAI-compatible mode. Defaults to the
	 * international endpoint; set DASHSCOPE_BASE_URL for the China-mainland
	 * (`https://dashscope.aliyuncs.com/compatible-mode/v1`), US, or a regional
	 * workspace endpoint. Keys are region- and workspace-scoped, which is why the
	 * location is decoded from the host rather than stated.
	 */
	qwen: {
		kind: 'compatible',
		baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
		baseUrlEnv: 'DASHSCOPE_BASE_URL',
		envVar: 'DASHSCOPE_API_KEY',
		catalog: 'openai',
		wire: 'qwen-cache',
		hosting: { vendor: 'Alibaba Cloud (Model Studio)', location: qwenLocation },
		note: 'e.g. qwen:qwen3-coder-plus · region override via DASHSCOPE_BASE_URL',
	},

	/**
	 * Cloudflare Workers AI + AI Gateway, OpenAI-compatible mode. The endpoint is
	 * account-scoped (`…/accounts/<id>/ai/v1`), so there is no static default —
	 * set CLOUDFLARE_AI_BASE_URL with the account id. Model ids keep their full
	 * catalog prefix: `@cf/…` runs on Cloudflare's own network, a bare
	 * `vendor/model` slug (e.g. `openai/gpt-4.1-mini`) is partner-served under
	 * unified billing. Deliberately NOT wrangler's CLOUDFLARE_API_TOKEN, so an
	 * ambient deploy token is never silently used for inference.
	 */
	cloudflare: {
		kind: 'compatible',
		baseUrl: '',
		baseUrlEnv: 'CLOUDFLARE_AI_BASE_URL',
		envVar: 'CLOUDFLARE_AI_API_TOKEN',
		catalog: 'cloudflare-catalog',
		hosting: {
			vendor: 'Cloudflare (Workers AI)',
			// D-53 honesty: `@cf/…` ids run on Cloudflare's network; bare
			// `vendor/model` ids are partner-served on that vendor's infrastructure.
			location: 'global (Cloudflare network) · vendor/model ids partner-served',
		},
		suggested: ['@cf/zai-org/glm-5.2', '@cf/moonshotai/kimi-k2.7-code', 'deepseek/deepseek-v4-pro'],
		note: 'e.g. cloudflare:@cf/zai-org/glm-5.2 · set CLOUDFLARE_AI_BASE_URL to https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1',
	},

	/**
	 * Scaleway Generative APIs — EU-hosted (Paris) open-weight models behind the
	 * OpenAI dialect. The row that makes the data-residency answer a picker
	 * choice rather than a procurement exception.
	 */
	scaleway: {
		kind: 'compatible',
		baseUrl: 'https://api.scaleway.ai/v1',
		baseUrlEnv: 'SCALEWAY_AI_BASE_URL',
		envVar: 'SCALEWAY_API_KEY',
		catalog: 'openai',
		hosting: { vendor: 'Scaleway (Generative APIs)', location: 'European Union (France, Paris)' },
		note: 'e.g. scaleway:llama-3.3-70b-instruct · EU-resident inference',
	},

	/** Local models. No credential; the endpoint is Ollama's OpenAI-compatible one. */
	ollama: {
		kind: 'compatible',
		baseUrl: 'http://localhost:11434/v1',
		baseUrlEnv: 'OLLAMA_BASE_URL',
		catalog: 'openai',
		hosting: { vendor: 'Ollama (self-hosted)', location: ollamaLocation, local: true },
		note: 'e.g. ollama:qwen3-coder · needs `ollama serve` and the model pulled',
	},

	/** Escape hatch: anything else speaking the OpenAI dialect (vLLM, LM Studio, OpenRouter…). */
	compat: {
		kind: 'compatible',
		baseUrl: '',
		baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL',
		envVar: 'OPENAI_COMPATIBLE_API_KEY',
		catalog: 'openai',
		hosting: { vendor: 'Custom endpoint', location: 'operator-defined' },
		note: 'set OPENAI_COMPATIBLE_BASE_URL to the endpoint',
	},
};

/**
 * Ollama's endpoint is overridable, so "this machine" is a claim about the ENDPOINT, not
 * about the row. Pointed at a GPU box on the LAN it is somebody else's machine, and the
 * disclosure says so rather than repeating the default.
 */
export function ollamaLocation(host: string): string {
	return isLoopbackHost(host) ? 'this machine' : 'a remote host — OLLAMA_BASE_URL points off this machine';
}

/** DashScope endpoints encode region three different ways; decode them all. */
export function qwenLocation(host: string): string {
	if (host.includes('dashscope-intl')) return 'Singapore (international endpoint)';
	if (host.includes('dashscope-us')) return 'United States';
	if (host === 'dashscope.aliyuncs.com') return 'China mainland';
	const regional = host.match(/^([^.]+)\.([a-z]{2}-[a-z]+-\d)\.maas\.aliyuncs\.com$/);
	if (regional) return `workspace "${regional[1]}" · region ${regional[2]}`;
	return 'unknown region';
}

/** One line per provider, for a CLI's "known providers" listing. */
export function knownProviders(): string {
	return Object.entries(PROVIDERS)
		.map(([name, spec]) => `    ${name.padEnd(10)} ${spec.note ?? ''}`)
		.join('\n');
}

/** The credential env var of a provider, or null when it needs none / is unknown. */
export function credentialEnvVar(provider: string): string | null {
	return PROVIDERS[provider]?.envVar ?? null;
}

export { SENT as DATA_SENT_PHRASE };
