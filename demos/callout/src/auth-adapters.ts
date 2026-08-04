import { principalId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';

/**
 * Callout's dev auth seam — runtime-agnostic, so it carries no `node:*` or
 * `better-sqlite3` dependency. `resolvePrincipal` tries each mounted adapter in
 * order and the first to recognise the request wins. The kernel never sees any of
 * this; it only ever receives a `PrincipalId`.
 *
 * OIDC-only (oidc-only-demos.md): the vertical runs no credential store. Real login is the
 * OIDC round-trip (worker → issuer), and the sub→principal binding lives in the tenant's
 * IdentityDO (worker.ts). This seam now carries ONLY the dev-header persona picker used by
 * the local dev server; there is no Better-Auth session adapter here any more.
 *
 * A persona carries its own (tenant, scope) — Callout has a second company + portal
 * customers for the isolation beats — so the node is per-persona rather than fixed
 * (mapped in server.ts's CAST, keyed by the resolved principal).
 */

export interface DemoNode {
  tenantId: TenantId;
  scopeId: ScopeId;
}

export interface AuthResult {
  principal: PrincipalId;
  via: string;
  display?: string;
}

export interface AuthAdapter {
  id: string;
  resolve(headers: Headers): Promise<AuthResult | null>;
}

/**
 * The dev-header picker: names any principal and is believed.
 *
 * An impersonation bypass by design — fine for local iteration, never a production
 * posture — so the server mounts it only when explicitly opted in.
 */
export function devHeaderAdapter(): AuthAdapter {
  return {
    id: 'dev-header',
    async resolve(headers) {
      const raw = headers.get('x-principal');
      if (!raw) return null;
      const parsed = principalId.safeParse(raw);
      return parsed.success ? { principal: parsed.data, via: 'dev-header' } : null;
    },
  };
}

/** First adapter to recognise the request wins; null if none do. */
export async function resolvePrincipal(
  adapters: AuthAdapter[],
  headers: Headers,
): Promise<AuthResult | null> {
  for (const a of adapters) {
    const r = await a.resolve(headers);
    if (r) return r;
  }
  return null;
}
