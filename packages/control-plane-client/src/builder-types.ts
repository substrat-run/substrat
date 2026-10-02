import type { ExportBreak } from '@substrat-run/contracts';

/**
 * The answers a builder's tooling reads off the control plane — the fields the CLI actually
 * uses, typed and NOT parsed (#971): a field the deployed plane omits arrives as `undefined`
 * rather than as a thrown error, which is the behaviour the CLI has always had. The server's
 * own schemas live in `@substrat-run/contracts`; these are deliberately the narrower reading.
 */

/** `GET /auth/whoami` — the signed-in user and the tenants they can build for. */
export interface Whoami {
  user: { id: string; email?: string } | null;
  tenants: { id: string; slug: string; name: string }[];
}

export interface VersionRow {
  id: string;
  version: string;
  admission: string;
  deploymentRef?: string;
}

export interface ChannelRow {
  channel: string;
  versionId: string;
  /**
   * What prod's stable serving script actually runs (#286/#321). Differs from `versionId`
   * when an in-place serve failed: the channel was promoted but the scopes run old code.
   */
  servingVersionId?: string | null;
}

/** One scope of a tenant as the directory lists it (`GET /scopes?tenantId=`). */
export interface ScopeRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  vertical: string | null;
  verticalVersionId: string | null;
  forkedFrom: string | null;
  servingRef?: string | null;
  createdAt: string;
}

/** A DNS record the tenant must publish (contracts' dnsRecord). */
export interface DnsRecordRow {
  type: 'hostname' | 'txt';
  name: string;
  value: string;
}

/** One hostname binding as the control plane returns it (contracts' HostnameBinding). */
export interface HostnameRow {
  hostname: string;
  tenantId: string;
  scopeId: string;
  verticalSlug: string | null;
  surface: string;
  status: string;
  statusNote: string | null;
  canonical: boolean;
  createdAt: string;
  customHostnameId: string | null;
  validationRecords: DnsRecordRow[];
}

export interface BindHostnameBody {
  hostname: string;
  tenantId: string;
  scopeId: string;
  surface: string;
  canonical: boolean;
}

/** The installed apps a promote breaks (#1705 PR 3), as the control plane lists them to this caller. */
export interface ExportBreaks {
  affected: ExportBreak[];
  otherTenants?: number;
}

/**
 * One store the promote minted for an already-installed tenant (#825) — a store declared
 * by THIS version that the tenant, having been created before the declaration existed,
 * did not have.
 */
export interface MintedStore {
  tenantId: string;
  binding: string;
  kind: 'relational' | 'blob';
}

export interface PromoteAcknowledge {
  permissionChange?: boolean;
  migrationChange?: boolean;
  exportBreak?: boolean;
}

export interface PromoteResult {
  channel: string;
  versionId: string;
  /** Present only when this promote minted stores, or tried and could not. `minted` names
   *  only tenants the caller may see; `otherTenants` counts the rest of the fleet the sweep
   *  also covered. */
  storeBackfill?: { minted: MintedStore[]; otherTenants?: number; error?: string };
  /** Present when an acknowledged export break reached installed apps (#1705 PR 3). */
  exportBreaks?: ExportBreaks;
}

export interface DumpTable {
  name: string;
  ddl: string;
  columns: string[];
  rows: unknown[][];
}

/** `GET …/scopes/:id/export` — a scope's data as the control plane released it. */
export interface PulledDump {
  tenantId: string;
  scopeId: string;
  capturedAt: string;
  masked: boolean;
  tables: DumpTable[];
}

export interface RestoreBody {
  tenantId: string;
  scopeId: string;
  capturedAt: string;
  tables: DumpTable[];
}

export interface ScopeRecord {
  slug: string;
  name: string;
  status: string;
  vertical: string | null;
  verticalVersionId: string | null;
  servingRef?: string | null;
  schemaVersion: string;
  createdAt: string;
}

export interface ScopeHealthRecord {
  roleCount: number | null;
  roleProjectionEmpty: boolean;
  missingStores?: { binding: string; kind: string }[];
}

/** What a move's refusal may ask the caller to acknowledge (#1756). */
export interface ExportBreakAck {
  acknowledge?: { exportBreak: true };
}

export interface BindScopeVersionBody extends ExportBreakAck {
  versionId: string;
  snapshot?: true;
}

export interface RebindScopeBody extends ExportBreakAck {
  vertical: string;
  ackMigrations?: true;
  abandonData?: true;
}

export interface AdoptServingResult {
  servingRef?: string;
  alreadyAdopted?: boolean;
  tables?: number;
}

export interface AdoptVerticalResult {
  adopted?: string[];
  alreadyAdopted?: string[];
}

export interface RebindVerticalResult {
  servingRef?: string;
  versionId?: string;
  alreadyBound?: boolean;
  tables?: number;
  dataAbandoned?: boolean;
}

export interface ProvisionScopeResult {
  owner?: string;
  storeError?: string;
}

export interface BoundScopeVersion {
  verticalVersionId: string | null;
  vertical: string | null;
  servingRef?: string | null;
}

export interface ListingRecord {
  slug: string;
  listed: boolean;
}
