/**
 * Where does this model actually run? — the disclosure, as data.
 *
 * D-53/D-54: the model provider is a subprocessor of whatever is sent to it, so
 * a picker must say WHERE inference happens, not just which model. This turns a
 * provider row + its effective endpoint into a human-readable hosting statement.
 * Deliberately factual — vendor, place, host — not marketing.
 */
import { MODEL_PAIRS, type ModelPair } from './model-pairs.js';
import { PROVIDERS, type ProviderSpec } from './providers.js';
import { credentialsFrom, type CredentialEnv } from './resolve.js';

export interface HostingInfo {
	/** Who operates the inference endpoint. */
	readonly vendor: string;
	/** Where, as precisely as the endpoint tells us. */
	readonly location: string;
	/** The hostname requests actually go to. */
	readonly host: string;
	/** The one sentence about what is sent — the host's own words. */
	readonly dataNote: string;
}

export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

export interface CatalogOptions {
	/**
	 * What this host sends — 'Session code and chat', 'Conversation text and the
	 * knowledge base'. Rendered as "<sent> — sent to this provider." (number-neutral).
	 */
	readonly sent?: string;
	/** Exclude rows marked `local` (a hosted runtime cannot dial localhost). */
	readonly hosted?: boolean;
	/** Restrict to these providers — e.g. the direct rows a Worker statically wired. */
	readonly only?: readonly string[];
}

function effectiveHost(name: string, row: ProviderSpec, env: CredentialEnv): string {
	const creds = credentialsFrom(name, env);
	if (row.kind === 'direct') return creds.baseUrl ? hostOf(creds.baseUrl) : row.defaultHost;
	return creds.baseUrl ? hostOf(creds.baseUrl) : `(${row.baseUrlEnv} not set)`;
}

export function hostingInfo(provider: string, env: CredentialEnv, options: CatalogOptions = {}): HostingInfo {
	const row = PROVIDERS[provider];
	const sent = `${options.sent ?? 'Inputs'} — sent to this provider.`;
	if (!row) return { vendor: provider, location: 'unknown', host: 'unknown', dataNote: sent };
	const host = effectiveHost(provider, row, env);
	const location = typeof row.hosting.location === 'function' ? row.hosting.location(host) : row.hosting.location;
	return {
		vendor: row.hosting.vendor,
		location,
		host,
		dataNote: row.hosting.local ? `${options.sent ?? 'Inputs'} — never leaves this machine.` : sent,
	};
}

export interface ProviderCatalogEntry {
	readonly name: string;
	readonly kind: 'direct' | 'compatible';
	readonly hosting: HostingInfo;
	/**
	 * `set` means THIS ENVIRONMENT CAN RUN THE ROW — the credential and, for an
	 * account-scoped endpoint such as Cloudflare's, the base URL too. A picker gates
	 * listing and selection on it, and a token with no endpoint can do neither, so
	 * "credential present but endpoint absent" must read as not set. `missing` names
	 * which variables, so the UI can say which one rather than blaming the key.
	 */
	readonly credential: { readonly envVar: string | null; readonly set: boolean; readonly missing: readonly string[] };
	/** True when models can be listed live from the endpoint. */
	readonly listable: boolean;
	readonly suggested: readonly string[];
	/** The `<provider>:auto` pair, when one is declared (model-pairs.ts). */
	readonly pair?: ModelPair;
}

/**
 * The picker catalog: one entry per provider this host can run, with the
 * disclosure intact and `credential.set` reflecting THIS environment.
 */
export function providerCatalog(env: CredentialEnv, options: CatalogOptions = {}): ProviderCatalogEntry[] {
	return Object.entries(PROVIDERS)
		.filter(([name, row]) => !(options.hosted && row.hosting.local))
		.filter(([name]) => !options.only || options.only.includes(name))
		.map(([name, row]) => {
			const envVar = row.envVar ?? null;
			const creds = credentialsFrom(name, env);
			const pair = MODEL_PAIRS[name];
			return {
				name,
				kind: row.kind,
				hosting: hostingInfo(name, env, options),
				credential: { envVar, set: creds.missing.length === 0, missing: creds.missing },
				listable: row.kind === 'compatible',
				suggested: row.suggested ?? [],
				...(pair ? { pair } : {}),
			};
		});
}
