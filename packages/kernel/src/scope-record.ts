import { slug as slugSchema, substratError, verticalSlug } from '@substrat-run/contracts';
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
 * The slug and the vertical are parsed rather than trusted (the boundary rule): an
 * invalid one fails here, at provisioning, instead of at the first `listScopes`
 * read, when the scope already exists and the caller is someone else.
 */
export function resolveScopeRecord(input: ProvisionScopeInput): ResolvedScopeRecord {
  // A ULID lowercases into a valid slug ([0-9a-hjkmnp-tv-z]), so the default is
  // both structurally valid and unique within the tenant by construction.
  const slug = slugSchema.parse(input.slug ?? input.scopeId.toLowerCase());
  return {
    slug,
    kind: input.kind ?? 'scope',
    name: input.name ?? slug,
    vertical: verticalOf(input.vertical),
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

/**
 * The vertical a scope runs, as the registry names it (`verticalSlug`), or null for none.
 * An empty or whitespace-only string is not "no vertical": it is refused like any other
 * value the registry grammar does not admit, since the directory's own `scope` schema
 * reads it back as a parse error.
 */
function verticalOf(vertical: string | null | undefined): string | null {
  if (vertical === undefined || vertical === null) return null;
  if (verticalSlug.safeParse(vertical).success) return vertical;
  const message = 'must be a vertical slug: lowercase letters, digits and hyphens, optionally prefixed by an owner slug and one /';
  throw substratError('validation_failed', `provisionScope: vertical ${message}`, {
    errors: [{ path: 'vertical', message }],
  });
}
