import {
  blobStoreBindingName,
  storedDeployManifest,
  tenantStoreBindingName,
  type BlobStoreHandle,
  type PlatformActorId,
  type TenantId,
  type TenantStoreHandle,
} from '@substrat-run/contracts';
import type { BlobStoreRecord, ScopeHost, TenantStoreRecord } from '@substrat-run/kernel';
import type { ScriptBindingSpec, PatchScriptBindingsFn } from './wfp.js';

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
  // The version whose declaration governs is the one that will SERVE the provisioned
  // scope: the serving script's version (#286) when one exists, else the prod channel —
  // the same ladder provisioning itself resolves the VerticalClient through.
  const serving = await admin.verticalServing(opts.actor, opts.slug).catch(() => null);
  let versionId = serving?.versionId ?? null;
  if (!versionId) {
    const prod = (await admin.listChannels(opts.actor, opts.slug).catch(() => [])).find(
      (c) => c.channel === 'prod',
    );
    versionId = prod?.versionId ?? null;
  }
  if (!versionId) return [];
  const manifestJson = await admin
    .versionManifest(opts.actor, opts.slug, versionId)
    .catch(() => null);
  if (!manifestJson) return []; // pre-#286 push or a statically-bound vertical: declares nothing
  const needs = storedDeployManifest.parse(JSON.parse(manifestJson)).tenantStores;
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
  if (opts.patchBindings) {
    const scriptRef =
      serving?.ref ??
      (await admin.listVersions(opts.actor, opts.slug)).find((v) => v.id === versionId)
        ?.deploymentRef ??
      null;
    if (scriptRef) {
      const ledger = await admin.listTenantStores(opts.actor, { vertical: opts.slug });
      await opts.patchBindings(scriptRef, tenantStoreBindings(ledger));
    }
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
  const serving = await admin.verticalServing(opts.actor, opts.slug).catch(() => null);
  let versionId = serving?.versionId ?? null;
  if (!versionId) {
    const prod = (await admin.listChannels(opts.actor, opts.slug).catch(() => [])).find(
      (c) => c.channel === 'prod',
    );
    versionId = prod?.versionId ?? null;
  }
  if (!versionId) return [];
  const manifestJson = await admin
    .versionManifest(opts.actor, opts.slug, versionId)
    .catch(() => null);
  if (!manifestJson) return [];
  const needs = storedDeployManifest.parse(JSON.parse(manifestJson)).blobStores;
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

  if (opts.patchBindings) {
    const scriptRef =
      serving?.ref ??
      (await admin.listVersions(opts.actor, opts.slug)).find((v) => v.id === versionId)
        ?.deploymentRef ??
      null;
    if (scriptRef) {
      const ledger = await admin.listBlobStores(opts.actor, { vertical: opts.slug });
      await opts.patchBindings(scriptRef, blobStoreBindings(ledger));
    }
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
