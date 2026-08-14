/**
 * Where does this model actually run? — the §2.1 disclosure, as data.
 *
 * D-53: the model provider is a subprocessor of the customer's code, so the
 * picker must say WHERE inference happens, not just which model. This file turns
 * a provider + its effective endpoint into a human-readable hosting statement.
 * Deliberately factual — vendor, place, host — not marketing.
 */
import { PROVIDERS } from './providers.js';

export interface HostingInfo {
	/** Who operates the inference endpoint. */
	readonly vendor: string;
	/** Where, as precisely as the endpoint tells us. */
	readonly location: string;
	/** The hostname requests actually go to. */
	readonly host: string;
	/** The §2.1 sentence for this choice. */
	readonly dataNote: string;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** DashScope endpoints encode region three different ways; decode them all. */
function qwenLocation(host: string): string {
	if (host.includes('dashscope-intl')) return 'Singapore (international endpoint)';
	if (host.includes('dashscope-us')) return 'United States';
	if (host === 'dashscope.aliyuncs.com') return 'China mainland';
	const regional = host.match(/^([^.]+)\.([a-z]{2}-[a-z]+-\d)\.maas\.aliyuncs\.com$/);
	if (regional) return `workspace "${regional[1]}" · region ${regional[2]}`;
	return 'unknown region';
}

export function hostingInfo(providerName: string): HostingInfo {
	const spec = PROVIDERS[providerName];
	const sent = 'Session code and chat are sent to this provider.';

	switch (providerName) {
		case 'anthropic': {
			const host = hostOf(process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com');
			return { vendor: 'Anthropic', location: 'United States', host, dataNote: sent };
		}
		case 'openai': {
			const host = hostOf(process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com');
			return { vendor: 'OpenAI', location: 'United States', host, dataNote: sent };
		}
		case 'google':
			return {
				vendor: 'Google',
				location: 'United States / global',
				host: 'generativelanguage.googleapis.com',
				dataNote: sent,
			};
		case 'mistral':
			return { vendor: 'Mistral', location: 'European Union (France)', host: 'api.mistral.ai', dataNote: sent };
		case 'qwen': {
			const base =
				(spec?.kind === 'compatible' ? process.env[spec.baseUrlEnv] : undefined) ??
				(spec?.kind === 'compatible' ? spec.baseUrl : '');
			const host = hostOf(base);
			return {
				vendor: 'Alibaba Cloud (Model Studio)',
				location: qwenLocation(host),
				host,
				dataNote: sent,
			};
		}
		case 'cloudflare': {
			const base = spec?.kind === 'compatible' ? (process.env[spec.baseUrlEnv] ?? '') : '';
			return {
				vendor: 'Cloudflare (Workers AI)',
				// D-53 honesty: `@cf/…` ids run on Cloudflare's network; bare
				// `vendor/model` ids are partner-served on that vendor's infrastructure.
				location: 'global (Cloudflare network) · vendor/model ids partner-served',
				host: base ? hostOf(base) : '(CLOUDFLARE_AI_BASE_URL not set)',
				dataNote: sent,
			};
		}
		case 'ollama': {
			const base =
				(spec?.kind === 'compatible' ? process.env[spec.baseUrlEnv] : undefined) ??
				'http://localhost:11434/v1';
			return {
				vendor: 'Ollama (self-hosted)',
				location: 'this machine',
				host: hostOf(base),
				dataNote: 'Code and chat never leave this machine.',
			};
		}
		case 'compat': {
			const base = spec?.kind === 'compatible' ? (process.env[spec.baseUrlEnv] ?? '') : '';
			return {
				vendor: 'Custom endpoint',
				location: 'operator-defined',
				host: base ? hostOf(base) : '(OPENAI_COMPATIBLE_BASE_URL not set)',
				dataNote: sent,
			};
		}
		default:
			return { vendor: providerName, location: 'unknown', host: 'unknown', dataNote: sent };
	}
}

/**
 * Model suggestions for providers with no listable catalog. Marked as
 * suggestions in the UI — the picker also takes a free-text id, because a
 * hardcoded list is stale the day after it is written.
 */
export function suggestedModels(providerName: string): string[] {
	switch (providerName) {
		case 'anthropic':
			return ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5'];
		case 'cloudflare':
			return [
				'@cf/zai-org/glm-5.2',
				'@cf/zai-org/glm-4.7-flash',
				'@cf/moonshotai/kimi-k2.7-code',
				'deepseek/deepseek-v4-pro',
			];
		default:
			return [];
	}
}

export interface ProviderCatalogEntry {
	readonly name: string;
	readonly kind: 'direct' | 'compatible';
	readonly hosting: HostingInfo;
	readonly credential: { readonly envVar: string | null; readonly set: boolean };
	/** True when models can be listed live from the endpoint (`/models`). */
	readonly listable: boolean;
	readonly suggested: readonly string[];
}

export function providerCatalog(): ProviderCatalogEntry[] {
	return Object.entries(PROVIDERS).map(([name, spec]) => {
		const envVar = 'envVar' in spec ? (spec.envVar ?? null) : null;
		return {
			name,
			kind: spec.kind,
			hosting: hostingInfo(name),
			credential: { envVar, set: envVar === null || Boolean(process.env[envVar]) },
			listable: spec.kind === 'compatible',
			suggested: suggestedModels(name),
		};
	});
}
