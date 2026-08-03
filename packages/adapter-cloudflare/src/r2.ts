import type { ConnectorResponse, FetchLike, TenantBlobStore } from '@substrat-run/kernel';

/**
 * The live R2 side of per-tenant blob stores (#473): a minimal client over Cloudflare's
 * R2 REST API — create and delete buckets. Pure web-standard `fetch`, injected for tests,
 * holding the PLATFORM's Cloudflare credential (D-34: the builder never holds one; the
 * vertical is HANDED a store, it never mints or names a bucket).
 *
 * This is the control plane's reach only. The REQUEST-TIME reach is not HTTP at all: the
 * serving script carries a real `r2_bucket` binding per blob store, named by
 * `blobStoreBindingName` (contracts), attached by the control plane at provision and
 * re-derived from the ledger on every serving upload — exactly the tenant-store model
 * (#301). Object reads/writes happen exclusively through that binding, in the worker,
 * behind the kernel's attachment surface.
 */
export interface R2BlobStores {
  /**
   * Create a bucket, or resolve an existing one of the same name — the retry path (a
   * provision that crashed between create and the ledger write) must converge on the
   * SAME bucket, never mint a second. Returns the bucket name (the opaque `ref` the
   * handle carries — R2 buckets are addressed by name, there is no separate id).
   */
  create(name: string): Promise<string>;
  /** Delete by bucket name. Idempotent: an already-gone bucket is a success. */
  remove(ref: string): Promise<void>;
}

export interface R2BlobStoresOptions {
  accountId: string;
  /** A Cloudflare API token with Workers R2 Storage write on the account. Platform-held. */
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
 * The deterministic R2 bucket NAME for a blob store. Unlike D1 (where the ledger's ref is
 * a CF-assigned id), R2 addresses buckets by name — so the deterministic name IS the ref,
 * and determinism is what makes a crashed retry converge: recreate the same name, get
 * told it exists, resolve to it. Lowercased to R2's name alphabet; over-long inputs keep
 * a stable hash tail so the name stays unique AND deterministic within R2's 63-char cap.
 */
export async function blobStoreBucketName(
  tenantId: string,
  vertical: string,
  binding: string,
): Promise<string> {
  const raw = `blob-${vertical}-${binding}-${tenantId}`
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

export function createR2BlobStores(opts: R2BlobStoresOptions): R2BlobStores {
  const fetchImpl: FetchLike =
    opts.fetch ?? ((input, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(input, init));
  const base = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/r2/buckets`;
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

  return {
    async create(name) {
      const res = await fetchImpl(base, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        // A name that already exists is the crashed-retry path converging, not a failure.
        // R2 signals it with 409/10004; confirm the bucket is really there rather than
        // trusting the code, so an unrelated 409 stays an error.
        if (res.status === 409) {
          const probe = await fetchImpl(`${base}/${encodeURIComponent(name)}`, { headers: auth });
          if (probe.ok) {
            await probe.text().catch(() => '');
            return name;
          }
        }
        await readEnvelope(res, 'R2 bucket create'); // throws with the upstream detail
      } else {
        await readEnvelope(res, 'R2 bucket create');
      }
      return name;
    },
    async remove(ref) {
      const res = await fetchImpl(`${base}/${encodeURIComponent(ref)}`, {
        method: 'DELETE',
        headers: auth,
      });
      // Idempotent: an already-gone bucket is a success.
      if (res.status === 404) {
        await res.text().catch(() => '');
        return;
      }
      await readEnvelope(res, 'R2 bucket delete');
    },
  };
}

/** The minimal slice of a worker `R2Bucket` binding this adapter relies on. */
interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string };
  } | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * The WORKER-side open (#473): wrap the tenant's real `r2_bucket` binding — looked up as
 * `env[blobStoreBindingName(binding, tenantId)]` — in the kernel's `TenantBlobStore`
 * shape, so the attachment surface reads identically against live R2 in the worker and a
 * per-tenant directory on the pure adapter.
 */
export function r2TenantBlobStore(bucket: unknown): TenantBlobStore {
  const r2 = bucket as R2BucketLike;
  return {
    put: async (key, body, opts) => {
      await r2.put(key, body, opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined);
    },
    get: async (key) => {
      const obj = await r2.get(key);
      if (!obj) return null;
      const body = new Uint8Array(await obj.arrayBuffer());
      const contentType = obj.httpMetadata?.contentType;
      return contentType !== undefined ? { body, contentType } : { body };
    },
    delete: async (key) => {
      await r2.delete(key);
    },
    list: async (prefix) => {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await r2.list({ prefix, ...(cursor ? { cursor } : {}) });
        keys.push(...page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return keys.sort();
    },
  };
}
