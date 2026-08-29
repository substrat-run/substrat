/**
 * Per-request extras are a row property. Cloudflare's gateway headers appear for its row
 * and for no other; the five-key limit is refused, never truncated.
 */
import { describe, expect, it } from 'vitest';
import { requestHeadersFor } from '../src/index.js';

const attribution = { tenant: 't', scope: 's', vertical: 'v', version: '1', operation: 'o' };

describe('requestHeadersFor', () => {
	it('attaches attribution, turns payload retention off, and names the gateway when the platform did', () => {
		expect(requestHeadersFor('cloudflare', { attribution, env: {} })).toEqual({
			'cf-aig-metadata': JSON.stringify(attribution),
			'cf-aig-collect-log-payload': 'false',
		});
		expect(requestHeadersFor('cloudflare', { attribution, env: { CLOUDFLARE_AI_GATEWAY_ID: 'substrat' } })).toMatchObject({
			'cf-aig-gateway-id': 'substrat',
		});
	});

	it('sends nothing extra for every other row — and for an unknown or inherited one', () => {
		// `constructor` must reach the same nothing as `nope`, not an inherited row.
		for (const p of ['anthropic', 'scaleway', 'qwen', 'ollama', 'compat', 'nope', 'constructor', '__proto__']) {
			expect(requestHeadersFor(p, { attribution, env: {} })).toEqual({});
		}
	});

	it('refuses a sixth key rather than letting the gateway drop it silently', () => {
		expect(() => requestHeadersFor('cloudflare', { attribution: { ...attribution, install: 'i' }, env: {} })).toThrow(
			/five metadata keys/,
		);
	});
});
