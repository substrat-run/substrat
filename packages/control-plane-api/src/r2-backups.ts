import type { DrainedEvent } from '@substrat-run/contracts';
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
  scopeBackupIndex,
  scopeDump,
  type DirectoryBackup,
  type DirectoryDump,
  type ScopeBackup,
  type ScopeBackupObject,
  type ScopeDump,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import type { EventSink, AccessLogSink } from '@substrat-run/kernel';
import { storedTables, type BackupAddress, type DirectoryBackupStore, type ScopeBackupStore } from './backups.js';

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
  /** R2 takes up to 1000 keys in one call. */
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    /** Rolls up what lies below it, so a listing of a scope's backups never walks their pages. */
    delimiter?: string;
    include?: ('customMetadata' | 'httpMetadata')[];
  }): Promise<{
    objects: { key: string; size: number; customMetadata?: Record<string, string> }[];
    /** What `delimiter` rolled up. */
    delimitedPrefixes?: string[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * Keys are `scopes/<tenantId>/<scopeId>/<capturedAt>.json`, so a scope's copies are one
 * prefix list and a tenant's are one level up. The scheme is private to this module —
 * callers address a backup by (tenant, scope, capturedAt) and never build a path.
 *
 * That object is the backup: a whole dump, or the index of one held in parts (D-69). The parts lie
 * under `<capturedAt>/`, the scope's tables in `scope-<attempt>.json` and a store's pages in
 * `stores/<moveId>/<seq>.json`, and until the index lands no read names them. They sort after the
 * index (`.` before `/`), so a prune removes the index first: a backup cut short by one is gone,
 * not half there.
 */
function backupKey(tenantId: string, scopeId: string, capturedAt: string): string {
  return `scopes/${tenantId}/${scopeId}/${capturedAt}.json`;
}

function scopePrefix(tenantId: string, scopeId: string): string {
  return `scopes/${tenantId}/${scopeId}/`;
}

const partsPrefix = ({ tenantId, scopeId, capturedAt }: BackupAddress): string =>
  `${scopePrefix(tenantId, scopeId)}${capturedAt}/`;
const movePrefix = (at: BackupAddress, moveId: string): string => `${partsPrefix(at)}stores/${moveId}/`;
/** Padded past the longest chain a reader takes, so the keys of a chain sort in its order. */
const pageKey = (at: BackupAddress, moveId: string, seq: number): string =>
  `${movePrefix(at, moveId)}${String(seq).padStart(6, '0')}.json`;

const R2_DELETE_MAX_KEYS = 1000;

async function deleteAll(r2: R2BucketLike, keys: readonly string[]): Promise<void> {
  for (let at = 0; at < keys.length; at += R2_DELETE_MAX_KEYS) {
    await r2.delete(keys.slice(at, at + R2_DELETE_MAX_KEYS));
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text);

async function sha256Hex(bytes: ReturnType<typeof utf8>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}


export function createR2BackupStore(bucket: unknown): ScopeBackupStore {
  const r2 = bucket as R2BucketLike;
  /** What a backup's own object holds: a whole dump, or an index. Null when there is none. */
  const readHead = async (at: BackupAddress): Promise<unknown> => {
    const obj = await r2.get(backupKey(at.tenantId, at.scopeId, at.capturedAt));
    return obj ? (JSON.parse(await obj.text()) as unknown) : null;
  };
  const isIndex = (head: unknown): boolean => (head as { form?: unknown } | null)?.form === 'paged';
  const readObject = async (at: BackupAddress, ref: ScopeBackupObject): Promise<string | null> => {
    const what = `object '${ref.key.slice(partsPrefix(at).length)}' of the backup of ${at.capturedAt}`;
    if (!ref.key.startsWith(partsPrefix(at))) {
      throw new ControlPlaneError(422, `the backup of ${at.capturedAt} names an object outside itself; nothing was moved`);
    }
    const obj = await r2.get(ref.key);
    if (!obj) return null;
    const body = await obj.text();
    const bytes = utf8(body);
    if (bytes.length !== ref.bytes || (await sha256Hex(bytes)) !== ref.digest) {
      throw new ControlPlaneError(422, `${what} is not the bytes its index names, so it is damaged; nothing was moved`);
    }
    return body;
  };
  const listAllUnder = async (prefix: string): Promise<{ key: string; size: number; customMetadata?: Record<string, string> }[]> => {
    const out: { key: string; size: number; customMetadata?: Record<string, string> }[] = [];
    let cursor: string | undefined;
    do {
      // Include what is asked for and R2 may answer a short page, so only `truncated` ends the walk.
      const page = await r2.list({ prefix, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
      out.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  };
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
          delimiter: '/',
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
            // An index's own object is small: the copy's size is what its parts add up to.
            size: meta.size ? Number(meta.size) : o.size,
            tables: meta.tables ? Number(meta.tables) : 0,
          });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      // Newest first. ISO 8601 sorts lexicographically, which is why `capturedAt` is
      // the key's last segment.
      return out.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
    },

    async get(at) {
      const head = await readHead(at);
      if (head === null) return null;
      if (!isIndex(head)) {
        // Parsed through the contract on the way out: a corrupted or hand-edited object
        // fails HERE, loudly, rather than at the restore that trusted it.
        return scopeDump.parse(head) as ScopeDump;
      }
      const index = scopeBackupIndex.parse(head);
      const body = await readObject(at, index.scope);
      if (body === null) {
        throw new ControlPlaneError(422, `the scope's tables are missing from the backup of ${at.capturedAt}; nothing was moved`);
      }
      const { tables } = storedTables.parse(JSON.parse(body));
      return { tenantId: index.tenantId, scopeId: index.scopeId, capturedAt: index.capturedAt, tables, stores: [], storePages: index.stores };
    },

    async putScopeTables({ tables, ...at }) {
      const body = JSON.stringify({ tables });
      const bytes = utf8(body);
      const digest = await sha256Hex(bytes);
      const key = `${partsPrefix(at)}scope-${ulid()}.json`;
      await r2.put(key, body, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { capturedAt: at.capturedAt, digest },
      });
      return { key, bytes: bytes.length, digest, tables: tables.length };
    },

    async putStorePage({ moveId, seq, body, ...at }) {
      await r2.put(pageKey(at, moveId, seq), body, {
        httpMetadata: { contentType: 'application/json' },
        // In the metadata, so the index is built from a listing without reading a page, and so
        // retention can date a page with no index to date it by.
        customMetadata: { capturedAt: at.capturedAt, digest: await sha256Hex(utf8(body)) },
      });
    },

    async listStorePages({ moveId, pages, ...at }) {
      const prefix = movePrefix(at, moveId);
      const listed = await listAllUnder(prefix);
      // A step resumed from an older record can leave pages past where this chain ended.
      return listed
        .map((o) => ({ o, seq: Number(o.key.slice(prefix.length).replace(/\.json$/, '')) }))
        .filter(({ seq }) => seq < pages)
        .sort((a, b) => a.seq - b.seq)
        .map(({ o }) => ({ key: o.key, bytes: o.size, digest: o.customMetadata?.digest ?? '' }));
    },

    async putIndex({ vertical, index }) {
      const body = JSON.stringify(index);
      const size = index.stores.reduce(
        (total, store) => store.pages.reduce((n, page) => n + page.bytes, total),
        utf8(body).length + index.scope.bytes,
      );
      const backup: ScopeBackup = {
        tenantId: index.tenantId,
        scopeId: index.scopeId,
        vertical,
        capturedAt: index.capturedAt,
        size,
        tables: index.scope.tables,
      };
      await r2.put(backupKey(index.tenantId, index.scopeId, index.capturedAt), body, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: {
          tenantId: backup.tenantId,
          scopeId: backup.scopeId,
          capturedAt: backup.capturedAt,
          tables: String(backup.tables),
          size: String(size),
          ...(vertical ? { vertical } : {}),
        },
      });
      return backup;
    },

    async getIndex(at) {
      const head = await readHead(at);
      return isIndex(head) ? scopeBackupIndex.parse(head) : null;
    },

    readObject: ({ ref, ...at }) => readObject(at, ref),

    async deleteMove({ moveId, ...at }) {
      await deleteAll(r2, (await listAllUnder(movePrefix(at, moveId))).map((o) => o.key));
    },

    async deleteAttempt({ scopeKey, moveIds, ...at }) {
      const head = await readHead(at);
      if (scopeKey !== undefined && isIndex(head) && (head as { scope?: { key?: unknown } }).scope?.key === scopeKey) {
        await r2.delete(backupKey(at.tenantId, at.scopeId, at.capturedAt));
      }
      if (scopeKey !== undefined) await r2.delete(scopeKey);
      for (const moveId of moveIds) await deleteAll(r2, (await listAllUnder(movePrefix(at, moveId))).map((o) => o.key));
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
 * Where one scope's drained events land. Partitioned by **tenant, scope and day**,
 * because those are the three narrowings every Tier 2 query starts from —
 * reporting is per tenant, isolation is per scope, and reconciliation is per
 * period. A query engine that understands Hive-style paths prunes on all three
 * without reading a byte of the objects it skips.
 *
 * Keyed by the group's FIRST event id, not its id range. A range key looked
 * idempotent and is not: the drain ships before it stamps, so a failed mark
 * resends from the same first event — but with a different last one, once new
 * events have landed or the batch budget moved. Two range-keyed objects would
 * then both exist, overlapping, and a prefix scan would count the shared events
 * twice. Keyed by the start alone, the resend overwrites what it supersedes.
 *
 * That narrows duplication; it does not abolish it, and the contract does not
 * pretend otherwise. The drain is at-least-once by construction, so a reader
 * deduplicates on event id — which a lake keyed by event id does anyway.
 */
function eventLogKey(tenantId: string, scopeId: string, day: string, firstId: string): string {
  return `events/tenant=${tenantId}/scope=${scopeId}/day=${day}/${firstId}.ndjson`;
}

/** The UTC day an event occurred — the partition it belongs in, whatever day it shipped. */
function occurrenceDay(occurredAt: string): string {
  return occurredAt.slice(0, 10);
}

/**
 * The R2 implementation of the `EventSink` seam (#1334) — Tier 2 ingest, master-plan
 * §5.3's "exact history", landing as objects an engine can read.
 *
 * **NDJSON to R2, not Pipelines-to-Iceberg, for v1 — and that is a deliberate
 * staging choice rather than a shortcut.** §5.3 settles the architecture as
 * *"Iceberg is the contract, the query engine is replaceable"*, and the same
 * paragraph leaves R2 SQL's fitness explicitly open pending a benchmark. Writing
 * partitioned NDJSON to a bucket the platform already operates gets the events out
 * of the scope — which is what licenses the retention prune that bounds the outbox — without
 * committing the ingest path to a product decision nobody has made yet. A
 * compaction step turns these objects into Iceberg later, and the seam means the
 * drain never learns which happened.
 *
 * The same line-format reasoning as the access-log sink applies: one event per
 * line, so a truncated object still parses up to its last newline, and `jq`,
 * DuckDB and any lake loader all read it unaided.
 */
export function createR2EventSink(bucket: unknown): EventSink {
  const r2 = bucket as R2BucketLike;
  return {
    async ship(scope, events) {
      const first = events[0];
      if (!first) {
        // The sweep never ships an empty batch; returning a ref to an object that
        // was never written would be a lie, and the stamp it licenses would be one.
        throw new Error('event sink: refusing to ship an empty batch');
      }
      // Split by the day each event OCCURRED, not the batch's first — a drain that
      // crosses midnight otherwise files the later day's events under the earlier
      // partition, and `day=` stops meaning what a period query reads it to mean.
      // A late-draining scope still files by occurrence, never by ship time.
      const byDay = new Map<string, DrainedEvent[]>();
      for (const e of events) {
        const day = occurrenceDay(e.occurredAt);
        const group = byDay.get(day);
        if (group) group.push(e);
        else byDay.set(day, [e]);
      }

      const refs: string[] = [];
      for (const [day, group] of byDay) {
        const head = group[0]!;
        const tail = group[group.length - 1]!;
        const key = eventLogKey(scope.tenantId, scope.scopeId, day, head.id);
        const body = `${group.map((e) => JSON.stringify(e)).join('\n')}\n`;
        await r2.put(key, body, {
          httpMetadata: { contentType: 'application/x-ndjson' },
          customMetadata: {
            tenantId: scope.tenantId,
            scopeId: scope.scopeId,
            firstId: head.id,
            lastId: tail.id,
            rows: String(group.length),
          },
        });
        refs.push(key);
      }
      // One ref for the caller's report; a midnight-crossing batch wrote several,
      // and the metadata on each says what it holds.
      return { ref: refs[0]! };
    },
  };
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
  /** `pruneScopeBackups`: the listings and deletes one pass may spend. Default `SCOPE_PRUNE_PASS_CALLS`. */
  maxCalls?: number;
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
 * The listings and deletes one retention pass may spend, of the 1000 subrequests a scheduled
 * invocation shares with every other phase.
 */
export const SCOPE_PRUNE_PASS_CALLS = 200;

/** Where a pass that ran out of budget says how far it got, outside `scopes/`, so it is no copy. */
const SCOPE_PRUNE_CURSOR_KEY = 'retention/scope-backups-cursor';

class PruneBudgetSpent extends Error {}

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
 *
 * A backup's parts (D-69) age with it, so a page goes with its index and a page no index ever named
 * (a backup that never finished) goes too. One backup can hold tens of thousands of objects and a
 * pass has a budget, so this walks scope by scope with a delimiter, never listing a page of a backup
 * it keeps, and deletes as it goes: the index first, so a backup cut short is gone, not half there.
 * A pass out of budget leaves a cursor at the last scope it finished and the next starts after it,
 * so every scope is reached however many stand ahead of it, and a scope with more to delete than a
 * pass can spend still loses some on each. The answer counts copies, not their parts.
 */
export async function pruneScopeBackups(bucket: unknown, options: PruneOptions): Promise<number> {
  const r2 = bucket as R2BucketLike;
  const cutoff = (options.now?.() ?? new Date()).getTime() - options.olderThanDays * DAY_MS;
  let calls = options.maxCalls ?? SCOPE_PRUNE_PASS_CALLS;
  const spend = (): void => {
    if (calls <= 0) throw new PruneBudgetSpent();
    calls -= 1;
  };
  /** One level below `prefix`: what lies directly there, and what `/` rolled up. */
  const level = async (prefix: string) => {
    const objects: { key: string; customMetadata?: Record<string, string> }[] = [];
    const prefixes: string[] = [];
    let cursor: string | undefined;
    do {
      spend();
      const page = await r2.list({ prefix, delimiter: '/', include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
      objects.push(...page.objects);
      prefixes.push(...(page.delimitedPrefixes ?? []));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { objects, prefixes: prefixes.sort() };
  };
  const isStale = (capturedAt: string): boolean => {
    const at = new Date(capturedAt).getTime();
    return !Number.isNaN(at) && at < cutoff;
  };
  const deleteUnder = async (prefix: string): Promise<void> => {
    for (;;) {
      spend();
      const page = await r2.list({ prefix });
      if (page.objects.length === 0) return;
      spend();
      await r2.delete(page.objects.slice(0, R2_DELETE_MAX_KEYS).map((o) => o.key));
    }
  };
  let pruned = 0;
  const pruneScope = async (scope: string): Promise<void> => {
    const { objects, prefixes } = await level(scope);
    for (const o of objects) {
      const capturedAt = o.customMetadata?.capturedAt ?? o.key.slice(scope.length).replace(/\.json$/, '');
      if (!isStale(capturedAt)) continue;
      spend();
      await r2.delete(o.key);
      pruned += 1;
    }
    for (const parts of prefixes) {
      if (isStale(parts.slice(scope.length, -1))) await deleteUnder(parts);
    }
  };
  const resume = await (await r2.get(SCOPE_PRUNE_CURSOR_KEY))?.text();
  let finished = resume;
  try {
    for (const tenant of (await level('scopes/')).prefixes) {
      if (resume && tenant < resume.slice(0, resume.indexOf('/', 'scopes/'.length) + 1)) continue;
      for (const scope of (await level(tenant)).prefixes) {
        if (resume && scope <= resume) continue;
        await pruneScope(scope);
        finished = scope;
      }
    }
  } catch (e) {
    if (!(e instanceof PruneBudgetSpent)) throw e;
    if (finished && finished !== resume) await r2.put(SCOPE_PRUNE_CURSOR_KEY, finished);
    return pruned;
  }
  if (resume) await r2.delete(SCOPE_PRUNE_CURSOR_KEY);
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
