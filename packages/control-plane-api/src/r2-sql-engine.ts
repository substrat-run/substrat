import type { LakeQueryEngine } from './lake-gateway.js';

export interface R2SqlEngineOptions {
  accountId: string;
  /** The lake's bucket — `LAKE.bucket` in `scripts/lake-provision.mjs`. */
  bucket: string;
  /** An R2 "Admin Read only" token scoped to that bucket (`secrets/README.md`). */
  token: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; `LAKE_QUERY_TIMEOUT_MS` otherwise. */
  timeoutMs?: number;
  /** Injected for tests; `LAKE_RESPONSE_MAX_BYTES` otherwise. */
  maxResponseBytes?: number;
}

/**
 * How long one lake query may take, request and body together. R2 SQL is open beta and
 * names heavy queries as a timeout risk; without a bound, a stalled answer holds the
 * control-plane request open until the platform cuts it, and the caller gets a generic
 * failure instead of the gateway's 502.
 */
export const LAKE_QUERY_TIMEOUT_MS = 30_000;

/**
 * The largest answer the engine will read. A page is at most `LAKE_EVENTS_LIMIT_MAX` + 1
 * envelope rows, around a kilobyte each, so 4 MiB is far above any honest answer. Anything
 * bigger is refused before it is parsed, never parsed and then trimmed.
 */
export const LAKE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

/** A query R2 SQL refused or could not run. The message is Cloudflare's, never a row. */
export class LakeQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LakeQueryError';
  }
}

/**
 * The response body as text, refused once it passes `maxBytes`: up front when the
 * `content-length` says so, and while streaming when it does not (a chunked answer has none),
 * cancelling the rest rather than reading it.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new LakeQueryError(`R2 SQL answer exceeds ${maxBytes} bytes; refused before parsing`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * The R2 SQL implementation of `LakeQueryEngine` — the Cloudflare row of kernel-design's
 * adapter table ("Query gateway engine | R2 SQL").
 *
 * **Unverified against the real lake.** The endpoint and the response envelope below are
 * written from Cloudflare's documented shape (`POST …/r2-sql/query/<bucket>` with
 * `{ query }`, answering `{ success, errors, result: { rows } }`), and no run in this repo
 * has exercised them. Until a human has, the control plane is deployed without the bucket
 * var that turns this on, and the gateway's route answers 501.
 *
 * Read-only by its credential, not by its caller: the token is "Admin Read only", which is
 * read-only on the catalog AND on storage, so even a statement that tried to write could not.
 */
export function createR2SqlEngine(opts: R2SqlEngineOptions): LakeQueryEngine {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LAKE_QUERY_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? LAKE_RESPONSE_MAX_BYTES;
  const url =
    `https://api.sql.cloudflarestorage.com/api/v1/accounts/${encodeURIComponent(opts.accountId)}` +
    `/r2-sql/query/${encodeURIComponent(opts.bucket)}`;
  return {
    async query(sql) {
      let res: Response;
      let text: string;
      try {
        // One signal for the request AND the body read: a server that answers its headers
        // promptly and then stalls the body is the same stall.
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query: sql }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await readCapped(res, maxBytes);
      } catch (err) {
        if (err instanceof LakeQueryError) throw err;
        const name = (err as { name?: string } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new LakeQueryError(`R2 SQL query timed out after ${timeoutMs} ms`);
        }
        throw new LakeQueryError(`R2 SQL request failed: ${(err as Error)?.message ?? String(err)}`);
      }
      let body: { success?: boolean; errors?: { message?: string }[]; result?: { rows?: unknown } } | null;
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        body = null;
      }
      if (!res.ok || !body || body.success === false) {
        const reason = body?.errors?.map((e) => e.message).filter(Boolean).join('; ') || 'no error detail';
        throw new LakeQueryError(`R2 SQL query failed (${res.status}): ${reason}`);
      }
      const rows = body.result?.rows;
      if (!Array.isArray(rows) || !rows.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r))) {
        // A shape this client does not know is refused, not guessed at: the gateway's
        // tenant check reads `tenant_id` off each row, and a row it cannot read is not one
        // it can vouch for.
        throw new LakeQueryError('R2 SQL answered without a rows array of objects');
      }
      return rows as Record<string, unknown>[];
    },
  };
}
