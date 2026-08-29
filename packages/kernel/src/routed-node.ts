import { scopeId as scopeIdSchema, tenantId as tenantIdSchema } from '@substrat-run/contracts';
import { secretMatches } from './platform-call.js';
import type { ScopeId, TenantId } from '@substrat-run/contracts';

/**
 * Reading the node the router asserted (K-26).
 *
 * The router resolves `hostname → (tenant, scope, surface)` and forwards over a
 * service binding with that resolution in headers. This is the vertical's side of
 * that contract, in the kernel because every vertical needs it and none of them
 * should be re-deriving how to trust it.
 *
 * Web-standard only and structurally typed: the base tsconfig is `ES2023` with no
 * DOM lib, deliberately, so no package assumes a browser. Taking the one method we
 * need rather than the whole `Headers` type keeps that true and costs nothing — a
 * real `Headers` satisfies it, and so does a plain object in a test.
 */

/** The one method this needs from a `Headers`. A real `Headers` satisfies it. */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface RoutedNode {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** Which app answers: `app`, `storefront`, `back-office`, … Vertical vocabulary. */
  surface: string;
  verticalSlug: string | null;
}

/** Thrown when headers are present but not trustworthy. Never means "no router". */
export class RouterAssertionError extends Error {}

export interface ReadRoutedNodeOptions {
  /**
   * The router's shared secret, as this worker holds it (`ROUTER_SECRET`). When set,
   * an assertion is trusted only if `x-substrat-router` matches it — always, even
   * with `allowUnsigned`.
   */
  expectedSecret?: string;
  /**
   * Accept an assertion nobody signed, when no secret is configured (#966).
   *
   * Off by default, and that default is the boundary: a worker deployed without
   * its secret used to trust any `x-substrat-*` headers it was handed, which is a
   * forged tenant from anyone who could reach the script directly. Now it refuses
   * them — loudly, as a `RouterAssertionError` — until the secret is provisioned.
   *
   * The one legitimate exception is an un-routed local instance behind a dev
   * router that has no secret either, which is what `ALLOW_DEV_NODE` already
   * names; a host sets this from that flag and from nothing else.
   */
  allowUnsigned?: boolean;
}

/**
 * The `(tenant, scope)` this request is for, or `null` when no router fronted it.
 *
 * Three outcomes, kept distinct on purpose:
 *
 *   - **null** — no assertion at all. The caller decides: a single-tenant standalone
 *     deploy substitutes its own node, anything else refuses.
 *   - **throws** — headers are present but wrong: a bad or missing secret, a secret
 *     this worker cannot verify because it holds none, or ids that are not ULIDs.
 *     Present-but-wrong is a misconfiguration or an attack, and collapsing it into
 *     `null` would let either one fall through to whatever the caller does for
 *     "unrouted".
 *   - **a node** — trustworthy, and the tenant whose data this request may touch.
 *
 * `expectedSecret` is what makes the headers trustworthy in code. K-26's real
 * boundary is that vertical workers have no public route, so the router is the only
 * possible source — but that is a deployment fact, and `workers.dev` is on by
 * default. When the secret is configured, a request that did not come from the
 * router cannot assert a tenant no matter how the routes are configured. When it is
 * NOT configured the assertion fails closed (#966): an unsigned assertion is refused
 * unless the host opted in with `allowUnsigned`, so forgetting to provision the
 * secret is a visible outage rather than an open door.
 */
export function readRoutedNode(
  headers: HeaderReader,
  options: ReadRoutedNodeOptions = {},
): RoutedNode | null {
  const rawTenant = headers.get('x-substrat-tenant');
  const rawScope = headers.get('x-substrat-scope');
  if (!rawTenant && !rawScope) return null;

  const { expectedSecret, allowUnsigned = false } = options;
  if (expectedSecret) {
    if (!secretMatches(headers.get('x-substrat-router'), expectedSecret)) {
      throw new RouterAssertionError('router assertion is not signed by a known router');
    }
  } else if (!allowUnsigned) {
    throw new RouterAssertionError(
      'router assertion cannot be verified: this worker has no ROUTER_SECRET configured',
    );
  }
  if (!rawTenant || !rawScope) {
    throw new RouterAssertionError('router assertion is incomplete');
  }

  const tenant = tenantIdSchema.safeParse(rawTenant);
  const scope = scopeIdSchema.safeParse(rawScope);
  if (!tenant.success || !scope.success) {
    throw new RouterAssertionError('router assertion carries a malformed id');
  }

  return {
    tenantId: tenant.data,
    scopeId: scope.data,
    surface: headers.get('x-substrat-surface') ?? 'app',
    verticalSlug: headers.get('x-substrat-vertical'),
  };
}
