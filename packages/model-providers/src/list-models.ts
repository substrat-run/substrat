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

/** One entry of a catalog row's `properties` array: `{ property_id, value }`. */
interface CatalogProperty {
	readonly property_id?: unknown;
	/** A string for the capability flags; an array for `price`. Never assumed. */
	readonly value?: unknown;
}

interface CatalogRow {
	readonly name?: unknown;
	readonly properties?: unknown;
}

/**
 * Can this model run a tool call?
 *
 * A build turn is a tool loop from end to end, so a model that cannot call a
 * function cannot run one — it can only be picked and then fail. The catalog
 * answers per row: `function_calling: "true"` inside `properties`, present on the
 * models that support it and absent on the ones that do not.
 *
 * Fails SOFT, and the asymmetry is deliberate. A row carrying NO `properties`
 * array is kept, because that is the response shape moving rather than the model
 * saying no; a row that HAS the array and no flag is dropped, because that is the
 * catalog answering. Offering too much is a picker a builder can work around;
 * offering nothing is not.
 */
function runsToolCalls(row: CatalogRow): boolean {
	if (!Array.isArray(row.properties)) return true;
	const props = row.properties as readonly CatalogProperty[];
	const flag = props.find((p) => p !== null && typeof p === 'object' && p.property_id === 'function_calling');
	return flag?.value === 'true';
}

/**
 * Workers AI's OpenAI-compatible surface serves chat/completions and embeddings
 * but NOT `GET /models` (405) — the catalog lives one level up, on the account
 * API (`…/ai/v1` → `…/ai/models/search`). Three of the four filters are the
 * endpoint's own documented query parameters, so they cost nothing to apply:
 * `task` (a text turn, not embeddings or speech), `hide_experimental` and
 * `include_deprecated`. The fourth — can it run a tool call — is per row and
 * applied here (`runsToolCalls`). It lists Cloudflare's own `@cf/…` models only;
 * partner-served `vendor/model` ids stay free-text. Paged defensively; the
 * filtered catalog fits one page today.
 */
async function listCloudflareCatalog(baseUrl: string, headers: Record<string, string>): Promise<string[]> {
	const root = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
	const names: string[] = [];
	const seen: string[] = [];
	for (let page = 1; page <= 5; page++) {
		const url =
			`${root}/models/search?task=${encodeURIComponent('Text Generation')}` +
			`&hide_experimental=true&include_deprecated=false&per_page=100&page=${page}`;
		const res = await fetch(url, { headers });
		if (!res.ok) throw new ProviderError(`${root}/models/search returned HTTP ${res.status}`);
		const body = (await res.json()) as { result?: CatalogRow[] };
		const rows = body.result ?? [];
		for (const row of rows) {
			if (typeof row.name !== 'string') continue;
			seen.push(row.name);
			if (runsToolCalls(row)) names.push(row.name);
		}
		// The page boundary is the RAW page length: a filtered-out entry must not end the walk early.
		if (rows.length < 100) break;
	}
	// The last fail-soft: if the catalog answered and the tool-call filter took ALL of
	// it, the flag has moved rather than every model having lost the capability. An
	// over-wide picker beats an empty one, which reads as "Cloudflare is down".
	if (names.length === 0 && seen.length > 0) return seen.sort();
	return names.sort();
}
