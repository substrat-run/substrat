import {
  LIST_PAGE_MAX,
  mayHoldScopeStores,
  scopeStoresDeclaredIn,
  STORE_KINDS,
  issueScopeStoreEnvelope,
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

/** The same bindings, whatever order the two manifests listed them in. */
export function sameDeclaredStores(
  left: readonly DeclaredScopeStore[],
  right: readonly DeclaredScopeStore[],
): boolean {
  const key = (stores: readonly DeclaredScopeStore[]) =>
    stores.map((store) => `${store.binding}\0${store.kind}`).sort().join('\n');
  return key(left) === key(right);
}

/**
 * The version a scope pinned to its vertical's serving script is running (#2285). Null when the
 * scope is not on that pin, or the pin names a script the pointer no longer serves: the bound
 * version decides then, and a subject-erasure claim does not fence the pointer.
 */
export async function pinnedServingVersionId(
  admin: Pick<HostAdmin, 'verticalServing'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'vertical' | 'servingRef'>,
): Promise<string | null> {
  if (!scope.vertical || !scope.servingRef) return null;
  const pointer = await admin.verticalServing(actor, scope.vertical).catch(() => null);
  return pointer?.ref === scope.servingRef ? pointer.versionId : null;
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
  const hostnames = await admin.listHostnames(actor, { tenantId: scope.tenantId, scopeId: scope.id });
  for (const hostname of hostnames) {
    await admin.unbindHostname(actor, hostname.hostname);
  }
}

/**
 * The stores of the version a scope's deployment runs (#2207). A scope on its vertical's serving
 * pin runs the serving pointer's version, and any other scope its bound version; this is the
 * version the router reads (`READ_ROUTE_SQL`) and the one a restore may import into (L8).
 * Provisioning sets the serving pin and no bound version, so reading the bound version alone
 * answers "no store" for an ordinary install whose store the router serves. A pin that names
 * another script than the pointer's is unknown, as #2242's erasure gate has it.
 *
 * The gate is `mayHoldScopeStores`: with no kind registered nothing can hold a store, and the
 * answer is none. Otherwise a version that cannot be named, a manifest that cannot be read, or one
 * the gate says may hold a store without naming it refuses (503).
 */
export async function runningVersionStoresOf(
  admin: Pick<HostAdmin, 'verticalServing' | 'versionManifest'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'id' | 'vertical' | 'verticalVersionId' | 'servingRef'>,
  kinds: readonly StoreKindRegistration[] = STORE_KINDS,
): Promise<DeclaredScopeStore[]> {
  if (!scope.vertical || !mayHoldScopeStores(undefined, kinds)) return [];
  let versionId: string | null = scope.verticalVersionId;
  if (scope.servingRef) {
    const pointer = await admin.verticalServing(actor, scope.vertical).catch(() => null);
    versionId = pointer?.ref === scope.servingRef ? pointer.versionId : null;
  }
  const manifestJson = versionId
    ? await admin.versionManifest(actor, scope.vertical, versionId).catch(() => undefined)
    : undefined;
  if (!mayHoldScopeStores(manifestJson, kinds)) return [];
  const declared = typeof manifestJson === 'string' && scopeStoresDeclaredIn(manifestJson) ? declaredStoresOf(manifestJson) : [];
  if (declared.length > 0) return declared;
  throw new ControlPlaneError(503, `scope ${scope.id} may hold scope stores, and the version it runs cannot say which`);
}

/**
 * Every (binding, kind) any version of the scope's vertical has declared (#2286, L17), on top of
 * {@link runningVersionStoresOf}. Export, wipe, erasure and the meter reach a binding a later
 * version dropped. The running version is still resolved first, so an unknown one refuses before
 * the union is read. The same binding declared as two kinds, or a manifest that cannot be read,
 * refuses (503). A version with no manifest predates stores and adds none.
 *
 * Not the router's check and not a restore's import check. Those stay on the running version:
 * a vertical calls only what its current code declares, and a restore imports only what the
 * destination currently declares.
 */
export async function scopeStoresOf(
  admin: Pick<HostAdmin, 'verticalServing' | 'versionManifest' | 'listVersions'>,
  actor: PlatformActorId,
  scope: Pick<Scope, 'id' | 'vertical' | 'verticalVersionId' | 'servingRef'>,
  kinds: readonly StoreKindRegistration[] = STORE_KINDS,
): Promise<DeclaredScopeStore[]> {
  const current = await runningVersionStoresOf(admin, actor, scope, kinds);
  if (!scope.vertical || !mayHoldScopeStores(undefined, kinds)) return current;
  const union = new Map(current.map((store) => [store.binding, store.kind]));
  let cursor: string | undefined;
  for (;;) {
    const page = await admin.listVersions(actor, scope.vertical, {
      limit: LIST_PAGE_MAX,
      ...(cursor ? { cursor } : {}),
    });
    for (const version of page) {
      let manifestJson: string | null;
      try {
        manifestJson = await admin.versionManifest(actor, scope.vertical, version.id);
      } catch {
        throw new ControlPlaneError(503, 'scope store declarations could not be read');
      }
      if (manifestJson === null) continue;
      for (const store of declaredStoresOf(manifestJson)) {
        const previous = union.get(store.binding);
        if (previous !== undefined && previous !== store.kind) {
          throw new ControlPlaneError(
            503,
            `scope store '${store.binding}' is declared as both '${previous}' and '${store.kind}'`,
          );
        }
        union.set(store.binding, store.kind);
      }
    }
    const last = page.at(-1);
    if (page.length < LIST_PAGE_MAX || !last) break;
    cursor = last.id;
  }
  return [...union].map(([binding, kind]) => ({ binding, kind }));
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
      const body = JSON.stringify({ ...request, objectName });
      let issued;
      try {
        issued = await issueScopeStoreEnvelope({
          privateKey: dispatch.platformKey,
          aud: 'platform',
          name: objectName,
          op: request.operation,
          body,
        });
      } catch {
        throw new ControlPlaneError(503, 'this control plane holds no scope-store key');
      }
      const response = await dispatch.fetch(
        scopeStoreScriptName(target.vertical, target.kind),
        new Request('https://scope-store/invoke', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-substrat-store-envelope': issued.header,
            'x-substrat-store-signature': issued.signature,
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
