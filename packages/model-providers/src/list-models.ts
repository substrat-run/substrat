/**
 * Ask an OpenAI-compatible endpoint which models it actually serves.
 *
 * Worth having as a first-class affordance: a workspace or regional plan exposes
 * its own model list, so a model id that is valid on one endpoint returns a bare
 * "Model not exist." on another — with no hint of what would work instead.
 *
 * Direct providers are not listable here — see their own documentation.
 */
import { credentialsFrom, ProviderError, providerSpec, type CredentialEnv } from './resolve.js';

export async function listModels(provider: string, env: CredentialEnv): Promise<string[]> {
	const row = providerSpec(provider);
	if (row.kind !== 'compatible') {
		throw new ProviderError(
			`listing models is only supported for OpenAI-compatible providers; ` +
				`${provider} is a direct provider — see its own documentation.`,
		);
	}
	const creds = credentialsFrom(provider, env);
	if (!creds.baseUrl) throw new ProviderError(`provider ${provider} needs ${row.baseUrlEnv} set.`);
	const headers: Record<string, string> = creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {};

	if (row.catalog === 'cloudflare-catalog') return listCloudflareCatalog(creds.baseUrl, headers);

	const res = await fetch(`${creds.baseUrl.replace(/\/$/, '')}/models`, { headers });
	if (!res.ok) throw new ProviderError(`${creds.baseUrl}/models returned HTTP ${res.status}`);
	const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
	return (body.data ?? [])
		.map((m) => (typeof m.id === 'string' ? m.id : null))
		.filter((id): id is string => id !== null)
		.sort();
}

/**
 * Workers AI's OpenAI-compatible surface serves chat/completions and embeddings
 * but NOT `GET /models` (405) — the catalog lives one level up, on the account
 * API (`…/ai/v1` → `…/ai/models/search`), task-filtered server-side so the
 * picker offers models that can run a text turn, not embeddings or speech. It
 * lists Cloudflare's own `@cf/…` models only; partner-served `vendor/model` ids
 * stay free-text. Paged defensively; the filtered catalog fits one page today.
 */
async function listCloudflareCatalog(baseUrl: string, headers: Record<string, string>): Promise<string[]> {
	const root = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
	const names: string[] = [];
	for (let page = 1; page <= 5; page++) {
		const url = `${root}/models/search?task=${encodeURIComponent('Text Generation')}&per_page=100&page=${page}`;
		const res = await fetch(url, { headers });
		if (!res.ok) throw new ProviderError(`${root}/models/search returned HTTP ${res.status}`);
		const body = (await res.json()) as { result?: Array<{ name?: unknown }> };
		const batch = (body.result ?? [])
			.map((m) => (typeof m.name === 'string' ? m.name : null))
			.filter((n): n is string => n !== null);
		names.push(...batch);
		if (batch.length < 100) break;
	}
	return names.sort();
}
