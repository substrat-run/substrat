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
 *
 * The same row reached through its runtime BINDING (Workers AI's `env.AI`, #3320) has no
 * headers to carry them: the binding takes a `gateway` option instead, and without one the
 * call never passes a gateway, so nothing outside the caller can attribute it.
 * `bindingGatewayFor` is that option, as data — the same five keys as metadata, the same
 * gateway, and retention off. See its own comment for why retention is spelled differently.
 */
import { providerRow } from './providers.js';
import type { CredentialEnv } from './resolve.js';

/** Attribution as the wire takes it — flat, five keys, scalar values. */
export type WireAttribution = Readonly<Record<string, string | number | boolean>>;

export interface RequestExtrasInput {
	readonly attribution: WireAttribution;
	readonly env: CredentialEnv;
}

/** The gateway keeps five metadata keys; a sixth would drop silently, so it is refused. */
function fiveKeys(attribution: WireAttribution): WireAttribution {
	const keys = Object.keys(attribution);
	if (keys.length > 5) {
		throw new RangeError(`AI Gateway keeps five metadata keys; ${keys.length} were given (${keys.join(', ')})`);
	}
	return attribution;
}

/** The per-request headers a row wants, or none. Pure. */
export function requestHeadersFor(provider: string, input: RequestExtrasInput): Record<string, string> {
	const row = providerRow(provider);
	if (!row || row.kind !== 'compatible' || !row.request) return {};
	switch (row.request) {
		case 'cloudflare-gateway': {
			fiveKeys(input.attribution);
			const gateway = input.env['CLOUDFLARE_AI_GATEWAY_ID'];
			return {
				'cf-aig-metadata': JSON.stringify(input.attribution),
				'cf-aig-collect-log-payload': 'false',
				...(gateway ? { 'cf-aig-gateway-id': gateway } : {}),
			};
		}
	}
}

/**
 * The gateway a binding call names: the shape of Workers AI's `gateway` option
 * (`env.AI.run(model, inputs, { gateway })`), kept to the fields this sets.
 */
export interface BindingGateway {
	/** `CLOUDFLARE_AI_GATEWAY_ID` when the platform named one, else the account's `default` gateway. */
	readonly id: string;
	/** The five attribution keys — what the HTTP path sends as `cf-aig-metadata`. */
	readonly metadata: WireAttribution;
	/**
	 * `false`: the gateway keeps no log entry for the call — so no prompt and no answer (D-54).
	 *
	 * The HTTP path turns off only the PAYLOAD (`cf-aig-collect-log-payload`); the binding has
	 * no option for that, and `collectLog` maps to `cf-aig-collect-log`, which drops the whole
	 * entry. Checked on the platform's account (#3320): a binding call with `collectLog: false`
	 * still passes the gateway and is still counted in `aiGatewayRequestsAdaptiveGroups` with
	 * its metadata, which is the row the model reconciliation reads. What it loses is the log
	 * line, which held nothing the reconciliation uses.
	 */
	readonly collectLog: false;
}

/**
 * The `gateway` option a row's binding transport wants for one call, or none. Pure.
 *
 * Absent for every row whose endpoint has no gateway extras — the host passes nothing and
 * never learns which case it was in, exactly as with `requestHeadersFor`.
 */
export function bindingGatewayFor(provider: string, input: RequestExtrasInput): BindingGateway | undefined {
	const row = providerRow(provider);
	if (!row || row.kind !== 'compatible' || !row.request || !row.binding) return undefined;
	switch (row.request) {
		case 'cloudflare-gateway':
			return {
				id: input.env['CLOUDFLARE_AI_GATEWAY_ID'] || 'default',
				metadata: { ...fiveKeys(input.attribution) },
				collectLog: false,
			};
	}
}
