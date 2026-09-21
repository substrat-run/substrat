import type { StorageExclusion, StorageMeterReading } from '@substrat-run/contracts';

/**
 * The console's running tally over a tenant's storage pages (#1524).
 *
 * The platform answers one page of scopes at a time, because each scope it reads is a
 * Durable Object it wakes. The card asks for further pages only when a person presses
 * for them, and this fold decides the one thing the card must not get wrong: whether
 * the sum shown is the tenant's TOTAL, or only part of it.
 *
 * `complete` needs all three: no page is left, no read failed, and every scope the
 * directory counts was read. The last one catches a tenant that gained a scope between
 * two pages. That scope sorts before the cursor, so no later page will read it.
 */
export interface StorageTally {
  readAt: string;
  bytes: number;
  read: number;
  failed: number;
  total: number;
  reaped: number;
  nextCursor: string | null;
  failures: { scopeId: string; error: string }[];
  excluded: StorageExclusion[];
  complete: boolean;
}

export function foldStoragePage(prev: StorageTally | null, page: StorageMeterReading): StorageTally {
  const failures = [
    ...(prev?.failures ?? []),
    ...page.scopes.flatMap((s) => (s.bytes === null ? [{ scopeId: s.scopeId, error: s.error }] : [])),
  ];
  const bytes = (prev?.bytes ?? 0) + page.bytes;
  const read = (prev?.read ?? 0) + page.read;
  const failed = (prev?.failed ?? 0) + page.failed;
  return {
    // The instant of the FIRST page. A tally that spans pages is quoted from when it began.
    readAt: prev?.readAt ?? page.readAt,
    bytes,
    read,
    failed,
    total: page.total,
    reaped: page.reaped,
    nextCursor: page.nextCursor,
    failures,
    excluded: page.excluded,
    complete: page.nextCursor === null && failed === 0 && read === page.total,
  };
}

/** What each exclusion is, in the words the card and the doc both use. */
export const EXCLUSION_LABEL: Record<StorageExclusion, string> = {
  attachments: 'attachment files (they live in a blob store)',
  'tenant-stores': 'per-tenant D1 databases',
  lake: 'event history shipped to the lake',
};

/** Binary units, as a DO's storage is billed. Bytes are exact below 1 KiB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
