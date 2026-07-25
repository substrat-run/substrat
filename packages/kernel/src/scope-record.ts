import { slug as slugSchema } from '@substrat-run/contracts';
import type { Jurisdiction, StorageShape } from '@substrat-run/contracts';
import type { ProvisionScopeInput } from './scope-host.js';

/** The directory columns `provisionScope` writes, with every optional resolved. */
export interface ResolvedScopeRecord {
  slug: string;
  kind: string;
  name: string;
  vertical: string | null;
  storageShape: StorageShape;
  jurisdiction: Jurisdiction;
  forkedFrom: string | null;
  forkedAt: string | null;
  expiresAt: string | null;
}

/**
 * Resolve `ProvisionScopeInput`'s optional naming fields into the row both
 * adapters write.
 *
 * It lives in the kernel, not in either adapter, because these defaults are a
 * CONTRACT: "an unnamed scope's slug is its lowercased id" has to be one fact
 * with one implementation. Two copies would agree until the day they didn't, and
 * the contract tests — which run the same suite against both adapters — would
 * still pass, because each adapter would be consistent with itself.
 *
 * The slug is parsed rather than trusted (the boundary rule): an invalid slug
 * fails here, at provisioning, instead of at the first `listScopes` read, when
 * the scope already exists and the caller is someone else.
 */
export function resolveScopeRecord(input: ProvisionScopeInput): ResolvedScopeRecord {
  // A ULID lowercases into a valid slug ([0-9a-hjkmnp-tv-z]), so the default is
  // both structurally valid and unique within the tenant by construction.
  const slug = slugSchema.parse(input.slug ?? input.scopeId.toLowerCase());
  return {
    slug,
    kind: input.kind ?? 'scope',
    name: input.name ?? slug,
    vertical: input.vertical ?? null,
    storageShape: input.storageShape ?? 'A',
    // No jurisdiction stated means `global` — unconstrained, the honest name for
    // what an un-pinned scope already is (K-32). The old default was `null`, which
    // also meant "nobody decided"; `global` is a decision, and the only one the
    // provisioning boundary accepts until `eu`/`us` enforcement exists.
    jurisdiction: input.jurisdiction ?? 'global',
    // Provenance is set only by importScope; a normal provision leaves it null.
    forkedFrom: input.forkedFrom ?? null,
    forkedAt: input.forkedAt ?? null,
    expiresAt: input.expiresAt ?? null,
  };
}
