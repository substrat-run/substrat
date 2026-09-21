import {
  STORAGE_EXCLUSIONS,
  storageMeterReading,
  type ScopeId,
  type ScopeStatus,
  type ScopeStorageReading,
  type StorageMeterReading,
  type TenantId,
} from '@substrat-run/contracts';

/**
 * The on-demand storage reading (#1524), without any HTTP around it.
 *
 * Every scope it reads is a Durable Object it wakes, so every limit here is a cost
 * limit. The directory listing that supplies `scopes` is a cheap read and is taken
 * whole, which keeps `total` honest. Only the wakes are bounded:
 * - **per page**: at most `limit` scopes, capped at `STORAGE_PAGE_MAX`. A tenant with
 *   thousands of scopes is read a page at a time, and each page is asked for by a person.
 * - **in flight**: at most `STORAGE_READ_CONCURRENCY` reads run at once within a page.
 */
export const STORAGE_PAGE_DEFAULT = 50;
export const STORAGE_PAGE_MAX = 200;
export const STORAGE_READ_CONCURRENCY = 8;

export interface StorageScope {
  scopeId: ScopeId;
  status: ScopeStatus;
}

export interface StoragePageInput<S extends StorageScope> {
  tenantId: TenantId;
  readAt: string;
  /** Every scope row the tenant has, in any order. Reaped rows are counted, never read. */
  scopes: readonly S[];
  /** Resume after this scope id, the previous page's `nextCursor`. */
  cursor?: ScopeId;
  limit?: number;
  concurrency?: number;
  /** One scope's database size. A throw is recorded against that scope, never the page. */
  read: (scope: S) => Promise<number>;
}

export async function readStoragePage<S extends StorageScope>(
  input: StoragePageInput<S>,
): Promise<StorageMeterReading> {
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? STORAGE_PAGE_DEFAULT), STORAGE_PAGE_MAX));
  const concurrency = Math.max(1, Math.min(Math.floor(input.concurrency ?? STORAGE_READ_CONCURRENCY), STORAGE_READ_CONCURRENCY));

  const readable = input.scopes
    .filter((s) => s.status !== 'reaped')
    .sort((a, b) => (a.scopeId < b.scopeId ? -1 : a.scopeId > b.scopeId ? 1 : 0));
  const reaped = input.scopes.length - readable.length;
  const after = input.cursor;
  const remaining = after === undefined ? readable : readable.filter((s) => s.scopeId > after);
  const page = remaining.slice(0, limit);
  const nextCursor = remaining.length > page.length ? page[page.length - 1]!.scopeId : null;

  const results: ScopeStorageReading[] = new Array(page.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < page.length; i = next++) {
      const scope = page[i]!;
      try {
        const bytes = await input.read(scope);
        if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`not a size: ${String(bytes)}`);
        results[i] = { scopeId: scope.scopeId, status: scope.status, bytes };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        results[i] = { scopeId: scope.scopeId, status: scope.status, bytes: null, error: message || 'read failed' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, page.length) }, worker));

  let bytes = 0;
  let failed = 0;
  for (const r of results) {
    if (r.bytes === null) failed += 1;
    else bytes += r.bytes;
  }
  return storageMeterReading.parse({
    tenantId: input.tenantId,
    readAt: input.readAt,
    basis: 'scope-databases',
    excluded: [...STORAGE_EXCLUSIONS],
    bytes,
    scopes: results,
    read: results.length - failed,
    failed,
    total: readable.length,
    reaped,
    nextCursor,
    // The one field that licenses the word "total": this page is the whole tenant, and
    // every read in it answered.
    complete: after === undefined && nextCursor === null && failed === 0,
  });
}
