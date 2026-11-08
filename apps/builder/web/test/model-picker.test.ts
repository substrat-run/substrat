/**
 * Which provider row the model picker lists. The picker opens on the current
 * model's provider; that row's models must be fetched without a click, or a
 * listable provider (Workers AI, Qwen) shows a row with nothing to pick.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderEntry } from '../src/api.js';
import { rowToList } from '../src/ModelPicker.js';

const row = (name: string, listable: boolean, set: boolean): ProviderEntry => ({
	name,
	kind: 'compatible',
	hosting: { vendor: name, location: '', host: '', dataNote: '' },
	credential: { envVar: null, set, missing: set ? [] : ['KEY'] },
	listable,
	suggested: [],
});

const PROVIDERS = [
	row('anthropic', false, true),
	row('cloudflare', true, true),
	row('scaleway', true, false),
];

describe('rowToList', () => {
	it('lists the row the current model opens, before any click', () => {
		expect(rowToList(PROVIDERS, 'cloudflare', {})?.name).toBe('cloudflare');
	});

	it.each([
		['the providers have not loaded', null, 'cloudflare', {}],
		['no row is open', PROVIDERS, null, {}],
		['the listing is already under way', PROVIDERS, 'cloudflare', { cloudflare: 'loading' as const }],
		['the open row has no listable catalog', PROVIDERS, 'anthropic', {}],
		['the open row lacks its credential', PROVIDERS, 'scaleway', {}],
	])('lists nothing when %s', (_, providers, open, models) => {
		expect(rowToList(providers, open, models)).toBeNull();
	});
});
