import type { Page } from '@substrat-run/contracts';

import type {
  AdoptServingResult,
  AdoptVerticalResult,
  BindHostnameBody,
  BindScopeVersionBody,
  BoundScopeVersion,
  ChannelRow,
  ExportBreakAck,
  HostnameRow,
  ListingRecord,
  PromoteAcknowledge,
  PromoteResult,
  ProvisionScopeResult,
  PulledDump,
  RebindScopeBody,
  RebindVerticalResult,
  RestoreBody,
  ScopeHealthRecord,
  ScopeRecord,
  ScopeRow,
  VersionRow,
  Whoami,
} from './builder-types.js';
import { ControlPlaneTransport } from './transport.js';

/** One page of a list route: how many, and where after. */
export interface PageRequest {
  limit?: number;
  cursor?: string | null;
}

/** The page size a walk to the END asks for — the routes' ceiling, to keep the walk short. */
export const WALK_PAGE_LIMIT = 200;

/**
 * Walk a paged list to the end. Every GET list route answers `{ entries, nextCursor }`, and
 * a builder tool's reads are complete-list semantics (the max semver, installs joined to
 * hostnames), so it follows the cursor at the ceiling page size until it runs out.
 */
export async function walkPages<T>(
  fetchPage: (page: { limit: number; cursor: string | null }) => Promise<Page<T>>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await fetchPage({ limit: WALK_PAGE_LIMIT, cursor });
    out.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return out;
}

const seg = encodeURIComponent;

