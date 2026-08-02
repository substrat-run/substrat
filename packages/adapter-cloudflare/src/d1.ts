import type { ConnectorResponse, FetchLike, SqlValue, TenantRelationalStore } from '@substrat-run/kernel';

/**
 * The live D1 side of per-tenant relational stores (#301, PR-2): a minimal client over
 * Cloudflare's D1 REST API — create, delete, query. Pure web-standard `fetch`, injected
 * for tests, holding the PLATFORM's Cloudflare credential (D-34: the builder never holds
 * one; the vertical is HANDED a store, it never mints or names a database id).
 *
 * This is the control plane's reach into a tenant store: minting at provision
 * (`CloudflareScopeHost.provisionTenantStore`) and out-of-band SQL (`openTenantStore`) —
 * driving a store's migration journal externally, ops inspection, tests. The REQUEST-TIME
 * reach is not HTTP at all: the serving script carries a real `d1` binding per tenant
 * store, named by `tenantStoreBindingName` (contracts), attached by the control plane at
 * provision and re-derived from the ledger on every serving upload.
 */
export interface D1TenantStores {
  /**
   * Create a database, or resolve an existing one of the same name — Cloudflare rejects a
   * duplicate name, and the retry path (a provision that crashed between create and the
   * ledger write) must converge on the SAME database, never mint a second. Returns the
   * platform-minted database id (the opaque `ref` the handle carries).
   */
  create(name: string): Promise<string>;
  /** Delete by database id. Idempotent: an already-gone database is a success. */
  remove(ref: string): Promise<void>;
  /** Run ONE statement against a database over the D1 HTTP API. */
  query(
    ref: string,
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<{ results: unknown[]; changes: number }>;
}

export interface D1TenantStoresOptions {
  accountId: string;
  /** A Cloudflare API token with D1 read/write on the account. Platform-held. */
  apiToken: string;
  /** Injectable for tests and dev; defaults to the runtime's `fetch`. */
  fetch?: FetchLike;
}

/** Bound an untrusted upstream body for an error message, marking the cut (#307). */
function bounded(body: string, max = 2000): string {
  return body.length <= max ? body : `${body.slice(0, max)} … [truncated, ${body.length - max} chars omitted]`;
}

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
}

/**
 * The deterministic D1 database NAME for a tenant store — informational (the ledger's
 * `ref`, a database id, is the source of truth), but deterministic on purpose: a retried
 * provision that crashed after `create` recreates the same name, collides, and resolves
 * to the same database instead of minting an orphan. Lowercased to D1's name alphabet;
 * over-long inputs keep a stable hash tail so the name stays unique AND deterministic.
 */
export async function tenantStoreDatabaseName(
  tenantId: string,
  vertical: string,
  binding: string,
): Promise<string> {
  const raw = `tstore-${vertical}-${binding}-${tenantId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-');
  if (raw.length <= 63) return raw;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const tail = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${raw.slice(0, 46)}-${tail}`;
}

export function createD1TenantStores(opts: D1TenantStoresOptions): D1TenantStores {
  const fetchImpl: FetchLike =
    opts.fetch ?? ((input, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(input, init));
  const base = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/d1/database`;
  const auth = { authorization: `Bearer ${opts.apiToken}` };

  const readEnvelope = async <T>(res: ConnectorResponse, what: string): Promise<CfEnvelope<T>> => {
    const text = await res.text().catch(() => '');
    let env: CfEnvelope<T> | undefined;
    try {
      env = text ? (JSON.parse(text) as CfEnvelope<T>) : undefined;
    } catch {
      // Non-JSON upstream body — fall through to the status-based error below.
    }
    if (!res.ok || !env?.success) {
      const msg = env?.errors?.map((e) => e.message).filter(Boolean).join('; ') || bounded(text);
      const err = new Error(`Cloudflare ${what} failed (${res.status}): ${msg || 'unknown error'}`);
      (err as { status?: number }).status = res.status;
      throw err;
    }
    return env;
  };

  const findByName = async (name: string): Promise<string | undefined> => {
    // `?name=` is a substring filter upstream — match EXACTLY, or a provision could
    // adopt a different tenant's database whose name merely contains this one.
    const res = await fetchImpl(`${base}?name=${encodeURIComponent(name)}&per_page=100`, {
      headers: auth,
    });
    const env = await readEnvelope<{ uuid: string; name: string }[]>(res, 'D1 list');
    return env.result?.find((d) => d.name === name)?.uuid;
  };

  return {
    async create(name) {
      const res = await fetchImpl(base, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        // A name that already exists is the crashed-retry path converging, not a failure:
        // resolve it to the existing database. Anything unresolvable stays an error.
        const existing = await findByName(name).catch(() => undefined);
        if (existing) return existing;
        const text = await res.text().catch(() => '');
        throw new Error(`Cloudflare D1 create failed (${res.status}) for '${name}': ${bounded(text)}`);
      }
      const env = await readEnvelope<{ uuid: string }>(res, 'D1 create');
      if (!env.result?.uuid) throw new Error(`Cloudflare D1 create for '${name}' returned no database id`);
      return env.result.uuid;
    },

    async remove(ref) {
      const res = await fetchImpl(`${base}/${encodeURIComponent(ref)}`, {
        method: 'DELETE',
        headers: auth,
      });
      if (res.status === 404) return; // already gone — the outcome, not an error
      await readEnvelope(res, 'D1 delete');
    },

    async query(ref, sql, params = []) {
      // The HTTP API carries params as JSON — a blob or bigint cannot ride it. Refuse
      // loudly rather than silently coercing (this path is control-plane SQL: migrations,
      // ops reads; request-time blob traffic belongs on the worker's real D1 binding).
      for (const p of params) {
        if (p instanceof Uint8Array || typeof p === 'bigint') {
          throw new Error(
            `unsupported parameter type for the D1 HTTP query path (${typeof p === 'bigint' ? 'bigint' : 'blob'}) — ` +
              `use the worker-side D1 binding for blob/bigint traffic`,
          );
        }
      }
      const res = await fetchImpl(`${base}/${encodeURIComponent(ref)}/query`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ sql, params }),
      });
      const env = await readEnvelope<{ results?: unknown[]; meta?: { changes?: number } }[]>(
        res,
        'D1 query',
      );
      const first = env.result?.[0];
      return { results: first?.results ?? [], changes: first?.meta?.changes ?? 0 };
    },
  };
}

/** The minimal slice of a worker `D1Database` binding this adapter relies on. */
interface D1BindingLike {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all(): Promise<{ results?: unknown[]; meta?: { changes?: number } }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

/**
 * The WORKER-side open (#301): wrap the tenant's real `d1` binding — looked up as
 * `env[tenantStoreBindingName(handle.binding, tenantId)]` — in the substrate's
 * `TenantRelationalStore` shape, so a vertical's store code reads identically against
 * live D1 in the worker and a `.sqlite` file on the pure adapter. `native` is the raw
 * `D1Database`, for a library (e.g. Better Auth's Kysely dialect) that wants the driver.
 */
export function d1TenantRelationalStore(db: unknown): TenantRelationalStore {
  const d1 = db as D1BindingLike;
  return {
    query: async <T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> => {
      const out = await d1.prepare(sql).bind(...(params as unknown[])).all();
      return (out.results ?? []) as T[];
    },
    exec: async (sql: string, params: readonly SqlValue[] = []) => {
      const out = await d1.prepare(sql).bind(...(params as unknown[])).run();
      return { changes: out.meta?.changes ?? 0 };
    },
    native: db,
  };
}
