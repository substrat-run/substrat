import type { StorageExclusion, StorageGauge, StorageMeterReading } from '@substrat-run/contracts';

/**
 * The console's running tally over a tenant's storage pages (#1524).
 *
 * The platform answers one page of scopes at a time, because each scope it reads is a
 * Durable Object it wakes. The card asks for further pages only when a person presses
 * for them, and this fold decides the one thing the card must not get wrong: whether
 * the sum shown is the tenant's TOTAL, or only part of it.
 *
 * `complete` is true only for a walk that fit in ONE page, which the platform itself
 * marked complete: every non-reaped scope was read in a single directory listing and none
 * failed. A walk over several pages is never complete. The directory has no revision to
 * compare between pages, and scopes provisioned or reaped during the walk can substitute
 * one scope for another with the counts still agreeing. So a multi-page sum is reported
 * as what it is, the scopes that were read, with `directoryMayHaveChanged` set.
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
  /** Pages folded into this tally. */
  pages: number;
  complete: boolean;
  /**
   * The walk spanned more than one directory listing, so the scopes read may not be the
   * scopes the tenant has now. Nothing can confirm it either way.
   */
  directoryMayHaveChanged: boolean;
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
    pages: (prev?.pages ?? 0) + 1,
    complete: prev === null && page.complete,
    directoryMayHaveChanged: prev !== null,
  };
}

/**
 * How many scopes a sum leaves out, when that can be said, and `null` when it cannot. After
 * a multi-page walk `total` comes from the last listing and `read` from several, so their
 * difference compares two different sets of scopes. It can even come out negative, when a
 * scope read on an earlier page was reaped before the last one.
 */
export function scopesLeftOut(t: StorageTally): number | null {
  if (t.directoryMayHaveChanged) return null;
  return Math.max(0, t.total - t.read);
}

/** Why a sum is not the total, in the one form the tally can support. */
export function partialNote(t: StorageTally): string {
  const left = scopesLeftOut(t);
  if (left !== null) {
    return `This sum leaves out ${left} scope${left === 1 ? '' : 's'}. It is not this tenant's storage total.`;
  }
  const more = t.nextCursor ? ' More pages are left.' : '';
  return (
    `Read ${t.read} scope${t.read === 1 ? '' : 's'} across ${t.pages} pages. The directory may have changed ` +
    `during the walk, so this is not a total, and how many scopes it misses cannot be said.${more} ` +
    'Re-read for a total if the tenant fits in one page.'
  );
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

/**
 * The stored gauge is sampled at most daily, so a reading older than two days means the
 * sweep has not reached some scope for a full day longer than it should have.
 */
export const STORAGE_STALE_AFTER_MS = 2 * 86_400_000;

/** How a surface states a stored storage figure (#1524), from the gauge alone. */
export interface GaugeView {
  /** The number to show, or a dash when there is nothing to sum. */
  value: string;
  /** `total` only when every scope is sampled, none is stale and none is failing. */
  label: 'total' | 'partial' | 'failing' | 'stale' | 'not sampled' | 'not recorded';
  /** One sentence naming what the figure covers and how old it is. */
  detail: string;
}

/**
 * The words a stored figure may be shown with. It is only ever called a total when every
 * non-reaped scope has a reading, the oldest reading is fresh and no scope's last read failed.
 * One whose oldest reading is past `STORAGE_STALE_AFTER_MS` is `stale`; one with a scope whose
 * last read failed is `failing` (its last good reading is still in the sum); one missing scopes
 * is `partial`. Every case still says how many scopes it covers, from when, and which failed.
 */
export function gaugeView(g: StorageGauge | undefined, nowMs: number): GaugeView {
  if (!g) return { value: '—', label: 'not recorded', detail: 'This host keeps no storage gauge.' };
  const scopes = (n: number) => `${n} scope${n === 1 ? '' : 's'}`;
  const failing =
    g.failing > 0 && g.lastFailedAt
      ? ` The last read of ${scopes(g.failing)} failed, most recently at ${new Date(g.lastFailedAt).toLocaleString()}.`
      : '';
  if (g.sampled === 0 || g.oldestReadAt === null) {
    return {
      value: '—',
      label: failing ? 'failing' : 'not sampled',
      detail:
        g.total === 0
          ? 'No scope holds data.'
          : `None of ${scopes(g.total)} has been sampled yet. The scheduled pass reads each at most once a day.${failing}`,
    };
  }
  const covers = g.sampled < g.total ? `${g.sampled} of ${scopes(g.total)} sampled` : `all ${scopes(g.total)} sampled`;
  const asOf = `as of ${new Date(g.oldestReadAt).toLocaleString()}`;
  const stale = nowMs - Date.parse(g.oldestReadAt) > STORAGE_STALE_AFTER_MS;
  return {
    value: formatBytes(g.bytes),
    label: stale ? 'stale' : failing ? 'failing' : g.sampled < g.total ? 'partial' : 'total',
    detail: `Scope databases only, ${covers}, ${asOf}.${failing}`,
  };
}
