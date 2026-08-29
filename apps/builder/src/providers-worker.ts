/**
 * Provider resolution for the HOSTED studio (#626) — env bindings, not
 * process.env, and static imports only: a worker cannot dynamically install
 * provider packages the way the local CLI offers to.
 *
 * Same `provider:model` grammar and the same table as src/providers.ts — both
 * from `@substrat-run/model-providers` (#1054). What this file decides is only
 * which direct providers the worker bundle carries (the factories below) and
 * how missing configuration is phrased (worker secrets). The D-53 hosting
 * disclosure carries over unchanged; Ollama is meaningfully LOCAL and is
 * refused hosted by the resolver's `hosted` flag.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import {
	ProviderError,
	createModel,
	listModels,
	providerCatalog,
	type DirectFactories,
	type ProviderCatalogEntry,
} from '@substrat-run/model-providers';
import { SENT } from './disclosure.js';

/** Structurally identical to hosting.ts `ProviderCatalogEntry` (and the web client's `ProviderEntry`). */
export type HostedCatalogEntry = ProviderCatalogEntry;

export interface ProviderSecrets {
	ANTHROPIC_API_KEY?: string;
	DASHSCOPE_API_KEY?: string;
	DASHSCOPE_BASE_URL?: string;
	CLOUDFLARE_AI_BASE_URL?: string;
	CLOUDFLARE_AI_API_TOKEN?: string;
	SCALEWAY_API_KEY?: string;
	SCALEWAY_AI_BASE_URL?: string;
	OPENAI_COMPATIBLE_BASE_URL?: string;
	OPENAI_COMPATIBLE_API_KEY?: string;
}

export { ProviderError as HostedProviderError };

/** The direct providers this bundle statically carries. Add a row here AND `pnpm add` to wire another. */
const FACTORIES: DirectFactories = { anthropic: createAnthropic };

/** Direct rows the bundle wired, plus every compatible row (they need no package). */
const HOSTED = ['anthropic', 'qwen', 'cloudflare', 'scaleway', 'compat'];

export function resolveModelHosted(env: ProviderSecrets, spec: string) {
	return createModel(spec, env as Record<string, string | undefined>, {
		factories: FACTORIES,
		hosted: true,
		describeMissing: (envVar) => `${envVar} is not set as a worker secret`,
	});
}

/**
 * The picker catalog for the HOSTED studio — only the providers
 * `resolveModelHosted` can actually run, with the D-53 disclosure intact
 * (who runs inference, where, what is sent). Credentials are worker secrets,
 * so `credential.set` reflects the deployed configuration, not anyone's .env.
 */
export function hostedProviderCatalog(env: ProviderSecrets): HostedCatalogEntry[] {
	return providerCatalog(env as Record<string, string | undefined>, { hosted: true, only: HOSTED, sent: SENT });
}

/** The hosted twin of providers.ts `listModels`, credentials from worker secrets. */
export function listModelsHosted(env: ProviderSecrets, provider: string): Promise<string[]> {
	if (!HOSTED.includes(provider)) {
		throw new ProviderError(`provider ${JSON.stringify(provider)} is not wired hosted. Available: ${HOSTED.join(', ')}.`);
	}
	return listModels(provider, env as Record<string, string | undefined>);
}
