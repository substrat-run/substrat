import {
  blobStoreBindingName,
  storedDeployManifest,
  tenantStoreBindingName,
  type BlobStoreHandle,
  type BlobStoreNeed,
  type PlatformActorId,
  type TenantId,
  type TenantStoreHandle,
  type TenantStoreNeed,
} from '@substrat-run/contracts';
import type { BlobStoreRecord, HostAdmin, ScopeHost, TenantStoreRecord } from '@substrat-run/kernel';
import type { ScriptBindingSpec, PatchScriptBindingsFn } from './wfp.js';

/**
 * What a vertical DECLARES its tenants must be given, and where that declaration is
 * being served from — the one resolution every store path shares (mint, backfill, and
 * the health check that reports a store as missing).
 *
 * The version whose declaration governs is the one that will SERVE a provisioned scope:
 * the serving script's version (#286) when one exists, else the prod channel — the same
 * ladder provisioning itself resolves the `VerticalClient` through. A vertical with no
 * retained manifest (a pre-#286 push, or a statically-bound one) declares nothing, which
 * is what keeps every existing vertical untouched by all of this.
 */
export interface StoreDeclaration {
  /** The version the declaration was read from — null when nothing is deployed. */
  versionId: string | null;
  /** The script a binding must be attached to: the serving script, else the version's own. */
  scriptRef: string | null;
  tenantStores: TenantStoreNeed[];
  blobStores: BlobStoreNeed[];
}

const NOTHING_DECLARED: StoreDeclaration = {
  versionId: null,
  scriptRef: null,
  tenantStores: [],
  blobStores: [],
};

/** Resolve {@link StoreDeclaration} for a vertical — see its doc for the version ladder. */
export async function resolveStoreDeclaration(
  admin: HostAdmin,
  actor: PlatformActorId,
  slug: string,
): Promise<StoreDeclaration> {
  const serving = await admin.verticalServing(actor, slug).catch(() => null);
  let versionId = serving?.versionId ?? null;
  if (!versionId) {
    const prod = (await admin.listChannels(actor, slug).catch(() => [])).find(
      (c) => c.channel === 'prod',
    );
    versionId = prod?.versionId ?? null;
  }
  if (!versionId) return NOTHING_DECLARED;
  const manifestJson = await admin.versionManifest(actor, slug, versionId).catch(() => null);
  if (!manifestJson) return { ...NOTHING_DECLARED, versionId };
  const manifest = storedDeployManifest.parse(JSON.parse(manifestJson));
  const scriptRef =
    serving?.ref ??
    (await admin.listVersions(actor, slug)).find((v) => v.id === versionId)?.deploymentRef ??
    null;
  return {
    versionId,
    scriptRef,
    tenantStores: manifest.tenantStores,
    blobStores: manifest.blobStores,
  };
}

/** One store a vertical declared that a tenant has no ledger row for (#825). */
export interface MissingStore {
  binding: string;
  kind: 'relational' | 'blob';
}

/** A store minted by the promote-time backfill, for the report it returns (#825). */
export interface MintedStore extends MissingStore {
  tenantId: TenantId;
}

/** Ledger rows → tenant id → the bindings that tenant already holds. */
function heldByTenant(rows: Array<{ tenantId: TenantId; binding: string }>): Map<string, Set<string>> {
  const held = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = held.get(row.tenantId) ?? new Set<string>();
    set.add(row.binding);
    held.set(row.tenantId, set);
  }
  return held;
}

/** The declared-minus-minted diff for ONE tenant, against ledgers already read. */
function missingFor(
  declared: StoreDeclaration,
  tenantId: TenantId,
  heldRelational: Map<string, Set<string>>,
  heldBlob: Map<string, Set<string>>,
): MissingStore[] {
  return [
    ...declared.tenantStores
      .filter((n) => !heldRelational.get(tenantId)?.has(n.binding))
      .map((n) => ({ binding: n.binding, kind: 'relational' as const })),
    ...declared.blobStores
      .filter((n) => !heldBlob.get(tenantId)?.has(n.binding))
      .map((n) => ({ binding: n.binding, kind: 'blob' as const })),
  ];
}

