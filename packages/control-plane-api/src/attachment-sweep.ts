import type { PlatformActorId, ScopeId, TenantId } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { isPrimaryScope, unsettledCopyRefusal, type HostAdmin, type OrphanAttachmentOutcome } from '@substrat-run/kernel';
import { listAllScopeScriptCopies, routeOfScope } from './scope-copy-cleanup.js';
import { isRouteMiss, type VerticalClient } from './vertical-client.js';

/** What the platform's orphan-attachment reach needs (#2314). */
export interface AttachmentSweepReach {
  admin: HostAdmin;
  actor: PlatformActorId;
  /** The client for one dispatch script, by its name. */
  resolveRef: (scriptRef: string) => Promise<Pick<VerticalClient, 'sweepOrphanAttachments'> | undefined>;
}

/**
 * One scope's orphan-attachment pass, reached from the control plane (#2314).
 *
 * The deployment that holds a scope cannot tell on its own that it still SERVES it, and a CP-less
 * one cannot read the copy ledger, so both questions are answered here, from this directory, before
 * any deployment is asked to judge anything:
 * - the scope must be on record, active and primary, bound to a vertical, under an active tenant;
 * - every copy-ledger entry of the scope must be settled (`done` only, the kernel's allowlist): a
 *   copy in another script may hold rows the serving one lacks;
 * - the pass goes to the script the directory routes the scope to (its serving script, else its
 *   bound version's), with no fallback to another script and never to a host here, whose scope
 *   namespace holds none of the scope's rows and would judge every object an orphan.
 * Each of those is a `refused` outcome, a standing condition the sweep counts. A deployment built
 * before the route (501, or a route miss) is `unsupported`. Anything else throws.
 */
export async function sweepScopeAttachments(
  reach: AttachmentSweepReach,
  tenantId: TenantId,
  scopeId: ScopeId,
  opts: { dryRun: boolean },
): Promise<OrphanAttachmentOutcome> {
  const scope = await reach.admin.getScopeRecord(reach.actor, tenantId, scopeId);
  if (!scope) return { refused: `scope ${scopeId} is not on record in tenant ${tenantId}` };
  if (scope.status !== 'active') return { refused: `scope ${scopeId} is ${scope.status}` };
  if (!isPrimaryScope(scope)) return { refused: `scope ${scopeId} is a copy` };
  if (!scope.vertical) return { refused: `scope ${scopeId} is bound to no vertical` };
  const tenant = await reach.admin.getTenant(reach.actor, tenantId);
  if (!tenant || tenant.status !== 'active') return { refused: `tenant ${tenantId} is ${tenant?.status ?? 'not on record'}` };
  const unsettled = unsettledCopyRefusal(scopeId, await listAllScopeScriptCopies(reach.admin, reach.actor, tenantId, scopeId));
  if (unsettled) return { refused: unsettled.message };
  const route = await routeOfScope(reach, scope);
  if (!route) return { refused: `no deployment serves scope ${scopeId}` };
  const client = await reach.resolveRef(route);
  if (!client) return { refused: `the script serving scope ${scopeId} cannot be reached` };
  try {
    return { swept: await client.sweepOrphanAttachments({ tenantId, scopeId, dryRun: opts.dryRun, copiesSettled: true }) };
  } catch (err) {
    if (err instanceof ControlPlaneError) {
      if (err.status === 501 || isRouteMiss(err)) {
        return { unsupported: `the deployment serving scope ${scopeId} predates the orphan-attachment sweep (${err.status}); redeploy it` };
      }
      // The deployment's own guards (a copy marker, a lifecycle it holds, a receipt naming another
      // tenant) refuse with a conflict or a not-found: the same standing kind as the ones above.
      if (err.status === 409 || err.status === 404) return { refused: err.message };
    }
    throw err;
  }
}
