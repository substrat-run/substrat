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

interface ServiceBinding {
  fetch(url: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/**
 * The real plane's answers, with `rewrite` applied to the JSON body of every successful answer
 * whose path `match` accepts (#2401): a plane newer than the dashboard, or one answering outside a
 * route's declaration. The write behind the answer really happens; only the answer is rewritten.
 */
export function rewrittenPlane(svc: unknown, match: (path: string) => boolean, rewrite: (body: unknown) => unknown): ServiceBinding {
  const plain = svc as ServiceBinding;
  return {
    fetch: async (url, init) => {
      const res = await plain.fetch(url, init);
      const json = res.headers.get('content-type')?.includes('json') ?? false;
      if (!res.ok || !json || !match(new URL(String(url)).pathname)) return res;
      return Response.json(rewrite(await res.json()), { status: res.status });
    },
  };
}

type Row = Record<string, unknown>;

/** A `rewrite` that patches every object in an answer, at any depth: `patch` returns its replacement, or `undefined` to keep it. */
export function patchRows(patch: (row: Row) => Row | undefined): (body: unknown) => unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== 'object') return v;
    const row = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return patch(row) ?? row;
  };
  return walk;
}
