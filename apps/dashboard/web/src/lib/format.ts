/** Small presentational helpers. Nothing here is authoritative — display only. */

/** Initials for an avatar tile, from a display name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/** Middle-truncate a ULID for display (full value goes in a `title`). */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

/** A coarse relative-time label from an ISO timestamp, against `now`. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * A deadline label from an ISO timestamp — the future-facing twin of `relativeTime`, which
 * clamps to the past and would call any deadline "just now". "in 14m" / "in 2h" / "until
 * Sep 3" while it lies ahead; once passed, it says so rather than counting further.
 */
export function untilTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const s = Math.round((then - now) / 1000);
  if (s <= 0) return `expired ${relativeTime(iso, now)}`;
  if (s < 60) return 'in under a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `until ${new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** A friendly "Jul 14, 2026" date from an ISO timestamp. */
export function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A URL-safe slug from a display name (for the default `*.substrat.run` host). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app'
  );
}
