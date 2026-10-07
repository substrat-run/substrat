import { z } from 'zod';
import { scopeId, tenantId, verticalSlug } from './ids.js';

/**
 * WHO is calling the control plane's relay, as the platform knows it.
 *
 * A deployed vertical reaches the relay (`/internal/email/send`, `/internal/connections/*`)
 * with a platform credential that proves "a platform script is calling" and nothing about
 * which vertical, so a relay that read the tenant and scope from the body was reading them
 * from the caller.
 *
 * This is the caller the ROUTER set when it dispatched the script — the same dispatch
 * parameters a peer call's identity is read from (`peerCaller`, #1706). The egress worker
 * attaches it on the way to the relay's `RelayGateway` entrypoint, which only a service
 * binding can reach, and the control plane holds it to the request object rather than to
 * anything a public request could carry. Never assembled from a request.
 */
export const relayCaller = z.object({
  vertical: verticalSlug,
  tenantId,
  scopeId,
});
export type RelayCaller = z.infer<typeof relayCaller>;

/**
 * The header the egress worker hands the caller to the gateway in. Only ever read on the
 * gateway's side of a service binding: the control plane's public `fetch` ignores it, and the
 * egress worker drops any copy a script put on its own request before setting its own.
 */
export const RELAY_CALLER_HEADER = 'x-substrat-relay-caller';
