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
  mergeDumpPages,
  scopeDump,
  scopeDumpChange,
  scopeDumpPageTable,
  scopeDumpTable,
  z,
  type DirectoryBackup,
  type DirectoryDump,
  type ScopeBackup,
  type ScopeDumpTable,
} from '@substrat-run/contracts';
import type { EventSink, AccessLogSink } from '@substrat-run/kernel';
import type { DirectoryBackupStore, ScopeBackupEntry, ScopeBackupStore } from './backups.js';

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
    delimiter?: string;
  }): Promise<{
    objects: { key: string; size: number; customMetadata?: Record<string, string> }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * A backup is `scopes/<tenantId>/<scopeId>/<capturedAt>.json`, so a scope's copies are one
 * prefix list and a tenant's are one level up. The scheme is private to this module —
 * callers address a backup by (tenant, scope, capturedAt) and never build a path.
 *
 * That object is the backup's MANIFEST (#2839): the dump's header and how many entries hold its
 * tables, each entry its own object at `scopes/<tenantId>/<scopeId>/<capturedAt>/<stageId>/<seq>.json`.
 * One object per page rather than one multipart object, because a restore reads it back a page at
 * a time: a single JSON document cannot be read in parts. The manifest is written last, so a
 * backup that did not finish has none and is never listed or read.
 *
 * A backup written before #2839 is one whole dump at the manifest's key. It is read as a backup
 * of one entry, which is its tables.
 */
function backupKey(tenantId: string, scopeId: string, capturedAt: string): string {
  return `scopes/${tenantId}/${scopeId}/${capturedAt}.json`;
}

function entryKey(tenantId: string, scopeId: string, capturedAt: string, stageId: string, seq: number): string {
  return `scopes/${tenantId}/${scopeId}/${capturedAt}/${stageId}/${seq}.json`;
}

function scopePrefix(tenantId: string, scopeId: string): string {
  return `scopes/${tenantId}/${scopeId}/`;
}

/** A backup's manifest: the dump without its tables, and where its entries are. */
const backupManifest = scopeDump.omit({ tables: true }).extend({
  format: z.literal('paged'),
  stageId: z.string().min(1),
  entries: z.number().int().positive(),
  tables: z.number().int().nonnegative(),
});

const backupEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), tables: z.array(scopeDumpPageTable) }),
  z.object({ kind: z.literal('changes'), tables: z.array(scopeDumpChange) }),
]);

/** Byte length, not string length: a size is the stored object's, and non-ASCII would under-report. */
const byteLength = (body: string): number => new TextEncoder().encode(body).length;

