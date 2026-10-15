import {
  LIST_PAGE_MAX,
  mayHoldScopeStores,
  scopeStoresDeclaredIn,
  STORE_KINDS,
  issueScopeStoreEnvelope,
  SCOPE_STORE_ENVELOPE_HEADER,
  SCOPE_STORE_SIGNATURE_HEADER,
  ScopeStoreKeyError,
  scopeStoreObjectName,
  scopeStoreScriptName,
  storeEraseResult,
  storeExportResult,
  storeSizeResult,
  StoreError,
  type PlatformActorId,
  type ReservedStoreOperation,
  type Scope,
  type ScopeDumpTable,
  type StoreKindRegistration,
} from '@substrat-run/contracts';
import { callReservedStoreOperation, type HostAdmin } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { storedDeployManifest } from './deploy.js';

/**
 * A reserved scope-store call, made by the control plane straight at the store
 * script (#2207). The vertical is not on this path: it holds neither the
 * namespace nor the key. The key signs the envelope here, audience `platform`,
 * which is the only audience a `substrat.*` operation accepts.
 */
export interface PlatformScopeStoreDispatch {
  /** PKCS8 Ed25519 private key, base64url. Signs audience `platform`. */
  readonly platformKey: string;
  fetch(scriptName: string, request: Request): Promise<Response>;
}

export interface PlatformScopeStoreTarget {
  readonly vertical: string;
  readonly kind: string;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly binding: string;
}

/** One declared binding, as a version manifest lists it. */
export interface DeclaredScopeStore {
  readonly binding: string;
  readonly kind: string;
}

export interface PlatformScopeStores {
  exportStores(input: {
    tenantId: string;
    scopeId: string;
    vertical: string;
    stores: readonly DeclaredScopeStore[];
  }): Promise<{ binding: string; kind: string; tables: ScopeDumpTable[] }[]>;
  importStores(input: {
    tenantId: string;
    scopeId: string;
    vertical: string;
    stores: readonly { binding: string; kind: string; tables: ScopeDumpTable[] }[];
  }): Promise<void>;
  eraseSubject(input: {
    tenantId: string;
    scopeId: string;
    vertical: string;
    subjectId: string;
    stores: readonly DeclaredScopeStore[];
  }): Promise<{ binding: string; erased: number }[]>;
  wipeStores(input: {
    tenantId: string;
    scopeId: string;
    vertical: string;
    stores: readonly DeclaredScopeStore[];
  }): Promise<void>;
  sizeStores(input: {
    tenantId: string;
    scopeId: string;
    vertical: string;
    stores: readonly DeclaredScopeStore[];
  }): Promise<{ binding: string; bytes: number }[]>;
}

/** Bindings a version manifest declares. Missing JSON is none. Unreadable JSON fails closed. */
export function declaredStoresOf(manifestJson: string | null): DeclaredScopeStore[] {
  if (!manifestJson) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(manifestJson);
  } catch {
    throw new ControlPlaneError(503, 'scope store declarations could not be read');
  }
  const parsed = storedDeployManifest.safeParse(raw);
  if (!parsed.success) {
    throw new ControlPlaneError(503, 'scope store declarations could not be read');
  }
  return parsed.data.scopeStores;
}

/**
 * The version a scope's deployment runs, read once (#2207, L14). A scope with a serving pin runs
 * the serving pointer's version when the pointer's ref is its pin, and an unknown one otherwise;
 * a scope with no pin runs its bound version. `servingPointer` is the pointer as read, for a scope
 * with a pin: the pair a subject-erasure claim requires to still hold (#2285). A pointer that
 * cannot be read refuses (503): neither the version nor the fence can be named.
 */
export interface RunningVersion {
  readonly versionId: string | null;
  readonly servingPointer?: { ref: string; versionId: string } | null;
}

export async function runningVersionOf(
  admin: Pick<HostAdmin, 'verticalServing'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'vertical' | 'verticalVersionId' | 'servingRef'>,
): Promise<RunningVersion> {
  if (!scope.vertical || !scope.servingRef) return { versionId: scope.verticalVersionId };
  let pointer: Awaited<ReturnType<HostAdmin['verticalServing']>>;
  try {
    pointer = await admin.verticalServing(actor, scope.vertical);
  } catch {
    throw new ControlPlaneError(503, `the serving pointer of '${scope.vertical}' could not be read`);
  }
  const servingPointer = pointer ? { ref: pointer.ref, versionId: pointer.versionId } : null;
  return { versionId: servingPointer?.ref === scope.servingRef ? servingPointer.versionId : null, servingPointer };
}

/**
 * Stop the router serving a scope, before its stores are wiped (#2285, L6). The router admits a
 * scope only while one of its hostnames is `active`, and it reads that row on every request, so
 * unbinding is immediate. Unbind is idempotent: a retry after a failed wipe finds nothing left
 * to remove. A hostname set merely non-active would not hold — the issuance reconcile heals a
 * platform hostname back to `active`.
 */
