/**
 * @substrat-run/model-providers — the model-provider seam (#1054).
 *
 * One `provider:model` grammar, one table of providers, one disclosure per row,
 * one generated rate card and the list-price math over it. Hosts differ only in
 * where credentials come from and how direct-provider packages get loaded, and
 * both of those are parameters. Cloudflare is one row.
 */
export { DEFAULT_PROVIDER, normalizeModelSpec, parseModelSpec, providerOf, type ModelSpec } from './spec.js';
export {
	PROVIDERS,
	credentialEnvVar,
	knownProviders,
	ollamaLocation,
	qwenLocation,
	type CompatibleProvider,
	type DirectProvider,
	type HostingSpec,
	type ProviderSpec,
} from './providers.js';
export {
	ProviderError,
	createModel,
	credentialsFrom,
	providerSpec,
	type CreateModelOptions,
	type CredentialEnv,
	type DirectFactories,
	type DirectFactory,
	type ProviderCredentials,
	type ResolvedModel,
} from './resolve.js';
export { listModels } from './list-models.js';
export { hostOf, isLoopbackHost } from './host.js';
export {
	hostingInfo,
	providerCatalog,
	type CatalogOptions,
	type HostingInfo,
	type ProviderCatalogEntry,
} from './catalog.js';
export { MODEL_PAIRS, pairFor, resolveAutoSpec, samplingFor, type ModelPair, type PairTier } from './model-pairs.js';
export {
	listCostOf,
	listCostOfSteps,
	rateFor,
	type ModelRate,
	type RateTier,
	type StepTokens,
} from './pricing.js';
export { RATE_CARD, RATE_CARD_GENERATED_AT } from './rate-card.generated.js';
export { errorFacts, explainProviderFailure, type ErrorFacts } from './provider-errors.js';
export { qwenCacheFetch, withQwenCacheMarkers } from './qwen-cache.js';
