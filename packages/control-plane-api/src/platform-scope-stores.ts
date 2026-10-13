import {
  scopeStoreObjectName,
  scopeStoreScriptName,
  signScopeStoreName,
  storeEraseResult,
  storeExportResult,
  storeSizeResult,
  StoreError,
  type ReservedStoreOperation,
  type ScopeDumpTable,
} from '@substrat-run/contracts';
import { callReservedStoreOperation } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { storedDeployManifest } from './deploy.js';

/**
 * A reserved scope-store call, made by the control plane straight at the store
 * script (#2207). The vertical is not on this path: it holds neither the
 * namespace nor the key. The key signs the object name here, and the audience
 * is `platform`, which is the only audience a `substrat.*` operation accepts.
 */
export interface PlatformScopeStoreDispatch {
  readonly hmacKey: string;
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

function asControlPlane(error: unknown): never {
  if (error instanceof StoreError) {
    throw new ControlPlaneError(error.storeStatus, error.message);
  }
  throw error;
}

/** Sign `objectName` and POST the reserved operation at that kind's script. */
export async function callPlatformScopeStore(
  dispatch: PlatformScopeStoreDispatch,
  target: PlatformScopeStoreTarget,
  operation: ReservedStoreOperation,
  input?: unknown,
): Promise<unknown> {
  if (!dispatch.hmacKey) {
    throw new ControlPlaneError(503, 'this control plane holds no scope-store key');
  }
  try {
    return await callReservedStoreOperation(async (request) => {
      const objectName = scopeStoreObjectName(target.tenantId, target.vertical, target.scopeId, target.binding);
      const mac = await signScopeStoreName(dispatch.hmacKey, objectName);
      const response = await dispatch.fetch(
        scopeStoreScriptName(target.vertical, target.kind),
        new Request('https://scope-store/invoke', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-substrat-store-mac': mac,
            'x-substrat-store-audience': 'platform',
          },
          body: JSON.stringify({ ...request, objectName }),
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