/**
 * Stores a vertical DECLARES that this tenant was never minted (#825) — the check that
 * turns "the vertical throws at first upload, in production" into a condition the fleet
 * can see. Per-tenant stores are minted in the tenant-creation lifecycle, so a tenant
 * that predates a newly declared need passes that gate once, before the need existed,
 * and never passes it again: nothing about its scope looks unhealthy, and the first
 * signal is a runtime refusal arbitrarily long after the deploy that introduced the need.
 *
 * Reported by `/scopes/:id/health` and repaired by re-provisioning the scope, which mints
 * whatever this returns (`collectTenantStoreHandles` / `collectBlobStoreHandles`).
 */
export async function missingStoresForTenant(opts: {
  host: ScopeHost;
  actor: PlatformActorId;
  slug: string;
  tenantId: TenantId;
}): Promise<MissingStore[]> {
  const admin = opts.host.admin;
  const declared = await resolveStoreDeclaration(admin, opts.actor, opts.slug);
  if (!declared.tenantStores.length && !declared.blobStores.length) return [];
  const [tenantLedger, blobLedger] = await Promise.all([
    admin.listTenantStores(opts.actor, { tenantId: opts.tenantId, vertical: opts.slug }),
    admin.listBlobStores(opts.actor, { tenantId: opts.tenantId, vertical: opts.slug }),
  ]);
  return missingFor(declared, opts.tenantId, heldByTenant(tenantLedger), heldByTenant(blobLedger));
}

/**
 * Mint every declared store the named tenants are missing, in ONE pass (#825) — the
 * deploy-time backfill, called on promote once the new version is the serving one.
 *
 * This is what keeps a newly declared store from being an ops runbook. Minting used to
 * happen only in the tenant-creation lifecycle, which is a gate every existing tenant has
 * already passed: declaring a store in version N+1 gave it to nobody, and the operator had
 * to know to re-provision each install by hand. Promote is where the declaration becomes
 * real for everyone else (the serving script is uploaded, its bindings re-derived), so it
 * is where the fleet's stores are reconciled to it too.
 *
 * Reads both ledgers ONCE and diffs in memory, so the common case — every tenant already
 * holds what the version declares, or the version declares nothing — costs two reads and
 * mints nothing. The binding attach is a single ledger-derived PATCH after the mints, not
 * one per tenant, and runs only if something was actually minted (the serving upload that
 * just happened already carried every pre-existing binding).
 */
export async function backfillDeclaredStores(opts: {
  host: ScopeHost;
  actor: PlatformActorId;
  slug: string;
  /** The tenants installed on this vertical, from the directory's own inventory. */
  tenantIds: TenantId[];
  patchBindings?: PatchScriptBindingsFn;
}): Promise<MintedStore[]> {
  const admin = opts.host.admin;
  const declared = await resolveStoreDeclaration(admin, opts.actor, opts.slug);
  if (!declared.tenantStores.length && !declared.blobStores.length) return [];
  const [tenantLedger, blobLedger] = await Promise.all([
    admin.listTenantStores(opts.actor, { vertical: opts.slug }),
    admin.listBlobStores(opts.actor, { vertical: opts.slug }),
  ]);
  const heldRelational = heldByTenant(tenantLedger);
  const heldBlob = heldByTenant(blobLedger);

  const minted: MintedStore[] = [];
  for (const tenantId of opts.tenantIds) {
    for (const missing of missingFor(declared, tenantId, heldRelational, heldBlob)) {
      const input = { tenantId, vertical: opts.slug, binding: missing.binding };
      if (missing.kind === 'relational') {
        await opts.host.provisionTenantStore(opts.actor, input);
      } else {
        await opts.host.provisionBlobStore(opts.actor, input);
      }
      minted.push({ tenantId, ...missing });
    }
  }
  if (minted.length && opts.patchBindings && declared.scriptRef) {
    await opts.patchBindings(declared.scriptRef, [
      ...tenantStoreBindings(await admin.listTenantStores(opts.actor, { vertical: opts.slug })),
      ...blobStoreBindings(await admin.listBlobStores(opts.actor, { vertical: opts.slug })),
    ]);
  }
  return minted;
}

