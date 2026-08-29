/**
 * `provider:model` + credentials → a `LanguageModel`, with the host deciding
 * WHERE credentials come from and HOW provider packages are loaded.
 *
 * Two hosts exist today and they differ on exactly those two axes: the builder
 * CLI reads `process.env` and imports provider packages dynamically; a Worker
 * reads its bindings and can only import statically. So the resolver takes the
 * credential environment as a plain record and the direct-provider factories as
 * a map — the table (providers.ts) says which env var and which factory NAME,
 * the host supplies the values. Nothing here touches `process`.
 *
 * Compatible providers need no injection: `@ai-sdk/openai-compatible` is a
 * dependency of this package, imported statically, and safe everywhere.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { PROVIDERS, providerRow, type ProviderSpec } from './providers.js';
import { qwenCacheFetch } from './qwen-cache.js';
import { parseModelSpec } from './spec.js';

export class ProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProviderError';
	}
}

/** A credential environment — `process.env`, a Worker's bindings, or a test's literal. */
export type CredentialEnv = Readonly<Record<string, string | undefined>>;

/** What a provider row resolves to against one environment. */
export interface ProviderCredentials {
	readonly apiKey?: string;
	/** Effective endpoint (compatible rows) or override (direct rows); '' when unset and required. */
	readonly baseUrl: string;
	/** Which env var supplied the endpoint, or 'default'. */
	readonly baseUrlSource: 'default' | string;
	/** Env vars the row needs and the environment does not carry. */
	readonly missing: readonly string[];
}

/**
 * Read a provider's credential and endpoint from an environment — pure, no
 * process access, so a Worker and the CLI resolve identically from their own
 * sources.
 */
export function credentialsFrom(provider: string, env: CredentialEnv): ProviderCredentials {
	const spec = providerRow(provider);
	if (!spec) throw unknownProvider(provider);
	const missing: string[] = [];
	const apiKey = spec.envVar ? env[spec.envVar] : undefined;
	if (spec.envVar && !apiKey) missing.push(spec.envVar);

	if (spec.kind === 'direct') {
		const override = spec.baseUrlEnv ? env[spec.baseUrlEnv] : undefined;
		return {
			...(apiKey ? { apiKey } : {}),
			baseUrl: override ?? '',
			baseUrlSource: override && spec.baseUrlEnv ? spec.baseUrlEnv : 'default',
			missing,
		};
	}
	const override = env[spec.baseUrlEnv];
	const baseUrl = override ?? spec.baseUrl;
	if (!baseUrl) missing.push(spec.baseUrlEnv);
	return {
		...(apiKey ? { apiKey } : {}),
		baseUrl,
		baseUrlSource: override ? spec.baseUrlEnv : 'default',
		missing,
	};
}

/** The `createX` shape every AI SDK direct provider exports. */
export type DirectFactory = (config: { apiKey?: string; baseURL?: string }) => (modelId: string) => LanguageModel;

/** Direct-provider factories keyed by provider name — `{ anthropic: createAnthropic }`. */
export type DirectFactories = Readonly<Record<string, DirectFactory | undefined>>;

export interface ResolvedModel {
	readonly model: LanguageModel;
	/** `provider/modelId` — the label ledgers and banners show. */
	readonly label: string;
	readonly provider: string;
	readonly modelId: string;
	/**
	 * The endpoint this model will actually call, and which env var chose it.
	 * Surfaced because a silently-ignored base-URL override is otherwise
	 * invisible until a request fails — and then it looks like a bad key.
	 */
	readonly endpoint?: string;
	readonly endpointSource?: 'default' | string;
}

export interface CreateModelOptions {
	/** Direct-provider factories the host loaded. A direct row with no factory here is refused. */
	readonly factories?: DirectFactories;
	/**
	 * Turns a missing env var into the host's own advice ("set it in .env" vs
	 * "set it as a worker secret"). Default names the variable and stops.
	 */
	readonly describeMissing?: (envVar: string, provider: string) => string;
	/** Refuse rows marked `local` — a hosted runtime cannot dial localhost. */
	readonly hosted?: boolean;
}

/**
 * Build the model. Every refusal is a `ProviderError` with the next step in it.
 */
export function createModel(spec: string, env: CredentialEnv, options: CreateModelOptions = {}): ResolvedModel {
	const { provider, modelId } = parseModelSpec(spec);
	const row = providerRow(provider);
	if (!row) throw unknownProvider(provider);
	if (!modelId) throw new ProviderError(`no model id in ${JSON.stringify(spec)}`);
	if (options.hosted && row.hosting.local) {
		throw new ProviderError(
			`${provider} is local-machine inference — it does not exist on a hosted runtime. Use a local host for local models.`,
		);
	}

	const creds = credentialsFrom(provider, env);
	if (creds.missing.length) {
		const describe = options.describeMissing ?? ((v: string) => `${v} is not set.`);
		throw new ProviderError(
			`provider ${provider} is not configured.\n` + creds.missing.map((v) => `  ${describe(v, provider)}`).join('\n'),
		);
	}

	const label = `${provider}/${modelId}`;
	if (row.kind === 'direct') {
		const create = options.factories?.[provider];
		if (!create) {
			throw new ProviderError(
				`provider ${provider} needs ${row.pkg} (${row.createFactory}) loaded by the host — it is not wired here.`,
			);
		}
		const built = create({
			...(creds.apiKey ? { apiKey: creds.apiKey } : {}),
			...(creds.baseUrl ? { baseURL: creds.baseUrl } : {}),
		});
		return {
			model: built(modelId),
			label,
			provider,
			modelId,
			...(creds.baseUrl ? { endpoint: creds.baseUrl, endpointSource: creds.baseUrlSource } : {}),
		};
	}

	const factory = createOpenAICompatible({
		name: provider,
		baseURL: creds.baseUrl,
		// Local runtimes ignore this but the client still wants a value.
		apiKey: creds.apiKey ?? 'local',
		...(row.wire === 'qwen-cache' ? { fetch: qwenCacheFetch() } : {}),
	});
	return {
		model: factory(modelId),
		label,
		provider,
		modelId,
		endpoint: creds.baseUrl,
		endpointSource: creds.baseUrlSource,
	};
}

function unknownProvider(provider: string): ProviderError {
	return new ProviderError(
		`unknown provider ${JSON.stringify(provider)}. Known: ${Object.keys(PROVIDERS).join(', ')}\n` +
			`  Use provider:model, e.g. anthropic:claude-opus-5 — or provider:auto for a declared pair`,
	);
}

/** The row for a provider, or a ProviderError naming the known ones. */
export function providerSpec(provider: string): ProviderSpec {
	const row = providerRow(provider);
	if (!row) throw unknownProvider(provider);
	return row;
}
