/**
 * The Cloudflare R2 implementation of the `ScopeBackupStore` seam (#493) — the platform's
 * own backup bucket, bound on the control-plane worker.
 *
 * Structurally typed against the binding (`R2BucketLike`) rather than importing a
 * Cloudflare SDK, the same way `adapter-cloudflare/src/r2.ts` wraps a tenant blob store:
 * this package stays SDK-free and the fake in tests is an object literal.
 *
 * One bucket, held by the PLATFORM, not by the tenant. A tenant-held bucket would be
 * deleted by the very teardown these copies exist to survive.
 */

import {
  directoryDump,
  scopeDump,
  type DirectoryBackup,
  type DirectoryDump,
  type ScopeBackup,
  type ScopeDump,
} from '@substrat-run/contracts';
import type { AccessLogSink } from '@substrat-run/kernel';
import type { DirectoryBackupStore, ScopeBackupStore } from './backups.js';

/** The minimal slice of a worker `R2Bucket` binding this store relies on. */
interface R2BucketLike {
  put(
    key: string,
    value: string | Uint8Array | ArrayBuffer,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    include?: ('customMetadata' | 'httpMetadata')[];
  }): Promise<{
    objects: { key: string; size: number; customMetadata?: Record<string, string> }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * Keys are `scopes/<tenantId>/<scopeId>/<capturedAt>.json`, so a scope's copies are one
 * prefix list and a tenant's are one level up. The scheme is private to this module —
 * callers address a backup by (tenant, scope, capturedAt) and never build a path.
 */
function backupKey(tenantId: string, scopeId: string, capturedAt: string): string {
  return `scopes/${tenantId}/${scopeId}/${capturedAt}.json`;
}

function scopePrefix(tenantId: string, scopeId: string): string {
  return `scopes/${tenantId}/${scopeId}/`;
}

export function createR2BackupStore(bucket: unknown): ScopeBackupStore {
  const r2 = bucket as R2BucketLike;
  return {
    async put({ vertical, dump }) {
      const body = JSON.stringify(dump);
      // Byte length, not string length: the size is meant to be the stored object's,
      // and a dump full of non-ASCII would otherwise under-report.
      const size = new TextEncoder().encode(body).length;
      const backup: ScopeBackup = {
        tenantId: dump.tenantId,
        scopeId: dump.scopeId,
        vertical,
        capturedAt: dump.capturedAt,
        size,
        tables: dump.tables.length,
      };
      await r2.put(backupKey(dump.tenantId, dump.scopeId, dump.capturedAt), body, {
        httpMetadata: { contentType: 'application/json' },
        // Mirrored into custom metadata so `list` can answer without fetching every
        // dump — a scope's backups are megabytes, its listing is a table row.
        customMetadata: {
          tenantId: backup.tenantId,
          scopeId: backup.scopeId,
          capturedAt: backup.capturedAt,
          tables: String(backup.tables),
          ...(vertical ? { vertical } : {}),
        },
      });
      return backup;
    },

    async list({ tenantId, scopeId }) {
      const prefix = scopePrefix(tenantId, scopeId);
      const out: ScopeBackup[] = [];
      let cursor: string | undefined;
      do {
        const page = await r2.list({
          prefix,
          include: ['customMetadata'],
          ...(cursor ? { cursor } : {}),
        });
        for (const o of page.objects) {
          const meta = o.customMetadata ?? {};
          // The key is the fallback address: an object written before the metadata
          // existed (or by a manual upload) still lists rather than vanishing.
          const capturedAt = meta.capturedAt ?? o.key.slice(prefix.length).replace(/\.json$/, '');
          out.push({
            tenantId,
            scopeId,
            vertical: meta.vertical ?? null,
            capturedAt,
            size: o.size,
            tables: meta.tables ? Number(meta.tables) : 0,
          });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      // Newest first. ISO 8601 sorts lexicographically, which is why `capturedAt` is
      // the key's last segment.
      return out.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
    },

    async get({ tenantId, scopeId, capturedAt }) {
      const obj = await r2.get(backupKey(tenantId, scopeId, capturedAt));
      if (!obj) return null;
      // Parsed through the contract on the way out: a corrupted or hand-edited object
      // fails HERE, loudly, rather than at the restore that trusted it.
      return scopeDump.parse(JSON.parse(await obj.text())) as ScopeDump;
    },
  };
}

/**
 * Keys are `directory/<capturedAt>.json` — one flat prefix, because there is exactly one
 * directory per deployment and `capturedAt` is a copy's whole address. Sharing a bucket
 * with the scope backups above is safe by construction: `scopes/` and `directory/` cannot
 * collide, and neither prefix is ever built by a caller.
 */
function directoryKey(capturedAt: string): string {
  return `directory/${capturedAt}.json`;
}

const DIRECTORY_PREFIX = 'directory/';

/**
 * The Cloudflare R2 implementation of `DirectoryBackupStore` (#40).
 *
 * Deliberately a separate factory over the SAME binding shape rather than a mode flag on
 * `createR2BackupStore`: the two stores answer different questions and only this one can
 * delete. A deployment may point them at one bucket or two — the prefixes keep them apart
 * either way, and pointing THIS one at a bucket in another account is the upgrade path
 * from "survives losing the directory" to "survives losing the account".
 */
export function createR2DirectoryBackupStore(bucket: unknown): DirectoryBackupStore {
  const r2 = bucket as R2BucketLike;
  return {
    async put({ dump }) {
      const body = JSON.stringify(dump);
      // Byte length, not string length — the size is the stored object's.
      const size = new TextEncoder().encode(body).length;
      const backup: DirectoryBackup = {
        capturedAt: dump.capturedAt,
        size,
        tables: dump.tables.length,
      };
      await r2.put(directoryKey(dump.capturedAt), body, {
        httpMetadata: { contentType: 'application/json' },
        // Mirrored into custom metadata so `list` answers without fetching every dump —
        // a directory copy is megabytes, its listing is a table row.
        customMetadata: {
          capturedAt: backup.capturedAt,
          tables: String(backup.tables),
        },
      });
      return backup;
    },

    async list() {
      const out: DirectoryBackup[] = [];
      let cursor: string | undefined;
      do {
        const page = await r2.list({
          prefix: DIRECTORY_PREFIX,
          include: ['customMetadata'],
          ...(cursor ? { cursor } : {}),
        });
        for (const o of page.objects) {
          const meta = o.customMetadata ?? {};
          // The key is the fallback address, as in the scope store: an object written
          // before the metadata existed still lists rather than vanishing.
          const capturedAt =
            meta.capturedAt ?? o.key.slice(DIRECTORY_PREFIX.length).replace(/\.json$/, '');
          out.push({
            capturedAt,
            size: o.size,
            tables: meta.tables ? Number(meta.tables) : 0,
          });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      // Newest first — ISO 8601 sorts lexicographically, which is why `capturedAt` is
      // the key's last segment. The daily-cadence guard reads element 0.
      return out.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
    },

    async get({ capturedAt }) {
      const obj = await r2.get(directoryKey(capturedAt));
      if (!obj) return null;
      // Parsed through the contract on the way out, so a corrupted object fails HERE
      // rather than half-way through the restore that trusted it.
      return directoryDump.parse(JSON.parse(await obj.text())) as DirectoryDump;
    },

    async delete({ capturedAt }) {
      await r2.delete(directoryKey(capturedAt));
    },
  };
}

/**
 * Keys are `access-log/<firstId>-<lastId>.ndjson` — the batch's own id range, which is
 * also its time range (a ULID sorts chronologically). That makes the object self-
 * describing: "which file holds the row I am looking for" is answered by the key alone,
 * without a manifest, and re-shipping an identical batch overwrites in place rather than
 * accumulating duplicates. Shares the bucket with `scopes/` and `directory/` — three
 * prefixes that cannot collide, none of them built by a caller.
 */
function accessLogKey(firstId: string, lastId: string): string {
  return `access-log/${firstId}-${lastId}.ndjson`;
}

/**
 * The R2 implementation of the `AccessLogSink` seam (K-24, control-plane.md §4.4) — the
 * Tier 2 that makes the access log's retention window closable.
 *
 * **NDJSON, not JSON.** One row per line, appended-shaped: an operator greps it, a SIEM
 * ingests it line-by-line, and a truncated object still parses up to its last newline.
 * A single JSON array would have to be whole to be readable at all, which is the wrong
 * failure mode for evidence.
 *
 * **Vendor-neutral by construction**, which was the point (#36): this writes a documented
 * line format to an object store, so Splunk, Datadog, Drata and a human with `jq` all
 * consume the same file. A vendor-specific push connector would have coupled the platform's
 * retention policy to one company's roadmap.
 */
export function createR2AccessLogSink(bucket: unknown): AccessLogSink {
  const r2 = bucket as R2BucketLike;
  return {
    async ship(entries) {
      const first = entries[0];
      const last = entries[entries.length - 1];
      if (!first || !last) {
        // The sweep does not call `ship` with an empty batch; if some other caller does,
        // returning a ref to an object that was never written would be a lie.
        throw new Error('access-log sink: refusing to ship an empty batch');
      }
      const key = accessLogKey(first.id, last.id);
      const body = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
      await r2.put(key, body, {
        // `application/x-ndjson` so a browser or a fetch-based consumer streams it as
        // lines rather than trying to parse the whole object as one document.
        httpMetadata: { contentType: 'application/x-ndjson' },
        customMetadata: {
          firstId: first.id,
          lastId: last.id,
          rows: String(entries.length),
          // The wall-clock span, mirrored so a listing can answer "what covers March"
          // without fetching a single object.
          from: first.at,
          to: last.at,
        },
      });
      // Resolving here IS the durability claim the sweep relies on before it stamps
      // `drainedAt`: R2's `put` resolves after the write is committed.
      return { ref: key };
    },
  };
}

/**
 * The stored-copy lifecycle rule (#557) — the retention leg #36 left unmade.
 *
 * Every prune here is **operator-chosen**: these functions run only when a deployment
 * has named a window (the CP worker's `SCOPE_BACKUP_RETENTION_DAYS` /
 * `ACCESS_LOG_RETENTION_DAYS`), never on a default. That is the #553 posture — the
 * platform never deletes evidence on a schedule a human did not choose — applied to the
 * copies themselves. Enforced in code rather than by an R2 bucket lifecycle rule so the
 * policy is visible in the repo, testable against the fake bucket, and identical on any
 * future non-R2 store.
 *
 * Both prunes are age-based and **conservative by construction**: an object whose age
 * cannot be determined is kept, and a batch is deleted only when its NEWEST row is out
 * of the window — never one that still holds in-window rows. The walk collects stale
 * keys first and deletes after, so deletion never races the pagination cursor.
 */
interface PruneOptions {
  /**
   * Copies strictly older than this many days are dropped. `0` is honored (drop
   * everything on the next pass) — an operator can ask for it, as with the reap windows.
   */
  olderThanDays: number;
  /** Injected clock, for tests. */
  now?: () => Date;
}

/** Walk one prefix completely, returning every object's key + custom metadata. */
async function listAll(
  r2: R2BucketLike,
  prefix: string,
): Promise<{ key: string; customMetadata?: Record<string, string> }[]> {
  const out: { key: string; customMetadata?: Record<string, string> }[] = [];
  let cursor: string | undefined;
  do {
    const page = await r2.list({
      prefix,
      include: ['customMetadata'],
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

const DAY_MS = 86_400_000;

/**
 * Drop `scopes/…` reap copies (#493) older than the window. A copy's age is its
 * `capturedAt` — the key's last segment, same as the store's own fallback address — so a
 * hand-uploaded object without metadata still ages out rather than living forever by
 * omission. An unparsable timestamp keeps the copy: deleting what cannot be dated is not
 * retention.
 *
 * Note the interaction with #37 (erasure): per-subject payloads inside these dumps are
 * sealed under per-subject DEKs, so an old copy's PII exposure is bounded by key
 * destruction already — this rule is the cost/hygiene bound, not the privacy one.
 */
export async function pruneScopeBackups(bucket: unknown, options: PruneOptions): Promise<number> {
  const r2 = bucket as R2BucketLike;
  const cutoff = (options.now?.() ?? new Date()).getTime() - options.olderThanDays * DAY_MS;
  let pruned = 0;
  for (const o of await listAll(r2, 'scopes/')) {
    const capturedAt =
      o.customMetadata?.capturedAt ?? o.key.slice(o.key.lastIndexOf('/') + 1).replace(/\.json$/, '');
    const at = new Date(capturedAt).getTime();
    if (Number.isNaN(at) || at >= cutoff) continue;
    await r2.delete(o.key);
    pruned += 1;
  }
  return pruned;
}

/** Crockford base32, the ULID alphabet — no I, L, O, U. */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID's timestamp: its first 10 chars, base32-decoded to epoch ms. Null when malformed. */
function ulidTimeMs(id: string): number | null {
  if (id.length !== 26) return null;
  let ms = 0;
  for (const ch of id.slice(0, 10)) {
    const v = ULID_ALPHABET.indexOf(ch.toUpperCase());
    if (v < 0) return null;
    ms = ms * 32 + v;
  }
  return ms;
}

/**
 * Drop `access-log/…` NDJSON batches (#553) whose NEWEST row is older than the window.
 * Age comes from the mirrored `to` metadata, falling back to the key's own `lastId` (a
 * ULID carries its timestamp), so a batch is datable from either half of what `ship`
 * wrote. Undatable ⇒ kept, as above.
 *
 * The rows themselves already left the directory DO — `pruneAccessLog` deleted them only
 * after this object durably existed — so this window is where the record's Tier 2
 * lifetime finally ends, and choosing it is choosing how far back "which rows left, and
 * when" can be answered from the object store. The admin log's own `drainAccessLog` /
 * `pruneAccessLog` rows are never touched: the egress stays witnessed after its payload
 * expires.
 */
export async function pruneAccessLogBatches(
  bucket: unknown,
  options: PruneOptions,
): Promise<number> {
  const r2 = bucket as R2BucketLike;
  const cutoff = (options.now?.() ?? new Date()).getTime() - options.olderThanDays * DAY_MS;
  let pruned = 0;
  for (const o of await listAll(r2, 'access-log/')) {
    let newest: number | null = null;
    if (o.customMetadata?.to) {
      const at = new Date(o.customMetadata.to).getTime();
      newest = Number.isNaN(at) ? null : at;
    }
    if (newest === null) {
      // `access-log/<firstId>-<lastId>.ndjson` — the lastId is chars 27…52 of the name.
      const name = o.key.slice('access-log/'.length).replace(/\.ndjson$/, '');
      const lastId = name.length === 53 && name[26] === '-' ? name.slice(27) : null;
      newest = lastId ? ulidTimeMs(lastId) : null;
    }
    if (newest === null || newest >= cutoff) continue;
    await r2.delete(o.key);
    pruned += 1;
  }
  return pruned;
}