/** `?a=b&limit=…&cursor=…` — the leading params first, then the page, in the order the CLI always sent them. */
function queryOf(lead: Record<string, string>, page: PageRequest | undefined): string {
  const parts = Object.entries(lead).map(([k, v]) => `${k}=${seg(v)}`);
  if (page?.limit !== undefined) parts.push(`limit=${page.limit}`);
  if (page?.cursor) parts.push(`cursor=${seg(page.cursor)}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

const JSON_TYPE = { 'content-type': 'application/json' } as const;

/**
 * The control-plane routes a builder's tooling calls — the CLI's whole surface (#971): who
 * am I, a vertical's versions and channels, promote, hostnames, and the scope tools.
 *
 * It extends the transport and adds nothing to how a request is made. A write names its
 * `content-type` itself, so the same method sends the same request whether the client was
 * built to send the JSON type on everything (as the hostname and preview commands always
 * have) or on nothing (as a bare read always has). A refusal is a `ControlPlaneError`
 * carrying the raw body, which is how a caller that renders its own messages — the CLI —
 * keeps them; a 2xx that is not JSON is a `malformed` one.
 *
 * Responses are typed, not parsed (`builder-types.ts`).
 */
export class ControlPlaneBuilderClient extends ControlPlaneTransport {
  private write(method: string, body?: unknown): RequestInit {
    return {
      method,
      headers: { ...JSON_TYPE },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  }

  // -- identity ---------------------------------------------------------------

  whoami(): Promise<Whoami> {
    return this.read('/auth/whoami');
  }

  /** The `substrat login` code→token exchange. Unauthenticated: the code is the credential. */
  exchangeLoginCode(code: string, verifier: string): Promise<{ token?: string }> {
    return this.read('/auth/cli/token', this.write('POST', { code, verifier }));
  }

  // -- the registry -----------------------------------------------------------

  listVerticals(page?: PageRequest): Promise<Page<{ slug: string }>> {
    return this.read(`/verticals${queryOf({}, page)}`);
  }

  listVersions(slug: string, page?: PageRequest): Promise<Page<VersionRow>> {
    return this.read(`/verticals/${seg(slug)}/versions${queryOf({}, page)}`);
  }

  listChannels(slug: string, page?: PageRequest): Promise<Page<ChannelRow>> {
    return this.read(`/verticals/${seg(slug)}/channels${queryOf({}, page)}`);
  }

  /** The permission registry a version carries (`null`: it kept none). */
  getVersionRegistry<R>(slug: string, versionId: string): Promise<{ registry: R | null }> {
    return this.read(`/verticals/${seg(slug)}/versions/${seg(versionId)}/registry`);
  }

  /** The migrations a version adds over `base`, as the control plane diffs them. */
  getVersionMigrations<M>(slug: string, versionId: string, base: string): Promise<{ migrations: M | null }> {
    return this.read(`/verticals/${seg(slug)}/versions/${seg(versionId)}/migrations?base=${seg(base)}`);
  }

  promoteChannel(
    slug: string,
    channel: string,
    versionId: string,
    acknowledge?: PromoteAcknowledge,
  ): Promise<PromoteResult> {
    const path = `/verticals/${seg(slug)}/channels/${seg(channel)}/promote`;
    return this.read(path, this.write('POST', { versionId, ...(acknowledge ? { acknowledge } : {}) }));
  }

  setListing(slug: string, listed: boolean): Promise<ListingRecord> {
    const path = `/verticals/${seg(slug)}/listing`;
    return this.read(path, this.write('POST', { listed }));
  }

  /** A builder asks for listing; a staff operator reviews it. */
  requestPublish(slug: string): Promise<void> {
    const path = `/verticals/${seg(slug)}/publish-request`;
    return this.send(path, { method: 'POST', headers: { ...JSON_TYPE }, body: '{}' }).then(() => undefined);
  }

  adoptVerticalServing(slug: string, body: ExportBreakAck): Promise<AdoptVerticalResult | null> {
    const path = `/verticals/${seg(slug)}/adopt-serving`;
    // Lenient on purpose: a 2xx whose body is not JSON reads as "nothing reported", which is
    // what the command prints for it.
    return this.send(path, this.write('POST', body)).then((res) => res.json().catch(() => null));
  }

  // -- the directory ----------------------------------------------------------

  listScopes(tenantId: string, page?: PageRequest): Promise<Page<ScopeRow>> {
    return this.read(`/scopes${queryOf({ tenantId }, page)}`);
  }

  listHostnames(tenantId: string, page?: PageRequest): Promise<Page<HostnameRow>> {
    return this.read(`/hostnames${queryOf({ tenantId }, page)}`);
  }

  bindHostname(body: BindHostnameBody): Promise<HostnameRow> {
    return this.read('/hostnames', this.write('POST', body));
  }

  verifyHostname(hostname: string): Promise<HostnameRow> {
    const path = `/hostnames/${seg(hostname)}/verify`;
    return this.read(path, this.write('POST'));
  }

  /** Unbind one hostname. Reads the answer like every other call here: an empty body is not JSON. */
  unbindHostname(hostname: string): Promise<unknown> {
    return this.read(`/hostnames/${seg(hostname)}`, this.write('DELETE'));
  }

  // -- one scope --------------------------------------------------------------

  private scopePath(tenantId: string, scopeId: string): string {
    return `/tenants/${seg(tenantId)}/scopes/${seg(scopeId)}`;
  }

  getScope(tenantId: string, scopeId: string): Promise<ScopeRecord> {
    return this.read(this.scopePath(tenantId, scopeId));
  }

  /** Reaches into the vertical's own deployment, so it can fail while the record answers. */
  getScopeHealth(tenantId: string, scopeId: string): Promise<ScopeHealthRecord> {
    return this.read(`${this.scopePath(tenantId, scopeId)}/health`);
  }

  exportScope(tenantId: string, scopeId: string, full: boolean): Promise<PulledDump> {
    return this.read(`${this.scopePath(tenantId, scopeId)}/export${full ? '?full=true' : ''}`);
  }

  /** The restore's answer carries nothing the caller reads — only that it landed. */
  restoreScope(tenantId: string, scopeId: string, body: RestoreBody): Promise<void> {
    const path = `${this.scopePath(tenantId, scopeId)}/restore`;
    return this.send(path, this.write('POST', body)).then(() => undefined);
  }

  adoptServing(tenantId: string, scopeId: string, body: ExportBreakAck): Promise<AdoptServingResult> {
    const path = `${this.scopePath(tenantId, scopeId)}/adopt-serving`;
    return this.read(path, this.write('POST', body));
  }

  provisionScope(tenantId: string, scopeId: string): Promise<ProvisionScopeResult> {
    const path = `${this.scopePath(tenantId, scopeId)}/provision`;
    return this.read(path, this.write('POST'));
  }

  bindScopeVersion(tenantId: string, scopeId: string, body: BindScopeVersionBody): Promise<BoundScopeVersion> {
    const path = `${this.scopePath(tenantId, scopeId)}/version`;
    return this.read(path, this.write('POST', body));
  }

  rebindScopeVertical(tenantId: string, scopeId: string, body: RebindScopeBody): Promise<RebindVerticalResult> {
    const path = `${this.scopePath(tenantId, scopeId)}/rebind-vertical`;
    return this.read(path, this.write('POST', body));
  }
}
