/**
 * Provider resolution for the LOCAL studio — builder-studio.md §5.3, D-49.
 *
 * The table, the grammar, the disclosure and the resolver live in
 * `@substrat-run/model-providers` (#1054); this file is what a Node host adds:
 * credentials from `process.env` (after env.ts loaded the .env files), direct
 * provider packages imported DYNAMICALLY so a missing one is an actionable
 * error rather than a build failure, and advice phrased for apps/builder/.env.
 *
 * The honest bound (§5.3): this makes a model *runnable*, not *capable*. Writing a
 * correct vertical is a hard agentic task with a long tool loop, and smaller models
 * will fail the tier-1 gates rather than fail quietly. That is the right outcome
 * and it is what `evals/` (§9.6) exists to measure.
 */
import {
	PROVIDERS,
	ProviderError,
	createModel,
	explainProviderFailure,
	listModels as listModelsFrom,
	parseModelSpec,
	providerSpec,
	type DirectFactory,
	type ResolvedModel,
} from '@substrat-run/model-providers';
import { envHint } from './env.js';

export { PROVIDERS, ProviderError, type ResolvedModel };

/**
 * The default: the qwen auto pair (model-pairs.ts) — fast for interview turns,
 * strong for build turns. Chosen while the studio is in its testing era: cheap,
 * and weak-model runs are adversarial QA for the mechanical guards (a weak
 * model is what exposed the concept.md dead end). The hosted studio's default
 * stays Anthropic-strong; revisit both once evals/ measures gate pass-rates.
 */
export const DEFAULT_MODEL = 'qwen:auto';

async function importOrExplain(pkg: string): Promise<Record<string, unknown>> {
	try {
		return (await import(pkg)) as Record<string, unknown>;
	} catch {
		throw new ProviderError(`provider package ${pkg} is not installed.\n  pnpm add --filter @substrat-run/builder ${pkg}`);
	}
}

/**
 * `anthropic:claude-opus-5`, `qwen:qwen3-coder-plus`, `ollama:qwen3-coder` → a
 * LanguageModel. A direct provider's package is loaded on demand — adding a
 * provider is a row in the table plus `pnpm add`.
 */
export async function resolveModel(spec: string): Promise<ResolvedModel> {
	const { provider } = parseModelSpec(spec);
	const row = providerSpec(provider);
	const factories: Record<string, DirectFactory> = {};
	if (row.kind === 'direct') {
		const mod = await importOrExplain(row.pkg);
		const create = mod[row.createFactory];
		if (typeof create !== 'function') {
			throw new ProviderError(`${row.pkg} has no callable export ${row.createFactory}`);
		}
		factories[provider] = create as DirectFactory;
	}
	return createModel(spec, process.env, {
		factories,
		describeMissing: (envVar, name) =>
			envVar === row.envVar ? envHint(envVar) : `provider ${name} needs an endpoint.\n  set ${envVar} in apps/builder/.env`,
	});
}

/** Which models a compatible provider's endpoint actually serves, credentials from the environment. */
export function listModels(providerName: string): Promise<string[]> {
	return listModelsFrom(providerName, process.env);
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

		const envVar = PROVIDERS[providerName]?.envVar;
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
			lines.push('', '  Otherwise check the key itself, and that it has no stray quotes or', '  trailing whitespace in .env.');
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