export function createR2BackupStore(bucket: unknown): ScopeBackupStore {
  const r2 = bucket as R2BucketLike;

  return {
    begin({ vertical, header }) {
      const { tenantId, scopeId, capturedAt } = header;
      const written = new Map<string, number[]>();
      return {
        async put(stageId, seq, entry) {
          const body = JSON.stringify(entry);
          await r2.put(entryKey(tenantId, scopeId, capturedAt, stageId, seq), body, {
            httpMetadata: { contentType: 'application/json' },
            // Retention dates every object of a backup by this, entries included.
            customMetadata: { capturedAt },
          });
          const sizes = written.get(stageId) ?? [];
          sizes[seq] = byteLength(body);
          written.set(stageId, sizes);
        },

        async discard(stageId) {
          const sizes = written.get(stageId) ?? [];
          written.delete(stageId);
          await Promise.all(
            sizes.map((_, seq) => r2.delete(entryKey(tenantId, scopeId, capturedAt, stageId, seq)).catch(() => undefined)),
          );
        },

        async commit({ stageId, entries, tables }) {
          const sizes = written.get(stageId) ?? [];
          for (let seq = 0; seq < entries; seq++) {
            if (sizes[seq] === undefined) throw new Error(`backup entry ${seq} of ${entries} was never written`);
          }
          const body = JSON.stringify({ ...header, format: 'paged', stageId, entries, tables });
          const size = byteLength(body) + sizes.slice(0, entries).reduce((a, b) => a + b, 0);
          const backup: ScopeBackup = { tenantId, scopeId, vertical, capturedAt, size, tables };
          await r2.put(backupKey(tenantId, scopeId, capturedAt), body, {
            httpMetadata: { contentType: 'application/json' },
            // Mirrored into custom metadata so `list` can answer without fetching every
            // manifest. `size` too: the manifest is the smallest part of the copy.
            customMetadata: {
              tenantId,
              scopeId,
              capturedAt,
              tables: String(tables),
              size: String(size),
              ...(vertical ? { vertical } : {}),
            },
          });
          return backup;
        },
      };
    },

    async list({ tenantId, scopeId }) {
      const prefix = scopePrefix(tenantId, scopeId);
      const out: ScopeBackup[] = [];
      let cursor: string | undefined;
      do {
        // One level: a backup's entries sit under a directory of their own, and are not backups.
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

    async get({ tenantId, scopeId, capturedAt }) {
      const obj = await r2.get(backupKey(tenantId, scopeId, capturedAt));
      if (!obj) return null;
      // Parsed through the contract on the way out: a corrupted or hand-edited object
      // fails HERE, loudly, rather than at the restore that trusted it. A manifest says so,
      // so a damaged one is refused as a manifest rather than as a whole dump.
      const raw: unknown = JSON.parse(await obj.text());
      if ((raw as { format?: unknown } | null)?.format !== 'paged') {
        const { tables, ...header } = scopeDump.parse(raw);
        return {
          header,
          entries: 1,
          entry: async (index) => {
            if (index !== 0) throw new Error(`backup ${capturedAt} of scope ${scopeId} has one entry`);
            return { kind: 'page', tables };
          },
        };
      }
      const { format: _, stageId, entries, tables: __, ...header } = backupManifest.parse(raw);
      return {
        header,
        entries,
        entry: async (index): Promise<ScopeBackupEntry> => {
          const part = await r2.get(entryKey(tenantId, scopeId, capturedAt, stageId, index));
          if (!part) throw new Error(`backup ${capturedAt} of scope ${scopeId} is missing entry ${index}`);
          return backupEntry.parse(JSON.parse(await part.text()));
        },
      };
    },
  };
}

/**
 * Keys are `directory/<capturedAt>.json` — one flat prefix, because there is exactly one
 * directory per deployment and `capturedAt` is a copy's whole address. Sharing a bucket
 * with the scope backups above is safe by construction: `scopes/` and `directory/` cannot
 * collide, and neither prefix is ever built by a caller.
 *
 * That object is the copy's MANIFEST (#2868), as a scope backup's is (#2839): its capture time
 * and how many pages hold its tables, each page its own object at
 * `directory/<capturedAt>/<stageId>/<seq>.json`. The manifest is written last, so a copy that did
 * not finish has none and is never listed or read. A copy written before #2868 is one whole dump
 * at the manifest's key, and still reads.
 */
function directoryKey(capturedAt: string): string {
  return `directory/${capturedAt}.json`;
}

function directoryPageKey(capturedAt: string, stageId: string, seq: number): string {
  return `directory/${capturedAt}/${stageId}/${seq}.json`;
}

const DIRECTORY_PREFIX = 'directory/';

/** Outside `directory/`, so it is never listed as a copy: the newest started copy (#2868). */
const DIRECTORY_ATTEMPT_KEY = 'directory-attempt.json';

const directoryManifest = z.object({
  capturedAt: z.string().min(1),
  format: z.literal('paged'),
  stageId: z.string().min(1),
  entries: z.number().int().positive(),
  tables: z.number().int().nonnegative(),
});

const directoryPage = z.object({ tables: z.array(scopeDumpTable) });

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
    begin({ capturedAt }) {
      const stageId = crypto.randomUUID();
      const sizes: number[] = [];
      return {
        async put(seq, tables) {
          const body = JSON.stringify({ tables });
          await r2.put(directoryPageKey(capturedAt, stageId, seq), body, {
            httpMetadata: { contentType: 'application/json' },
          });
          sizes[seq] = byteLength(body);
        },

        async discard() {
          await Promise.all(
            sizes.map((_, seq) => r2.delete(directoryPageKey(capturedAt, stageId, seq)).catch(() => undefined)),
          );
        },

        async commit({ entries, tables }) {
          for (let seq = 0; seq < entries; seq++) {
            if (sizes[seq] === undefined) throw new Error(`directory backup page ${seq} of ${entries} was never written`);
          }
          const body = JSON.stringify({ capturedAt, format: 'paged', stageId, entries, tables });
          const size = byteLength(body) + sizes.slice(0, entries).reduce((a, b) => a + b, 0);
          await r2.put(directoryKey(capturedAt), body, {
            httpMetadata: { contentType: 'application/json' },
            // Mirrored into custom metadata so `list` answers without fetching every manifest.
            // `size` too: the manifest is the smallest part of the copy.
            customMetadata: { capturedAt, tables: String(tables), size: String(size) },
          });
          return { capturedAt, size, tables };
        },
      };
    },

    async list() {
      const out: DirectoryBackup[] = [];
      let cursor: string | undefined;
      do {
        // One level: a copy's pages sit under a directory of their own, and are not copies.
        const page = await r2.list({
          prefix: DIRECTORY_PREFIX,
          delimiter: '/',
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
            size: meta.size ? Number(meta.size) : o.size,
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
      const raw: unknown = JSON.parse(await obj.text());
      if ((raw as { format?: unknown } | null)?.format !== 'paged') return directoryDump.parse(raw) as DirectoryDump;
      const manifest = directoryManifest.parse(raw);
      const pages: ScopeDumpTable[][] = [];
      for (let seq = 0; seq < manifest.entries; seq++) {
        const part = await r2.get(directoryPageKey(capturedAt, manifest.stageId, seq));
        if (!part) throw new Error(`directory backup ${capturedAt} is missing page ${seq}`);
        pages.push(directoryPage.parse(JSON.parse(await part.text())).tables);
      }
      // `restoreDirectory` takes one dump, so the pages are joined here (a paged restore is #2868's follow-up).
      return { capturedAt, tables: mergeDumpPages(pages) };
    },

    async delete({ capturedAt }) {
      // The manifest first: once it is gone the copy is no longer listed, whatever of its pages remain.
      await r2.delete(directoryKey(capturedAt));
      const prefix = `${DIRECTORY_PREFIX}${capturedAt}/`;
      let cursor: string | undefined;
      do {
        const page = await r2.list({ prefix, ...(cursor ? { cursor } : {}) });
        await Promise.all(page.objects.map((o) => r2.delete(o.key)));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },

    async markAttempt({ attemptedAt }) {
      await r2.put(DIRECTORY_ATTEMPT_KEY, JSON.stringify({ attemptedAt }), {
        httpMetadata: { contentType: 'application/json' },
      });
    },

    async lastAttempt() {
      const obj = await r2.get(DIRECTORY_ATTEMPT_KEY);
      if (!obj) return null;
      const parsed = z.object({ attemptedAt: z.string().min(1) }).safeParse(JSON.parse(await obj.text()));
      return parsed.success ? parsed.data.attemptedAt : null;
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
 * `capturedAt`: the object's metadata, else the key's segment after the scope, which is the
 * manifest's name and the directory a paged copy's entries sit in (#2839). So a hand-uploaded
 * object without metadata still ages out rather than living forever by omission. An
 * unparsable timestamp keeps the copy: deleting what cannot be dated is not retention.
 *
 * A copy's manifest sorts before its entries (`.` before `/`), so it goes first: a pass cut
 * short leaves entries no backup names, for the next pass, never a backup missing its entries.
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
      o.customMetadata?.capturedAt ?? (o.key.split('/')[3] ?? '').replace(/\.json$/, '');
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
