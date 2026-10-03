import { createControlPlaneApi, serviceTokenAuth, tenantTokenAuth, type ControlPlaneApiOptions } from '@substrat-run/control-plane-api';
import type { PlatformActorId } from '@substrat-run/contracts';

/** The dashboard's fleet-wide credential in these suites — what the worker env's `CP_SERVICE_TOKEN` holds. */
export const SERVICE_TOKEN = 'service-token';

const TENANT_TOKEN_SECRET = 'test-tenant-token-secret';

/**
 * A real control plane wired the way production wires it for the dashboard (#977): the
 * service token is honoured to mint a tenant token (`POST /tenant-tokens`), and that token is
 * what every other call presents — so a suite meets the tenant-confined surface the dashboard
 * really reaches, never a staff one. `actor` is the audited subject both readers resolve to.
 */
export function tenantPlane(host: ControlPlaneApiOptions['host'], actor: PlatformActorId) {
  return createControlPlaneApi({
    host,
    authenticate: serviceTokenAuth(SERVICE_TOKEN, actor),
    authenticateTenantService: tenantTokenAuth(TENANT_TOKEN_SECRET, actor),
    tenantTokenSecret: TENANT_TOKEN_SECRET,
  });
}
