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

import { scopeDump, type ScopeBackup, type ScopeDump } from '@substrat-run/contracts';
import type { ScopeBackupStore } from './backups.js';

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
