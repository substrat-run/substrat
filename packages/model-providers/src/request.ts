/**
 * Per-request extras, by row — what a host attaches to one call beyond the prompt.
 *
 * The only consumer today is Cloudflare's AI Gateway, whose extras are all headers:
 *
 *   - `cf-aig-metadata`            the call's attribution, as JSON. The gateway keeps at
 *                                  most FIVE keys, which is why `ModelAttribution` is
 *                                  fixed at five — a sixth would drop silently here.
 *   - `cf-aig-collect-log-payload` `false`: the gateway logs token counts, model, cost
 *                                  and duration but never the prompt or the answer. The
 *                                  D-54 subprocessor promise, made true on the wire.
 *   - `cf-aig-gateway-id`          which gateway, when the platform has named one
 *                                  (`CLOUDFLARE_AI_GATEWAY_ID`); absent, the account's
 *                                  default gateway serves the request.
 *
 * What is deliberately NOT here: a spend limit. That is gateway configuration keyed on
 * the same metadata (per tenant, per day), set by the operator and enforced by the
 * gateway — a second guard beneath the host's own budget policy, never the only one.
 *
 * A row with no `request` kind sends nothing extra, and the host never learns which
 * case it was in.
 */
import { providerRow } from './providers.js';
import type { CredentialEnv } from './resolve.js';

/** Attribution as the wire takes it — flat, five keys, scalar values. */
export type WireAttribution = Readonly<Record<string, string | number | boolean>>;

export interface RequestExtrasInput {
	readonly attribution: WireAttribution;
	readonly env: CredentialEnv;
}

/** The per-request headers a row wants, or none. Pure. */
export function requestHeadersFor(provider: string, input: RequestExtrasInput): Record<string, string> {
	const row = providerRow(provider);
	if (!row || row.kind !== 'compatible' || !row.request) return {};
	switch (row.request) {
		case 'cloudflare-gateway': {
			const keys = Object.keys(input.attribution);
			if (keys.length > 5) {
				throw new RangeError(
					`AI Gateway keeps five metadata keys; ${keys.length} were given (${keys.join(', ')})`,
				);
			}
			const gateway = input.env['CLOUDFLARE_AI_GATEWAY_ID'];
			return {
				'cf-aig-metadata': JSON.stringify(input.attribution),
				'cf-aig-collect-log-payload': 'false',
				...(gateway ? { 'cf-aig-gateway-id': gateway } : {}),
			};
		}
	}
}
