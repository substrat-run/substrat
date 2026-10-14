import type { LakeQueryEngine } from './lake-gateway.js';

export interface R2SqlEngineOptions {
  accountId: string;
  /** The lake's bucket — `LAKE.bucket` in `scripts/lake-provision.mjs`. */
  bucket: string;
  /** An R2 "Admin Read only" token scoped to that bucket (`secrets/README.md`). */
  token: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/** A query R2 SQL refused or could not run. The message is Cloudflare's, never a row. */
export class LakeQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LakeQueryError';
  }
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
  const url =
    `https://api.sql.cloudflarestorage.com/api/v1/accounts/${encodeURIComponent(opts.accountId)}` +
    `/r2-sql/query/${encodeURIComponent(opts.bucket)}`;
  return {
    async query(sql) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: sql }),
      });
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        errors?: { message?: string }[];
        result?: { rows?: unknown };
      } | null;
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