export async function unrouteScope(
  admin: Pick<HostAdmin, 'listHostnames' | 'unbindHostname'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'tenantId' | 'id'>,
): Promise<void> {
  // Every page: an unbind deletes the row, so each read starts again from the first hostname left.
  // A row still listed after its unbind would loop forever, so it refuses instead.
  const unbound = new Set<string>();
  for (;;) {
    const page = await admin.listHostnames(actor, { tenantId: scope.tenantId, scopeId: scope.id, limit: LIST_PAGE_MAX });
    if (page.length === 0) return;
    for (const { hostname } of page) {
      if (unbound.has(hostname)) throw new Error(`hostname '${hostname}' is still bound after its unbind`);
      // Only while the row still names this scope: a name rebound elsewhere since the list stays bound.
      await admin.unbindHostname(actor, hostname, { tenantId: scope.tenantId, scopeId: scope.id });
      unbound.add(hostname);
    }
  }
}

/**
 * The scope stores of the version a scope's deployment runs (#2207). A scope on its vertical's
 * serving pin runs the serving pointer's version, and any other scope its bound version; this
 * is the version the router reads a scope's stores from (`READ_ROUTE_SQL`), and the one a restore
 * may import into (L8). The lifecycle reaches more: `scopeStoresOf`. Provisioning sets the
 * serving pin and no bound version, so reading the bound version alone answers "no store" for an
 * ordinary install whose store the router serves. A pin that names another script than the
 * pointer's is unknown, as #2242's erasure gate has it.
 *
 * The gate is `mayHoldScopeStores`: with no kind registered nothing can hold a store, and the
 * answer is none. Otherwise a version that cannot be named, a manifest that cannot be read, or one
 * the gate says may hold a store without naming it refuses (503), rather than let a backup, a
 * wipe, a replay or an erasure skip a store that may hold data.
 *
 * `running` is a resolution the caller already holds (`runningVersionOf`), so a caller that fences
 * on the version reads it once and judges the stores against the same read.
 */
export async function runningVersionStoresOf(
  admin: Pick<HostAdmin, 'verticalServing' | 'versionManifest'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'id' | 'vertical' | 'verticalVersionId' | 'servingRef'>,
  kinds: readonly StoreKindRegistration[] = STORE_KINDS,
  running?: RunningVersion,
): Promise<DeclaredScopeStore[]> {
  if (!scope.vertical || !mayHoldScopeStores(undefined, kinds)) return [];
  const { versionId } = running ?? await runningVersionOf(admin, actor, scope);
  const manifestJson = versionId
    ? await admin.versionManifest(actor, scope.vertical, versionId).catch(() => undefined)
    : undefined;
  if (!mayHoldScopeStores(manifestJson, kinds)) return [];
  const declared = typeof manifestJson === 'string' && scopeStoresDeclaredIn(manifestJson) ? declaredStoresOf(manifestJson) : [];
  if (declared.length > 0) return declared;
  throw new ControlPlaneError(503, `scope ${scope.id} may hold scope stores, and the version it runs cannot say which`);
}

/**
 * What the lifecycle reaches for a scope (#2286, L17): the running version's stores
 * (`runningVersionStoresOf`, which still fails closed first), and every binding any version of its
 * vertical has declared (`HostAdmin.verticalScopeStores`, read by its keys). Export, wipe, erasure
 * and the meter reach `all`, so an object under a binding a later version dropped is still
 * reached. A restore imports only into `running` (L8).
 *
 * A binding keeps its kind for the life of the vertical, since publish refuses a re-kind; a
 * running version whose kind disagrees with the record, or a record that cannot be read,
 * refuses (503).
 */
export async function scopeStoreReachOf(
  admin: Pick<HostAdmin, 'verticalServing' | 'versionManifest' | 'verticalScopeStores'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'id' | 'vertical' | 'verticalVersionId' | 'servingRef'>,
  kinds: readonly StoreKindRegistration[] = STORE_KINDS,
  running?: RunningVersion,
): Promise<{ running: DeclaredScopeStore[]; all: DeclaredScopeStore[] }> {
  const current = await runningVersionStoresOf(admin, actor, scope, kinds, running);
  if (!scope.vertical || !mayHoldScopeStores(undefined, kinds)) return { running: current, all: current };
  let declared: readonly DeclaredScopeStore[];
  try {
    declared = await admin.verticalScopeStores(actor, scope.vertical);
  } catch {
    throw new ControlPlaneError(503, `the scope stores '${scope.vertical}' has declared could not be read`);
  }
  const all = new Map(declared.map((store) => [store.binding, store.kind]));
  for (const store of current) {
    const kind = all.get(store.binding);
    if (kind !== undefined && kind !== store.kind) {
      throw new ControlPlaneError(503, `scope store '${store.binding}' is declared as both '${kind}' and '${store.kind}'`);
    }
    all.set(store.binding, store.kind);
  }
  return { running: current, all: [...all].map(([binding, kind]) => ({ binding, kind })) };
}

