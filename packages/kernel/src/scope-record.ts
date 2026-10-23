import { slug as slugSchema, substratError, verticalSlug } from '@substrat-run/contracts';
import type { Jurisdiction, Scope, StorageShape } from '@substrat-run/contracts';
import type { ProvisionScopeInput, ScopeListing } from './scope-host.js';

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
 * The slug, kind, name and vertical are parsed rather than trusted (the boundary
 * rule): an invalid one fails here, at provisioning, instead of at the first
 * `listScopes` read, when the scope already exists and the caller is someone else.
 * A default stands in only for an absent value: an empty or whitespace-only `kind`
 * or `name` is refused, never defaulted.
 */
export function resolveScopeRecord(input: ProvisionScopeInput): ResolvedScopeRecord {
  // A ULID lowercases into a valid slug ([0-9a-hjkmnp-tv-z]), so the default is
  // both structurally valid and unique within the tenant by construction.
  const slug = slugSchema.parse(input.slug ?? input.scopeId.toLowerCase());
  return {
    slug,
    kind: textOf('kind', input.kind) ?? 'scope',
    name: textOf('name', input.name) ?? slug,
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
 * Map directory rows to `Scope`s the way `HostAdmin.listScopesReadable` answers: a row `map`
 * throws on is named in `unreadable` by its stored ids and the fields that failed, and the rest
 * are returned in order. One implementation for both adapters, so they name a bad row alike.
 */
export function readableScopes<R extends { scope_id: unknown; tenant_id: unknown }>(
  rows: readonly R[],
  map: (row: R) => Scope,
): ScopeListing {
  const out: ScopeListing = { scopes: [], unreadable: [] };
  for (const row of rows) {
    try {
      out.scopes.push(map(row));
    } catch (err) {
      out.unreadable.push({ scopeId: storedId(row.scope_id), tenantId: storedId(row.tenant_id), fields: failedFieldsOf(err) });
    }
  }
  return out;
}

/** A stored id as text, bounded: a corrupt row's id column is not trusted to be a ULID. */
const storedId = (value: unknown): string => String(value).slice(0, 64);

/** The top-level field names a parse failure names, without the values it read. */
function failedFieldsOf(err: unknown): string[] {
  const issues = (err as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return ['row'];
  const fields = new Set<string>();
  for (const issue of issues as { path?: unknown }[]) {
    const head = Array.isArray(issue.path) ? issue.path[0] : undefined;
    fields.add(typeof head === 'string' ? head : 'row');
  }
  return fields.size > 0 ? [...fields] : ['row'];
}

/** A `kind` or `name` as given, null when absent; an empty or whitespace-only one is refused. */
function textOf(field: 'kind' | 'name', value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.trim().length > 0) return value;
  return refuse(field, 'must not be empty or whitespace');
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
  return refuse('vertical', 'must be a vertical slug: lowercase letters, digits and hyphens, optionally prefixed by an owner slug and one /');
}

/** The standard refusal for one provisioning field, naming it. */
function refuse(field: 'kind' | 'name' | 'vertical', message: string): never {
  throw substratError('validation_failed', `provisionScope: ${field} ${message}`, {
    errors: [{ path: field, message }],
  });
}