/**
 * The provision-time half of per-tenant relational stores (#301, PR-2): resolve what a
 * vertical DECLARED (its bound version's stored manifest, `tenantStores`), have the host
 * MINT each store for this tenant (idempotent — a retried provision re-resolves the same
 * handles), make the stores REACHABLE at request time (attach the D1 bindings to the
 * script that serves this vertical), and return the handles the K-31 provision callback
 * hands over so the vertical runs its own migrations inside the existing fail-closed /
 * retryable ready-gate.
 *
 * Substrate-agnostic by construction: a vertical with no retained manifest or no declared
 * `tenantStores` yields `[]` (nothing changes for every existing vertical), and the
 * binding attach only runs where a patcher is configured (Cloudflare) — the pure adapter
 * has no script to patch and needs none, its handle refs open directly.
 */
export async function collectTenantStoreHandles(opts: {
  host: ScopeHost;
  actor: PlatformActorId;
  /** The vertical's registry slug — the id its ledger rows and manifest live under. */
  slug: string;
  tenantId: TenantId;
  /** Attach bindings on the dispatch script (Cloudflare); absent = no attach step. */
  patchBindings?: PatchScriptBindingsFn;
}): Promise<TenantStoreHandle[]> {
  const admin = opts.host.admin;
  // What the SERVING version declares (`resolveStoreDeclaration` owns the ladder), and
  // which script its bindings must land on.
  const declared = await resolveStoreDeclaration(admin, opts.actor, opts.slug);
  const needs = declared.tenantStores;
  if (needs.length === 0) return [];

  const handles: TenantStoreHandle[] = [];
  for (const need of needs) {
    handles.push(
      await opts.host.provisionTenantStore(opts.actor, {
        tenantId: opts.tenantId,
        vertical: opts.slug,
        binding: need.binding,
      }),
    );
  }

  // Attach the bindings where the worker will look them up
  // (`env[tenantStoreBindingName(binding, tenantId)]`). Derived from the LEDGER, not the
  // handles just minted, and re-run even on an idempotent re-provision — so a provision
  // that crashed between the ledger write and the attach heals here, and the serving
  // upload's own ledger-derived injection (serveVersionInPlace) keeps re-deploys honest.
  // The target is the script provisioning dispatches to: the serving script, or the
  // resolved version's own script for a vertical not yet serving in place.
  if (opts.patchBindings && declared.scriptRef) {
    const ledger = await admin.listTenantStores(opts.actor, { vertical: opts.slug });
    await opts.patchBindings(declared.scriptRef, tenantStoreBindings(ledger));
  }
  return handles;
}

/**
 * The provision-time half of per-tenant blob stores (#473) — the byte-store twin of
 * {@link collectTenantStoreHandles}: mint one R2 bucket per declared `blobStoreNeed` for
 * this tenant (idempotent) and attach its `r2_bucket` binding to the serving script.
 * Unlike tenant stores, blob stores need no migration ready-gate (there is no schema), so
 * this returns nothing for the provision callback — the effect is the ledger + bindings.
 */
export async function collectBlobStoreHandles(opts: {
  host: ScopeHost;
  actor: PlatformActorId;
  slug: string;
  tenantId: TenantId;
  patchBindings?: PatchScriptBindingsFn;
}): Promise<BlobStoreHandle[]> {
  const admin = opts.host.admin;
  const declared = await resolveStoreDeclaration(admin, opts.actor, opts.slug);
  const needs = declared.blobStores;
  if (needs.length === 0) return [];

  const handles: BlobStoreHandle[] = [];
  for (const need of needs) {
    handles.push(
      await opts.host.provisionBlobStore(opts.actor, {
        tenantId: opts.tenantId,
        vertical: opts.slug,
        binding: need.binding,
      }),
    );
  }

  if (opts.patchBindings && declared.scriptRef) {
    const ledger = await admin.listBlobStores(opts.actor, { vertical: opts.slug });
    await opts.patchBindings(declared.scriptRef, blobStoreBindings(ledger));
  }
  return handles;
}

/** Ledger rows → the D1 bindings a script serving this vertical must carry (#301). */
export function tenantStoreBindings(ledger: TenantStoreRecord[]): ScriptBindingSpec[] {
  return ledger.map((r) => ({
    type: 'd1',
    name: tenantStoreBindingName(r.binding, r.tenantId),
    id: r.ref,
  }));
}

/** Ledger rows → the R2 bindings a script serving this vertical must carry (#473). */
export function blobStoreBindings(ledger: BlobStoreRecord[]): ScriptBindingSpec[] {
  return ledger.map((r) => ({
    type: 'r2_bucket',
    name: blobStoreBindingName(r.binding, r.tenantId),
    bucketName: r.ref,
  }));
}
