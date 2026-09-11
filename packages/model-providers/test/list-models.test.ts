/**
 * The Cloudflare catalog read — what the picker is allowed to offer.
 *
 * A build turn is a tool loop, so a model that cannot call a function can only be
 * picked and then fail mid-run. The row shapes pinned here are the account API's
 * own (`{ property_id, value }` entries under `properties`, string-valued flags,
 * `price` array-valued), taken from the published Workers AI catalog.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listModels } from '../src/list-models.js';

const ENV = {
	CLOUDFLARE_AI_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/acct/ai/v1',
	CLOUDFLARE_AI_API_TOKEN: 'token',
};

interface Row {
	name: string;
	properties?: unknown;
}

const toolCaller = (name: string): Row => ({
	name,
	properties: [
		{ property_id: 'context_window', value: '24000' },
		{ property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.29, currency: 'USD' }] },
		{ property_id: 'function_calling', value: 'true' },
	],
});
const noToolCalls = (name: string): Row => ({ name, properties: [{ property_id: 'context_window', value: '4000' }] });

/** Answers each page from `pages`, and records every URL it was asked for. */
function stubCatalog(pages: Row[][]): { urls: string[] } {
	const urls: string[] = [];
	vi.stubGlobal('fetch', (url: string) => {
		urls.push(url);
		const page = Number(new URL(url).searchParams.get('page') ?? '1');
		return Promise.resolve(
			new Response(JSON.stringify({ result: pages[page - 1] ?? [] }), {
				headers: { 'content-type': 'application/json' },
			}),
		);
	});
	return { urls };
}

afterEach(() => vi.unstubAllGlobals());

describe('listModels(cloudflare)', () => {
	it('offers only the models that report function calling', async () => {
		stubCatalog([
			[
				toolCaller('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
				noToolCalls('@cf/meta/llama-2-7b-chat-int8'),
				{ name: '@cf/says/no', properties: [{ property_id: 'function_calling', value: 'false' }] },
			],
		]);
		expect(await listModels('cloudflare', ENV)).toEqual(['@cf/meta/llama-3.3-70b-instruct-fp8-fast']);
	});

	it('keeps a row carrying no properties at all — a moved response shape narrows nothing', async () => {
		stubCatalog([[{ name: '@cf/no/properties' }, toolCaller('@cf/has/properties')]]);
		expect(await listModels('cloudflare', ENV)).toEqual(['@cf/has/properties', '@cf/no/properties']);
	});

	it('falls back to the raw catalog when the filter would empty a non-empty answer', async () => {
		// The flag renamed under us reads as "no model can call a tool", which is never
		// true. An over-wide picker beats one that looks like an outage.
		stubCatalog([[noToolCalls('@cf/one'), noToolCalls('@cf/two')]]);
		expect(await listModels('cloudflare', ENV)).toEqual(['@cf/one', '@cf/two']);
	});

	it('asks the endpoint for the filters it can apply itself', async () => {
		const { urls } = stubCatalog([[toolCaller('@cf/a')]]);
		await listModels('cloudflare', ENV);
		const q = new URL(urls[0]).searchParams;
		expect(urls[0]).toContain('/ai/models/search?');
		expect(urls[0]).not.toContain('/v1/models/search');
		expect(q.get('task')).toBe('Text Generation');
		expect(q.get('hide_experimental')).toBe('true');
		expect(q.get('include_deprecated')).toBe('false');
	});

	it('pages on the RAW page length, so a filtered-out row cannot end the walk early', async () => {
		const full = Array.from({ length: 100 }, (_, i) => (i === 0 ? toolCaller('@cf/keep') : noToolCalls(`@cf/drop-${i}`)));
		const { urls } = stubCatalog([full, [toolCaller('@cf/second-page')]]);
		expect(await listModels('cloudflare', ENV)).toEqual(['@cf/keep', '@cf/second-page']);
		expect(urls).toHaveLength(2);
	});

	it('reports the HTTP status when the account API refuses', async () => {
		vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 403 })));
		await expect(listModels('cloudflare', ENV)).rejects.toThrow(/returned HTTP 403/);
	});
});

describe('listModels(compat)', () => {
	it('reads a plain OpenAI-compatible /models list unfiltered — the capability flags are Cloudflare-only', async () => {
		vi.stubGlobal('fetch', (url: string) => {
			expect(url).toBe('https://llm.example/v1/models');
			return Promise.resolve(
				new Response(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { nope: true }] }), {
					headers: { 'content-type': 'application/json' },
				}),
			);
		});
		const models = await listModels('compat', {
			OPENAI_COMPATIBLE_BASE_URL: 'https://llm.example/v1',
			OPENAI_COMPATIBLE_API_KEY: 'k',
		});
		expect(models).toEqual(['a-model', 'b-model']);
	});
});
