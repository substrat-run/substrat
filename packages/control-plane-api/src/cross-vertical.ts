import { importsOfManifestJson, type PlatformActorId, type Scope, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { registryImportCandidates, type CrossVerticalReach, type HostAdmin } from '@substrat-run/kernel';
import type { VerticalClient } from './vertical-client.js';

/**
 * The shared control plane's reach for the cross-vertical phase (#1705 PR 2).
 *
 * On the hosted path neither end of an edge lives in the control plane: each scope's storage is
 * in its vertical's own dispatch deployment, and the control plane's own `SCOPE` namespace is
 * the module-less placeholder. The kernel's default reach would call that placeholder, which
 * refuses (`assertServedHere`), so the control plane passes this instead. It reaches each side
 * over `/internal/import-state`, `/internal/exported-events` and `/internal/import-events`,
 * on the deployment the same ladder resolves for every other delegated verb (serving script →
 * bound version → slug).
 *
 * A scope whose vertical resolves no deployment THROWS, and the sweep records the edge as
 * `failed`. It never answers "imports nothing" or "nothing to export" for it: the Tier-2 drain's
 * rule (#1334), where silence is the failure mode.
 *
 * Cost, per pass:
 * - `candidates` reads the version registry (`registryImportCandidates`): one `listVerticals`
 *   when some scope is on a serving script, and one `versionManifest` per distinct running
 *   version, both directory reads. A scope whose running version declares no import is never
 *   called, so a fleet with no importer makes zero `/internal` calls.
 * - It keeps the scopes the pass listed, so resolving a scope's deployment costs no further
 *   directory read for a scope the pass already has.
 */
export function hostedCrossVerticalReach(input: {
  admin: Pick<HostAdmin, 'listVerticals' | 'versionManifest' | 'getScopeRecord'>;
  actor: PlatformActorId;
  /** The ladder (`resolveVerticalForScopeFor` in the control-plane worker). */
  clientForScope: (scope: {
    vertical: string | null;
    verticalVersionId: string | null;
    servingRef?: string | null;
  }) => Promise<VerticalClient | undefined>;
}): CrossVerticalReach {
  const listed = new Map<ScopeId, Scope>();
  const narrow = registryImportCandidates({
    admin: input.admin,
    actor: input.actor,
    importsOf: (json) => importsOfManifestJson(json),
  });
  const clientFor = async (tenantId: TenantId, scopeId: ScopeId, verb: string): Promise<VerticalClient> => {
    const known = listed.get(scopeId);
    const rec = known && known.tenantId === tenantId ? known : await input.admin.getScopeRecord(input.actor, tenantId, scopeId);
    const client = rec?.vertical ? await input.clientForScope(rec) : undefined;
    if (!client) {
      throw new Error(
        `no deployment serving scope ${scopeId} (vertical '${rec?.vertical ?? 'none'}') — cannot ${verb}; ` +
          `the edge's watermark holds`,
      );
    }
    return client;
  };
  return {
    candidates: async (scopes, hint) => {
      for (const s of scopes) listed.set(s.id, s);
      return narrow(scopes, hint);
    },
    importState: async (tenantId, scopeId) =>
      (await clientFor(tenantId, scopeId, 'read its imports')).importState({ tenantId, scopeId }),
    readExports: async (tenantId, scopeId, read) =>
      (await clientFor(tenantId, scopeId, 'read its exports')).exportedEvents({ tenantId, scopeId, input: read }),
    deliver: async (tenantId, scopeId, batch) =>
      (await clientFor(tenantId, scopeId, 'deliver to it')).importEvents({ tenantId, scopeId, batch }),
  };
}
