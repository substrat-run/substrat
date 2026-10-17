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
  status: string | null;
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
  /**
   * #2333: the review these acknowledgements answer, as the migrations read returned it beside the
   * diff that was shown (`getVersionMigrations` → `review`). The control plane refuses one that no
   * longer holds, and a migration acknowledgement without one.
   */
  review?: PromoteReviewBinding;
}

/** What a promote review is bound to (#2333): the base it was read against, and the host's digest of it. */
export interface PromoteReviewBinding {
  base: string | null;
  digest: string;
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
/** One scope store inside a pull or a restore (#2211). Opaque tables, not sealed. */
export interface StoreDump {
  binding: string;
  driver: string;
  tables: DumpTable[];
}

export interface PulledDump {
  tenantId: string;
  scopeId: string;
  capturedAt: string;
  masked: boolean;
  tables: DumpTable[];
  /** Absent on a pull from before scope stores. A masked pull sends an empty list. */
  stores?: StoreDump[];
}

export interface RestoreBody {
  tenantId: string;
  scopeId: string;
  capturedAt: string;
  tables: DumpTable[];
  /** Absent means the restore does not touch scope stores. */
  stores?: StoreDump[];
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
  snapshot?: true | undefined;
}

export interface RebindScopeBody {
  vertical: string;
  ackMigrations?: true | undefined;
  abandonData?: true | undefined;
  /**
   * #2347: `review` names the rebind review `ackMigrations` answers, exactly as the
   * rebind-review read returned it beside the diff that was shown. The control plane refuses one
   * whose base or stored rows moved since (`rebind_review_stale`), and an `ackMigrations` sent
   * with none where the two lineages' migration digests differ (`rebind_review_unbound`).
   */
  acknowledge?: { exportBreak?: true; review?: PromoteReviewBinding };
}

/** #2347: one side of a rebind review: a lineage and the version on it. */
export interface RebindReviewSide {
  vertical: string;
  versionId: string;
}

/**
 * #2347: what a rebind would apply — the target lineage's serving version over the version the
 * scope is bound to (`base`, null when it is bound to none) — and the binding to acknowledge it with.
 */
export interface RebindReview<M> {
  base: RebindReviewSide | null;
  target: RebindReviewSide;
  /** The two lineages carry the same migration digest, so the rebind needs no acknowledgement. */
  digestsMatch: boolean;
  /** Null for a target version whose migrations cannot be shown, or when they are withheld. */
  migrations: M | null;
  /**
   * The SQL is shown only to an owner of both verticals (staff included): any other caller gets
   * `migrations: null` with this set, and still the digests-differ fact and the binding.
   */
  migrationsWithheld: boolean;
  review: PromoteReviewBinding;
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
  /** The owner the vertical re-seated; `null` when it keeps no owner of record (#2263), so the
   *  reconcile seated what its version declares and repaired no lockout. */
  owner?: string | null;
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

/** A stored store-driver release (#2300): its bytes are named by their sha256. */
export interface StoreDriverReleaseView {
  driver: string;
  sha256: string;
  sourceCommit: string;
  uploadedBy: string;
  uploadedAt: string;
}

/** One attempt to move every script of a driver to a release. */
export interface StoreDriverRolloutView {
  driver: string;
  seq: number;
  sha256: string;
  action: 'rollout' | 'rollback';
  fromSha256: string | null;
  previousGoodSha256: string | null;
  state: 'rolling' | 'good' | 'failed' | 'diverged' | 'paused';
  actor: string;
  startedAt: string;
  endedAt: string | null;
  detail: string | null;
}

export interface StoreDriverView {
  driver: string;
  pins: { sha256: string; sourceCommit: string; schema: number }[];
  current: { sha256: string; seq: number; previousGoodSha256: string | null } | null;
  rollouts: StoreDriverRolloutView[];
  /** Where a rollback goes now: the server decides, a client never derives it. */
  rollbackTarget: string | null;
  /** A rollback that stopped part way, until it ends good. Unless it targets the current release, no rollout begins meanwhile. */
  unfinishedRollback: string | null;
  /**
   * The platform's rebuild of every script of the driver (#2309), when this control plane rebuilds
   * them. `current`: every script is built from what the platform builds from now (its key lists,
   * entry and verifier). Until it is, `pending` names the scripts that may not be (`-canary` is the
   * driver's canary script), an upper bound.
   */
  rebuild?: StoreDriverRebuildView;
}

/** A failure of the fleet rebuild: the vertical (or `-canary`) and why. */
export interface StoreDriverRebuildFailureView {
  vertical: string;
  detail: string;
}

export interface StoreDriverRebuildView {
  /** What the platform builds every script from now. */
  fingerprint: string;
  current: boolean;
  pending: string[];
  /**
   * Set when the walk is done but finished within an hour of its fingerprint appearing, while the
   * deploy may still have been rolling out: when it is walked again. Not current until then.
   */
  settling?: string;
  /** When the scheduled pass walks a done rebuild again (after the settle window, then daily). */
  nextWalk?: string;
  /** A walk is re-checking a fleet already proved current at these lists; `current` meanwhile. */
  reverifying?: boolean;
  /** The walk's row: absent before its first pass. Its fingerprint may be an older one. */
  walk: {
    fingerprint: string;
    fingerprintSince: string;
    cursor: string | null;
    failures: StoreDriverRebuildFailureView[];
    state: 'running' | 'done';
    startedAt: string;
    /** The person who attested, when this walk began, that no control-plane deploy was rolling out. */
    attestedBy: string | null;
    /** When a walk at these lists last proved every script current. */
    verifiedAt: string | null;
    updatedAt: string;
    finishedAt: string | null;
  } | null;
}

/** One pass of the fleet rebuild over one driver, as a staff request ran it. */
export interface StoreDriverRebuildPassView {
  driver: string;
  outcome: 'current' | 'busy' | 'held' | 'paused' | 'done' | 'failing' | 'error';
  walked: string[];
  uploaded: string[];
  error?: string;
}

export interface StoreDriverRolloutResultView {
  rollout: StoreDriverRolloutView;
  /** The verticals this request moved. */
  moved: string[];
  /** False when verticals remain: post the same rollout again. */
  complete: boolean;
}

/** A poll connector's landing target. Binding never grants new authority. */
export interface ConnectionScopeBindingInput {
  operation: string;
  permission: string;
  organizationId?: number | null;
  currency?: string;
  window?: { fromYear: number; toYear: number } | null;
  horizonYears?: number;
}
export interface ConnectionScopeBinding extends ConnectionScopeBindingInput {
  /** Read from the target scope's live projection; omitted when inspection fails. */
  permissionHeld?: boolean;
  /** A failure to inspect this target, preserving the stored binding in list responses. */
  permissionInspectionError?: string;
  auditWarning?: string;
  tenantId: string;
  scopeId: string;
  vertical: string;
  boundAt: string;
}
