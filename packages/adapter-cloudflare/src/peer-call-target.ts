import {
  isPrimaryScopeRow,
  peerVerticalSpellings,
  resolvePeerInstanceFrom,
  samePeerVertical,
  type PeerTenant,
} from '@substrat-run/kernel';
import type { ScopeId, ScopeStatus, TenantId } from '@substrat-run/contracts';

/**
 * The directory's answer to "may this caller place a peer call to `vertical`, and to which
 * instance" (#1706), as one function over the directory's tables. `ControlPlaneDO.peerCallTarget`
 * answers the router with it, and the routing read model (#3395, K-72) publishes from it, so the
 * entry the router reads from KV and the answer it would have had from the directory are computed
 * by the same code: there is no second copy of the rule to drift.
 */

/** One candidate instance of a vertical in a tenant (#1706), with what it dispatches as. */
export interface PeerCandidateRow {
  scope_id: string;
  tenant_id: string;
  vertical: string | null;
  status: string;
  kind: string | null;
  forked_from: string | null;
  deployment_ref: string | null;
  outbound_json: string | null;
  calls_json: string | null;
}

/** Where the CALLER stands: usable, or the one reason it is not (#1706). */
export type PeerCallerState = 'ok' | 'unknown' | 'not-primary' | 'inactive';

/** What `peerCallTarget` answers: the caller's standing, and the resolved target (or why not). */
export interface PeerCallTargetRow {
  /** `tenantSlug`: the directory's slug for the caller's tenant (#2252), for the target's door. */
  caller: { state: PeerCallerState; status: string | null; tenantSlug: string | null };
  outcome: 'resolved' | 'not-installed' | 'ambiguous' | 'bound-unavailable';
  /** How many live instances, when `ambiguous`. Zero otherwise. */
  count: number;
  target: PeerCandidateRow | null;
}

/**
 * What the read model needs beside the answer, and the router never sees: where the target's
 * dispatch comes from (a serving script takes its vertical's serving policy, which the read model
 * keeps under its own key), and whether either scope is residency-pinned (K-36).
 */
export interface PeerCallTargetSource {
  /** The resolved target's `scopes.serving_ref`, and its bound version's own script. */
  target: { serving_ref: string | null; version_ref: string | null } | null;
  /** The caller or the resolved target is jurisdiction-pinned, or holds a region-pinned hostname. */
  pinned: boolean;
}

/** A jurisdiction that pins storage, which KV cannot honour (K-36). `global` pins nothing. */
const isPinned = (jurisdiction: string | null): boolean => jurisdiction !== null && jurisdiction !== 'global';

/** Any active hostname of the scope is region-pinned. */
const PINNED_HOSTNAME = (scope: string) =>
  `EXISTS (SELECT 1 FROM hostnames WHERE scope_id = ${scope} AND status = 'active' AND region IS NOT NULL)`;

/**
 * Everything the router needs to place ONE peer call (#1706), in two SQL reads, because this sits
 * on a request path. The binding and the tenant's slug join the caller read, so even an unbound
 * singleton adds no round trip. The caller's record is what decides whether it may call at all —
 * live, primary, and the vertical it claims — and it is read HERE rather than inferred from
 * routing, so this path does not inherit #1713. The target side applies the kernel's one rule
 * (`resolvePeerInstanceFrom`), the same rule the pure host and the local broker apply.
 */