/** `scopeStoreReachOf`'s `all`: every store the lifecycle reaches for a scope (#2286). */
export async function scopeStoresOf(
  admin: Pick<HostAdmin, 'verticalServing' | 'versionManifest' | 'verticalScopeStores'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'id' | 'vertical' | 'verticalVersionId' | 'servingRef'>,
  kinds: readonly StoreKindRegistration[] = STORE_KINDS,
  running?: RunningVersion,
): Promise<DeclaredScopeStore[]> {
  return (await scopeStoreReachOf(admin, actor, scope, kinds, running)).all;
}

function asControlPlane(error: unknown): never {
  if (error instanceof StoreError) {
    throw new ControlPlaneError(error.storeStatus, error.message);
  }
  throw error;
}

/** Sign the envelope and POST the reserved operation at that kind's script. */
export async function callPlatformScopeStore(
  dispatch: PlatformScopeStoreDispatch,
  target: PlatformScopeStoreTarget,
  operation: ReservedStoreOperation,
  input?: unknown,
): Promise<unknown> {
  if (!dispatch.platformKey) {
    throw new ControlPlaneError(503, 'this control plane holds no scope-store key');
  }
  try {
    return await callReservedStoreOperation(async (request) => {
      const objectName = scopeStoreObjectName(target.tenantId, target.vertical, target.scopeId, target.binding);
      const scriptName = scopeStoreScriptName(target.vertical, target.kind);
      const body = JSON.stringify({ ...request, objectName });
      let issued;
      try {
        issued = await issueScopeStoreEnvelope({
          privateKey: dispatch.platformKey,
          aud: 'platform',
          script: scriptName,
          name: objectName,
          op: request.operation,
          body,
        });
      } catch (error) {
        if (!(error instanceof ScopeStoreKeyError)) throw error;
        // Set but unusable, e.g. a raw key where PKCS8 belongs. The message never carries the key.
        console.warn(`scope store call refused: STORE_PLATFORM_KEY is set but unusable (${error.message})`);
        throw new ControlPlaneError(503, 'this control plane holds no usable scope-store key');
      }
      const response = await dispatch.fetch(
        scriptName,
        new Request('https://scope-store/invoke', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SCOPE_STORE_ENVELOPE_HEADER]: issued.header,
            [SCOPE_STORE_SIGNATURE_HEADER]: issued.signature,
          },
          body,
        }),
      );
      try {
        return await response.json();
      } catch {
        return null;
      }
    }, operation, input);
  } catch (error) {
    asControlPlane(error);
  }
}

/** The five reserved operations, one call per declared binding. */
export function platformScopeStoresFor(dispatch: PlatformScopeStoreDispatch): PlatformScopeStores {
  const call = (target: PlatformScopeStoreTarget, operation: ReservedStoreOperation, input?: unknown) =>
    callPlatformScopeStore(dispatch, target, operation, input);
  return {
    async exportStores({ tenantId, scopeId, vertical, stores }) {
      const exported = [];
      for (const store of stores) {
        const { tables } = storeExportResult.parse(
          await call({ ...store, tenantId, scopeId, vertical }, 'substrat.export'),
        );
        exported.push({ binding: store.binding, kind: store.kind, tables });
      }
      return exported;
    },
    async importStores({ tenantId, scopeId, vertical, stores }) {
      for (const store of stores) {
        await call({ ...store, tenantId, scopeId, vertical }, 'substrat.import', { tables: store.tables });
      }
    },
    async eraseSubject({ tenantId, scopeId, vertical, subjectId, stores }) {
      const erased = [];
      for (const store of stores) {
        const { erased: count } = storeEraseResult.parse(
          await call({ ...store, tenantId, scopeId, vertical }, 'substrat.erase', { subjectId }),
        );
        erased.push({ binding: store.binding, erased: count });
      }
      return erased;
    },
    async wipeStores({ tenantId, scopeId, vertical, stores }) {
      for (const store of stores) {
        await call({ ...store, tenantId, scopeId, vertical }, 'substrat.wipe');
      }
    },
    async sizeStores({ tenantId, scopeId, vertical, stores }) {
      const sizes = [];
      for (const store of stores) {
        const { bytes } = storeSizeResult.parse(
          await call({ ...store, tenantId, scopeId, vertical }, 'substrat.size'),
        );
        sizes.push({ binding: store.binding, bytes });
      }
      return sizes;
    },
  };
}

/**
 * The caller of a hosted control plane that has no route to the store scripts (#2207): every
 * call is refused (503). A hosted control plane always passes a caller, this one included, so
 * a missing route refuses the backup, wipe or erasure that needs a store instead of skipping it.
 */
export function unreachablePlatformScopeStores(): PlatformScopeStores {
  const refuse = async (): Promise<never> => {
    throw new ControlPlaneError(503, 'this control plane cannot reach scope stores');
  };
  return { exportStores: refuse, importStores: refuse, eraseSubject: refuse, wipeStores: refuse, sizeStores: refuse };
}
