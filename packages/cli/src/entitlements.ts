/**
 * `substrat entitlements list | grant | revoke` — a tenant's entitlement keys from the command
 * line (control-plane.md §4.3, #2778). The console is the interactive path; this is the one a
 * script or an agent session can run.
 *
 * Every rule stays the plane's: a tenant credential grants only keys a vertical it can install
 * declares, without plan fields (#977), and revoking is staff-only. A refusal is printed as the
 * plane worded it, not anticipated here.
 */
import type { EntitlementGrant, EntitlementGrantInput } from '@substrat-run/contracts';
import type { ControlPlaneError } from '@substrat-run/control-plane-client';
import { bodyOrStatus, planeFor, viaPlane } from './plane.js';
import { failureMessage } from './problem.js';

export interface EntitlementTarget {
  controlPlaneUrl: string;
  header: Record<string, string>;
  tenantId: string;
}

const refusing = (verb: string) => (e: ControlPlaneError) =>
  new Error(failureMessage(`entitlements ${verb} refused`, e.status, bodyOrStatus(e)));

export const listEntitlements = (t: EntitlementTarget): Promise<EntitlementGrant[]> =>
  viaPlane(() => planeFor(t.controlPlaneUrl, t.header).listEntitlements(t.tenantId), refusing('list'));

export const grantEntitlement = (t: EntitlementTarget, key: string, plan?: EntitlementGrantInput): Promise<EntitlementGrant[]> =>
  viaPlane(() => planeFor(t.controlPlaneUrl, t.header).grantEntitlement(t.tenantId, key, plan), refusing('grant'));

export const revokeEntitlement = (t: EntitlementTarget, key: string): Promise<EntitlementGrant[]> =>
  viaPlane(() => planeFor(t.controlPlaneUrl, t.header).revokeEntitlement(t.tenantId, key), refusing('revoke'));

/**
 * `--plan` / `--expires` / `--quota` as the grant body, or `undefined` when none is given (the
 * bare flag grant). A quota is checked here because `Number('x')` would reach the wire as
 * `null`; the plan name and the instant are the plane's to judge.
 */
export function planOf(flags: { plan?: string; expires?: string; quota?: string }): EntitlementGrantInput | undefined {
  const plan: EntitlementGrantInput = {};
  if (flags.plan !== undefined) plan.plan = flags.plan;
  if (flags.expires !== undefined) plan.expiresAt = flags.expires;
  if (flags.quota !== undefined) {
    const quota = Number(flags.quota);
    if (!flags.quota.trim() || !Number.isSafeInteger(quota) || quota <= 0) throw new Error('--quota must be a positive integer');
    plan.quota = quota;
  }
  return Object.keys(plan).length > 0 ? plan : undefined;
}

/** The aligned table the three subcommands print: key, plan, quota, expiry. */
export function formatEntitlements(rows: readonly EntitlementGrant[]): string {
  if (rows.length === 0) return '(no entitlements)';
  const width = Math.max(...rows.map((r) => r.entitlementKey.length));
  return rows
    .map((r) =>
      [
        r.entitlementKey.padEnd(width),
        (r.plan ?? '-').padEnd(10),
        String(r.quota ?? '-').padEnd(6),
        r.expiresAt ? `expires ${r.expiresAt}` : 'perpetual',
      ].join('  '),
    )
    .join('\n');
}