export function readPeerCallTarget(
  sql: SqlStorage,
  tenantId: string,
  callerScopeId: string,
  callerVertical: string,
  vertical: string,
): { row: PeerCallTargetRow; source: PeerCallTargetSource } {
  const caller = sql
    .exec(
      `SELECT s.tenant_id, s.vertical, s.status, s.kind, s.forked_from, s.jurisdiction,
              ${PINNED_HOSTNAME('s.scope_id')} AS has_pinned_hostname,
              t.status AS tenant_status, pb.target_scope_id AS bound_target_scope_id,
              pb.invalidated AS binding_invalidated,
              (SELECT slug FROM tenants WHERE tenant_id = ?) AS peer_tenant_slug
         FROM scopes s
         LEFT JOIN tenants t ON t.tenant_id = s.tenant_id
         LEFT JOIN peer_bindings pb ON pb.tenant_id = s.tenant_id
           AND pb.caller_scope_id = s.scope_id AND pb.vertical = ?
        WHERE s.scope_id = ?`,
      tenantId,
      vertical,
      callerScopeId,
    )
    .toArray()[0] as
    | {
        tenant_id: string; vertical: string | null; status: string; tenant_status: string | null; kind: string | null;
        forked_from: string | null; jurisdiction: string | null; has_pinned_hostname: number;
        bound_target_scope_id: string | null; binding_invalidated: number | null; peer_tenant_slug: string | null;
      }
    | undefined;
  // No caller row is refused below ('unknown'); its candidates are then read exactly.
  const tenant: PeerTenant = { id: tenantId as TenantId, slug: caller?.peer_tenant_slug ?? null };
  const candidates = sql
    .exec(
      `SELECT s.scope_id, s.tenant_id, s.vertical, s.status, s.kind, s.forked_from,
              COALESCE(s.serving_ref, vv.deployment_ref) AS deployment_ref,
              CASE WHEN s.serving_ref IS NOT NULL
                   THEN json_extract(sv.manifest_json, '$.outbound')
                   ELSE json_extract(vv.manifest_json, '$.outbound') END AS outbound_json,
              CASE WHEN s.serving_ref IS NOT NULL
                   THEN json_extract(sv.manifest_json, '$.calls')
                   ELSE json_extract(vv.manifest_json, '$.calls') END AS calls_json,
              s.serving_ref, vv.deployment_ref AS version_ref, s.jurisdiction,
              ${PINNED_HOSTNAME('s.scope_id')} AS has_pinned_hostname
         FROM scopes s
         LEFT JOIN vertical_versions vv ON vv.id = s.vertical_version_id
         LEFT JOIN verticals vr ON vr.slug = s.vertical
         LEFT JOIN vertical_versions sv ON sv.id = vr.serving_version_id
        WHERE s.tenant_id = ? AND s.vertical IN (SELECT value FROM json_each(?))`,
      tenantId,
      JSON.stringify(peerVerticalSpellings(vertical, tenant.slug)),
    )
    .toArray() as unknown as Array<
      PeerCandidateRow & { serving_ref: string | null; version_ref: string | null; jurisdiction: string | null; has_pinned_hostname: number }
    >;
  const resolution = resolvePeerInstanceFrom(
    candidates.map((r) => ({
      id: r.scope_id as ScopeId,
      tenantId: r.tenant_id as TenantId,
      vertical: r.vertical,
      status: r.status as ScopeStatus,
      kind: r.kind ?? '',
      forkedFrom: (r.forked_from as ScopeId | null) ?? null,
    })),
    tenant,
    vertical,
    (caller?.bound_target_scope_id as ScopeId | undefined) ?? null,
    caller?.binding_invalidated === 1,
  );
  const resolved =
    resolution.outcome === 'resolved'
      ? (candidates.find((r) => r.scope_id === resolution.instance.scopeId) ?? null)
      : null;
  // The caller's own state, decided HERE — this already applies the kernel's one rule for the
  // target, and the router must not carry a second copy of "what is primary".
  const callerState: PeerCallerState = !caller || caller.tenant_id !== tenantId || !samePeerVertical(caller.vertical, callerVertical, tenant.slug)
    ? 'unknown'
    : !isPrimaryScopeRow(caller)
      ? 'not-primary'
      : caller.status !== 'active' || caller.tenant_status !== 'active'
        ? 'inactive'
        : 'ok';
  const target: PeerCandidateRow | null = resolved
    ? {
        scope_id: resolved.scope_id,
        tenant_id: resolved.tenant_id,
        vertical: resolved.vertical,
        status: resolved.status,
        kind: resolved.kind,
        forked_from: resolved.forked_from,
        deployment_ref: resolved.deployment_ref,
        outbound_json: resolved.outbound_json,
        calls_json: resolved.calls_json,
      }
    : null;
  return {
    row: {
      caller: {
        state: callerState,
        status: caller?.tenant_status !== 'active' ? `tenant ${caller?.tenant_status ?? 'unknown'}` : caller.status,
        // The directory's own, for the tenant this call was authenticated in.
        tenantSlug: tenant.slug,
      },
      outcome: resolution.outcome,
      count: resolution.outcome === 'ambiguous' ? resolution.count : 0,
      target,
    },
    source: {
      target: resolved ? { serving_ref: resolved.serving_ref, version_ref: resolved.version_ref } : null,
      pinned:
        (caller !== undefined && (isPinned(caller.jurisdiction) || Number(caller.has_pinned_hostname) === 1)) ||
        (resolved !== null && (isPinned(resolved.jurisdiction) || Number(resolved.has_pinned_hostname) === 1)),
    },
  };
}
