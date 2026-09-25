import type { ManifestImports, PlatformActorId, Scope, ScopeId, TenantId } from '@substrat-run/contracts';
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
 *   when some scope is on a serving script, and one `readImports` per distinct running version
 *   it has not seen. The answers are cached by (slug, version) in `importsCache`, because a
 *   pushed version's manifest never changes. So a fleet of known versions costs no registry read
 *   at all. A scope whose running version declares no import is never called, so a fleet with no
 *   importer makes zero `/internal` calls. A version the registry cannot answer for keeps its
 *   scopes, and is never cached: the next pass asks again.
 * - It keeps the scopes the pass listed, so resolving a scope's deployment costs no further
 *   directory read for a scope the pass already has.
 */
export function hostedCrossVerticalReach(input: {
  admin: Pick<HostAdmin, 'listVerticals' | 'getScopeRecord'>;
  actor: PlatformActorId;
  /**
   * What a pushed version imports: the control plane's unaudited registry read
   * (`CloudflareScopeHost.versionImports`), never `admin.versionManifest`, which writes an
   * access row per call.
   */
  readImports: (verticalSlug: string, versionId: string) => Promise<ManifestImports>;
  /**
   * Answers kept across passes, keyed (slug, version). Pass one that outlives a pass (the
   * control-plane worker keeps one per isolate) to skip the registry for versions already
   * seen. Absent, answers live for this reach only.
   */
  importsCache?: Map<string, ManifestImports>;
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
    readImports: cachedImports(input.readImports, input.importsCache ?? new Map()),
  });
  // One resolution per scope for the life of this reach (one pass, or one kick): a producer is
  // read once per consumer that imports from it, and the ladder is directory reads each time.
  // A failed resolution is not kept, so the next verb asks again exactly as before.
  const resolving = new Map<string, Promise<VerticalClient>>();
  const clientFor = (tenantId: TenantId, scopeId: ScopeId, verb: string): Promise<VerticalClient> => {
    const key = `${tenantId}\u0000${scopeId}`;
    const hit = resolving.get(key);
    if (hit) return hit;
    const pending = resolve(tenantId, scopeId, verb);
    resolving.set(key, pending);
    pending.catch(() => resolving.delete(key));
    return pending;
  };
  const resolve = async (tenantId: TenantId, scopeId: ScopeId, verb: string): Promise<VerticalClient> => {
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

/** Distinct versions one cache holds before it starts over. It bounds memory, not correctness. */
const IMPORTS_CACHE_MAX = 4096;

/**
 * `read`, remembered by (slug, version). Only definite answers (`none`, `imports`) are kept: a
 * version's manifest never changes once pushed, so they cannot go stale. `unreadable` and a
 * failed read are asked again next time, since those may be transient.
 */
function cachedImports(
  read: (verticalSlug: string, versionId: string) => Promise<ManifestImports>,
  cache: Map<string, ManifestImports>,
): (verticalSlug: string, versionId: string) => Promise<ManifestImports> {
  return async (verticalSlug, versionId) => {
    const key = `${verticalSlug}\u0000${versionId}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const fact = await read(verticalSlug, versionId);
    if (fact.kind !== 'unreadable') {
      if (cache.size >= IMPORTS_CACHE_MAX) cache.clear();
      cache.set(key, fact);
    }
    return fact;
  };
}
